// The approval decision, as pure logic. No I/O here so it's exhaustively
// testable; the daemon wires the 'approve' outcome to a real human via the
// approval queue and the bridge. This is the safety spine — every consequential
// tool call routes through decide() (PRD FR-19/FR-20/FR-44).

export type Mode = 'ask' | 'auto'
export type DecisionSource = 'auto-class' | 'auto-mode' | 'human-tap' | 'human-text' | 'timeout' | 'standing-rule'

export interface BotPolicy {
  mode: Mode
  // The tools this bot may use AT ALL (FR-11 availability). Enforcement lives
  // here rather than in CLI flags because flags can't express it: `--tools ""`
  // disables MCP servers too (verified on 2.1.206), and a name blocklist fails
  // open on every CLI release. Anything not matched is denied outright — never
  // escalated to the human, since a bot reaching for a tool it was never
  // granted is a bug or an injection, not a decision worth a human's time.
  grants: string[]
  // Tool-name patterns that run without asking because they are genuinely
  // read-only (FR-19). Everything not matched here is gated by default —
  // unknown tools are gated, never auto-allowed.
  autoApprove: string[]
  // Patterns that keep asking even in Auto mode (FR-44). Shell is wholesale here
  // by default because no classifier reliably spots a deletion inside an
  // arbitrary command; callers get that default via defaultPolicy().
  alwaysAsk: string[]
}

export type GateOutcome =
  | { kind: 'allow'; source: Extract<DecisionSource, 'auto-class' | 'auto-mode'>; reason: string }
  | { kind: 'deny'; reason: string } // not granted to this bot at all
  | { kind: 'approve'; reason: string } // must block on a human; queue + bridge take over

export function defaultPolicy(mode: Mode = 'ask'): BotPolicy {
  return {
    mode,
    grants: [],
    autoApprove: [],
    // Bash/shell and anything that reads as a shell tool: block even in Auto.
    alwaysAsk: ['Bash', 'shell', 'mcp__*__shell*', 'mcp__*__exec*'],
  }
}

// Glob-lite: '*' matches any run of chars. Tool names are a controlled namespace
// (built-ins like "Bash", MCP tools like "mcp__fs__read_file"), so this is all
// the matching we need — no regex engine, no dependency.
export function matches(pattern: string, name: string): boolean {
  if (pattern === name) return true
  if (!pattern.includes('*')) return false
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return re.test(name)
}

const anyMatch = (patterns: string[], name: string) => patterns.some((p) => matches(p, name))

// Discovery machinery, not actions. MCP tools are deferred: the model finds them
// through ToolSearch, so gating it makes every attached MCP server invisible and
// the bot insists its tools do not exist. It reads names and descriptions of
// tools we already decided to attach — no side effects, nothing to approve.
const DISCOVERY_TOOLS = ['ToolSearch']

// forceAsk drops this one call back to Ask whatever the bot's stored mode says.
// Two things use it: the global /pause switch, and a replayed step the human
// marked sensitive when they reviewed the recording — same meaning, so it needs
// no second mechanism and the audit row honestly reads mode = ask.
export function decide(tool: string, policy: BotPolicy, forceAsk = false): GateOutcome {
  if (DISCOVERY_TOOLS.includes(tool)) {
    return { kind: 'allow', source: 'auto-class', reason: 'tool discovery, no side effects' }
  }
  if (!anyMatch(policy.grants, tool)) {
    return { kind: 'deny', reason: `${tool} is not granted to this bot` }
  }
  if (anyMatch(policy.autoApprove, tool)) {
    return { kind: 'allow', source: 'auto-class', reason: 'read-only tool, auto-approved' }
  }
  const effectiveMode: Mode = forceAsk ? 'ask' : policy.mode
  const mustAlwaysAsk = anyMatch(policy.alwaysAsk, tool)
  if (effectiveMode === 'auto' && !mustAlwaysAsk) {
    return { kind: 'allow', source: 'auto-mode', reason: 'auto mode, not on always-ask list' }
  }
  return {
    kind: 'approve',
    reason: mustAlwaysAsk ? 'always-ask tool — requires approval even in auto' : 'gated tool — requires approval',
  }
}
