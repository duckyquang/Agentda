import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/db'
import { DEFAULT_HANDOFF_CAP, handoffCount, tryHandoff } from '../src/handoff'

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
