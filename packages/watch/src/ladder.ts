import type { RoutineStep } from '@agentda/core'

// How to find a recorded element on a page that has changed since.
//
// Deliberately pure: which handles to try, and in what order, is the part worth
// testing, and it needs no browser. Turning a rung into a real locator is three
// lines in the player.
//
// The order is most-specific-first, and the rule at each rung is the same:
// exactly one match or climb. Two rules that are easy to get backwards:
//
//   - MORE matches never means try something looser. A looser matcher matches
//     more, so climbing on an ambiguous rung walks away from the answer.
//   - A handle that only says "the third one" is not on this ladder at all.
//     Measured: an nth-of-type selector silently resolves to a different
//     element after a sibling is inserted, and nothing throws.
export type Rung =
  | { kind: 'selector'; value: string }
  | { kind: 'role'; role: string; name?: string; exact: boolean }
  | { kind: 'label'; value: string }
  | { kind: 'placeholder'; value: string }
  | { kind: 'testId'; value: string }
  | { kind: 'text'; value: string }

export function ladder(step: RoutineStep): Rung[] {
  const rungs: Rung[] = []
  // What the recorder produced. It is the most faithful handle while the page
  // is unchanged, and the first thing to stop matching when it changes.
  if (step.selector) rungs.push({ kind: 'selector', value: step.selector })
  if (step.role && step.name) {
    // The words on the button, which is what a human would look for and what a
    // redesign usually keeps.
    rungs.push({ kind: 'role', role: step.role, name: step.name, exact: true })
    rungs.push({ kind: 'role', role: step.role, name: step.name, exact: false })
  } else if (step.role) {
    rungs.push({ kind: 'role', role: step.role, exact: false })
  }
  if (step.label) rungs.push({ kind: 'label', value: step.label })
  if (step.placeholder) rungs.push({ kind: 'placeholder', value: step.placeholder })
  if (step.testId) rungs.push({ kind: 'testId', value: step.testId })
  // Only for things whose text IS their identity. A typed value is not a
  // handle: looking for the field by what was typed into it last time finds
  // nothing on an empty form.
  if (step.verb === 'click' && step.name) rungs.push({ kind: 'text', value: step.name })
  return rungs
}

export const describeRung = (r: Rung): string =>
  r.kind === 'role' ? `role=${r.role}${r.name ? ` name="${r.name}"${r.exact ? '' : ' (loose)'}` : ''}` : `${r.kind}=${r.value}`

export type Resolution =
  | { ok: true; rung: Rung; recovered: boolean }
  | { ok: false; reason: string }

// Walks the ladder against whatever can count matches. `counts` is injected so
// this stays testable; the player passes Playwright locators.
export async function resolveStep(
  step: RoutineStep,
  count: (rung: Rung) => Promise<number>,
): Promise<Resolution> {
  if (step.fragile) {
    return { ok: false, reason: `step ${step.n} was only recorded by position, so there is no way to know it is still the same element` }
  }
  const rungs = ladder(step)
  if (!rungs.length) return { ok: false, reason: `step ${step.n} has nothing to find the element by` }

  for (const [i, rung] of rungs.entries()) {
    let n: number
    try {
      n = await count(rung)
    } catch {
      continue // a rung the page cannot even evaluate is just a miss
    }
    if (n === 1) return { ok: true, rung, recovered: i > 0 }
    if (n > 1) {
      return {
        ok: false,
        reason: `step ${step.n}: ${describeRung(rung)} matches ${n} elements now, and picking one would be a guess`,
      }
    }
  }
  return { ok: false, reason: `step ${step.n}: none of the recorded handles match this page any more` }
}
