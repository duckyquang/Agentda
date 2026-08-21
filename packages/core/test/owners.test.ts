import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/db'
import { Owners } from '../src/owners'

const dir = mkdtempSync(join(tmpdir(), 'agentda-owners-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const fresh = () => new Owners(openDb(join(dir, `o${n++}.db`)))

describe('owner pairing', () => {
  it('nobody is an owner until they pair', () => {
    const o = fresh()
    expect(o.isOwner('telegram', 123)).toBe(false)
    expect(o.count('telegram')).toBe(0)
  })

  it('a valid code pairs exactly one account, once', () => {
    const o = fresh()
    const code = o.mintCode('telegram')
    expect(o.claim('telegram', code, 111, 'me')).toBe(true)
    expect(o.isOwner('telegram', 111)).toBe(true)
    // The same code must not enroll a second person — the obvious attack.
    expect(o.claim('telegram', code, 222)).toBe(false)
    expect(o.isOwner('telegram', 222)).toBe(false)
  })

  it('a wrong or unknown code enrolls nobody', () => {
    const o = fresh()
    o.mintCode('telegram')
    expect(o.claim('telegram', 'deadbeef', 999)).toBe(false)
    expect(o.count('telegram')).toBe(0)
  })

  it('codes are scoped per platform', () => {
    const o = fresh()
    const code = o.mintCode('telegram')
    expect(o.claim('discord', code, 111)).toBe(false)
    expect(o.isOwner('discord', 111)).toBe(false)
  })

  it('numeric and string ids are the same identity (Telegram sends numbers)', () => {
    const o = fresh()
    o.claim('telegram', o.mintCode('telegram'), 555)
    expect(o.isOwner('telegram', '555')).toBe(true)
  })

  it('knows when a code is already waiting, so a later bridge does not print another', () => {
    const o = fresh()
    expect(o.hasUnusedCode('telegram')).toBe(false)
    const code = o.mintCode('telegram')
    expect(o.hasUnusedCode('telegram')).toBe(true)
    // Per platform: a Discord bridge starting still needs its own.
    expect(o.hasUnusedCode('discord')).toBe(false)
    o.claim('telegram', code, 111)
    expect(o.hasUnusedCode('telegram')).toBe(false)
  })
})

