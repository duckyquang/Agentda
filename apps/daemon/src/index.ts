import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ApprovalQueue,
  HookServer,
  loadPersonas,
  openDb,
  Owners,
  type Persona,
  Scheduler,
  SessionStore,
  tryHandoff,
  setPersonaMode,
  TurnRunner,
} from '@agentda/core'
import { ClaudeAdapter } from '@agentda/provider-claude'
import { CodexAdapter } from '@agentda/provider-codex'
import { AnthropicClient, ApiAdapter, GeminiClient, OpenAICompatClient } from '@agentda/provider-api'
import { ControlApi } from './api'
import { createBridge } from './telegram'

const home = process.env.AGENTDA_HOME ?? join(homedir(), '.agentda')
const db = openDb(join(home, 'agentda.db'))
const sessions = new SessionStore(join(home, 'agentda.db'))
const owners = new Owners(db)
const botsDir = process.env.AGENTDA_BOTS ?? join(home, 'bots')

let personas = loadPersonas(botsDir)
if (!personas.length) {
  console.error(`no bots found in ${botsDir} — create one with a bot.toml (see docs/quickstart.md)`)
  process.exit(1)
}

// One global pause switch that drops every bot back to Ask instantly (FR-44).
let paused = false
const chatFor = new Map<string, string>() // botId -> last chat, so approvals reach the right thread

// Open approvals, so a desktop client that connects mid-wait still sees them.
const openApprovals = new Map<string, any>()

const queue = new ApprovalQueue(db, {
  timeoutMs: Number(process.env.AGENTDA_APPROVAL_TIMEOUT_MS ?? 30 * 60_000),
  ask: (req) => {
    openApprovals.set(req.id, req)
    api?.emit('approval', { id: req.id, bot: req.bot, tool: req.tool, input: req.input, reason: req.reason })
    const chat = req.chat ?? chatFor.get(req.bot)
    if (chat) void bridge?.ask(req, chat)
  },
  onResolved: (req, r) => {
    openApprovals.delete(req.id)
    api?.emit('resolved', { id: req.id, decision: r.decision, source: r.source })
    if (r.source !== 'human-tap') void bridge?.closeCard(req.id, `${r.decision} (${r.source})`)
  },
})

// The hook payload identifies the provider session, not the bot, so we record
// which bot owns which session as turns produce results.
const sessionOwner = new Map<string, string>()

const hook = new HookServer(
  queue,
  (sessionId) => {
    const bot = sessionOwner.get(sessionId) ?? personas[0].id
    const p = personas.find((x) => x.id === bot) ?? personas[0]
    return { bot: p.id, chat: chatFor.get(p.id) ?? null, policy: p.policy, paused }
  },
  randomBytes(16).toString('hex'),
)

const port = await hook.listen()
const settingsPath = hook.writeSettings(join(home, 'run'))
console.log(`gate listening on 127.0.0.1:${port}`)

// The MCP server runs as a stdio child of the CLI. Spawned through tsx so it
// runs from source like the rest of the workspace (no build step yet).
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const mcpServerEntry = join(repoRoot, 'packages/mcp-agentda/src/index.ts')
const tsxLoader = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')
const runner = new TurnRunner({
  db,
  sessions,
  queue,
  hook,
  adapters: buildAdapters(),
  settingsPath,
  codexShim: hook.shimPath(join(home, 'run'), 'codex'),
  guardrails: { perWindow: Number(process.env.AGENTDA_TURNS_PER_WINDOW ?? 60) },
  mcpEntries: (p) => ({
    ...(p.agentdaTools && {
      agentda: {
        command: process.execPath,
        args: [tsxLoader, join(repoRoot, 'packages/mcp-agentda/src/index.ts')],
        env: { AGENTDA_BOT_DIR: p.dir, AGENTDA_SCOPE: p.scope.join(':') },
      },
    }),
    ...(p.email && {
      email: {
        command: process.execPath,
        args: [tsxLoader, join(repoRoot, 'packages/mcp-email/src/index.ts')],
        // Mailbox credentials come from the daemon's environment, never from
        // bot files on disk.
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k.startsWith('AGENTDA_IMAP_') || k.startsWith('AGENTDA_SMTP_')),
        ) as Record<string, string>,
      },
    }),
    ...(p.browser && {
      browser: {
        command: process.execPath,
        args: [tsxLoader, join(repoRoot, 'packages/mcp-browser/src/index.ts')],
        env: {
          AGENTDA_BROWSER_PROFILE: join(p.dir, 'browser-profile'),
          AGENTDA_BROWSER_SURFACE: p.browserSurface,
        },
      },
    }),
  }),
})

