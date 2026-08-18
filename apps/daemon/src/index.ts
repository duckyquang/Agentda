import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ApprovalQueue,
  type ApprovalRequest,
  archivePersona,
  createPersona,
  HookServer,
  type LiveChecklist,
  loadPacks,
  loadPersonas,
  missingEnv,
  openDb,
  Owners,
  parseHandoffs,
  type Persona,
  Scheduler,
  SessionStore,
  setPersonaMode,
  TokenStore,
  transcribe,
  tryHandoff,
  TurnRunner,
  updatePersona,
  voiceConfigFromEnv,
  withPacks,
} from '@agentda/core'
import { ClaudeAdapter } from '@agentda/provider-claude'
import { CodexAdapter } from '@agentda/provider-codex'
import { AnthropicClient, ApiAdapter, GeminiClient, OpenAICompatClient } from '@agentda/provider-api'
import { ControlApi } from './api'
import { createDiscordBridge } from './discord'
import { createSlackBridge } from './slack'
import { createBridge } from './telegram'

const home = process.env.AGENTDA_HOME ?? join(homedir(), '.agentda')
const db = openDb(join(home, 'agentda.db'))
const sessions = new SessionStore(join(home, 'agentda.db'))
const owners = new Owners(db)
// Bot tokens live here rather than in bot.toml: a bot directory is meant to be
// copied and shared, a token is a password.
const tokens = new TokenStore(join(home, 'telegram.json'))
const botsDir = process.env.AGENTDA_BOTS ?? join(home, 'bots')
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

// Packs ship with the repo and can be added per user; a user copy of the same
// id wins.
const packDirs = [join(repoRoot, 'packs'), join(home, 'packs')]

// Bots are always loaded with their packs attached, so nothing downstream has
// to remember to do it.
const readPersonas = () => {
  const packs = loadPacks(...packDirs)
  return loadPersonas(botsDir).map((p) => {
    const withThem = withPacks(p, packs)
    for (const n of withThem.packNotices ?? []) console.warn(`${p.id}: ${n}`)
    return withThem
  })
}

let personas = readPersonas()
if (!personas.length) {
  console.error(`no bots found in ${botsDir} — create one with a bot.toml (see docs/quickstart.md)`)
  process.exit(1)
}

// One global pause switch that drops every bot back to Ask instantly (FR-44).
let paused = false
const chatFor = new Map<string, string>() // botId -> last chat, so approvals reach the right thread

// Open approvals, so a desktop client that connects mid-wait still sees them.
const openApprovals = new Map<string, any>()
// The edit-in-place checklist a chat sees while a turn runs, one per bot.
const liveLists = new Map<string, LiveChecklist>()

