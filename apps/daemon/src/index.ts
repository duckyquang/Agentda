import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ApprovalQueue,
  archivePersona,
  createPersona,
  HookServer,
  loadPersonas,
  openDb,
  Owners,
  type Persona,
  Scheduler,
  SessionStore,
  tryHandoff,
  setPersonaMode,
  TokenStore,
  updatePersona,
  TurnRunner,
  voiceConfigFromEnv,
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
// Bot tokens live here rather than in bot.toml: a bot directory is meant to be
// copied and shared, a token is a password.
const tokens = new TokenStore(join(home, 'telegram.json'))
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
    // Only real Telegram chat ids go to Telegram. A desktop turn carries
    // `desktop:<bot>`, and sending to that id makes the API reject and, being
    // unawaited, take the daemon down with it.
    const chat = isTelegramChat(req.chat) ? req.chat : chatFor.get(req.bot)
    if (chat) void bridgeFor(req.bot)?.ask(req, chat).catch((e: Error) => console.warn(`telegram ask failed: ${e.message}`))
  },
  onResolved: (req, r) => {
    openApprovals.delete(req.id)
    api?.emit('resolved', { id: req.id, decision: r.decision, source: r.source })
    if (r.source !== 'human-tap') void bridgeFor(req.bot)?.closeCard(req.id, `${r.decision} (${r.source})`)
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
  isPaused: () => paused,
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
  createBot: (spec) => {
    const p = createPersona(botsDir, spec)
    personas = loadPersonas(botsDir)
    api.emit('bots', { changed: p.id })
    return p
  },
  updateBot: (botId, patch) => {
    const p = personas.find((x) => x.id === botId)
    if (!p) throw new Error(`no bot named ${botId}`)
    const next = updatePersona(p, patch)
    personas = loadPersonas(botsDir)
    api.emit('bots', { changed: botId })
    return next
  },
  archiveBot: (botId) => {
    const p = personas.find((x) => x.id === botId)
    if (!p) throw new Error(`no bot named ${botId}`)
    const dest = archivePersona(botsDir, p)
    tokens.remove(botId)
    personas = loadPersonas(botsDir)
    syncBridges()
    api.emit('bots', { changed: botId })
    return dest
  },
  setToken: (botId, token) => {
    if (!personas.some((x) => x.id === botId)) throw new Error(`no bot named ${botId}`)
    tokens.set(botId, token)
    syncBridges()
    api.emit('bots', { changed: botId })
  },
  clearToken: (botId) => {
    tokens.remove(botId)
    syncBridges()
    api.emit('bots', { changed: botId })
  },
  tokenIds: () => tokens.ids(),
  send: (botId, text) => {
    const p = personas.find((x) => x.id === botId)
    if (!p) return api.emit('message-out', { bot: botId, text: `no bot named ${botId}` })
    // Same rule as chat: type "yes" at an open card and it answers the card
    // (FR-21). The desktop has buttons too, but the composer is where your
    // hands already are.
    const answered = queue.answerByText(text, { chat: `desktop:${botId}` })
    if (answered) {
      return api.emit('message-out', {
        bot: p.id,
        text: answered.amendment
          ? `Sent back for a change: ${answered.amendment} — expect a revised ${answered.tool} card.`
          : `${answered.decision === 'allow' ? 'Approved' : 'Denied'} — ${answered.tool}.`,
      })
    }
    // Deliberately not awaited: the turn may pause on an approval for as long
    // as the human takes, and the UI shows that card meanwhile. Same path as a
    // chat message, so the desktop gets handoffs and provider notices too.
    void runTurn(p, `desktop:${botId}`, text, text).catch((err) =>
      api.emit('message-out', { bot: p.id, text: `error: ${(err as Error).message}` }),
    )
  },
})
await api.listen()
console.log(`desktop UI at ${api.url()}`)

// One bridge per Telegram identity (PLAN Phase 2). A persona with its own
// BotFather token speaks under its own name and avatar; everything else shares
// the daemon's token. Owner pairing is per Telegram account, not per bot, so a
// new token needs no new pairing — the same human is already trusted.
type Bridge = ReturnType<typeof createBridge>
const SHARED = ''
const bridges = new Map<string, Bridge>()

const bridgeFor = (botId: string): Bridge | undefined => bridges.get(botId) ?? bridges.get(SHARED)

function startBridge(key: string, botToken: string, bound?: string): void {
  const bridge = createBridge({
    token: botToken,
    owners,
    queue,
    voice: voiceConfigFromEnv(),
    // A bound bridge only ever speaks for its own persona, so a message to it
    // never has to name anyone.
    personas: () => (bound ? personas.filter((p) => p.id === bound) : personas),
    logDropped: (userId, why) => console.warn(`dropped update from ${userId}: ${why}`),
    onMessage: async (persona, chat, text) => {
      await runTurn(persona, chat, stripAddress(text, persona), text)
    },
    onCommand: async (cmd, args, chat, reply) => handleCommand(cmd, args, chat, reply),
  })
  bridges.set(key, bridge)
  void bridge.bot
    .start({ drop_pending_updates: true, onStart: (me) => console.log(`${bound ?? 'shared'} bridge live as @${me.username}`) })
    .catch((err) => {
      bridges.delete(key)
      const e = err as { error_code?: number; message: string }
      console.error(
        e.error_code === 401
          ? `Telegram rejected the token for ${bound ?? 'the shared bridge'}. Check it against what @BotFather gave you.`
          : e.error_code === 409
            ? `Another process is already polling the token for ${bound ?? 'the shared bridge'} — stop the other daemon first.`
            : `Telegram bridge (${bound ?? 'shared'}) failed: ${e.message}`,
      )
    })
}

