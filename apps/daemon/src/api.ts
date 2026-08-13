import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApprovalQueue, ApprovalRequest, Db, Persona } from '@agentda/core'

// Loopback-only control API for the desktop app.
//
// Bound to 127.0.0.1 and gated on a per-run bearer token: anything else on the
// machine could otherwise read the audit log and, worse, answer approvals.
// Same reasoning as the gate's own server.
export interface ApiDeps {
  db: Db
  queue: ApprovalQueue
  personas: () => Persona[]
  pending: () => ApprovalRequest[]
  // Fire-and-forget: a turn can wait minutes on a human, so the reply comes
  // back over the event stream rather than holding an HTTP request open.
  send: (botId: string, text: string) => void
  setMode: (botId: string, mode: 'ask' | 'auto') => void
  pause: (on: boolean) => void
  isPaused: () => boolean
}

const UI_DIR = fileURLToPath(new URL('../../desktop/ui', import.meta.url))

export class ControlApi {
  readonly token = randomBytes(24).toString('hex')
  private server: Server
  private port = 0
  private listeners = new Set<(event: string, data: unknown) => void>()

  constructor(private deps: ApiDeps) {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const json = (code: number, body: unknown) =>
        res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))

      // The UI itself is unauthenticated (it is just markup); every data route
      // is not. The token rides in the URL for the initial page load so the
      // app can hand it to the page without a login screen.
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        try {
          const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8').replace('__AGENTDA_TOKEN__', this.token)
          return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
        } catch {
          return res.writeHead(404).end('desktop UI not found')
        }
      }

      if (req.headers.authorization !== `Bearer ${this.token}`) return json(401, { error: 'unauthorized' })

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(200, {
          paused: this.deps.isPaused(),
          bots: this.deps.personas().map((p) => ({
            id: p.id,
            name: p.name,
            mode: p.policy.mode,
            provider: p.provider,
            providers: p.providers.map((x) => x.provider),
            tools: { browser: p.browser, email: p.email, memory: p.agentdaTools },
          })),
          pending: this.deps.pending().map((r) => ({ id: r.id, bot: r.bot, tool: r.tool, input: r.input, reason: r.reason })),
        })
      }

      if (req.method === 'GET' && url.pathname === '/api/audit') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 1000)
        const bot = url.searchParams.get('bot')
        const rows = bot
          ? this.deps.db.prepare('SELECT * FROM audit_log WHERE bot = ? ORDER BY id DESC LIMIT ?').all(bot, limit)
          : this.deps.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
        return json(200, { rows })
      }

      if (req.method === 'POST') {
        const body = await readBody(req)
        if (url.pathname === '/api/approve') {
          const ok = this.deps.queue.settle(body.id, {
            decision: body.decision === 'allow' ? 'allow' : 'deny',
            source: 'human-tap',
          })
          return json(200, { settled: ok })
        }
        if (url.pathname === '/api/mode') {
          this.deps.setMode(body.bot, body.mode === 'auto' ? 'auto' : 'ask')
          return json(200, { ok: true })
        }
        if (url.pathname === '/api/pause') {
          this.deps.pause(!!body.on)
          return json(200, { paused: this.deps.isPaused() })
        }
        if (url.pathname === '/api/send') {
          this.deps.send(body.bot, String(body.text ?? ''))
          return json(202, { accepted: true })
        }
      }

      // Server-sent events: the UI learns about approvals and replies without
      // polling. SSE rather than WebSocket because this is one-way and it is
      // three lines of client code.
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(': connected\n\n') // flush headers so the client knows it is live
        const push = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        this.listeners.add(push)
        req.on('close', () => this.listeners.delete(push))
        return
      }

      json(404, { error: 'not found' })
    })
  }

  emit(event: string, data: unknown): void {
    for (const l of this.listeners) {
      try {
        l(event, data)
      } catch {
        // a dead client must not take the daemon down
      }
    }
  }

  async listen(preferred = Number(process.env.AGENTDA_API_PORT ?? 4599)): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(preferred, '127.0.0.1', resolve)
    })
    this.port = (this.server.address() as { port: number }).port
    return this.port
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/?token=${this.token}`
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}

async function readBody(req: { on: (e: string, f: (c?: unknown) => void) => void }): Promise<any> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      if (raw.length < 1_000_000) raw += c
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}