// API providers register only when their key is present, so a bot naming one
// it cannot reach fails with "no adapter" rather than a confusing auth error.
function buildAdapters(): Map<string, any> {
  const m = new Map<string, any>([
    ['claude', new ClaudeAdapter()],
    ['codex', new CodexAdapter()],
  ])
  const model = (fallback: string) => process.env.AGENTDA_API_MODEL ?? fallback
  if (process.env.ANTHROPIC_API_KEY) {
    m.set('anthropic-api', new ApiAdapter(new AnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY, model: model('claude-sonnet-5') }), 'anthropic-api'))
  }
  if (process.env.OPENAI_API_KEY) {
    m.set('openai-api', new ApiAdapter(new OpenAICompatClient('openai-api', { baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, model: model('gpt-5.2') }), 'openai-api'))
  }
  if (process.env.XAI_API_KEY) {
    m.set('xai-api', new ApiAdapter(new OpenAICompatClient('xai-api', { baseUrl: 'https://api.x.ai/v1', apiKey: process.env.XAI_API_KEY, model: model('grok-4') }), 'xai-api'))
  }
  if (process.env.GEMINI_API_KEY) {
    m.set('gemini-api', new ApiAdapter(new GeminiClient({ apiKey: process.env.GEMINI_API_KEY, model: model('gemini-3-pro') }), 'gemini-api'))
  }
  // Local models cost nothing and need no key, so they are always available if
  // the user points at an Ollama server.
  m.set('ollama', new ApiAdapter(new OpenAICompatClient('ollama', {
    baseUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/v1',
    model: process.env.OLLAMA_MODEL ?? 'llama3.1:8b',
  }), 'ollama'))
  return m
}

const api = new ControlApi({
  db,
  queue,
  personas: () => personas,
  pending: () => [...openApprovals.values()],
  setMode: (botId, mode) => {
    const p = personas.find((x) => x.id === botId)
    if (p) setPersonaMode(p, mode)
  },
  pause: (on) => {
    paused = on
    if (on) queue.denyAll('paused by the owner')
  },
  isPaused: () => paused,
  send: (botId, text) => {
    const p = personas.find((x) => x.id === botId)
    if (!p) return api.emit('message-out', { bot: botId, text: `no bot named ${botId}` })
    // Deliberately not awaited: the turn may pause on an approval for as long
    // as the human takes, and the UI shows that card meanwhile.
    void runner
      .run(p, `desktop:${botId}`, text, {
        onEvent: (e) => {
          if (e.type === 'result') sessionOwner.set(e.sessionId, p.id)
        },
      })
      .then((res) => {
        const body = [
          ...(res.notices ?? []),
          res.skipped ? `(skipped: ${res.skipped})` : '',
          res.error ? `${res.error.kind}: ${res.error.hint ?? res.error.message}` : res.text,
          res.memoryNotice ?? '',
        ]
          .filter(Boolean)
          .join('\n\n')
        api.emit('message-out', { bot: p.id, text: body || '(no reply)' })
      })
      .catch((err) => api.emit('message-out', { bot: p.id, text: `error: ${(err as Error).message}` }))
  },
})
await api.listen()
console.log(`desktop UI at ${api.url()}`)

// Telegram is optional: without a token the daemon still serves the desktop
// app, which is the whole point of not coupling them.
const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.log('TELEGRAM_BOT_TOKEN not set — running desktop-only (get a token from @BotFather to add chat)')
}

const bridge = token ? createBridge({
  token,
  owners,
  queue,
  personas: () => personas,
  logDropped: (userId, why) => console.warn(`dropped update from ${userId}: ${why}`),
  onMessage: async (persona, chat, text, reply) => {
    await runTurn(persona, chat, stripAddress(text, persona), reply, text)
  },
  onCommand: async (cmd, args, chat, reply) => {
    if (cmd === 'mode') {
      const [botId, mode] = args.split(/\s+/)
      const p = personas.find((x) => x.id === botId)
      if (!p || (mode !== 'ask' && mode !== 'auto')) return reply('usage: /mode <bot> ask|auto')
      setPersonaMode(p, mode)
      return reply(
        mode === 'auto'
          ? `${p.id} is now in AUTO mode. It will run gated actions without asking, except: ${p.policy.alwaysAsk.join(', ')}. Everything is still audited, budgets still apply, and /pause drops it back to Ask.`
          : `${p.id} is back in ASK mode.`,
      )
    }
    if (cmd === 'pause') {
      paused = true
      queue.denyAll('paused by the owner')
      return reply('Paused: every bot is back to Ask, and pending approvals were denied.')
    }
    if (cmd === 'resume') {
      paused = false
      return reply('Resumed: bots use their own modes again.')
    }
    if (cmd === 'audit') {
      const rows = db
        .prepare('SELECT ts, bot, tool, decision, source, mode FROM audit_log ORDER BY id DESC LIMIT 15')
        .all() as any[]
      return reply(
        rows.length
          ? rows.map((r) => `${r.ts} ${r.bot} ${r.tool} → ${r.decision} (${r.source}, ${r.mode})`).join('\n')
          : 'audit log is empty',
      )
    }
    if (cmd === 'bots') {
      return reply(personas.map((p) => `${p.id} — ${p.policy.mode}${paused ? ' (paused)' : ''}`).join('\n'))
    }
    if (cmd === 'routines') {
      return reply(
        personas.flatMap((p) => p.routines.map((r) => `${p.id}/${r.id} ${r.cron} ${r.enabled ? '' : '(disabled)'}`)).join('\n') ||
          'no routines',
      )
    }
    if (cmd === 'reload') {
      personas = loadPersonas(botsDir)
      return reply(`reloaded ${personas.length} bot(s)`)
    }
    return reply('commands: /bots /mode <bot> ask|auto /pause /resume /audit /routines /reload')
  },
}) : undefined