// Starts bridges for newly-tokened personas and stops ones whose token was
// removed. Called at boot and whenever a token or the persona list changes.
function syncBridges(): void {
  for (const p of personas) {
    const t = tokens.get(p.id)
    if (t && !bridges.has(p.id)) startBridge(p.id, t, p.id)
  }
  for (const [key, bridge] of bridges) {
    if (key === SHARED) continue
    if (!tokens.get(key) || !personas.some((p) => p.id === key)) {
      bridges.delete(key)
      void bridge.bot.stop().catch(() => {})
    }
  }
}

// Telegram is optional: without any token the daemon still serves the desktop
// app, which is the whole point of not coupling them.
const sharedToken = process.env.TELEGRAM_BOT_TOKEN
if (sharedToken) startBridge(SHARED, sharedToken)
syncBridges()
if (!bridges.size) {
  console.log('no Telegram token — running desktop-only (add one from @BotFather in the app, or set TELEGRAM_BOT_TOKEN)')
}

// Whatever the bot says, said by the right identity: its own bridge when it has
// one, the shared bridge otherwise, and the desktop app either way.
async function say(persona: Persona, chat: string, text: string): Promise<void> {
  if (!text) return
  api.emit('message-out', { bot: persona.id, text })
  if (!isTelegramChat(chat)) return
  const bot = bridgeFor(persona.id)?.bot
  if (!bot) return
  for (let i = 0; i < text.length; i += 4000) {
    await bot.api.sendMessage(chat, text.slice(i, i + 4000)).catch((e) => console.warn(`telegram send failed: ${e.message}`))
  }
}

async function handleCommand(cmd: string, args: string, chat: string, reply: (s: string) => Promise<void>): Promise<void> {
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
    return reply(
      personas
        .map((p) => `${p.id} — ${p.policy.mode}${paused ? ' (paused)' : ''}${tokens.get(p.id) ? ' · own identity' : ''}`)
        .join('\n'),
    )
  }
  if (cmd === 'routines') {
    return reply(
      personas.flatMap((p) => p.routines.map((r) => `${p.id}/${r.id} ${r.cron} ${r.enabled ? '' : '(disabled)'}`)).join('\n') ||
        'no routines',
    )
  }
  if (cmd === 'reload') {
    personas = loadPersonas(botsDir)
    syncBridges()
    return reply(`reloaded ${personas.length} bot(s)`)
  }
  return reply('commands: /bots /mode <bot> ask|auto /pause /resume /audit /routines /reload')
}

const scheduler = new Scheduler(
  db,
  () => personas,
  async (persona, _routineId, prompt) => {
    const chat = chatFor.get(persona.id) ?? lastKnownChat()
    if (!chat) return
    const res = await runner.run(persona, chat, prompt, { scheduled: true })
    const body = res.skipped ? `(routine skipped: ${res.skipped})` : res.error ? `routine error: ${res.error.message}` : res.text
    if (body) await say(persona, chat, body)
  },
)

const isTelegramChat = (chat: string | null | undefined): chat is string => !!chat && /^-?\d+$/.test(chat)

function lastKnownChat(): string | undefined {
  return chatFor.values().next().value
}

// One turn, plus the handoff chain it may start. A bot ends its turn with
// `@other: do X` to pass work along; every hop is visible in the thread and
// counted against the per-task cap, so two bots cannot ping-pong forever.
async function runTurn(persona: Persona, chat: string, input: string, task: string): Promise<void> {
  chatFor.set(persona.id, chat)
  const res = await runner.run(persona, chat, input, {
    onEvent: (e) => {
      if (e.type === 'result') sessionOwner.set(e.sessionId, persona.id)
    },
  })
  for (const n of res.notices ?? []) await say(persona, chat, n) // e.g. a provider switch
  if (res.skipped) return say(persona, chat, `(skipped: ${res.skipped})`)
  if (res.error) return say(persona, chat, `${res.error.kind}: ${res.error.hint ?? res.error.message}`)
  await say(persona, chat, res.text || '(no reply)')
  if (res.memoryNotice) await say(persona, chat, res.memoryNotice)

  const next = parseHandoff(res.text)
  if (!next) return
  const target = personas.find((p) => p.id.toLowerCase() === next.to.toLowerCase())
  if (!target || target.id === persona.id) return
  const gate = tryHandoff(db, { chat, task, from: persona.id, to: target.id, note: next.note })
  if (!gate.ok) return say(persona, chat, `↪︎ ${gate.reason}`)
  await say(persona, chat, `↪︎ handing this to ${target.id}`)
  // The receiving bot answers through its own bridge, so a handoff in a group
  // chat reads as two bots talking rather than one bot narrating both sides.
  await runTurn(target, chat, `${persona.id} handed this to you: ${next.note}`, task)
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

if (bridges.size && owners.count('telegram') === 0) {
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
  await Promise.all([...bridges.values()].map((b) => b.bot.stop().catch(() => {})))
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
// Bridges poll on their own; the daemon stays up for the desktop app and the
// scheduler until a signal arrives.
await new Promise(() => {})
