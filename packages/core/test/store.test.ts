import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { SessionStore } from '../src/store'

const dir = mkdtempSync(join(tmpdir(), 'agentda-store-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('round-trips and survives reopen', () => {
  const path = join(dir, 'nested', 'agentda.db') // ctor must create parent dirs
  let store = new SessionStore(path)
  expect(store.get('default', 'local', 'claude')).toBeUndefined()

  store.set('default', 'local', 'claude', 'session-1')
  store.set('default', 'local', 'claude', 'session-2') // upsert wins
  expect(store.get('default', 'local', 'claude')).toBe('session-2')
  store.close()

  store = new SessionStore(path) // restart survival is the whole point (PLAN Phase 0)
  expect(store.get('default', 'local', 'claude')).toBe('session-2')
  store.clear('default', 'local', 'claude')
  expect(store.get('default', 'local', 'claude')).toBeUndefined()
  store.close()
})
