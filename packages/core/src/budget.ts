import type { Db } from './db'

// Usage guardrails (PRD NFR-5 / FR-33). Bot turns draw from the same plan window
// as the user's own Claude usage, so an over-eager schedule can lock the human
// out of their own subscription. All counts are OUR OWN turn counts — local
// estimates, never a claim about the provider's real metering, which no vendor
// publishes.
export interface Guardrails {
  perWindow?: number // turns per 5-hour rolling window
  perWeek?: number
  perDay?: number
  quietHours?: { start: number; end: number }
}

export type BudgetVerdict = { ok: true } | { ok: false; reason: string }

export function recordTurn(db: Db, bot: string): void {
  db.prepare(`INSERT INTO turn_ledger (bot, ts) VALUES (?, datetime('now'))`).run(bot)
}

const count = (db: Db, bot: string, since: string): number =>
  (db.prepare(`SELECT count(*) c FROM turn_ledger WHERE bot = ? AND ts > datetime('now', ?)`).get(bot, since) as { c: number }).c

// `now` is injectable so quiet-hours logic is testable without waiting for 2am.
export function checkBudget(db: Db, bot: string, g: Guardrails, now = new Date()): BudgetVerdict {
  if (g.quietHours) {
    const { start, end } = g.quietHours
    const h = now.getHours()
    const inQuiet = start <= end ? h >= start && h < end : h >= start || h < end // wraps midnight
    if (inQuiet) return { ok: false, reason: `quiet hours (${start}:00–${end}:00)` }
  }
  if (g.perWindow !== undefined && count(db, bot, '-5 hours') >= g.perWindow) {
    return { ok: false, reason: `soft budget reached: ${g.perWindow} turns per 5-hour window (estimate)` }
  }
  if (g.perDay !== undefined && count(db, bot, '-1 day') >= g.perDay) {
    return { ok: false, reason: `soft budget reached: ${g.perDay} turns per day (estimate)` }
  }
  if (g.perWeek !== undefined && count(db, bot, '-7 days') >= g.perWeek) {
    return { ok: false, reason: `soft budget reached: ${g.perWeek} turns per week (estimate)` }
  }
  return { ok: true }
}
