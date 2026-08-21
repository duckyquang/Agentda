import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { amendmentReason } from '@agentda/core'
import type { ApprovalQueue, ApprovalRequest, Db, Persona, PersonaPatch } from '@agentda/core'

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
  // A voice note from the desktop mic. Same destination as typed text once it
  // has been transcribed — including answering an open approval card.
  voiceNote: (botId: string, audio: Buffer) => Promise<string>
  setMode: (botId: string, mode: 'ask' | 'auto') => void
  pause: (on: boolean) => void
  isPaused: () => boolean
  // Persona management (PLAN Phase 2). The daemon owns the files; the API is
  // just the door the desktop app knocks on.
  createBot: (spec: { id: string; name?: string } & PersonaPatch) => Persona
  updateBot: (botId: string, patch: PersonaPatch) => Persona
  archiveBot: (botId: string) => string
  setToken: (botId: string, token: string) => void
  clearToken: (botId: string) => void
  tokenIds: () => string[]
  // Re-read the bot directories: the files are the truth, and people edit them
  // by hand while the daemon is up.
  reload: () => number
  // Tool packs available to install on a bot, with what each still needs.
  packs: () => { id: string; name: string; description: string; docs?: string; verified?: string; missing: string[]; outbound: string[] }[]
}

// What the browser server is told to do next. Frames flow one way; this is the
// only thing that flows back.
export type BrowserControl = 'take-over' | 'hand-back' | null

const UI_DIR = fileURLToPath(new URL('../../desktop/ui', import.meta.url))

export class ControlApi {
  readonly token = randomBytes(24).toString('hex')
  private server: Server
  private port = 0
  private listeners = new Set<(event: string, data: unknown) => void>()
  // Open SSE responses, so shutdown can end them: server.close() waits for
  // active connections, and an event stream never ends on its own.
  private streams = new Set<import('node:http').ServerResponse>()
  // Per-bot browser control, read by the browser server as it works. Take over
  // stops the bot touching the page and puts the window on screen; hand back
  // gives it to the bot again.
  private browserControl = new Map<string, BrowserControl>()

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

      // The browser asks for this on its own and has no token to offer; a 401
      // here is a red console error on every page load for nothing.
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return void res.writeHead(204).end()

      // EventSource cannot set headers, so the stream authenticates by query
      // param. Same secret either way.
      const presented = req.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('token')
      if (presented !== this.token) return void json(401, { error: 'unauthorized' })

