import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalQueue, openDb, Owners } from '@agentda/core'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../src/telegram'

// The bridge's security rules, exercised through grammY's own update dispatch
// with a fake token (no network: we never call bot.start()). What matters here
// is who is allowed to talk and, above all, who is allowed to approve.
const dir = mkdtempSync(join(tmpdir(), 'agentda-tg-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
function harness(opts: { paired?: number } = {}) {
  const db = openDb(join(dir, `tg${n++}.db`))
  const owners = new Owners(db)
  if (opts.paired) owners.claim('telegram', owners.mintCode('telegram'), opts.paired)
  const queue = new ApprovalQueue(db, {})
  const dropped: string[] = []
  const messages: string[] = []
  const bridge = createBridge({
    token: '123456:fake-token-for-tests',
    owners,
    queue,
    personas: () => [{ id: 'chief' } as any],
    onMessage: async (_p, _chat, text) => void messages.push(text),
    onCommand: async (cmd) => void messages.push(`/${cmd}`),
    logDropped: (id, why) => dropped.push(`${id}:${why}`),
  })
  // Stop grammY from calling getMe over the network.
  bridge.bot.botInfo = { id: 1, is_bot: true, first_name: 'test', username: 'testbot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business_account: false, has_main_web_app: false }
  return { bridge, owners, queue, dropped, messages, db }
}

const textUpdate = (userId: number, text: string) => ({
  update_id: n++,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 42, type: 'private' as const, first_name: 'x' },
    from: { id: userId, is_bot: false, first_name: 'x' },
    text,
  },
})

const callbackUpdate = (userId: number, data: string) => ({
  update_id: n++,
  callback_query: {
    id: 'cb1',
    from: { id: userId, is_bot: false, first_name: 'x' },
    chat_instance: 'ci',
    data,
    message: {
      message_id: 2,
      date: 0,
      chat: { id: 42, type: 'private' as const, first_name: 'x' },
      text: 'approval card',
    },
  },
})

describe('telegram bridge access control', () => {
  it('a stranger gets no bot turn, and the drop is logged', async () => {
    const h = harness({ paired: 111 })
    const api = vi.spyOn(h.bridge.bot.api, 'raw', 'get').mockReturnValue({ sendMessage: async () => ({}) } as any)
    await h.bridge.bot.handleUpdate(textUpdate(999, 'hello') as any)
    expect(h.messages).toEqual([]) // never reached a bot
    expect(h.dropped[0]).toContain('999')
    api.mockRestore()
  })

  it('the paired owner is answered', async () => {
    const h = harness({ paired: 111 })
    await h.bridge.bot.handleUpdate(textUpdate(111, 'hello chief') as any)
    expect(h.messages).toEqual(['hello chief'])
    expect(h.dropped).toEqual([])
  })

  it('a non-owner CANNOT approve — the tap is rejected and the approval stays open', async () => {
    const h = harness({ paired: 111 })
    let reqId = ''
    const q = new ApprovalQueue(h.db, { ask: (r) => void (reqId = r.id) })
    const pending = q.request({ bot: 'chief', tool: 'mcp__mail__send', input: {} }, { mode: 'ask', grants: ['*'], autoApprove: [], alwaysAsk: [] })
    await new Promise((r) => setImmediate(r))

    const h2 = harness({ paired: 111 })
    h2.bridge.bot.api.config.use(async () => ({ ok: true as const, result: true as any }))
    await h2.bridge.bot.handleUpdate(callbackUpdate(999, `ok:${reqId}`) as any)

    expect(q.pendingCount()).toBe(1) // still waiting on a real owner
    expect(h2.dropped.some((d) => d.includes('999'))).toBe(true)
    q.denyAll()
    await expect(pending).resolves.toMatchObject({ decision: 'deny' })
  })

  it('first contact with no owners can only pair, not chat', async () => {
    const h = harness()
    const code = h.owners.mintCode('telegram')
    h.bridge.bot.api.config.use(async () => ({ ok: true as const, result: {} as any }))

    await h.bridge.bot.handleUpdate(textUpdate(111, 'let me in') as any)
    expect(h.messages).toEqual([]) // wrong code: no bot turn
    expect(h.owners.count('telegram')).toBe(0)

    await h.bridge.bot.handleUpdate(textUpdate(111, code) as any)
    expect(h.owners.isOwner('telegram', 111)).toBe(true)
    expect(h.messages).toEqual([]) // pairing itself is not a bot turn

    await h.bridge.bot.handleUpdate(textUpdate(111, 'now hello') as any)
    expect(h.messages).toEqual(['now hello'])
  })

  it('commands from the owner route to the command handler', async () => {
    const h = harness({ paired: 111 })
    h.bridge.bot.api.config.use(async () => ({ ok: true as const, result: {} as any }))
    await h.bridge.bot.handleUpdate(textUpdate(111, '/audit') as any)
    expect(h.messages).toEqual(['/audit'])
  })
})
