import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
    private resolveContext: (sessionId: string) => { bot: string; chat: string | null; policy: BotPolicy; paused: boolean },
    private secret: string,
  ) {
    this.server = createServer((req, res) => {
      if (req.url !== `/hook/${this.secret}` || req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      let body = ''
      req.on('data', (c) => {
        if (body.length < 1_000_000) body += c
      })
      req.on('end', async () => {
        let verdict: { decision: 'allow' | 'deny'; reason?: string }
        try {
          const payload = JSON.parse(body)
          const ctx = this.resolveContext(payload.session_id)
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
  writeSettings(dir?: string): string {
    const d = dir ?? mkdtempSync(join(tmpdir(), 'agentda-hook-'))
    const shim = join(d, 'gate.sh')
    const timeoutSec = Math.ceil(this.queue.timeoutMs / 1000) + 30
    writeFileSync(
      shim,
      `#!/bin/sh\nexec curl -sS --max-time ${timeoutSec} -X POST --data-binary @- http://127.0.0.1:${this.port}/hook/${this.secret}\n`,
      { mode: 0o700 },
    )
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
}