      const botRoute = /^\/api\/bots\/([\w-]+)(\/token)?$/.exec(url.pathname)

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
            ownIdentity: this.deps.tokenIds().includes(p.id),
          })),
          pending: this.deps.pending().map((r) => ({ id: r.id, bot: r.bot, tool: r.tool, input: r.input, reason: r.reason })),
        })
      }

      // Everything the persona editor needs, including the prompt, which is a
      // file rather than a config key.
      if (req.method === 'GET' && botRoute && !botRoute[2]) {
        const p = this.deps.personas().find((x) => x.id === botRoute[1])
        if (!p) return void json(404, { error: 'no such bot' })
        return void json(200, {
          id: p.id,
          name: p.name,
          dir: p.dir,
          mode: p.policy.mode,
          prompt: p.prompt,
          providers: p.providers.map((x) => x.provider),
          model: p.model ?? '',
          allowMeteredFailover: p.allowMeteredFailover,
          agentdaTools: p.agentdaTools,
          browser: p.browser,
          browserSurface: p.browserSurface,
          email: p.email,
          scope: p.scope,
          autoApprove: p.policy.autoApprove,
          alwaysAsk: p.policy.alwaysAsk,
          dailyTurnCap: p.dailyTurnCap ?? null,
          weeklyTurnCap: p.weeklyTurnCap ?? null,
          packs: p.packs,
          packNotices: p.packNotices ?? [],
          routines: p.routines,
          ownIdentity: this.deps.tokenIds().includes(p.id),
        })
      }

      if (req.method === 'GET' && url.pathname === '/api/packs') {
        return void json(200, { packs: this.deps.packs() })
      }

      // Routine history: at-most-once firing is only believable if you can see
      // what actually fired.
      if (req.method === 'GET' && url.pathname === '/api/routines') {
        const bot = url.searchParams.get('bot')
        const rows = bot
          ? this.deps.db
              .prepare('SELECT * FROM routine_runs WHERE bot = ? ORDER BY ran_at DESC LIMIT 100')
              .all(bot)
          : this.deps.db.prepare('SELECT * FROM routine_runs ORDER BY ran_at DESC LIMIT 100').all()
        return void json(200, { rows })
      }

      if (req.method === 'DELETE' && botRoute) {
        if (botRoute[2]) {
          this.deps.clearToken(botRoute[1])
          return void json(200, { ok: true })
        }
        // Archived, not deleted: a bot's memory is the user's own writing.
        try {
          return void json(200, { archivedTo: this.deps.archiveBot(botRoute[1]) })
        } catch (err) {
          return void json(400, { error: (err as Error).message })
        }
      }

      // Bot-screen preview (PLAN Phase 2). The browser runs inside an MCP
      // server the CLI spawned, not in the daemon, so frames come to us rather
      // than us reaching into it. JPEG bytes straight through: re-encoding a
      // screencast frame to JSON would cost more than the frame is worth.
      const previewRoute = /^\/api\/preview\/([\w-]+)(\/control)?$/.exec(url.pathname)
      if (previewRoute && req.method === 'POST' && !previewRoute[2]) {
        // CDP hands us base64 JPEG already, so it travels as-is: decoding it
        // here only to re-encode it for the browser would be work for nobody.
        let jpeg = ''
        for await (const c of req) {
          jpeg += c
          if (jpeg.length > 4_000_000) return void json(413, { error: 'frame too large' })
        }
        // The page renders this straight into an <img src>, so it has to be
        // base64 and nothing else.
        if (!/^[A-Za-z0-9+/=]*$/.test(jpeg)) return void json(400, { error: 'frame must be base64' })
        this.emit('frame', { bot: previewRoute[1], jpeg })
        // The response carries the control state, so a working browser learns
        // it has been taken over on its next frame without a second request.
        return void json(200, { control: this.browserControl.get(previewRoute[1]) ?? null })
      }
      if (previewRoute && previewRoute[2] && req.method === 'GET') {
        return void json(200, { control: this.browserControl.get(previewRoute[1]) ?? null })
      }
      if (previewRoute && previewRoute[2] && req.method === 'POST') {
        const body = await readBody(req)
        const control: BrowserControl = body.control === 'take-over' ? 'take-over' : body.control === 'hand-back' ? 'hand-back' : null
        this.browserControl.set(previewRoute[1], control)
        this.emit('browser-control', { bot: previewRoute[1], control })
        return void json(200, { control })
      }

      if (req.method === 'POST' && url.pathname === '/api/voice') {
        const bot = url.searchParams.get('bot') ?? ''
        const chunks: Buffer[] = []
        let size = 0
        for await (const c of req) {
          size += (c as Buffer).length
          if (size > 25_000_000) return void json(413, { error: 'that recording is too long' })
          chunks.push(c as Buffer)
        }
        try {
          return void json(200, { text: await this.deps.voiceNote(bot, Buffer.concat(chunks)) })
        } catch (err) {
          return void json(400, { error: (err as Error).message })
        }
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
          // An amendment denies this call and hands the model the change to
          // make, so the next card shows a real payload rather than one we
          // edited behind the model's back (FR-21).
          const amending = body.decision === 'amend' && String(body.instruction ?? '').trim()
          const ok = this.deps.queue.settle(
            body.id,
            amending
              ? { decision: 'deny', source: 'human-text', reason: amendmentReason(amending) }
              : { decision: body.decision === 'allow' ? 'allow' : 'deny', source: 'human-tap' },
          )
          return void json(200, { settled: ok })
        }
        if (url.pathname === '/api/mode') {
          this.deps.setMode(body.bot, body.mode === 'auto' ? 'auto' : 'ask')
          return void json(200, { ok: true })
        }
        if (url.pathname === '/api/reload') {
          return void json(200, { bots: this.deps.reload() })
        }
        if (url.pathname === '/api/pause') {
          this.deps.pause(!!body.on)
          return void json(200, { paused: this.deps.isPaused() })
        }
        if (url.pathname === '/api/send') {
          this.deps.send(body.bot, String(body.text ?? ''))
          return void json(202, { accepted: true })
        }
        if (url.pathname === '/api/bots') {
          try {
            return void json(200, { bot: this.deps.createBot(body).id })
          } catch (err) {
            return void json(400, { error: (err as Error).message })
          }
        }
        if (botRoute) {
          try {
            if (botRoute[2]) {
              // The token never comes back out of this API — it goes in and
              // stays in the 0600 registry.
              this.deps.setToken(botRoute[1], String(body.token ?? ''))
              return void json(200, { ok: true })
            }
            this.deps.updateBot(botRoute[1], body as PersonaPatch)
            return void json(200, { ok: true })
          } catch (err) {
            return void json(400, { error: (err as Error).message })
          }
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

  // Handed to each bot's browser server so it knows where to send frames.
  previewUrl(botId: string): string {
    return `http://127.0.0.1:${this.port}/api/preview/${botId}?token=${this.token}`
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
