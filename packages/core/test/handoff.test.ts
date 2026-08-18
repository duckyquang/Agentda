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