const queue = new ApprovalQueue(db, {
  timeoutMs: Number(process.env.AGENTDA_APPROVAL_TIMEOUT_MS ?? 30 * 60_000),
  ask: (req) => {
    openApprovals.set(req.id, req)
    api?.emit('approval', { id: req.id, bot: req.bot, tool: req.tool, input: req.input, reason: req.reason })
    liveLists.get(req.bot)?.mark(req.tool, 'wait')
    // Only real Telegram chat ids go to Telegram. A desktop turn carries
    // `desktop:<bot>`, and sending to that id makes the API reject and, being
    // unawaited, take the daemon down with it.
    // Desktop turns carry `desktop:<bot>`, which no chat bridge can post to;
    // those cards live in the app's own inbox.
    const chat = req.chat && routeFor.has(req.chat) ? req.chat : chatFor.get(req.bot)
    const speaker = chat ? speakerFor(req.bot, chat) : undefined
    if (chat && speaker) void speaker.ask(req, chat).catch((e: Error) => console.warn(`${speaker.platform} ask failed: ${e.message}`))
  },
  onResolved: (req, r) => {
    openApprovals.delete(req.id)
    api?.emit('resolved', { id: req.id, decision: r.decision, source: r.source })
    liveLists.get(req.bot)?.mark(req.tool, r.decision === 'allow' ? 'ok' : 'deny')
    // Whichever bridge posted the card owns it; the others no-op on an id they
    // never saw.
    if (r.source !== 'human-tap') {
      for (const s of speakers) void s.closeCard(req.id, `${r.decision} (${r.source})`)
    }
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
          // Where to send screencast frames, so the desktop can watch a shadow
          // session and take it over mid-run.
          AGENTDA_PREVIEW_URL: api.previewUrl(p.id),
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

// What a desktop message does, shared with the mic so both take exactly the
// same path — including answering an open card.
function sendToBot(botId: string, text: string): void {
  const p = personas.find((x) => x.id === botId)
  if (!p) return api.emit('message-out', { bot: botId, text: `no bot named ${botId}` })
  // Same rule as chat: type "yes" at an open card and it answers the card
  // (FR-21). The desktop has buttons too, but the composer is where your hands
  // already are.
  const answered = queue.answerByText(text, { chat: `desktop:${botId}` })
  if (answered) {
    return api.emit('message-out', {
      bot: p.id,
      text: answered.amendment
        ? `Sent back for a change: ${answered.amendment} — expect a revised ${answered.tool} card.`
        : `${answered.decision === 'allow' ? 'Approved' : 'Denied'} — ${answered.tool}.`,
    })
  }
  // Deliberately not awaited: the turn may pause on an approval for as long as
  // the human takes, and the UI shows that card meanwhile. Same path as a chat
  // message, so the desktop gets handoffs and provider notices too.
  void runTurn(p, `desktop:${botId}`, text, text).catch((err) =>
    api.emit('message-out', { bot: p.id, text: `error: ${(err as Error).message}` }),
  )
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
    personas = readPersonas()
    api.emit('bots', { changed: p.id })
    return p
  },
  updateBot: (botId, patch) => {
    const p = personas.find((x) => x.id === botId)
    if (!p) throw new Error(`no bot named ${botId}`)
    const next = updatePersona(p, patch)
    personas = readPersonas()
    api.emit('bots', { changed: botId })
    return next
  },
  archiveBot: (botId) => {
    const p = personas.find((x) => x.id === botId)
    if (!p) throw new Error(`no bot named ${botId}`)
    const dest = archivePersona(botsDir, p)
    tokens.remove(botId)
    personas = readPersonas()
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
  packs: () => {
    const packs = loadPacks(...packDirs)
    return packs.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      docs: p.docs,
      verified: p.verified,
      missing: missingEnv(p),
      outbound: p.servers.flatMap((s) => s.outbound),
    }))
  },
  reload: () => {
    personas = readPersonas()
    syncBridges()
    api.emit('bots', { changed: null })
    return personas.length
  },
  // The desktop mic goes through the same transcriber as a Telegram voice note
  // (ADR 0004), then down the same path as typing it.
  voiceNote: async (botId, audio) => {
    const text = await transcribe(audio, voiceConfigFromEnv())
    api.emit('message-in', { bot: botId, text })
    sendToBot(botId, text)
    return text
  },
  send: sendToBot,
})
await api.listen()
console.log(`desktop UI at ${api.url()}`)

// One bridge per chat identity. On Telegram a persona with its own BotFather
// token speaks under its own name; everything else shares the daemon's token.
// Slack and Discord are one app each, which is what those platforms give you.
// Owner pairing is per platform account, so a second Telegram token needs no
// second pairing.
interface Speaker {
  platform: string
  send: (chat: string, text: string) => Promise<unknown>
  ask: (req: ApprovalRequest, chat: string) => Promise<void>
  closeCard: (id: string, outcome: string) => Promise<void>
  checklist: (chat: string, title: string) => LiveChecklist
  stop: () => Promise<unknown>
}

const SHARED = ''
const telegramSpeakers = new Map<string, Speaker>() // bot id, or SHARED
const speakers = new Set<Speaker>()
// Which bridge a chat is reachable on, learned from the messages that arrive
// there. A daemon that has never heard from a chat cannot post into it anyway.
const routeFor = new Map<string, Speaker>()

// The bot's own Telegram identity wins when it has one; otherwise whoever owns
// the thread the message came from.
function speakerFor(botId: string, chat: string): Speaker | undefined {
  const via = routeFor.get(chat)
  if (via?.platform === 'telegram') return telegramSpeakers.get(botId) ?? via
  return via
}

function bridgeHost(bound?: string) {
  return {
    owners,
    queue,
    personas: () => personas,
    bound: bound ? () => personas.find((p) => p.id === bound) : undefined,
    logDropped: (userId: string, why: string) => console.warn(`dropped update from ${userId}: ${why}`),
    onMessage: async (persona: Persona, chat: string, text: string) => {
      await runTurn(persona, chat, stripAddress(text, persona), text)
    },
    onCommand: (cmd: string, args: string, chat: string, reply: (s: string) => Promise<void>) =>
      handleCommand(cmd, args, chat, reply),
  }
}

// Remembers which bridge a chat belongs to, so replies and approval cards go
// back the way they came. The holder exists because the host has to be built
// before the bridge, and the speaker wraps the bridge.
function withRoute(holder: { speaker?: Speaker }, host: ReturnType<typeof bridgeHost>): ReturnType<typeof bridgeHost> {
  const note = (chat: string) => {
    if (holder.speaker) routeFor.set(chat, holder.speaker)
  }
  return {
    ...host,
    onMessage: async (persona, chat, text) => {
      note(chat)
      await host.onMessage(persona, chat, text)
    },
    onCommand: async (cmd, args, chat, reply) => {
      note(chat)
      await host.onCommand(cmd, args, chat, reply)
    },
  }
}