const scheduler = new Scheduler(
  db,
  () => personas,
  async (persona, _routineId, prompt) => {
    const chat = chatFor.get(persona.id) ?? lastKnownChat()
    if (!chat) return
    const res = await runner.run(persona, chat, prompt, { scheduled: true })
    const body = res.skipped ? `(routine skipped: ${res.skipped})` : res.error ? `routine error: ${res.error.message}` : res.text
    if (body) await bridge?.bot.api.sendMessage(chat, `[${persona.id}] ${body}`.slice(0, 4000))
  },
)

function lastKnownChat(): string | undefined {
  return chatFor.values().next().value
}

// One turn, plus the handoff chain it may start. A bot ends its turn with
// `@other: do X` to pass work along; every hop is visible in the thread and
// counted against the per-task cap, so two bots cannot ping-pong forever.
async function runTurn(
  persona: Persona,
  chat: string,
  input: string,
  reply: (s: string) => Promise<void>,
  task: string,
  depth = 0,
): Promise<void> {
  chatFor.set(persona.id, chat)
  const res = await runner.run(persona, chat, input, {
    onEvent: (e) => {
      if (e.type === 'result') sessionOwner.set(e.sessionId, persona.id)
    },
  })
  for (const n of res.notices ?? []) await reply(n) // e.g. a provider switch
  if (res.skipped) return reply(`(${persona.id} skipped: ${res.skipped})`)
  if (res.error) return reply(`${persona.id} — ${res.error.kind}: ${res.error.hint ?? res.error.message}`)
  await reply(res.text || '(no reply)')
  if (res.memoryNotice) await reply(res.memoryNotice)

  const next = parseHandoff(res.text)
  if (!next) return
  const target = personas.find((p) => p.id.toLowerCase() === next.to.toLowerCase())
  if (!target || target.id === persona.id) return
  const gate = tryHandoff(db, { chat, task, from: persona.id, to: target.id, note: next.note })
  if (!gate.ok) return reply(`↪︎ ${gate.reason}`)
  await reply(`↪︎ ${persona.id} → ${target.id}`)
  await runTurn(target, chat, `${persona.id} handed this to you: ${next.note}`, reply, task, depth + 1)
}

// A handoff is the last line of a reply: "@scout: check these three names".
function parseHandoff(text: string): { to: string; note: string } | undefined {
  const line = text.trim().split('\n').filter(Boolean).pop() ?? ''
  const m = /^@([\w-]+)\s*[::]\s*(.+)$/.exec(line.trim())
  return m ? { to: m[1], note: m[2] } : undefined
}

function stripAddress(text: string, p: Persona): string {
  return text.replace(new RegExp(`(^|\\s)@?${p.id}\\b[:,]?`, 'i'), ' ').trim() || text
}

if (token && owners.count('telegram') === 0) {
  const code = owners.mintCode('telegram')
  console.log(`\nPAIRING CODE: ${code}\nDM this code to your bot on Telegram to claim it. Until then it answers nobody.\n`)
}

let shuttingDown = false
const shutdown = async (code = 0) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\nshutting down…')
  scheduler.stop()
  queue.denyAll('daemon shutting down') // never leave a turn blocked on a dead daemon
  await bridge?.bot.stop().catch(() => {})
  await hook.close().catch(() => {})
  await api.close().catch(() => {})
  db.close()
  process.exit(code)
}
// Registered BEFORE start(): grammY's start() promise does not resolve while
// polling, so anything after it never runs and Ctrl-C would kill the daemon
// with approvals still parked and the db mid-write.
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

scheduler.start()
try {
  if (bridge) {
    await bridge.bot.start({ drop_pending_updates: true, onStart: (me) => console.log(`bridge live as @${me.username}`) })
  } else {
    // Desktop-only: nothing to poll, so just stay up until a signal.
    await new Promise(() => {})
  }
} catch (err) {
  const e = err as { error_code?: number; message: string }
  console.error(
    e.error_code === 401
      ? 'Telegram rejected the token. Check TELEGRAM_BOT_TOKEN against what @BotFather gave you.'
      : e.error_code === 409
        ? 'Another process is already polling this bot token — stop the other daemon first.'
        : `Telegram bridge failed: ${e.message}`,
  )
  await shutdown(1)
}
