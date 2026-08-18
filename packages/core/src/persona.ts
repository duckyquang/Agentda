import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { type BotPolicy, defaultPolicy, type Mode } from './gate'

// A bot is a directory, not a database row (PRD FR-9): bot.toml + prompt.md +
// memory/*.md. Copy the folder to share the bot; edit the files by hand any time.
export interface Persona {
  id: string
  dir: string
  name: string
  prompt: string
  provider: string // first choice; providers[] is the full ordered chain
  providers: { provider: string; metered?: boolean }[]
  allowMeteredFailover: boolean
  model?: string // for API providers, which model to call
  policy: BotPolicy
  tools: string[] // built-in tool grants (availability only; the gate still runs)
  agentdaTools: boolean // attach Agentda's own MCP server (memory + scoped files)
  browser: boolean // attach browser hands (opt-in: Playwright is a heavy install)
  email: boolean // attach IMAP/SMTP hands (opt-in: needs mailbox credentials)
  browserSurface: 'shadow' | 'on-screen'
  scope: string[] // directories the file tools may touch, absolute
  mcpConfig?: string // extra MCP config file, relative to the bot dir
  packs: string[] // tool pack ids this bot uses (PLAN Phase 3)
  // A coordinator may hand work to several bots in one turn and then gets a
  // last turn to make sense of what came back (FR-38). Every hop still counts
  // against the same per-task cap.
  coordinator: boolean
  // Filled in by withPacks(): the servers those packs resolve to, and anything
  // the user needs to hear about them.
  packServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
  packNotices?: string[]
  routines: { id: string; cron: string; prompt: string; enabled: boolean }[]
  quietHours?: { start: number; end: number } // local hours, [start, end)
  dailyTurnCap?: number
  weeklyTurnCap?: number
}

// A bot may name one provider or an ordered chain. Metered entries are marked
// so failover can refuse to spend money without an explicit opt-in (FR-6).
function normalizeChain(cfg: Record<string, any>): { provider: string; metered?: boolean }[] {
  const METERED = /^(anthropic|openai|xai|gemini)-api$/
  const raw = Array.isArray(cfg.providers) && cfg.providers.length ? cfg.providers : [cfg.provider ?? 'claude']
  return raw.map((entry: any) => {
    const provider = typeof entry === 'string' ? entry : String(entry.provider)
    const metered = typeof entry === 'object' && entry.metered !== undefined ? !!entry.metered : METERED.test(provider)
    return { provider, metered }
  })
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

// Server names from an attached MCP config, so their tools can be granted
// without the user listing every tool by hand.
function mcpServerNames(dir: string, cfg: Record<string, any>): string[] {
  if (typeof cfg.mcp_config !== 'string') return []
  const path = join(dir, cfg.mcp_config)
  if (!existsSync(path)) return []
  try {
    return Object.keys(JSON.parse(readFileSync(path, 'utf8')).mcpServers ?? {})
  } catch {
    return []
  }
}

export function loadPersona(dir: string): Persona {
  const cfgPath = join(dir, 'bot.toml')
  if (!existsSync(cfgPath)) throw new Error(`no bot.toml in ${dir}`)
  const cfg = parseToml(readFileSync(cfgPath, 'utf8')) as Record<string, any>
  const id = String(cfg.id ?? dir.split('/').pop())

  const promptPath = join(dir, 'prompt.md')
  const mode: Mode = cfg.mode === 'auto' ? 'auto' : 'ask'
  const base = defaultPolicy(mode)

  return {
    id,
    dir,
    name: String(cfg.name ?? id),
    prompt: existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : '',
    provider: String(Array.isArray(cfg.providers) && cfg.providers.length ? cfg.providers[0].provider ?? cfg.providers[0] : (cfg.provider ?? 'claude')),
    providers: normalizeChain(cfg),
    allowMeteredFailover: cfg.allow_metered_failover === true,
    model: typeof cfg.model === 'string' ? cfg.model : undefined,
    policy: {
      mode,
      // What this bot may touch at all: the built-ins it was given, plus every
      // tool of each MCP server attached to it. Explicit `grants` in bot.toml
      // overrides for finer control (e.g. one tool from a server, not all).
      grants: asStringArray(cfg.grants).length
        ? asStringArray(cfg.grants)
        : [
            ...asStringArray(cfg.tools),
            ...(cfg.agentda_tools !== false ? ['mcp__agentda__*'] : []),
            ...(cfg.browser === true ? ['mcp__browser__*'] : []),
            ...(cfg.email === true ? ['mcp__email__*'] : []),
            ...mcpServerNames(dir, cfg).map((s) => `mcp__${s}__*`),
          ],
      autoApprove: asStringArray(cfg.auto_approve),
      // Callers may extend the always-ask list but never shrink the shell
      // default out of it by omission — dropping it takes an explicit
      // always_ask entry list that simply doesn't include shell patterns.
      alwaysAsk: cfg.always_ask === undefined ? base.alwaysAsk : asStringArray(cfg.always_ask),
    },
    tools: asStringArray(cfg.tools),
    agentdaTools: cfg.agentda_tools !== false,
    browser: cfg.browser === true,
    email: cfg.email === true,
    browserSurface: cfg.browser_surface === 'on-screen' ? 'on-screen' : 'shadow',
    scope: asStringArray(cfg.scope).map((p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p))),
    mcpConfig: typeof cfg.mcp_config === 'string' ? join(dir, cfg.mcp_config) : undefined,
    packs: asStringArray(cfg.packs),
    coordinator: cfg.coordinator === true,
    routines: Array.isArray(cfg.routines)
      ? cfg.routines.map((r: any, i: number) => ({
          id: String(r.id ?? `r${i}`),
          cron: String(r.cron),
          prompt: String(r.prompt),
          enabled: r.enabled !== false,
        }))
      : [],
    quietHours:
      cfg.quiet_hours && typeof cfg.quiet_hours.start === 'number' && typeof cfg.quiet_hours.end === 'number'
        ? { start: cfg.quiet_hours.start, end: cfg.quiet_hours.end }
        : undefined,
    dailyTurnCap: typeof cfg.daily_turn_cap === 'number' ? cfg.daily_turn_cap : undefined,
    weeklyTurnCap: typeof cfg.weekly_turn_cap === 'number' ? cfg.weekly_turn_cap : undefined,
  }
}

