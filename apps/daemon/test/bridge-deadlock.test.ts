import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalQueue, defaultPolicy, openDb, Owners } from '@agentda/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createBridge } from '../src/telegram'

// The bug this exists for: a chat bridge delivers updates ONE AT A TIME. While
// its message handler awaited a turn, the turn was blocked on an approval, and
// the Approve tap was sitting in the very next update — undeliverable, because
// the handler holding the queue open was the thing waiting for it. Every gated
// action on Telegram would have timed out to deny, with the human looking at a
// card whose buttons did nothing.
//
// It could not be caught by the other tests: they call bot.handleUpdate()
// directly, which is not the polling loop.
let stop: (() => Promise<void>) | undefined
afterEach(async () => {
  await stop?.()
  stop = undefined
})

function harness(onMessage: (reply: () => void) => Promise<void>) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'agentda-deadlock-')), 'd.db'))
  const owners = new Owners(db)
  owners.claim('telegram', owners.mintCode('telegram'), 111)
  const queue = new ApprovalQueue(db, { timeoutMs: 10_000 })

  const bridge = createBridge({
    token: '123456:fake-token-for-tests',
    owners,
    queue,
    voice: { backend: 'off' },
    personas: () => [{ id: 'chief' } as never],
    logDropped: () => {},
    onCommand: async () => {},
    onMessage: () => onMessage(() => {}),
  })
  bridge.bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'test',
    username: 'testbot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as typeof bridge.bot.botInfo

  const message = {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 42, type: 'private' as const, first_name: 'x' },
      from: { id: 111, is_bot: false, first_name: 'x' },
      text: 'send that email',
    },
  }
  const tap = {
    update_id: 2,
    callback_query: {
      id: 'cb',
      from: { id: 111, is_bot: false, first_name: 'x' },
      chat_instance: 'ci',
      data: '',
      message: { message_id: 2, date: 0, chat: { id: 42, type: 'private' as const, first_name: 'x' }, text: 'card' },
    },
  }

  // A fake Telegram that hands over the message, then — once the test has
  // aimed it at the open card — the tap. The real long-polling loop, driving
  // the real bridge.
  let sentMessage = false
  let sentTap = false
  bridge.bot.api.config.use(async (_prev, method) => {
    if (method !== 'getUpdates') return { ok: true as const, result: {} as never }
    if (!sentMessage) {
      sentMessage = true
      return { ok: true as const, result: [message] as never }
    }
    if (!sentTap && tap.callback_query.data) {
      sentTap = true
      return { ok: true as const, result: [tap] as never }
    }
    await new Promise((r) => setTimeout(r, 25))
    return { ok: true as const, result: [] as never }
  })

  stop = () => bridge.bot.stop()
  return { bridge, queue, tap, start: () => void bridge.start(() => {}) }
}

describe('a gated turn does not block the tap that answers it', () => {
  it('delivers the Approve press while the turn is still waiting', async () => {
    let settled: unknown
    const h = harness(async () => {
      // What a turn does: raise a card and wait for a human.
      settled = await h.queue.request(
        { bot: 'chief', chat: '42', tool: 'mcp__email__email_send', input: { to: 'a@b.c' } },
        { ...defaultPolicy('ask'), grants: ['*'] },
      )
    })
    h.start()

    // Wait for the card, then set the tap's payload to its id — exactly what a
    // human pressing Approve on that card would send.
    await expect.poll(() => h.queue.pendingCount(), { timeout: 5_000 }).toBe(1)
    h.tap.callback_query.data = `ok:${h.queue.open()[0].id}`

    await expect.poll(() => settled, { timeout: 5_000 }).toMatchObject({ decision: 'allow', source: 'human-tap' })
    expect(h.queue.pendingCount()).toBe(0)
  }, 30_000)
})
