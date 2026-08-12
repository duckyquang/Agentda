import { CronExpressionParser } from 'cron-parser'
import type { Db } from './db'
import type { Persona } from './persona'

// Cron routines with at-most-once semantics across sleep and crash (NFR-4 /
// FR-34). We claim an occurrence in SQLite BEFORE running it, so a restart
// cannot re-fire the same slot, and on wake we skip anything missed rather than
// replaying a backlog — the default the plan committed to.
export class Scheduler {
  private timer?: NodeJS.Timeout

  constructor(
    private db: Db,
    private personas: () => Persona[],
    private runRoutine: (p: Persona, routineId: string, prompt: string) => Promise<void>,
    private intervalMs = 30_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  // Claims the occurrence; returns false if it was already claimed.
  private claim(bot: string, routine: string, occurrence: string, status: string, detail?: string): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO routine_runs (bot, routine, occurrence, status, detail) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(bot, routine, occurrence, status, detail ?? null)
    return r.changes > 0
  }

  async tick(now = new Date()): Promise<void> {
    for (const p of this.personas()) {
      for (const r of p.routines) {
        if (!r.enabled) continue
        let due: Date
        try {
          // The most recent scheduled slot at or before now.
          due = CronExpressionParser.parse(r.cron, { currentDate: now }).prev().toDate()
        } catch {
          continue // a malformed cron is the user's to fix; never guess
        }
        // Only fire a slot that just came due. An older slot means we were
        // asleep or down: skip it (skip-on-wake default) rather than replay.
        const ageMs = now.getTime() - due.getTime()
        const occurrence = due.toISOString()
        if (ageMs > this.intervalMs * 4) {
          this.claim(p.id, r.id, occurrence, 'skipped', 'missed while the machine was asleep or the daemon was down')
          continue
        }
        if (!this.claim(p.id, r.id, occurrence, 'running')) continue // already claimed
        try {
          await this.runRoutine(p, r.id, r.prompt)
          this.finish(p.id, r.id, occurrence, 'done')
        } catch (err) {
          this.finish(p.id, r.id, occurrence, 'error', (err as Error).message)
        }
      }
    }
  }

  private finish(bot: string, routine: string, occurrence: string, status: string, detail?: string): void {
    this.db
      .prepare(`UPDATE routine_runs SET status = ?, detail = ?, ran_at = datetime('now') WHERE bot = ? AND routine = ? AND occurrence = ?`)
      .run(status, detail ?? null, bot, routine, occurrence)
  }
}
