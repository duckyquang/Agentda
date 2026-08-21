import type { RoutineStep } from '@agentda/core'
import { describe, expect, it } from 'vitest'
import { describeRung, ladder, resolveStep, type Rung } from '../src/ladder'

const step = (over: Partial<RoutineStep> = {}): RoutineStep => ({
  n: 1,
  verb: 'click',
  selector: 'internal:role=button[name="Pay now"i]',
  role: 'button',
  name: 'Pay now',
  sensitive: false,
  fragile: false,
  expect: 'text:Paid',
  ...over,
})

describe('which handles to try, and in what order', () => {
  it('tries the recorded selector first, then the words on the element', () => {
    expect(ladder(step()).map(describeRung)).toEqual([
      'selector=internal:role=button[name="Pay now"i]',
      'role=button name="Pay now"',
      'role=button name="Pay now" (loose)',
      'text=Pay now',
    ])
  })

  it('does not look for a field by what was typed into it', () => {
    // The typed value is not a handle: an empty form has nothing containing it.
    const rungs = ladder(step({ verb: 'type', name: 'Amount', text: '42.00' }))
    expect(rungs.some((r) => r.kind === 'text')).toBe(false)
  })

  it('uses the visible text as a last resort for a click, where the text is the identity', () => {
    expect(ladder(step()).at(-1)).toMatchObject({ kind: 'text', value: 'Pay now' })
    expect(ladder(step({ label: 'Amount', placeholder: '0.00', testId: 'pay' })).map((r) => r.kind)).toEqual([
      'selector',
      'role',
      'role',
      'label',
      'placeholder',
      'testId',
      'text',
    ])
  })
})

const counter = (counts: Record<string, number>) => async (r: Rung) => counts[describeRung(r)] ?? 0

describe('resolving a step against a page that has moved on', () => {
  it('takes the recorded selector when it still matches exactly one', async () => {
    const found = await resolveStep(step(), counter({ 'selector=internal:role=button[name="Pay now"i]': 1 }))
    expect(found).toMatchObject({ ok: true, recovered: false })
  })

  it('climbs to the words on the button when the markup changed', async () => {
    const found = await resolveStep(step(), counter({ 'role=button name="Pay now"': 1 }))
    expect(found).toMatchObject({ ok: true, recovered: true })
    expect(found.ok && describeRung(found.rung)).toBe('role=button name="Pay now"')
  })

  it('refuses to climb when a rung is ambiguous, because looser matches more', async () => {
    // Two "Pay now" buttons is not a reason to try a vaguer description; it is
    // a reason to stop and ask a human which one they meant.
    const found = await resolveStep(step(), counter({ 'selector=internal:role=button[name="Pay now"i]': 3, 'role=button name="Pay now"': 1 }))
    expect(found).toMatchObject({ ok: false })
    expect(found.ok === false && found.reason).toMatch(/matches 3 elements/)
  })

  it('gives up when nothing matches any more', async () => {
    const found = await resolveStep(step(), counter({}))
    expect(found).toMatchObject({ ok: false })
    expect(found.ok === false && found.reason).toMatch(/none of the recorded handles/)
  })

  it('never acts on a handle that only says "the third one"', async () => {
    // Measured: a positional selector silently resolves to a DIFFERENT element
    // after a sibling is inserted, and nothing throws — so there is no failure
    // to recover from, only a wrong click.
    const found = await resolveStep(step({ fragile: true }), counter({ 'selector=internal:role=button[name="Pay now"i]': 1 }))
    expect(found).toMatchObject({ ok: false })
    expect(found.ok === false && found.reason).toMatch(/only recorded by position/)
  })

  it('treats a rung the page cannot evaluate as a miss, not a crash', async () => {
    const found = await resolveStep(step(), async (r) => {
      if (r.kind === 'selector') throw new Error('bad selector syntax')
      return 1
    })
    expect(found).toMatchObject({ ok: true, recovered: true })
  })

  it('refuses a step with no handles at all', async () => {
    const bare = step({ selector: undefined, role: undefined, name: undefined })
    expect(await resolveStep(bare, counter({}))).toMatchObject({ ok: false })
  })
})
