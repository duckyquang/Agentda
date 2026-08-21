import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalQueue } from './approvals'
import type { BotPolicy } from './gate'

// Bridges claude's PreToolUse hook to the ApprovalQueue.
//
// Mechanism note (verified against claude 2.1.206, see docs/adr/0001): the CLI
// has no --permission-prompt-tool; the supported interception point is a
// PreToolUse hook. The CLI runs the hook as a subprocess and WAITS for it, so a
// hook that blocks blocks the tool call — that is what makes a human-in-the-loop
// gate possible at all. The hook itself must be a command, so we ship a tiny
// curl-based shim that POSTs the hook payload to this loopback server and prints
// whatever verdict comes back.
//
// Loopback-only + a per-run secret in the URL path: anything else on the machine
// could otherwise answer approvals.
export class HookServer {
  private server: Server
  private port = 0

  constructor(
    private queue: ApprovalQueue,
    private resolveContext: (sessionId: string, bot?: string) => { bot: string; chat: string | null; policy: BotPolicy; paused: boolean },
    private secret: string,
  ) {
    this.server = createServer((req, res) => {
      // The path carries which provider is asking, because they disagree about
      // how to say yes (see below), and which bot is asking, because the
      // session id cannot answer that.
      //
      // The bot has to come from the URL. A session id is only known to us
      // once a turn produces a result, which is the END of the turn — so on a
      // session's first tool call there is nothing to look it up in, and the
      // fallback used to be "the first bot loaded". A tool from a bot granted
      // nothing, in Ask mode, was then evaluated against another bot's Auto
      // policy, ran unattended, and landed in the audit log under that bot's
      // name. The settings file each turn hands its CLI carries the bot's id,
      // so the gate always knows who is asking.
      const match = req.url?.match(new RegExp(`^/hook/${this.secret}/(claude|codex)(?:/([^/]+))?$`))
      if (!match || req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      const provider = match[1] as 'claude' | 'codex'
      const bot = match[2] ? decodeURIComponent(match[2]) : undefined
      let body = ''
      req.on('data', (c) => {
        if (body.length < 1_000_000) body += c
      })
      req.on('end', async () => {
        let verdict: { decision: 'allow' | 'deny'; reason?: string }
        try {
          const payload = JSON.parse(body)
          const ctx = this.resolveContext(payload.session_id, bot)
          const r = await this.queue.request(
            { bot: ctx.bot, chat: ctx.chat, tool: payload.tool_name, input: payload.tool_input },
            ctx.policy,
            ctx.paused,
          )
          verdict = { decision: r.decision, reason: r.reason }
        } catch (err) {
          // Fail closed: if the gate itself breaks, the tool does not run.
          verdict = { decision: 'deny', reason: `agentda gate error: ${(err as Error).message}` }
        }
        // Codex rejects permissionDecision:"allow" as unsupported: there,
        // approval is expressed by saying nothing and letting the call proceed.
        // Claude wants the explicit allow. Same decision, two dialects.
        // On Codex an approval is expressed as silence, but "silence" is also
        // what a failed shim produces — so the server answers with an explicit
        // ALLOW marker and the shim turns that into silence. Anything else,
        // including a dead server or a broken curl, stays a deny.
        if (provider === 'codex' && verdict.decision === 'allow') {
          res.writeHead(200, { 'content-type': 'text/plain' }).end('AGENTDA_ALLOW')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: verdict.decision,
              permissionDecisionReason: verdict.reason ?? '',
            },
          }),
        )
      })
    })
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as { port: number }).port
    return this.port
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  // Writes the hook shim + a settings file for --settings. Timeout must exceed
  // the approval window or the CLI would cancel the hook out from under the
  // human, silently turning "waiting for you" into a failure.
  // Returns the settings path Claude Code loads with --settings. The shim it
  // writes is also what Codex needs (as a bare command path), so both providers
  // are served from one call — see shimPath().
  writeSettings(dir?: string, provider: 'claude' | 'codex' = 'claude', bot?: string): string {
    const d = dir ?? mkdtempSync(join(tmpdir(), 'agentda-hook-'))
    mkdirSync(d, { recursive: true }) // callers pass a path that may not exist yet
    const shim = join(d, `gate-${provider}.sh`)
    const client = join(d, `gate-${provider}.mjs`)
    const timeoutSec = Math.ceil(this.queue.timeoutMs / 1000) + 30
    // Written per turn, so the bot in the path is the bot whose turn it is.
    const url = `http://127.0.0.1:${this.port}/hook/${this.secret}/${provider}${bot ? `/${encodeURIComponent(bot)}` : ''}`

    // The client is Node rather than curl. Node is guaranteed present (the
    // daemon runs on it) and behaves identically everywhere, whereas curl's
    // handling of a piped body varied enough to hang a turn during testing.
    //
    // FAIL CLOSED: a hook that prints nothing reads as "proceed" to both CLIs,
    // so every failure path — unreachable gate, timeout, malformed reply —
    // prints a deny instead. Learned the hard way: one run where the shim came
    // back empty executed a tool that never reached the queue and never hit the
    // audit log, which is exactly the hole this product exists to close.
    writeFileSync(
      client,
      `const DENY = ${JSON.stringify(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'agentda gate unreachable — denied rather than run ungated',
          },
        }),
      )}
let body = ''
process.stdin.on('data', (c) => (body += c))
process.stdin.on('end', async () => {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), ${timeoutSec * 1000})
    const res = await fetch(${JSON.stringify(url)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ctl.signal,
    })
    clearTimeout(t)
    const text = await res.text()
    if (!res.ok || !text) return process.stdout.write(DENY)
    ${provider === 'codex' ? "if (text === 'AGENTDA_ALLOW') return // approval is silence on codex" : ''}
    process.stdout.write(text)
  } catch {
    process.stdout.write(DENY)
  }
})
`,
      { mode: 0o600 },
    )
    writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(client)}\n`, {
      mode: 0o700,
    })

    const settings = join(d, 'settings.json')
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: shim, timeout: timeoutSec }] }] },
      }),
      { mode: 0o600 },
    )
    return settings
  }

  // Codex takes the hook as a command path rather than a settings file.
  shimPath(dir: string, provider: 'claude' | 'codex' = 'codex', bot?: string): string {
    this.writeSettings(dir, provider, bot)
    return join(dir, `gate-${provider}.sh`)
  }
}
