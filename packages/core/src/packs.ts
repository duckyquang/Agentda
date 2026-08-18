import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { Persona } from './persona'

// Tool packs (PLAN Phase 3): a curated, versioned pointer at an MCP server
// somebody else maintains, plus the two things a config file cannot infer —
// what credentials it needs, and which of its verbs reach the outside world.
//
// The verb classification is the point. A server's README says what it is for;
// it does not say which tools spend money or send mail, and the gate's defaults
// have to know. Anything not listed as read-only is gated, so a pack that
// forgets to classify a verb fails closed.
export interface PackServer {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  // Environment variables the user must have set for this server to work.
  envRequired: string[]
  readOnly: string[] // tools that only read: safe to auto-approve
  outbound: string[] // tools that send, post, buy, or write to someone else
}

export interface Pack {
  id: string
  name: string
  description: string
  docs?: string
  // What was actually done to check this pack works, and when. A pack that has
  // never been run says so rather than implying otherwise.
  verified?: string
  servers: PackServer[]
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function loadPack(dir: string): Pack {
  const cfg = parseToml(readFileSync(join(dir, 'pack.toml'), 'utf8')) as Record<string, any>
  const id = String(cfg.id ?? dir.split('/').pop())
  const servers = (Array.isArray(cfg.servers) ? cfg.servers : []).map((s: any) => ({
    name: String(s.name),
    command: String(s.command),
    args: strings(s.args),
    env: s.env && typeof s.env === 'object' ? (s.env as Record<string, string>) : undefined,
    envRequired: strings(s.env_required),
    readOnly: strings(s.read_only),
    outbound: strings(s.outbound),
  }))
  if (!servers.length) throw new Error(`pack ${id} declares no servers`)
  return {
    id,
    name: String(cfg.name ?? id),
    description: String(cfg.description ?? ''),
    docs: typeof cfg.docs === 'string' ? cfg.docs : undefined,
    verified: typeof cfg.verified === 'string' ? cfg.verified : undefined,
    servers,
  }
}

export function loadPacks(...dirs: string[]): Pack[] {
  const found = new Map<string, Pack>()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(dir, entry.name, 'pack.toml'))) continue
      // Later directories win, so a user's own copy overrides a shipped pack.
      const pack = loadPack(join(dir, entry.name))
      found.set(pack.id, pack)
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// Which required variables are missing from the environment. Headless runs
// cannot do interactive MCP OAuth, so a pack that needs credentials has to be
// set up before a bot is pointed at it — and saying which one is missing is the
// difference between a fixable message and a mystery.
export function missingEnv(pack: Pack, env: NodeJS.ProcessEnv = process.env): string[] {
  return pack.servers.flatMap((s) => s.envRequired.filter((k) => !env[k]))
}

export interface PackGrants {
  servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
  grants: string[] // tool patterns this bot may reach at all
  autoApprove: string[] // the read-only verbs
  outbound: string[] // fully-qualified names of the verbs that reach outside
}

// Turns packs into the three things the runner needs: MCP server entries, the
// grants that make their tools available, and the auto-approve list. Outbound
// verbs are deliberately absent from autoApprove — they are gated even in Auto
// unless the bot's own always-ask list is overridden by hand.
export function packGrants(packs: Pack[], env: NodeJS.ProcessEnv = process.env): PackGrants {
  const out: PackGrants = { servers: {}, grants: [], autoApprove: [], outbound: [] }
  for (const pack of packs) {
    for (const s of pack.servers) {
      out.servers[s.name] = {
        command: s.command,
        args: s.args,
        env: {
          ...Object.fromEntries(s.envRequired.filter((k) => env[k]).map((k) => [k, env[k] as string])),
          ...s.env,
        },
      }
      out.grants.push(`mcp__${s.name}__*`)
      out.autoApprove.push(...s.readOnly.map((t) => `mcp__${s.name}__${t}`))
      out.outbound.push(...s.outbound.map((t) => `mcp__${s.name}__${t}`))
    }
  }
  return out
}

// Codex bots have no working MCP tools at all (ADR 0003): the calls are
// cancelled in `codex exec` whatever the configuration says. So packs are
// refused there rather than half-attached, because a tool that looks available
// and silently never runs is worse than one that was never offered — and an
// outbound verb in that state is exactly the failure PRD M4 calls a release
// blocker.
export function refuseOnCodex(packs: Pack[]): string | undefined {
  if (!packs.length) return undefined
  const outbound = packs.filter((p) => p.servers.some((s) => s.outbound.length)).map((p) => p.id)
  return [
    `Codex cannot run MCP tools at all (ADR 0003), so ${packs.map((p) => p.id).join(', ')} would look attached and do nothing.`,
    outbound.length ? `${outbound.join(', ')} also expose outbound verbs, which must never look available without a gate that works.` : '',
    'Move this bot to another provider, or drop the packs.',
  ]
    .filter(Boolean)
    .join(' ')
}

// Attaches the packs a bot names: their servers become MCP entries, their
// read-only verbs become auto-approvals, and everything else stays gated.
// Returns a new persona rather than mutating one, so a reload is a clean
// rebuild rather than an accumulation.
export function withPacks(persona: Persona, available: Pack[], env: NodeJS.ProcessEnv = process.env): Persona {
  if (!persona.packs.length) return persona
  const notices: string[] = []
  const chosen: Pack[] = []
  for (const id of persona.packs) {
    const pack = available.find((p) => p.id === id)
    if (!pack) {
      notices.push(`${persona.id} names a pack that is not installed: ${id}`)
      continue
    }
    const missing = missingEnv(pack, env)
    if (missing.length) {
      // Attaching a server whose credentials are absent gets you a bot that
      // insists its tools are broken. Say which variable, and leave it off.
      notices.push(`${pack.id} needs ${missing.join(', ')} in the environment — not attached`)
      continue
    }
    chosen.push(pack)
  }

  if (persona.provider === 'codex') {
    const refusal = refuseOnCodex(chosen)
    if (refusal) {
      notices.push(refusal)
      return { ...persona, packNotices: notices }
    }
  }

  const grants = packGrants(chosen, env)
  // `{scope}` in a pack's args expands to the bot's own allowed directories, so
  // one pack definition serves every bot without the user editing paths into it.
  const servers = Object.fromEntries(
    Object.entries(grants.servers).map(([name, s]) => [
      name,
      { ...s, args: s.args.flatMap((a) => (a === '{scope}' ? persona.scope : [a])) },
    ]),
  )
  return {
    ...persona,
    packServers: servers,
    packNotices: notices.length ? notices : undefined,
    policy: {
      ...persona.policy,
      grants: [...persona.policy.grants, ...grants.grants],
      autoApprove: [...persona.policy.autoApprove, ...grants.autoApprove],
      // Outbound verbs join the always-ask list, not just the not-auto-approved
      // list. Otherwise a bot in Auto would send mail on a third-party server's
      // behalf unattended, which is exactly the class FR-44 seeds that list
      // with — and a pack is a server we do not control.
      alwaysAsk: [...persona.policy.alwaysAsk, ...grants.outbound],
    },
  }
}
