import { CronExpressionParser } from 'cron-parser'
import type { Db } from './db'
import type { Persona } from './persona'

// Cron routines with at-most-once semantics across sleep and crash (NFR-4 /
// FR-34). We claim an occurrence in SQLite BEFORE running it, so a restart
// cannot re-fire the same slot, and on wake we skip anything missed rather than
// replaying a backlog — the default the plan committed to.
export interface RoutineOutcome {
  status: 'done' | 'error' | 'skipped'
  detail?: string
}

export class Scheduler {
  private timer?: NodeJS.Timeout
  // One run of a given routine at a time. Ticks overlap by design — a run that
  // waits on a human takes as long as the human does — and without this a
  // routine that runs longer than its own cron interval starts a fresh copy
  // every interval and spends the user's plan window several times over.
  private inflight = new Map<string, Promise<unknown>>()

  constructor(
    private db: Db,
    private personas: () => Persona[],
    private runRoutine: (p: Persona, routineId: string, prompt: string) => Promise<RoutineOutcome | void>,
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

  get running(): number {
    return this.inflight.size
  }

  // Waits for runs already in flight, bounded. Shutdown uses it: the database
  // is closed at the end of it, and a routine still writing its ledger row when
  // that happens throws on a closed database. Bounded, because a run parked on
  // a human could otherwise hold the process open — the approval queue is
  // denied first, which is what lets these finish at all.
  async drain(timeoutMs = 5000): Promise<void> {
    if (!this.inflight.size) return
    await Promise.race([
      Promise.allSettled([...this.inflight.values()]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ])
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
        const key = `${p.id}/${r.id}`
        if (this.inflight.has(key)) continue // still running from an earlier tick
        if (!this.claim(p.id, r.id, occurrence, 'running')) continue // already claimed

        // Claimed synchronously above, so at-most-once holds; the run itself is
        // not awaited, because a routine parked on an approval must not hold up
        // every routine after it in this tick.
        const run = this.runRoutine(p, r.id, r.prompt)
          .then((outcome) => this.finish(p.id, r.id, occurrence, outcome?.status ?? 'done', outcome?.detail))
          .catch((err: Error) => this.finish(p.id, r.id, occurrence, 'error', err.message))
          .finally(() => this.inflight.delete(key))
        this.inflight.set(key, run)
      }
    }
  }

  private finish(bot: string, routine: string, occurrence: string, status: string, detail?: string): void {
    this.db
      .prepare(`UPDATE routine_runs SET status = ?, detail = ?, ran_at = datetime('now') WHERE bot = ? AND routine = ? AND occurrence = ?`)
      .run(status, detail ?? null, bot, routine, occurrence)
  }
}
