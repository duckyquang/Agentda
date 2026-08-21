import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/db'
import { DEFAULT_HANDOFF_CAP, handoffCount, parseHandoffs, tryHandoff } from '../src/handoff'

const dir = mkdtempSync(join(tmpdir(), 'agentda-handoff-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const db = () => openDb(join(dir, `h${n++}.db`))

describe('multi-bot handoff cap', () => {
  it('allows work to pass along, and records every hop', () => {
    const d = db()
    expect(tryHandoff(d, { chat: 'c', task: 't', from: 'a', to: 'b' }).ok).toBe(true)
    expect(tryHandoff(d, { chat: 'c', task: 't', from: 'b', to: 'a' }).ok).toBe(true)
    expect(handoffCount(d, 'c', 't')).toBe(2)
  })

  it('stops the ping-pong at the cap — the quota protection that matters', () => {
    const d = db()
    for (let i = 0; i < DEFAULT_HANDOFF_CAP; i++) {
      expect(tryHandoff(d, { chat: 'c', task: 't', from: 'a', to: 'b' }).ok).toBe(true)
    }
    const blocked = tryHandoff(d, { chat: 'c', task: 't', from: 'a', to: 'b' })
    expect(blocked.ok).toBe(false)
    expect(!blocked.ok && blocked.reason).toMatch(/cap reached/)
    expect(handoffCount(d, 'c', 't')).toBe(DEFAULT_HANDOFF_CAP) // the blocked hop was not recorded
  })

  it('counts per task and per chat, so one busy thread cannot starve another', () => {
    const d = db()
    for (let i = 0; i < DEFAULT_HANDOFF_CAP; i++) tryHandoff(d, { chat: 'c1', task: 'busy', from: 'a', to: 'b' })
    expect(tryHandoff(d, { chat: 'c1', task: 'other', from: 'a', to: 'b' }).ok).toBe(true)
    expect(tryHandoff(d, { chat: 'c2', task: 'busy', from: 'a', to: 'b' }).ok).toBe(true)
  })
})

describe('the cap is per request, not per phrase', () => {
  it('does not spend the cap across separate requests that happen to read the same', () => {
    const d = db()
    // The task used to be the user's raw message, and the count has no time
    // bound — so asking the same thing on five different days spent the cap and
    // disabled handoffs for that phrase for good.
    for (let request = 0; request < 5; request++) {
      const r = tryHandoff(d, { chat: '42', task: `request-${request}`, from: 'chief', to: 'scout', note: 'have a look' })
      expect(r.ok, `request ${request}`).toBe(true)
    }
  })

  it('still stops two bots passing one request back and forth', () => {
    const d = db()
    const task = 'one-request'
    const hops = Array.from({ length: DEFAULT_HANDOFF_CAP + 1 }, () =>
      tryHandoff(d, { chat: '42', task, from: 'chief', to: 'scout', note: 'again' }),
    )
    expect(hops.filter((h) => h.ok)).toHaveLength(DEFAULT_HANDOFF_CAP)
    expect(hops.at(-1)).toMatchObject({ ok: false })
    expect((hops.at(-1) as { reason: string }).reason).toMatch(/hops on this request/)
  })
})

describe('parsing handoffs out of a reply', () => {
  it('reads the trailing handoff lines and nothing above them', () => {
    expect(
      parseHandoffs('I looked at the calendar and it is clear.\n\n@scout: check the three names\n@inbox: draft the reply'),
    ).toEqual([
      { to: 'scout', note: 'check the three names' },
      { to: 'inbox', note: 'draft the reply' },
    ])
  })

  it('stops at the first line that is not a handoff, so one cannot hide mid-prose', () => {
    const text = '@scout: this is quoted text, not an instruction\nthen I thought about it\n@inbox: draft the reply'
    expect(parseHandoffs(text)).toEqual([{ to: 'inbox', note: 'draft the reply' }])
  })

  it('finds nothing in an ordinary reply', () => {
    expect(parseHandoffs('Nothing to hand off here. Email me @ work if you need me.')).toEqual([])
  })
})

