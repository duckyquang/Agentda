// The approval decision, as pure logic. No I/O here so it's exhaustively
// testable; the daemon wires the 'approve' outcome to a real human via the
// approval queue and the bridge. This is the safety spine — every consequential
// tool call routes through decide() (PRD FR-19/FR-20/FR-44).

export type Mode = 'ask' | 'auto'
export type DecisionSource = 'auto-class' | 'auto-mode' | 'human-tap' | 'human-text' | 'timeout' | 'standing-rule'

export interface BotPolicy {
  mode: Mode
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
  | { kind: 'approve'; reason: string } // must block on a human; queue + bridge take over

export function defaultPolicy(mode: Mode = 'ask'): BotPolicy {
  return {
    mode,
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

// paused forces Ask regardless of the bot's stored mode (the global /pause switch).
export function decide(tool: string, policy: BotPolicy, paused = false): GateOutcome {
  if (anyMatch(policy.autoApprove, tool)) {
    return { kind: 'allow', source: 'auto-class', reason: 'read-only tool, auto-approved' }
  }
  const effectiveMode: Mode = paused ? 'ask' : policy.mode
  const mustAlwaysAsk = anyMatch(policy.alwaysAsk, tool)
  if (effectiveMode === 'auto' && !mustAlwaysAsk) {
    return { kind: 'allow', source: 'auto-mode', reason: 'auto mode, not on always-ask list' }
  }
  return {
    kind: 'approve',
    reason: mustAlwaysAsk ? 'always-ask tool — requires approval even in auto' : 'gated tool — requires approval',
  }
}
