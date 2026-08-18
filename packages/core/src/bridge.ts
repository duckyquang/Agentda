import type { ApprovalQueue, ApprovalRequest } from './approvals'
import type { Owners } from './owners'
import type { Persona } from './persona'

// What every chat platform has to give us, and nothing more. Telegram, Slack
// and Discord disagree about almost everything except this: you can post a
// message, edit one, post something with two buttons on it, and be told when a
// button was pressed.
export interface OutboundRef {
  chat: string
  messageId: string
}

export interface BridgeTransport {
  platform: string
  send(chat: string, text: string): Promise<OutboundRef | undefined>
  edit(ref: OutboundRef, text: string): Promise<void>
  // The approve/deny buttons are the platform's own widget, so it renders them.
  askApproval(chat: string, req: ApprovalRequest, body: string): Promise<OutboundRef | undefined>
  closeCard(ref: OutboundRef, outcome: string): Promise<void>
}

export interface BridgeHost {
  owners: Owners
  queue: ApprovalQueue
  personas: () => Persona[]
  onMessage: (persona: Persona, chat: string, text: string, reply: (s: string) => Promise<void>) => Promise<void>
  onCommand: (cmd: string, args: string, chat: string, reply: (s: string) => Promise<void>) => Promise<void>
  logDropped: (userId: string, why: string) => void
  // Set when this bridge speaks for exactly one persona (its own bot token, its
  // own Slack app): then a message never has to name anyone.
  bound?: () => Persona | undefined
}

// The payload in full, because the human has to see the concrete action at the
// moment of decision — not a summary of it.
export function cardBody(req: ApprovalRequest, limit = 3000): string {
  return JSON.stringify(req.input ?? {}, null, 2).slice(0, limit)
}

// The rules that must be identical on every platform (FR-18): who may talk,
// who may approve, and what a message means. Platform code below this line
// deals with SDKs; platform code never deals with permission.
export class Bridge {
  private cards = new Map<string, OutboundRef>()

  constructor(
    private transport: BridgeTransport,
    private host: BridgeHost,
  ) {}

  get platform(): string {
    return this.transport.platform
  }

  // Returns false when the sender is not allowed to be here. First contact with
  // no owner yet may pair and nothing else — a bot's handle is public on every
  // one of these platforms, so "a human approved" has to mean a specific human.
  async authenticate(userId: string | undefined, text: string | undefined, reply: (s: string) => Promise<void>): Promise<boolean> {
    if (userId && this.host.owners.isOwner(this.platform, userId)) return true
    if (this.host.owners.count(this.platform) === 0 && text) {
      const code = text.trim().split(/\s+/).pop() ?? ''
      if (userId && this.host.owners.claim(this.platform, code, userId)) {
        await reply('Paired. This account is now the owner — only you can talk to these bots or answer approvals.')
        return false
      }
      await reply('Send the pairing code the daemon printed at startup to claim this bot.')
      return false
    }
    this.host.logDropped(String(userId ?? 'unknown'), `not a paired owner on ${this.platform}`)
    return false
  }

