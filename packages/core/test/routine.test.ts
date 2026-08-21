import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compileRoutine,
  defaultPolicy,
  loadRoutine,
  type Persona,
  type RawAction,
  refuseReplayOnCodex,
  renderRoutineToml,
  type Routine,
  validateRoutine,
  verbTool,
} from '../src/index'

// What the real recorder emits, taken from an actual run against Chromium
// rather than written from memory.
const RECORDED: RawAction[] = [
  { name: 'navigate', url: 'http://127.0.0.1:1234/invoices' },
  {
    name: 'fill',
    ref: 'e5',
    selector: 'internal:role=textbox[name="Amount"i]',
    text: '42.00',
    ariaSnapshot: '- textbox "Amount" [ref=e5]:\n  - text: "42.00"',
  },
  {
    name: 'fill',
    ref: 'e6',
    selector: 'internal:role=textbox[name="Password"i]',
    text: 'hunter2',
    ariaSnapshot: '- textbox "Password" [active] [ref=e6]: hunter2',
  },
  { name: 'select', ref: 'e7', selector: 'internal:role=combobox[name="Account"i]', options: ['Savings'] },
  { name: 'click', ref: 'e8', selector: 'internal:role=button[name="Send payment"i]' },
]

const compiled = () => compileRoutine(RECORDED, { recordedAt: '2026-08-21T09:00:00Z', recordedUrl: 'http://127.0.0.1:1234/invoices' })

describe('compiling a recording into a routine', () => {
  it('keeps the durable handles and drops the ephemeral ref', () => {
    const { routine } = compiled()
    const amount = routine.steps.find((s) => s.name === 'Amount')!
    expect(amount).toMatchObject({ verb: 'type', role: 'textbox', name: 'Amount', text: '42.00' })
    // ref=e5 is this session's handle and means nothing tomorrow.
    expect(JSON.stringify(routine)).not.toContain('e5')
  })

  it('never writes down a secret, in the step or anywhere else in the file', () => {
    const { routine, notes } = compiled()
    const rendered = renderRoutineToml(routine, notes)
    // The recorder emits the typed value in the action AND inside the aria
    // snapshot — measured, both. Neither may reach the file.
    expect(rendered).not.toContain('hunter2')
    expect(JSON.stringify(routine)).not.toContain('hunter2')
    // And it becomes a stop, not a silently missing step.
    const step = routine.steps.find((s) => s.name === 'Password')!
    expect(step.verb).toBe('handback')
    expect(notes.join(' ')).toMatch(/hands the browser to you/)
  })

  it('marks a step that spends money as one that keeps asking', () => {
    const { routine } = compiled()
    expect(routine.steps.find((s) => s.name === 'Send payment')!.sensitive).toBe(true)
    expect(routine.steps.find((s) => s.name === 'Amount')!.sensitive).toBe(false)
  })

  it('gives every acting step something to check afterwards', () => {
    const { routine } = compiled()
    for (const s of routine.steps.filter((x) => ['type', 'click', 'select'].includes(x.verb))) {
      expect(s.expect, `step ${s.n}`).toBeTruthy()
    }
  })

  it('refuses to compile a file upload rather than dropping the step', () => {
    const { routine, notes } = compileRoutine([{ name: 'setInputFiles', selector: 'input' }], { recordedAt: 'now' })
    expect(routine.steps).toEqual([])
    expect(notes.join(' ')).toMatch(/uploads a file/)
  })

  it('marks a position-only handle fragile, and says so', () => {
    const { routine, notes } = compileRoutine(
      [{ name: 'click', selector: 'form input:nth-of-type(1)' }],
      { recordedAt: 'now' },
    )
    expect(routine.steps[0].fragile).toBe(true)
    expect(notes.join(' ')).toMatch(/by position/)
  })

  it('writes a draft nobody has approved yet', () => {
    const { routine } = compiled()
    expect(routine.reviewed).toBe(false)
    expect(renderRoutineToml(routine)).toContain('reviewed = false')
  })

  it('round-trips through the file a human would edit', () => {
    const { routine, notes } = compiled()
    const path = join(mkdtempSync(join(tmpdir(), 'agentda-routine-')), 'r.toml')
    writeFileSync(path, renderRoutineToml(routine, notes))
    const back = loadRoutine(path)
    expect(back.steps.map((s) => s.verb)).toEqual(routine.steps.map((s) => s.verb))
    expect(back.steps.map((s) => s.name)).toEqual(routine.steps.map((s) => s.name))
    expect(back.reviewed).toBe(false)
  })
})

const routine = (over: Partial<Routine> = {}): Routine => ({
  version: 1,
  recordedAt: 'now',
  reviewed: true,
  steps: [
    { n: 1, verb: 'navigate', tool: verbTool('navigate'), url: 'https://x.test/', sensitive: false, fragile: false, expect: 'url:/' },
    {
      n: 2,
      verb: 'click',
      tool: verbTool('click'),
      selector: 'internal:role=button[name="Pay"i]',
      role: 'button',
      name: 'Pay',
      sensitive: true,
      fragile: false,
      expect: 'text:Payment sent',
    },
  ],
  ...over,
})

describe('what has to be true before a routine replays', () => {
  it('accepts a reviewed routine whose steps are complete', () => {
    expect(validateRoutine(routine())).toEqual([])
  })

  it('refuses one nobody has read', () => {
    expect(validateRoutine(routine({ reviewed: false })).join(' ')).toMatch(/reviewed/)
  })

  it('refuses a step whose tool name disagrees with its verb', () => {
    // The tool name is what the gate sees and what the card shows. If the file
    // says click and names the navigate tool, the human approves one thing and
    // another runs.
    const r = routine()
    r.steps[1].tool = 'mcp__browser__browser_navigate'
    expect(validateRoutine(r).join(' ')).toMatch(/says click but names the tool/)
  })

  it('refuses an acting step with nothing to check afterwards', () => {
    const r = routine()
    r.steps[1].expect = undefined
    expect(validateRoutine(r).join(' ')).toMatch(/no expect/)
  })

  it('refuses an expect it does not understand', () => {
    const r = routine()
    r.steps[1].expect = 'vibes:good'
    expect(validateRoutine(r).join(' ')).toMatch(/is not one of/)
  })

  it('refuses an acting step with nothing durable to find the element by', () => {
    const r = routine()
    r.steps[1].selector = undefined
    r.steps[1].role = undefined
    r.steps[1].name = undefined
    expect(validateRoutine(r).join(' ')).toMatch(/nothing durable/)
  })

  it('refuses an empty routine', () => {
    expect(validateRoutine(routine({ steps: [] })).join(' ')).toMatch(/no steps/)
  })
})

describe('replaying on a provider that has no browser', () => {
  const persona = (providers: string[]): Persona =>
    ({ id: 'chief', providers: providers.map((provider) => ({ provider })), policy: defaultPolicy() }) as Persona

  it('refuses a codex-only bot with the reason', () => {
    expect(refuseReplayOnCodex(persona(['codex']))).toMatch(/ADR 0003/)
  })

  it('allows one that can fall back to a provider with hands', () => {
    expect(refuseReplayOnCodex(persona(['codex', 'claude']))).toBeUndefined()
  })
})