function register(holder: { speaker?: Speaker }, speaker: Speaker): Speaker {
  holder.speaker = speaker
  speakers.add(speaker)
  return speaker
}

function startTelegram(key: string, botToken: string, bound?: string): void {
  const holder: { speaker?: Speaker } = {}
  const bridge = createBridge({ token: botToken, voice: voiceConfigFromEnv(), ...withRoute(holder, bridgeHost(bound)) })
  const speaker = register(holder, {
    platform: 'telegram',
    send: bridge.send,
    ask: bridge.ask,
    closeCard: bridge.closeCard,
    checklist: bridge.checklist,
    stop: bridge.stop,
  })
  telegramSpeakers.set(key, speaker)
  void bridge
    .start((me) => console.log(`${bound ?? 'shared'} Telegram bridge live as @${me.username}`))
    .catch((err) => {
      telegramSpeakers.delete(key)
      speakers.delete(speaker)
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
    if (t && !telegramSpeakers.has(p.id)) startTelegram(p.id, t, p.id)
  }
  for (const [key, speaker] of telegramSpeakers) {
    if (key === SHARED) continue
    if (!tokens.get(key) || !personas.some((p) => p.id === key)) {
      telegramSpeakers.delete(key)
      speakers.delete(speaker)
      void speaker.stop().catch(() => {})
    }
  }
}

// Every bridge is optional: with none of them the daemon still serves the
// desktop app, which is the whole point of not coupling them.
const sharedToken = process.env.TELEGRAM_BOT_TOKEN
if (sharedToken) startTelegram(SHARED, sharedToken)
syncBridges()

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  const holder: { speaker?: Speaker } = {}
  const slack = createSlackBridge({
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    ...withRoute(holder, bridgeHost()),
  })
  register(holder, {
    platform: 'slack',
    send: slack.send,
    ask: slack.ask,
    closeCard: slack.closeCard,
    checklist: slack.checklist,
    stop: slack.stop,
  })
  void slack.start().then(() => console.log('Slack bridge live (socket mode)')).catch((e: Error) => console.error(`Slack bridge failed: ${e.message}`))
}

if (process.env.DISCORD_BOT_TOKEN) {
  const holder: { speaker?: Speaker } = {}
  const discord = createDiscordBridge({ token: process.env.DISCORD_BOT_TOKEN, ...withRoute(holder, bridgeHost()) })
  register(holder, {
    platform: 'discord',
    send: discord.send,
    ask: discord.ask,
    closeCard: discord.closeCard,
    checklist: discord.checklist,
    stop: async () => discord.stop(),
  })
  discord.client.once('clientReady', (c: { user: { tag: string } }) => console.log(`Discord bridge live as ${c.user.tag}`))
  void discord.start().catch((e: Error) => console.error(`Discord bridge failed: ${e.message}`))
}

if (!speakers.size) {
  console.log('no chat bridge configured — running desktop-only (add a Telegram token in the app, or set SLACK_BOT_TOKEN / DISCORD_BOT_TOKEN)')
}