export function loadPersonas(botsDir: string): Persona[] {
  if (!existsSync(botsDir)) return []
  return readdirSync(botsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(botsDir, e.name, 'bot.toml')))
    .map((e) => loadPersona(join(botsDir, e.name)))
}

// Memory is plain Markdown in the bot's directory: the user can open and edit it
// like any file, and it survives everything (FR-25).
export function memoryDir(p: Persona): string {
  const d = join(p.dir, 'memory')
  mkdirSync(d, { recursive: true })
  return d
}

export function readMemory(p: Persona): string {
  const d = memoryDir(p)
  return readdirSync(d)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `## ${f}\n${readFileSync(join(d, f), 'utf8').trim()}`)
    .join('\n\n')
    .trim()
}

export function writeMemory(p: Persona, file: string, content: string): { path: string; before: string } {
  if (!/^[\w.-]+$/.test(file) || file.includes('..')) throw new Error(`invalid memory file name: ${file}`)
  const name = file.endsWith('.md') ? file : `${file}.md`
  const path = join(memoryDir(p), name)
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeFileSync(path, content)
  return { path, before }
}

// Mode changes persist by rewriting the one line in bot.toml, so what the user
// sees in the file is always the truth (NFR-7).
export function setPersonaMode(p: Persona, mode: Mode): void {
  const cfgPath = join(p.dir, 'bot.toml')
  const src = readFileSync(cfgPath, 'utf8')
  const next = /^\s*mode\s*=/m.test(src)
    ? src.replace(/^\s*mode\s*=.*$/m, `mode = "${mode}"`)
    : `mode = "${mode}"\n${src}`
  writeFileSync(cfgPath, next)
  p.policy.mode = mode
}

// --- Persona management (PLAN Phase 2) ---------------------------------------
//
// A bot is a directory, so creating and editing one is file work, not database
// work. Edits are made line by line rather than by re-serialising the TOML,
// because bot.toml is a file the user also opens and comments; a round-trip
// through a TOML writer would silently eat their comments and reorder
// everything the first time they touched a toggle in the desktop app.

