import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkBudget, recordTurn } from '../src/budget'
import { openDb } from '../src/db'

const dir = mkdtempSync(join(tmpdir(), 'agentda-budget-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const db = () => openDb(join(dir, `b${n++}.db`))

describe('usage guardrails', () => {
  it('stops scheduled work at the soft window budget', () => {
    const d = db()
    expect(checkBudget(d, 'b', { perWindow: 2 }).ok).toBe(true)
    recordTurn(d, 'b')
    recordTurn(d, 'b')
    const v = checkBudget(d, 'b', { perWindow: 2 })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.reason).toContain('estimate') // never claim it's the vendor's real metering
  })

  it('counts per bot, not globally', () => {
    const d = db()
    recordTurn(d, 'noisy')
    recordTurn(d, 'noisy')
    expect(checkBudget(d, 'quiet', { perWindow: 1 }).ok).toBe(true)
  })

  it('quiet hours block, including across midnight', () => {
    const d = db()
    const at = (h: number) => new Date(2026, 0, 1, h, 0, 0)
    expect(checkBudget(d, 'b', { quietHours: { start: 22, end: 7 } }, at(23)).ok).toBe(false)
    expect(checkBudget(d, 'b', { quietHours: { start: 22, end: 7 } }, at(3)).ok).toBe(false)
    expect(checkBudget(d, 'b', { quietHours: { start: 22, end: 7 } }, at(12)).ok).toBe(true)
    expect(checkBudget(d, 'b', { quietHours: { start: 9, end: 17 } }, at(12)).ok).toBe(false)
  })
})
