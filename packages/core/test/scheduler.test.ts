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
  desktop: false,
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
    await s.drain()
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
    await s.drain()
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

  it('says a routine did not run rather than recording it as done', async () => {
    const db = openDb(join(dir, `s${n++}.db`))
    const s = new Scheduler(db, () => [persona([{ id: 'r1', cron: '* * * * *', prompt: 'go', enabled: true }])], async () => ({
      status: 'error' as const,
      detail: 'no chat to post to yet',
    }))
    await s.tick(new Date(2026, 0, 1, 9, 30, 5))
    await s.drain()
    // A green row for a routine that never ran would make the ledger useless,
    // and the ledger is the only reason to believe at-most-once means anything.
    expect(db.prepare('SELECT status, detail FROM routine_runs').get()).toMatchObject({
      status: 'error',
      detail: 'no chat to post to yet',
    })
  })

  it('never runs two copies of one routine at once, however long a run takes', async () => {
    const db = openDb(join(dir, `s${n++}.db`))
    let running = 0
    let peak = 0
    let release: () => void = () => {}
    const s = new Scheduler(db, () => [persona([{ id: 'r1', cron: '* * * * *', prompt: 'go', enabled: true }])], async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise<void>((r) => (release = r))
      running--
    })
    // A run that outlives its own cron interval — a routine parked on an
    // approval is exactly this — must not have a second copy started under it.
    await s.tick(new Date(2026, 0, 1, 9, 30, 5))
    await s.tick(new Date(2026, 0, 1, 9, 31, 5))
    await s.tick(new Date(2026, 0, 1, 9, 32, 5))
    expect(peak).toBe(1)
    release()
    await s.drain()
  })

  it('does not let one routine hold up the ones after it in the same tick', async () => {
    const db = openDb(join(dir, `s${n++}.db`))
    const started: string[] = []
    let release: () => void = () => {}
    const bots = [
      persona([{ id: 'slow', cron: '* * * * *', prompt: 'go', enabled: true }]),
      { ...persona([{ id: 'quick', cron: '* * * * *', prompt: 'go', enabled: true }]), id: 'other' },
    ]
    const s = new Scheduler(db, () => bots, async (_p, id) => {
      started.push(id)
      if (id === 'slow') await new Promise<void>((r) => (release = r))
    })
    await s.tick(new Date(2026, 0, 1, 9, 30, 5))
    // The slow one is still parked, and the other bot's routine has run anyway.
    expect(started).toEqual(['slow', 'quick'])
    release()
    await s.drain()
  })
})

