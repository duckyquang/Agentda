import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/db'
import type { Persona } from '../src/persona'
import { Scheduler } from '../src/scheduler'

const dir = mkdtempSync(join(tmpdir(), 'agentda-sched-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0

const persona = (routines: Persona['routines']): Persona => ({
  id: 'b',
  dir: '/tmp/nope',
  name: 'b',
  prompt: '',
  provider: 'claude',
  providers: [{ provider: 'claude' }],
  allowMeteredFailover: false,
  policy: { mode: 'ask', grants: [], autoApprove: [], alwaysAsk: [] },
  packs: [],
  coordinator: false,
  tools: [],
  agentdaTools: false,
  browser: false,
  email: false,
  browserSurface: 'shadow' as const,
  scope: [],
  routines,
})

describe('scheduler at-most-once semantics', () => {
  it('fires a due routine exactly once, even if ticked repeatedly', async () => {
    const db = openDb(join(dir, `s${n++}.db`))
    const fired: string[] = []
    const s = new Scheduler(db, () => [persona([{ id: 'r1', cron: '* * * * *', prompt: 'go', enabled: true }])], async (_p, id) => {
      fired.push(id)
    })
    const now = new Date(2026, 0, 1, 9, 30, 5) // 5s past a minute boundary
    await s.tick(now)
    await s.tick(now)
    await s.tick(new Date(now.getTime() + 1000))
    expect(fired).toEqual(['r1']) // one occurrence, one run
  })

  it('skips a missed occurrence after sleep instead of replaying it', async () => {
    const db = openDb(join(dir, `s${n++}.db`))
    const fired: string[] = []
    const s = new Scheduler(db, () => [persona([{ id: 'r1', cron: '0 9 * * *', prompt: 'go', enabled: true }])], async (_p, id) => {
      fired.push(id)
    })
    // Machine woke at 14:00; the 09:00 slot is long gone.
    await s.tick(new Date(2026, 0, 1, 14, 0, 0))
    expect(fired).toEqual([])
    const row = db.prepare('SELECT status, detail FROM routine_runs').get() as any
    expect(row.status).toBe('skipped')
    expect(row.detail).toMatch(/asleep|down/)
  })

  it('does not run disabled routines', async () => {
    const db = openDb(join(dir, `s${n++}.db`))
    const fired: string[] = []
    const s = new Scheduler(db, () => [persona([{ id: 'r1', cron: '* * * * *', prompt: 'go', enabled: false }])], async (_p, id) => {
      fired.push(id)
    })
    await s.tick(new Date(2026, 0, 1, 9, 30, 5))
    expect(fired).toEqual([])
  })

  it('records an error without losing the claim (no retry storm)', async () => {
    const db = openDb(join(dir, `s${n++}.db`))
    let calls = 0
    const s = new Scheduler(db, () => [persona([{ id: 'r1', cron: '* * * * *', prompt: 'go', enabled: true }])], async () => {
      calls++
      throw new Error('provider exploded')
    })
    const now = new Date(2026, 0, 1, 9, 30, 5)
    await s.tick(now)
    await s.tick(now)
    expect(calls).toBe(1)
    expect(db.prepare('SELECT status, detail FROM routine_runs').get()).toMatchObject({ status: 'error', detail: 'provider exploded' })
  })

  it('a malformed cron is skipped, not guessed at', async () => {
    const db = openDb(join(dir, `s${n++}.db`))
    const fired: string[] = []
    const s = new Scheduler(db, () => [persona([{ id: 'r1', cron: 'not a cron', prompt: 'go', enabled: true }])], async (_p, id) => {
      fired.push(id)
    })
    await expect(s.tick(new Date())).resolves.toBeUndefined()
    expect(fired).toEqual([])
  })
})
