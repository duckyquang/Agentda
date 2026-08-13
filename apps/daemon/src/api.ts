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
  // Open SSE responses, so shutdown can end them: server.close() waits for
  // active connections, and an event stream never ends on its own.
  private streams = new Set<import('node:http').ServerResponse>()

  constructor(private deps: ApiDeps) {
    this.server = createServer((req, res) => void this.handle(req, res).catch((err) => {
      // A thrown handler must answer the request and leave the daemon standing.
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      } catch {
        // client already gone
      }
    }))
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const json = (code: number, body: unknown) =>
        res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))

      // Only loopback names may talk to us. Without this a page on the open
      // internet could DNS-rebind to 127.0.0.1, read the token off `/`, and
      // then answer approvals — the gate's own server avoids this with a random
      // port plus a path secret, and this one needs the equivalent.
      const host = (req.headers.host ?? '').split(':')[0]
      if (host && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
        return void json(403, { error: 'loopback only' })
      }

      // The UI itself is unauthenticated (it is just markup); every data route
      // is not. The token rides in the URL for the initial page load so the
      // app can hand it to the page without a login screen.
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        try {
          const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8').replace('__AGENTDA_TOKEN__', this.token)
          return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
        } catch {
          return void res.writeHead(404).end('desktop UI not found')
        }
      }

      // EventSource cannot set headers, so the stream authenticates by query
      // param. Same secret either way.
      const presented = req.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('token')
      if (presented !== this.token) return void json(401, { error: 'unauthorized' })

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return void json(200, {
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
        const asked = Number(url.searchParams.get('limit') ?? 100)
        // A non-numeric or negative limit must not reach SQLite: it throws a
        // datatype mismatch that would otherwise take the daemon down.
        const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 1000) : 100
        const bot = url.searchParams.get('bot')
        const rows = bot
          ? this.deps.db.prepare('SELECT * FROM audit_log WHERE bot = ? ORDER BY id DESC LIMIT ?').all(bot, limit)
          : this.deps.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
        return void json(200, { rows })
      }

      if (req.method === 'POST') {
        const body = await readBody(req)
        if (url.pathname === '/api/approve') {
          const ok = this.deps.queue.settle(body.id, {
            decision: body.decision === 'allow' ? 'allow' : 'deny',
            source: 'human-tap',
          })
          return void json(200, { settled: ok })
        }
        if (url.pathname === '/api/mode') {
          this.deps.setMode(body.bot, body.mode === 'auto' ? 'auto' : 'ask')
          return void json(200, { ok: true })
        }
        if (url.pathname === '/api/pause') {
          this.deps.pause(!!body.on)
          return void json(200, { paused: this.deps.isPaused() })
        }
        if (url.pathname === '/api/send') {
          this.deps.send(body.bot, String(body.text ?? ''))
          return void json(202, { accepted: true })
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
        this.streams.add(res)
        req.on('close', () => {
          this.listeners.delete(push)
          this.streams.delete(res)
        })
        return
      }

      json(404, { error: 'not found' })
    }
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
    // If the preferred port is taken (another daemon, or anything else), take
    // any free one rather than refusing to start.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE') return reject(err)
        this.server.listen(0, '127.0.0.1', resolve)
      }
      this.server.once('error', onError)
      this.server.listen(preferred, '127.0.0.1', () => {
        this.server.off('error', onError)
        resolve()
      })
    })
    this.port = (this.server.address() as { port: number }).port
    return this.port
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/?token=${this.token}`
  }

  close(): Promise<void> {
    for (const s of this.streams) s.end()
    this.streams.clear()
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
