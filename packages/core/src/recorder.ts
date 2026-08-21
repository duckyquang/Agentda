import type { Routine, RoutineStep, StepVerb } from './routine'
import { verbTool } from './routine'

// Turning a recorded session into a routine a human can read and approve.
//
// Nothing here imports Playwright: this is the pure half, so it can be tested
// without a browser. The recorder package feeds it whatever the browser said.

// What Playwright's recorder emits, narrowed to the parts we use. Verified
// against playwright 1.62.1 by running it: `action.name` is navigate | fill |
// click | select | press, `selector` is an internal role selector, and
// `ariaSnapshot` is the accessibility tree at the moment of the action.
export interface RawAction {
  name: string
  url?: string
  selector?: string
  ref?: string
  text?: string
  options?: string[]
  ariaSnapshot?: string
  signals?: unknown[]
}

const VERBS: Record<string, StepVerb> = {
  navigate: 'navigate',
  fill: 'type',
  click: 'click',
  select: 'select',
}

// Anything whose words suggest it spends money, sends something, or cannot be
// undone. Used to mark a step sensitive, which makes it ask even in Auto — it
// is a prompt for the human reviewing the draft, not a security boundary, and
// the draft says as much.
const CONSEQUENTIAL = /\b(pay|payment|buy|purchase|order|checkout|send|submit|transfer|delete|remove|cancel|confirm|publish|post|book|subscribe)\b/i

// A recorded field whose value must never be written down. The value is a
// secret the human typed; the routine records that a secret goes here and
// stops for them, rather than keeping their password in a file.
const SECRET_FIELD = /\b(password|passcode|pin|secret|token|otp|2fa|cvv|card|security code)\b/i

const roleOf = (selector?: string) => /internal:role=([a-z]+)/.exec(selector ?? '')?.[1]
const nameOf = (selector?: string) => /name="([^"]*)"/.exec(selector ?? '')?.[1]

// A handle that only says "the third one". Replay refuses to act on these:
// measured, an nth-of-type selector silently resolves to a DIFFERENT element
// after a sibling is inserted, and nothing throws.
const POSITIONAL = /:nth-|>>\s*nth=|\[\d+\]/

export interface CompileResult {
  routine: Routine
  // Things the human should know before they approve this draft.
  notes: string[]
}

export function compileRoutine(
  actions: RawAction[],
  meta: { recordedAt: string; recordedUrl?: string },
): CompileResult {
  const notes: string[] = []
  const steps: RoutineStep[] = []

  for (const a of actions) {
    // Recorded but not replayable, and dropping one silently would leave a
    // routine that cannot work and does not say why.
    if (a.name === 'setInputFiles') {
      notes.push('this recording uploads a file, which cannot be replayed — record it again without that step, or do that part by hand')
      continue
    }
    const verb = VERBS[a.name]
    if (!verb) {
      notes.push(`ignored a recorded ${a.name}, which this cannot replay`)
      continue
    }

    const role = roleOf(a.selector)
    const name = nameOf(a.selector)
    const label = [name, a.selector].filter(Boolean).join(' ')
    const secret = verb === 'type' && SECRET_FIELD.test(label)
    const fragile = !!a.selector && POSITIONAL.test(a.selector)
    const n = steps.length + 1

    if (secret) {
      // The value is theirs, and the recording is a file. Replay stops here and
      // hands them the browser, already on the right page.
      notes.push(`step ${n} types into what looks like a ${name ?? 'secret'} field — the routine stops there and hands the browser to you instead of keeping the value`)
      steps.push({
        n,
        verb: 'handback',
        role,
        name,
        selector: a.selector,
        sensitive: true,
        fragile: false,
        note: `a secret goes in here (${name ?? 'unnamed field'}) — take over and type it yourself`,
      })
      continue
    }

    const step: RoutineStep = {
      n,
      verb,
      tool: verbTool(verb),
      url: verb === 'navigate' ? a.url : undefined,
      selector: verb === 'navigate' ? undefined : a.selector,
      role,
      name,
      text: verb === 'type' ? a.text : verb === 'select' ? a.options?.[0] : undefined,
      sensitive: CONSEQUENTIAL.test(label),
      fragile,
      expect: defaultExpect(verb, a),
    }
    if (fragile) {
      notes.push(`step ${n} could only be recorded by position, so replay will stop there rather than act on whatever is in that position later`)
    }
    steps.push(step)
  }

  if (!steps.length) notes.push('nothing replayable was recorded')
  return { routine: { version: 1, recordedAt: meta.recordedAt, recordedUrl: meta.recordedUrl, reviewed: false, steps }, notes }
}

// A first guess at what should be true afterwards, for the human to correct.
// Every acting step gets one, because a routine without them cannot tell the
// difference between working and typing into the wrong box.
function defaultExpect(verb: StepVerb, a: RawAction): string | undefined {
  if (verb === 'navigate') return a.url ? `url:${new URL(a.url).pathname}` : undefined
  if (verb === 'type') return a.text ? `value:${a.text}` : undefined
  if (verb === 'select') return a.options?.[0] ? `value:${a.options[0]}` : undefined
  return a.selector ? `visible:${a.selector}` : undefined
}

const quote = (v: string) => JSON.stringify(v)

// Written as TOML because that is what the rest of a bot is, and because the
// point is that a person opens this file and reads it before saying yes.
export function renderRoutineToml(r: Routine, notes: string[] = []): string {
  const out: string[] = [
    '# Recorded by watching you do this once. Nothing here runs until you have',
    '# read it and set reviewed = true — and every consequential step still',
    '# stops for your approval when it runs.',
    '',
    `version = ${r.version}`,
    `recorded_at = ${quote(r.recordedAt)}`,
    ...(r.recordedUrl ? [`recorded_url = ${quote(r.recordedUrl)}`] : []),
    `reviewed = ${r.reviewed}`,
    '',
  ]
  for (const note of notes) out.push(`# NOTE: ${note}`)
  if (notes.length) out.push('')

  for (const s of r.steps) {
    out.push('[[steps]]')
    out.push(`n = ${s.n}`)
    out.push(`verb = ${quote(s.verb)}`)
    if (s.tool) out.push(`tool = ${quote(s.tool)}`)
    if (s.url) out.push(`url = ${quote(s.url)}`)
    if (s.selector) out.push(`selector = ${quote(s.selector)}`)
    if (s.role) out.push(`role = ${quote(s.role)}`)
    if (s.name) out.push(`name = ${quote(s.name)}`)
    if (s.label) out.push(`label = ${quote(s.label)}`)
    if (s.placeholder) out.push(`placeholder = ${quote(s.placeholder)}`)
    if (s.testId) out.push(`test_id = ${quote(s.testId)}`)
    if (s.tag) out.push(`tag = ${quote(s.tag)}`)
    if (s.inputType) out.push(`input_type = ${quote(s.inputType)}`)
    if (s.text !== undefined) out.push(`text = ${quote(s.text)}`)
    out.push(`sensitive = ${s.sensitive}`)
    out.push(`fragile = ${s.fragile}`)
    if (s.expect) out.push(`expect = ${quote(s.expect)}`)
    if (s.note) out.push(`note = ${quote(s.note)}`)
    out.push('')
  }
  return out.join('\n')
}