  // One route for every inbound message, whatever carried it: typed, pasted, or
  // transcribed from a voice note.
  async inbound(text: string, chat: string, isPrivate: boolean, reply: (s: string) => Promise<void>): Promise<void> {
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/)
      await this.host.onCommand(cmd.split('@')[0], rest.join(' '), chat, reply)
      return
    }

    // A card is open in this thread and you typed at it: answer the card rather
    // than starting a turn (FR-21). Only text the parser is sure about counts.
    const answered = this.host.queue.answerByText(text, { chat })
    if (answered) {
      await reply(
        answered.amendment
          ? `Sent back for a change: ${answered.amendment}\nYou'll get a new card with the revised ${answered.tool} call.`
          : `${answered.decision === 'allow' ? 'Approved' : 'Denied'} — ${answered.tool}.`,
      )
      return
    }

    const personas = this.host.bound?.() ? [this.host.bound()!] : this.host.personas()
    // Explicit addressing in group chats (FR-35): a bot acts when named. In a
    // 1:1 chat the single bot answers, or the first one if several are loaded.
    const named = personas.find((p) => new RegExp(`(^|\\s)@?${p.id}\\b`, 'i').test(text))
    const persona = named ?? (isPrivate ? personas[0] : undefined)
    if (!persona) {
      if (personas.length) await reply(`Name a bot: ${personas.map((p) => p.id).join(', ')}`)
      return
    }
    await this.host.onMessage(persona, chat, text, reply)
  }

  // A button press. The security-critical check is the same everywhere: it is
  // only an approval if the person pressing it is the owner.
  decide(userId: string | undefined, data: string): { ok: boolean; text: string } {
    if (!userId || !this.host.owners.isOwner(this.platform, userId)) {
      this.host.logDropped(String(userId ?? 'unknown'), `button press from non-owner on ${this.platform}`)
      return { ok: false, text: 'Not your bot.' }
    }
    const [action, id] = data.split(':')
    const decision = action === 'ok' ? 'allow' : 'deny'
    const settled = this.host.queue.settle(id, { decision, source: 'human-tap' })
    this.cards.delete(id)
    return { ok: settled, text: settled ? (decision === 'allow' ? 'Approved' : 'Denied') : 'Already resolved' }
  }

  async ask(req: ApprovalRequest, chat: string): Promise<void> {
    const ref = await this.transport.askApproval(chat, req, cardBody(req))
    if (ref) this.cards.set(req.id, ref)
  }

  // When an approval resolves without a tap (timeout, pause, shutdown) the card
  // must stop showing live buttons.
  async closeCard(id: string, outcome: string): Promise<void> {
    const ref = this.cards.get(id)
    if (!ref) return
    this.cards.delete(id)
    await this.transport.closeCard(ref, outcome).catch(() => {})
  }

  checklist(chat: string, title: string): LiveChecklist {
    return new LiveChecklist(this.transport, chat, title)
  }
}

export type StepStatus = 'run' | 'wait' | 'ok' | 'deny'

// The checklist the user watches while a turn happens, edited in place instead
// of posted as a stream of new messages. Throttled because every one of these
// platforms rate-limits edits — Telegram hardest, at roughly one per second per
// chat — and a bot that trips its own rate limit stops being live at all.
export class LiveChecklist {
  private steps: { name: string; status: StepStatus }[] = []
  private ref?: OutboundRef
  private lastEdit = 0
  private timer?: NodeJS.Timeout
  private closed = false
  // Paints run one at a time. Without this, two updates in flight both see no
  // message yet and both post one, which is how a "live" checklist turns into
  // a wall of near-identical messages.
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private transport: BridgeTransport,
    private chat: string,
    private title: string,
    private throttleMs = 1000,
  ) {}

  add(name: string, status: StepStatus = 'run'): void {
    this.steps.push({ name, status })
    this.schedule()
  }

  mark(name: string, status: StepStatus): void {
    const step = [...this.steps].reverse().find((s) => s.name === name)
    if (step) step.status = status
    else this.steps.push({ name, status })
    this.schedule()
  }

  // Nothing to show means nothing posted: an empty checklist is noise, and the
  // reply says everything anyway. The last paint is forced so the final state
  // always lands, whatever the throttle was holding.
  async finish(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    if (this.steps.length) this.schedule(true)
    await this.chain
  }

  private text(): string {
    const marks: Record<StepStatus, string> = { run: '·', wait: '◷', ok: '✓', deny: '✗' }
    return [this.title, ...this.steps.map((s) => `${marks[s.status]} ${s.name}`)].join('\n')
  }

  private schedule(force = false): void {
    if (this.closed && !force) return
    const wait = this.lastEdit + this.throttleMs - Date.now()
    if (wait > 0 && !force) {
      // Coalesce: one trailing edit rather than a queue of them.
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.schedule(), wait)
      this.timer.unref?.()
      return
    }
    this.lastEdit = Date.now()
    this.chain = this.chain.then(() => this.paint()).catch(() => {
      // A checklist that cannot be drawn must never fail the turn it describes.
    })
  }

  private async paint(): Promise<void> {
    if (!this.ref) this.ref = await this.transport.send(this.chat, this.text())
    else await this.transport.edit(this.ref, this.text())
  }
}
