import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import { type BotPolicy, type DecisionSource, decide, type Mode } from './gate'
import { amendmentReason, parseApprovalReply } from './reply'

export interface ApprovalRequest {
  id: string
  bot: string
  chat: string | null
  tool: string
  input: unknown
  reason: string
  expiresAt: number
}

export interface Resolution {
  decision: 'allow' | 'deny'
  source: DecisionSource
  reason?: string
  // Which human, once there is more than one — "platform:user_id". Absent for
  // the decisions no human made.
  by?: string
}

// The gate's runtime half: turns a decision into a resolved outcome, blocking on
// a human when the gate says so, and writing the audit row in the SAME call —
// the co-location NFR-3 depends on. Nothing here talks to a specific chat
// platform; the daemon supplies an `ask` callback that renders the request
// wherever the human is.
export class ApprovalQueue {
  private waiting = new Map<string, { req: ApprovalRequest; resolve: (r: Resolution) => void; timer: NodeJS.Timeout }>()

  constructor(
    private db: Db,
    private opts: {
      timeoutMs?: number
      ask?: (req: ApprovalRequest) => void | Promise<void>
      onResolved?: (req: ApprovalRequest, r: Resolution) => void | Promise<void>
    } = {},
  ) {
    // A daemon restart must not leave a provider turn blocked on an approval
    // nobody can answer any more: those rows are dead, so clear them.
    this.db.prepare('DELETE FROM pending_approvals').run()
  }

  get timeoutMs(): number {
    return this.opts.timeoutMs ?? 30 * 60_000 // FR-22 default: 30 minutes
  }

  private log(req: Pick<ApprovalRequest, 'bot' | 'chat' | 'tool' | 'input'>, mode: Mode, r: Resolution): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (bot, chat, tool, input_json, decision, source, mode, reason, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.bot, req.chat, req.tool, JSON.stringify(req.input ?? null), r.decision, r.source, mode, r.reason ?? null, r.by ?? null)
  }

  // The one entry point. Returns only after the decision is final AND logged.
  async request(
    args: { bot: string; chat?: string | null; tool: string; input: unknown },
    policy: BotPolicy,
    forceAsk = false,
  ): Promise<Resolution> {
    const chat = args.chat ?? null
    const outcome = decide(args.tool, policy, forceAsk)
    const mode: Mode = forceAsk ? 'ask' : policy.mode

    if (outcome.kind === 'allow') {
      const res: Resolution = { decision: 'allow', source: outcome.source, reason: outcome.reason }
      this.log({ ...args, chat }, mode, res)
      return res
    }

    if (outcome.kind === 'deny') {
      // Ungranted tool: refused outright and logged, never put to the human.
      const res: Resolution = { decision: 'deny', source: 'auto-class', reason: outcome.reason }
      this.log({ ...args, chat }, mode, res)
      return res
    }

    const req: ApprovalRequest = {
      id: randomUUID(),
      bot: args.bot,
      chat,
      tool: args.tool,
      input: args.input,
      reason: outcome.reason,
      expiresAt: Date.now() + this.timeoutMs,
    }
    this.db
      .prepare(
        `INSERT INTO pending_approvals (id, bot, chat, tool, input_json, expires_at)
         VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
      )
      .run(req.id, req.bot, chat, req.tool, JSON.stringify(args.input ?? null), `+${Math.round(this.timeoutMs / 1000)} seconds`)

    const resolution = await new Promise<Resolution>((resolve) => {
      const timer = setTimeout(
        () => this.settle(req.id, { decision: 'deny', source: 'timeout', reason: 'no answer before the timeout' }),
        this.timeoutMs,
      )
      timer.unref?.() // a pending approval must never hold the process open
      this.waiting.set(req.id, { req, resolve, timer })
      void this.opts.ask?.(req)
    })

    this.log({ ...args, chat }, mode, resolution)
    await this.opts.onResolved?.(req, resolution)
    return resolution
  }

  // A typed answer carries no id, so it lands on the newest open card in the
  // same thread. One implementation for every surface: Telegram text, a
  // transcribed voice note, and the desktop composer all end up here, which is
  // why the parsing does not live in any one bridge.
  answerByText(
    text: string,
    filter: { bot?: string; chat?: string | null } = {},
    by?: string,
  ): { id: string; tool: string; decision: 'allow' | 'deny'; amendment?: string } | undefined {
    const target = this.open(filter)[0]
    if (!target) return undefined
    const answer = parseApprovalReply(text)
    if (!answer) return undefined
    const r: Resolution =
      answer.kind === 'allow'
        ? { decision: 'allow', source: 'human-text', reason: 'approved in chat', by }
        : answer.kind === 'deny'
          ? { decision: 'deny', source: 'human-text', reason: 'denied in chat', by }
          : { decision: 'deny', source: 'human-text', reason: amendmentReason(answer.instruction), by }
    if (!this.settle(target.id, r)) return undefined
    return {
      id: target.id,
      tool: target.tool,
      decision: r.decision,
      amendment: answer.kind === 'amend' ? answer.instruction : undefined,
    }
  }

  // Called by the bridge when a human taps or types an answer.
  settle(id: string, r: Resolution): boolean {
    const entry = this.waiting.get(id)
    if (!entry) return false // already resolved, or from a previous process
    clearTimeout(entry.timer)
    this.waiting.delete(id)
    this.db.prepare('DELETE FROM pending_approvals WHERE id = ?').run(id)
    entry.resolve(r)
    return true
  }

  pendingCount(): number {
    return this.waiting.size
  }

  // Open requests, newest first. A typed "yes" names no id, so whoever handles
  // it needs to know which card the human is most plausibly answering.
  open(filter: { bot?: string; chat?: string | null } = {}): ApprovalRequest[] {
    return [...this.waiting.values()]
      .map((w) => w.req)
      .filter((r) => (filter.bot === undefined || r.bot === filter.bot) && (filter.chat === undefined || r.chat === filter.chat))
      .reverse()
  }

  // Deny everything still open — used on shutdown so no provider turn is left
  // blocked forever waiting on a daemon that is going away.
  denyAll(reason = 'daemon shutting down'): void {
    for (const id of [...this.waiting.keys()]) {
      this.settle(id, { decision: 'deny', source: 'timeout', reason })
    }
  }
}
