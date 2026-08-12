import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  provider: string
  policy: BotPolicy
  tools: string[] // built-in tool grants (availability only; the gate still runs)
  agentdaTools: boolean // attach Agentda's own MCP server (memory + scoped files)
  browser: boolean // attach browser hands (opt-in: Playwright is a heavy install)
  email: boolean // attach IMAP/SMTP hands (opt-in: needs mailbox credentials)
  browserSurface: 'shadow' | 'on-screen'
  scope: string[] // directories the file tools may touch, absolute
  mcpConfig?: string // extra MCP config file, relative to the bot dir
  routines: { id: string; cron: string; prompt: string; enabled: boolean }[]
  quietHours?: { start: number; end: number } // local hours, [start, end)
  dailyTurnCap?: number
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
    provider: String(cfg.provider ?? 'claude'),
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
