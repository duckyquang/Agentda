import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TokenStore } from '../src/index'

const store = () => new TokenStore(join(mkdtempSync(join(tmpdir(), 'agentda-tok-')), 'telegram.json'))
const REAL_SHAPE = '8123456789:AAHfake-token-material-that-is-long-enough'

describe('per-persona token registry', () => {
  it('keeps tokens out of the bot directory and off group-readable disk', () => {
    const s = store()
    s.set('chief', REAL_SHAPE)
    expect(s.get('chief')).toBe(REAL_SHAPE)
    expect(s.ids()).toEqual(['chief'])
    expect(statSync((s as any).path).mode & 0o077).toBe(0) // owner only
  })

  it('rejects anything that is not a BotFather token before it is stored', () => {
    const s = store()
    for (const bad of ['', 'hunter2', 'sk-ant-not-a-telegram-token', '123:short']) {
      expect(() => s.set('chief', bad), bad).toThrow()
    }
  })

  it('survives a corrupt registry rather than taking the daemon down with it', () => {
    const s = store()
    writeFileSync((s as any).path, '{ not json')
    expect(s.ids()).toEqual([])
    s.set('chief', REAL_SHAPE)
    expect(s.get('chief')).toBe(REAL_SHAPE)
  })

  it('forgets a token when a bot is archived', () => {
    const s = store()
    s.set('chief', REAL_SHAPE)
    s.remove('chief')
    expect(s.get('chief')).toBeUndefined()
  })
})
