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
function harness(opts: { paired?: number; deps?: Record<string, unknown> } = {}) {
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
    voice: { backend: 'openai', openaiKey: 'test-key', openaiModel: 'whisper-1' },
    ...opts.deps,
  })
  // Stop grammY from calling getMe over the network.
  bridge.bot.botInfo = { id: 1, is_bot: true, first_name: 'test', username: 'testbot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as typeof bridge.bot.botInfo
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

const voiceUpdate = (userId: number) => ({
  update_id: n++,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 42, type: 'private' as const, first_name: 'x' },
    from: { id: userId, is_bot: false, first_name: 'x' },
    voice: { file_id: 'AwAC-fake', file_unique_id: 'u1', duration: 2, mime_type: 'audio/ogg' },
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

describe('answering an approval by chat', () => {
  it('a typed yes settles the open card instead of starting a turn', async () => {
    const h = harness({ paired: 111 })
    h.bridge.bot.api.config.use(async () => ({ ok: true as const, result: {} as any }))
    const pending = h.queue.request(
      { bot: 'chief', chat: '42', tool: 'mcp__email__email_send', input: { to: 'a@b.c' } },
      { mode: 'ask', grants: ['*'], autoApprove: [], alwaysAsk: [] },
    )
    await new Promise((r) => setImmediate(r))

    await h.bridge.bot.handleUpdate(textUpdate(111, 'yes') as any)
    await expect(pending).resolves.toMatchObject({ decision: 'allow', source: 'human-text' })
    expect(h.messages).toEqual([]) // answering a card is not a new bot turn
  })

  it('an amendment denies the call and passes the instruction on', async () => {
    const h = harness({ paired: 111 })
    h.bridge.bot.api.config.use(async () => ({ ok: true as const, result: {} as any }))
    const pending = h.queue.request(
      { bot: 'chief', chat: '42', tool: 'mcp__email__email_send', input: { to: 'a@b.c' } },
      { mode: 'ask', grants: ['*'], autoApprove: [], alwaysAsk: [] },
    )
    await new Promise((r) => setImmediate(r))

    await h.bridge.bot.handleUpdate(textUpdate(111, 'approve but cc anna@example.com') as any)
    const res = await pending
    expect(res.decision).toBe('deny')
    expect(res.reason).toContain('cc anna@example.com')
  })

  it('an ordinary message with a card open is still a message', async () => {
    const h = harness({ paired: 111 })
    h.bridge.bot.api.config.use(async () => ({ ok: true as const, result: {} as any }))
    void h.queue.request(
      { bot: 'chief', chat: '42', tool: 'Write', input: {} },
      { mode: 'ask', grants: ['*'], autoApprove: [], alwaysAsk: [] },
    )
    await new Promise((r) => setImmediate(r))

    await h.bridge.bot.handleUpdate(textUpdate(111, 'what would that write exactly?') as any)
    expect(h.messages).toEqual(['what would that write exactly?'])
    expect(h.queue.pendingCount()).toBe(1)
    h.queue.denyAll()
  })
})

describe('voice notes', () => {
  const stubNetwork = (transcript: string) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) =>
      String(url).includes('api.telegram.org/file')
        ? new Response(new Uint8Array([1, 2, 3]))
        : new Response(JSON.stringify({ text: transcript }), { headers: { 'content-type': 'application/json' } }),
    )

  it('transcribes, echoes what it heard, and routes it like typed text', async () => {
    const h = harness({ paired: 111 })
    const sent: string[] = []
    h.bridge.bot.api.config.use(async (prev, method, payload: any) => {
      if (method === 'getFile') return { ok: true as const, result: { file_id: 'x', file_unique_id: 'u', file_path: 'voice/f.oga' } as any }
      if (method === 'sendMessage') sent.push(payload.text)
      return { ok: true as const, result: {} as any }
    })
    const fetchStub = stubNetwork('remind me to call the dentist')

    await h.bridge.bot.handleUpdate(voiceUpdate(111) as any)

    expect(sent[0]).toBe('🎤 "remind me to call the dentist"') // heard before acted on
    expect(h.messages).toEqual(['remind me to call the dentist'])
    fetchStub.mockRestore()
  })

  it('a spoken yes answers the open card', async () => {
    const h = harness({ paired: 111 })
    h.bridge.bot.api.config.use(async (prev, method) =>
      method === 'getFile'
        ? { ok: true as const, result: { file_id: 'x', file_unique_id: 'u', file_path: 'voice/f.oga' } as any }
        : { ok: true as const, result: {} as any },
    )
    const fetchStub = stubNetwork('yes')
    const pending = h.queue.request(
      { bot: 'chief', chat: '42', tool: 'Write', input: {} },
      { mode: 'ask', grants: ['*'], autoApprove: [], alwaysAsk: [] },
    )
    await new Promise((r) => setImmediate(r))

    await h.bridge.bot.handleUpdate(voiceUpdate(111) as any)
    await expect(pending).resolves.toMatchObject({ decision: 'allow', source: 'human-text' })
    fetchStub.mockRestore()
  })

  it('says what is missing rather than falling back to the cloud', async () => {
    const h = harness({ paired: 111, deps: { voice: { backend: 'local', whisperBin: 'whisper-cli' } } })
    const sent: string[] = []
    h.bridge.bot.api.config.use(async (prev, method, payload: any) => {
      if (method === 'getFile') return { ok: true as const, result: { file_id: 'x', file_unique_id: 'u', file_path: 'voice/f.oga' } as any }
      if (method === 'sendMessage') sent.push(payload.text)
      return { ok: true as const, result: {} as any }
    })
    const fetchStub = stubNetwork('never reached')

    await h.bridge.bot.handleUpdate(voiceUpdate(111) as any)

    expect(sent[0]).toContain('AGENTDA_WHISPER_MODEL')
    expect(h.messages).toEqual([])
    fetchStub.mockRestore()
  })
})