// Whatever the bot says, said by the right identity: its own bridge when it has
// one, the thread's bridge otherwise, and the desktop app either way.
async function say(persona: Persona, chat: string, text: string): Promise<void> {
  if (!text) return
  api.emit('message-out', { bot: persona.id, text })
  const speaker = speakerFor(persona.id, chat)
  if (!speaker) return
  await speaker.send(chat, text).catch((e: Error) => console.warn(`${speaker.platform} send failed: ${e.message}`))
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
    personas = readPersonas()
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

function lastKnownChat(): string | undefined {
  return chatFor.values().next().value
}

// One turn, plus the handoff chain it may start. A bot ends its turn with
// `@other: do X` to pass work along; every hop is visible in the thread and
// counted against the per-task cap, so two bots cannot ping-pong forever.
async function runTurn(persona: Persona, chat: string, input: string, task: string, opts: { silent?: boolean } = {}): Promise<string> {
  chatFor.set(persona.id, chat)
  // The desktop renders a live checklist off these, so they are emitted as the
  // turn happens rather than summarised at the end. Chat gets the same thing as
  // one message edited in place.
  api.emit('activity', { bot: persona.id, kind: 'start' })
  const list = speakerFor(persona.id, chat)?.checklist(chat, `${persona.id} is working on it…`)
  if (list) liveLists.set(persona.id, list)
  const res = await runner
    .run(persona, chat, input, {
      onEvent: (e) => {
        if (e.type === 'result') sessionOwner.set(e.sessionId, persona.id)
        if (e.type === 'tool_call') {
          api.emit('activity', { bot: persona.id, kind: 'tool', name: e.name })
          list?.add(e.name)
        }
        if (e.type === 'warning') {
          api.emit('activity', { bot: persona.id, kind: 'warning', text: e.message })
          list?.add(e.message, 'deny')
        }
      },
    })
    .finally(async () => {
      api.emit('activity', { bot: persona.id, kind: 'end' })
      liveLists.delete(persona.id)
      await list?.finish()
    })
  for (const n of res.notices ?? []) await say(persona, chat, n) // e.g. a provider switch
  if (res.skipped) {
    await say(persona, chat, `(skipped: ${res.skipped})`)
    return ''
  }
  if (res.error) {
    await say(persona, chat, `${res.error.kind}: ${res.error.hint ?? res.error.message}`)
    return ''
  }
  await say(persona, chat, res.text || '(no reply)')
  if (res.memoryNotice) await say(persona, chat, res.memoryNotice)
  // The synthesis turn has already had its say; letting it dispatch again is
  // how a coordinator becomes a loop.
  if (opts.silent) return res.text

  await dispatchHandoffs(persona, chat, res.text, task)
  return res.text
}

// Where a reply's trailing `@bot: note` lines go. One line is the Phase 1
// chain: the next bot picks the work up and may pass it on again. A
// coordinator may name several, and gets one last turn to make sense of what
// came back (FR-38). Either way every hop is recorded and counted against the
// same per-task cap, because two models passing work back and forth is the
// fastest way to burn a plan window.
async function dispatchHandoffs(persona: Persona, chat: string, text: string, task: string): Promise<void> {
  const all = parseHandoffs(text)
  // Only the trailing lines count, so nothing can smuggle a handoff into the
  // middle of a reply. Planners do produce stray ones though — say so instead
  // of quietly acting on half a plan.
  const looksLikeHandoff = text.split('\n').filter((l) => /^@[\w-]+\s*[::]\s*.+$/.test(l.trim())).length
  if (looksLikeHandoff > all.length) {
    await say(persona, chat, `↪︎ ignored ${looksLikeHandoff - all.length} handoff line(s) that weren't at the end of the message`)
  }
  if (!all.length) return
  const targets = (persona.coordinator ? all : all.slice(-1))
    .map((h) => ({ ...h, persona: personas.find((p) => p.id.toLowerCase() === h.to.toLowerCase()) }))
    .filter((h) => h.persona && h.persona.id !== persona.id)
  if (!targets.length) return

  const results: string[] = []
  for (const t of targets) {
    const gate = tryHandoff(db, { chat, task, from: persona.id, to: t.persona!.id, note: t.note })
    if (!gate.ok) {
      await say(persona, chat, `↪︎ ${gate.reason}`)
      break
    }
    await say(persona, chat, `↪︎ handing this to ${t.persona!.id}`)
    // The receiving bot answers through its own bridge, so a handoff in a
    // group chat reads as two bots talking rather than one narrating both.
    const answer = await runTurn(t.persona!, chat, `${persona.id} handed this to you: ${t.note}`, task)
    if (answer) results.push(`${t.persona!.id}: ${answer}`)
  }

  // Only a coordinator gets the last word. Giving every bot one would make any
  // two of them a loop with extra steps.
  if (!persona.coordinator || results.length < 2) return
  await runTurn(
    persona,
    chat,
    `Here is what you got back. Answer the original request using it, and do not hand this to anyone else.\n\n${results.join('\n\n')}`,
    task,
    { silent: true },
  )
}

function stripAddress(text: string, p: Persona): string {
  return text.replace(new RegExp(`(^|\\s)@?${p.id}\\b[:,]?`, 'i'), ' ').trim() || text
}

// One pairing code per platform in use: a bot handle is public everywhere, so
// every platform has to learn which human is the owner.
for (const platform of ['telegram', 'slack', 'discord']) {
  const running = [...speakers].some((s) => s.platform === platform)
  if (running && owners.count(platform) === 0) {
    console.log(
      `\nPAIRING CODE (${platform}): ${owners.mintCode(platform)}\nSend this code to your bot on ${platform} to claim it. Until then it answers nobody.\n`,
    )
  }
}

let shuttingDown = false
const shutdown = async (code = 0) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\nshutting down…')
  scheduler.stop()
  queue.denyAll('daemon shutting down') // never leave a turn blocked on a dead daemon
  await Promise.all([...speakers].map((s) => s.stop().catch(() => {})))
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
// Started by the desktop shell: when its pipe closes the window is gone, and a
// daemon nobody can see should not keep polling Telegram and firing routines.
// Opt-in, because under launchd/systemd stdin is /dev/null and ends at once.
if (process.env.AGENTDA_EXIT_WITH_PARENT === '1') {
  process.stdin.resume()
  process.stdin.on('end', () => void shutdown())
  process.stdin.on('close', () => void shutdown())
}

scheduler.start()
// Bridges poll on their own; the daemon stays up for the desktop app and the
// scheduler until a signal arrives.
await new Promise(() => {})
