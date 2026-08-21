import { readFileSync } from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import type { Persona } from './persona'

// A recorded routine: what a human did once, written down so a bot can do it
// again (PLAN Phase 4, watch-and-learn).
//
// It is a plain file the user reads and edits, because they are being asked to
// approve it in advance. Every field exists so that a step can be found again
// on a page that has changed, or so that replay can refuse to guess.

export type StepVerb = 'navigate' | 'type' | 'click' | 'select' | 'handback'

// The gated tool each verb runs as. A replayed step reaches the approval queue
// under the SAME name the model's own tool call would, so one policy covers
// both and the audit log does not need a second vocabulary.
const VERB_TOOLS: Record<Exclude<StepVerb, 'handback'>, string> = {
  navigate: 'mcp__browser__browser_navigate',
  type: 'mcp__browser__browser_type',
  click: 'mcp__browser__browser_click',
  select: 'mcp__browser__browser_select',
}

export const verbTool = (verb: StepVerb): string | undefined =>
  verb === 'handback' ? undefined : VERB_TOOLS[verb]

export interface RoutineStep {
  n: number
  verb: StepVerb
  tool?: string
  url?: string // navigate
  // How to find the element again, most durable first. Recorded as separate
  // handles rather than one selector: a page that changed its markup usually
  // still has the same button with the same words on it.
  selector?: string // what the recorder produced, e.g. internal:role=button[name="Pay"i]
  role?: string
  name?: string // accessible name
  label?: string
  placeholder?: string
  testId?: string
  tag?: string
  inputType?: string
  text?: string // typed text, or the option chosen for a select
  // Keeps asking even in Auto (FR-44). Set by the recorder for anything that
  // looks like it spends money or sends something, and by the human reviewing.
  sensitive: boolean
  // No durable handle was recorded — only a position. Replay refuses these
  // rather than acting on whatever is in that position now.
  fragile: boolean
  // What must be true after this step. Not optional on an acting step: without
  // it a replay that typed into the wrong field reports success.
  expect?: string
  note?: string
}

export interface Routine {
  version: number
  recordedAt: string
  recordedUrl?: string
  // A draft nobody has read yet never replays. The recorder writes false.
  reviewed: boolean
  steps: RoutineStep[]
}

const ACTING: StepVerb[] = ['type', 'click', 'select']

// `title:Invoices` · `url:/receipts` · `text:Payment sent` · `value:42.00` ·
// `visible:internal:role=alert`. A tiny vocabulary on purpose: the human
// reviewing the draft has to be able to read it.
export const EXPECT_KINDS = ['title', 'url', 'text', 'value', 'visible'] as const
export type ExpectKind = (typeof EXPECT_KINDS)[number]

export function parseExpect(expect: string): { kind: ExpectKind; value: string } | undefined {
  const at = expect.indexOf(':')
  if (at < 1) return undefined
  const kind = expect.slice(0, at) as ExpectKind
  const value = expect.slice(at + 1)
  return EXPECT_KINDS.includes(kind) && value ? { kind, value } : undefined
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export function loadRoutine(path: string): Routine {
  const cfg = parseToml(readFileSync(path, 'utf8')) as Record<string, any>
  const steps = Array.isArray(cfg.steps) ? cfg.steps : []
  return {
    version: typeof cfg.version === 'number' ? cfg.version : 1,
    recordedAt: String(cfg.recorded_at ?? ''),
    recordedUrl: str(cfg.recorded_url),
    reviewed: cfg.reviewed === true,
    steps: steps.map((s: any, i: number) => ({
      n: typeof s.n === 'number' ? s.n : i + 1,
      verb: s.verb as StepVerb,
      tool: str(s.tool),
      url: str(s.url),
      selector: str(s.selector),
      role: str(s.role),
      name: str(s.name),
      label: str(s.label),
      placeholder: str(s.placeholder),
      testId: str(s.test_id),
      tag: str(s.tag),
      inputType: str(s.input_type),
      text: typeof s.text === 'string' ? s.text : undefined,
      sensitive: s.sensitive === true,
      fragile: s.fragile === true,
      expect: str(s.expect),
      note: str(s.note),
    })),
  }
}

// Everything that must be true before a single step runs. Checked at load, so a
// routine that cannot be replayed safely says so instead of failing halfway
// through with a browser open on a half-filled form.
export function validateRoutine(r: Routine): string[] {
  const problems: string[] = []
  if (!r.steps.length) problems.push('this routine has no steps')
  if (!r.reviewed) problems.push('nobody has reviewed this recording yet — open it in the app and confirm the steps')

  for (const s of r.steps) {
    const expected = verbTool(s.verb)
    if (s.verb !== 'handback' && !expected) {
      problems.push(`step ${s.n}: ${s.verb} is not a verb this can replay`)
      continue
    }
    // The tool name is what the gate sees. If the file disagrees with the verb,
    // the human approved one thing and another would run.
    if (s.tool && s.tool !== expected) {
      problems.push(`step ${s.n}: says ${s.verb} but names the tool ${s.tool}`)
    }
    if (s.verb === 'navigate' && !s.url) problems.push(`step ${s.n}: navigate with no url`)
    if (ACTING.includes(s.verb) && !s.expect) {
      problems.push(`step ${s.n}: ${s.verb} has no expect — without one a step that hits the wrong element still reports success`)
    }
    if (s.expect && !parseExpect(s.expect)) {
      problems.push(`step ${s.n}: expect "${s.expect}" is not one of ${EXPECT_KINDS.join(', ')}`)
    }
    if (ACTING.includes(s.verb) && !s.fragile && !s.selector && !(s.role && s.name)) {
      problems.push(`step ${s.n}: nothing durable to find the element by`)
    }
  }
  return problems
}

// A Codex bot has no working MCP tools at all (ADR 0003), so it has no browser
// to replay into. Refused with the reason rather than failing at step one.
export function refuseReplayOnCodex(persona: Persona): string | undefined {
  return persona.providers.every((p) => p.provider === 'codex')
    ? `${persona.id} runs on Codex, which cannot run MCP tools at all (ADR 0003) — it has no browser to replay into. Give it another provider, or run this routine on a different bot.`
    : undefined
}