export interface PersonaPatch {
  name?: string
  mode?: Mode
  providers?: string[]
  model?: string | null
  allowMeteredFailover?: boolean
  agentdaTools?: boolean
  browser?: boolean
  browserSurface?: 'shadow' | 'on-screen'
  email?: boolean
  scope?: string[]
  autoApprove?: string[]
  alwaysAsk?: string[]
  dailyTurnCap?: number | null
  weeklyTurnCap?: number | null
  packs?: string[]
  prompt?: string
}

const tomlValue = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map((x) => tomlValue(x)).join(', ')}]`
    : typeof v === 'string'
      ? JSON.stringify(v)
      : String(v)

// Replaces top-level keys in place, appending the ones that are missing ABOVE
// the first table header — an appended key after `[[routines]]` would silently
// become part of that routine instead of the bot.
export function setConfigValues(cfgPath: string, values: Record<string, unknown>): void {
  let lines = readFileSync(cfgPath, 'utf8').split('\n')
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l))
    if (value === null || value === undefined) {
      if (at >= 0) lines.splice(at, 1)
      continue
    }
    const rendered = `${key} = ${tomlValue(value)}`
    if (at >= 0) {
      lines[at] = rendered
    } else {
      const firstTable = lines.findIndex((l) => /^\s*\[/.test(l))
      lines.splice(firstTable === -1 ? lines.length : firstTable, 0, rendered)
    }
  }
  // Keep the file tidy when keys are inserted next to a trailing blank line.
  while (lines.length > 1 && lines.at(-1) === '' && lines.at(-2) === '') lines.pop()
  writeFileSync(cfgPath, lines.join('\n'))
}

const PATCH_KEYS: Record<keyof PersonaPatch, string> = {
  name: 'name',
  mode: 'mode',
  providers: 'providers',
  model: 'model',
  allowMeteredFailover: 'allow_metered_failover',
  agentdaTools: 'agentda_tools',
  browser: 'browser',
  browserSurface: 'browser_surface',
  email: 'email',
  scope: 'scope',
  autoApprove: 'auto_approve',
  alwaysAsk: 'always_ask',
  dailyTurnCap: 'daily_turn_cap',
  weeklyTurnCap: 'weekly_turn_cap',
  packs: 'packs',
  prompt: 'prompt', // handled separately: prompt.md, not a config key
}

export function updatePersona(p: Persona, patch: PersonaPatch): Persona {
  if (patch.prompt !== undefined) writeFileSync(join(p.dir, 'prompt.md'), patch.prompt)
  const values: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'prompt' || value === undefined) continue
    values[PATCH_KEYS[key as keyof PersonaPatch]] = value
  }
  if (Object.keys(values).length) setConfigValues(join(p.dir, 'bot.toml'), values)
  return loadPersona(p.dir)
}

const VALID_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

export function createPersona(botsDir: string, spec: { id: string; name?: string } & PersonaPatch): Persona {
  // The id becomes a directory name and is matched against message text, so it
  // stays boring on purpose.
  if (!VALID_ID.test(spec.id)) throw new Error('bot id must be lowercase letters, digits or dashes (max 32)')
  const dir = join(botsDir, spec.id)
  if (existsSync(join(dir, 'bot.toml'))) throw new Error(`a bot called ${spec.id} already exists`)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(
    join(dir, 'bot.toml'),
    [`id = "${spec.id}"`, `name = ${JSON.stringify(spec.name ?? spec.id)}`, 'mode = "ask"', ''].join('\n'),
  )
  writeFileSync(join(dir, 'prompt.md'), spec.prompt ?? `You are ${spec.name ?? spec.id}.\n`)
  const { id, ...patch } = spec
  return updatePersona(loadPersona(dir), patch)
}

// Deleting a bot deletes its memory, which is the user's own writing and the
// one thing here that cannot be regenerated. So this moves the directory into
// a trash folder instead: reversible with `mv`, and gone whenever they say so.
export function archivePersona(botsDir: string, p: Persona, stamp = new Date().toISOString().replace(/[:.]/g, '-')): string {
  const resolvedBots = resolve(botsDir)
  const dir = resolve(p.dir)
  if (dir !== join(resolvedBots, p.id) || !existsSync(join(dir, 'bot.toml'))) {
    throw new Error(`refusing to archive ${dir}: not a bot directory inside ${resolvedBots}`)
  }
  const trash = join(resolvedBots, '.trash')
  mkdirSync(trash, { recursive: true })
  const dest = join(trash, `${p.id}-${stamp}`)
  renameSync(dir, dest)
  return dest
}
