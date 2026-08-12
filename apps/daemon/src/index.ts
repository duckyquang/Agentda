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

const queue = new ApprovalQueue(db, {
  timeoutMs: Number(process.env.AGENTDA_APPROVAL_TIMEOUT_MS ?? 30 * 60_000),
  ask: (req) => {
    const chat = req.chat ?? chatFor.get(req.bot)
    if (chat) void bridge.ask(req, chat)
  },
  onResolved: (req, r) => {
    if (r.source !== 'human-tap') void bridge.closeCard(req.id, `${r.decision} (${r.source})`)
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
  adapters: new Map([['claude', new ClaudeAdapter()]]),
  settingsPath,
  guardrails: { perWindow: Number(process.env.AGENTDA_TURNS_PER_WINDOW ?? 60) },
  mcpEntries: (p) => ({
    ...(p.agentdaTools && {
      agentda: {
        command: process.execPath,
        args: [tsxLoader, join(repoRoot, 'packages/mcp-agentda/src/index.ts')],
        env: { AGENTDA_BOT_DIR: p.dir, AGENTDA_SCOPE: p.scope.join(':') },
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

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set — get one from @BotFather')
  process.exit(1)
}

const bridge = createBridge({
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
})

const scheduler = new Scheduler(
  db,
  () => personas,
  async (persona, _routineId, prompt) => {
    const chat = chatFor.get(persona.id) ?? lastKnownChat()
    if (!chat) return
    const res = await runner.run(persona, chat, prompt, { scheduled: true })
    const body = res.skipped ? `(routine skipped: ${res.skipped})` : res.error ? `routine error: ${res.error.message}` : res.text
    if (body) await bridge.bot.api.sendMessage(chat, `[${persona.id}] ${body}`.slice(0, 4000))
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

if (owners.count('telegram') === 0) {
  const code = owners.mintCode('telegram')
  console.log(`\nPAIRING CODE: ${code}\nDM this code to your bot on Telegram to claim it. Until then it answers nobody.\n`)
}

scheduler.start()
try {
  await bridge.bot.start({ drop_pending_updates: true, onStart: (me) => console.log(`bridge live as @${me.username}`) })
} catch (err) {
  const e = err as { error_code?: number; message: string }
  console.error(
    e.error_code === 401
      ? 'Telegram rejected the token. Check TELEGRAM_BOT_TOKEN against what @BotFather gave you.'
      : e.error_code === 409
        ? 'Another process is already polling this bot token — stop the other daemon first.'
        : `Telegram bridge failed: ${e.message}`,
  )
  queue.denyAll('daemon failed to start')
  await hook.close()
  db.close()
  process.exit(1)
}

const shutdown = async () => {
  console.log('\nshutting down…')
  scheduler.stop()
  queue.denyAll('daemon shutting down') // never leave a turn blocked on a dead daemon
  await bridge.bot.stop()
  await hook.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
