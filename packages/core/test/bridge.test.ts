import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalQueue, Bridge, type BridgeTransport, defaultPolicy, LiveChecklist, openDb, Owners, type Persona } from '../src/index'

// The rules every platform has to enforce identically (FR-18). They are tested
// once, here, against a transport that is only a recorder — Telegram, Slack and
// Discord all run this same code, so a parity bug would have to be a bug in
// their SDK wiring rather than in who is allowed to approve.
const persona = (id: string): Persona =>
  ({ id, name: id, dir: '/tmp', prompt: '', provider: 'claude', providers: [], policy: defaultPolicy() }) as unknown as Persona

function fakeTransport() {
  const sent: { chat: string; text: string }[] = []
  const edits: { id: string; text: string }[] = []
  const cards: { chat: string; id: string }[] = []
  const closed: string[] = []
  let n = 0
  const transport: BridgeTransport = {
    platform: 'testchat',
    send: async (chat, text) => {
      sent.push({ chat, text })
      return { chat, messageId: `m${n++}` }
    },
    edit: async (ref, text) => void edits.push({ id: ref.messageId, text }),
    askApproval: async (chat, req) => {
      cards.push({ chat, id: req.id })
      return { chat, messageId: `card-${req.id}` }
    },
    closeCard: async (ref) => void closed.push(ref.messageId),
  }
  return { transport, sent, edits, cards, closed }
}

function harness(opts: { paired?: string; bound?: string; role?: 'owner' | 'approver' | 'member' } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'agentda-bridge-')), 'd.db'))
  const owners = new Owners(db)
  if (opts.paired) owners.claim('testchat', owners.mintCode('testchat', opts.role ?? 'owner'), opts.paired)
  const queue = new ApprovalQueue(db, { timeoutMs: 5000 })
  const t = fakeTransport()
  const turns: { bot: string; text: string }[] = []
  const commands: string[] = []
  const dropped: string[] = []
  const replies: string[] = []
  const bots = [persona('chief'), persona('scout')]
  const bridge = new Bridge(t.transport, {
    owners,
    queue,
    personas: () => bots,
    bound: opts.bound ? () => bots.find((p) => p.id === opts.bound) : undefined,
    onMessage: async (p, _chat, text) => void turns.push({ bot: p.id, text }),
    onCommand: async (cmd) => void commands.push(cmd),
    logDropped: (id, why) => dropped.push(`${id}:${why}`),
  })
  const reply = async (s: string) => void replies.push(s)
  return { bridge, queue, owners, turns, commands, dropped, replies, reply, ...t }
}

describe('bridge rules, shared by every platform', () => {
  it('answers the paired owner and drops a stranger', async () => {
    const h = harness({ paired: 'U1' })
    expect(await h.bridge.authenticate('U1', 'hello', h.reply)).toBe(true)
    expect(await h.bridge.authenticate('U999', 'hello', h.reply)).toBe(false)
    expect(h.dropped[0]).toContain('U999')
  })

  it('first contact with no owner can only pair', async () => {
    const h = harness()
    const code = h.owners.mintCode('testchat')
    expect(await h.bridge.authenticate('U1', 'let me in', h.reply)).toBe(false)
    expect(h.owners.count('testchat')).toBe(0)
    expect(await h.bridge.authenticate('U1', code, h.reply)).toBe(false) // pairing is not a turn
    expect(h.owners.isOwner('testchat', 'U1')).toBe(true)
    expect(await h.bridge.authenticate('U1', 'now hello', h.reply)).toBe(true)
  })

  it('a button press from a non-owner never settles anything', async () => {
    const h = harness({ paired: 'U1' })
    const pending = h.queue.request({ bot: 'chief', chat: 'C1', tool: 'Write', input: {} }, { ...defaultPolicy(), grants: ['*'] })
    await new Promise((r) => setImmediate(r))
    const id = h.queue.open()[0].id

    expect(h.bridge.decide('U999', `ok:${id}`)).toMatchObject({ ok: false, text: 'Not your bot.' })
    expect(h.queue.pendingCount()).toBe(1)

    expect(h.bridge.decide('U1', `ok:${id}`)).toMatchObject({ ok: true, text: 'Approved' })
    await expect(pending).resolves.toMatchObject({ decision: 'allow', source: 'human-tap' })
  })

  it('routes commands, card answers, and addressed messages', async () => {
    const h = harness({ paired: 'U1' })
    await h.bridge.inbound('/audit', 'C1', true, h.reply)
    expect(h.commands).toEqual(['audit'])

    await h.bridge.inbound('scout: look this up', 'C1', false, h.reply)
    expect(h.turns).toEqual([{ bot: 'scout', text: 'scout: look this up' }])

    // In a group nobody is addressed by default: acting anyway is how two bots
    // start answering each other.
    await h.bridge.inbound('what do you think', 'C1', false, h.reply)
    expect(h.turns).toHaveLength(1)
    expect(h.replies.at(-1)).toContain('Name a bot')
  })

  it('a bound bridge speaks for its one persona without being named', async () => {
    const h = harness({ paired: 'U1', bound: 'scout' })
    await h.bridge.inbound('anything at all', 'C1', true, h.reply)
    expect(h.turns).toEqual([{ bot: 'scout', text: 'anything at all' }])
  })

  it('a typed answer settles the open card rather than starting a turn', async () => {
    const h = harness({ paired: 'U1' })
    const pending = h.queue.request({ bot: 'chief', chat: 'C1', tool: 'Write', input: {} }, { ...defaultPolicy(), grants: ['*'] })
    await new Promise((r) => setImmediate(r))
    await h.bridge.inbound('yes', 'C1', true, h.reply)
    await expect(pending).resolves.toMatchObject({ decision: 'allow', source: 'human-text' })
    expect(h.turns).toEqual([])
  })

  it('closes only the card it posted', async () => {
    const h = harness({ paired: 'U1' })
    void h.queue.request({ bot: 'chief', chat: 'C1', tool: 'Write', input: {} }, { ...defaultPolicy(), grants: ['*'] })
    await new Promise((r) => setImmediate(r))
    const req = h.queue.open()[0]
    await h.bridge.ask(req, 'C1')
    expect(h.cards).toEqual([{ chat: 'C1', id: req.id }])

    await h.bridge.closeCard('some-other-id', 'deny (timeout)')
    expect(h.closed).toEqual([])
    await h.bridge.closeCard(req.id, 'deny (timeout)')
    expect(h.closed).toEqual([`card-${req.id}`])
    h.queue.denyAll()
  })
})

describe('a team, where being paired is not the same as being allowed to approve', () => {
  it('a member may talk but their tap does not count', async () => {
    const h = harness({ paired: 'U1', role: 'member' })
    const pending = h.queue.request({ bot: 'chief', chat: 'C1', tool: 'Write', input: {} }, { ...defaultPolicy(), grants: ['*'] })
    await new Promise((r) => setImmediate(r))
    const id = h.queue.open()[0].id

    // They can use the bots.
    expect(await h.bridge.authenticate('U1', 'hello', h.reply)).toBe(true)
    // They cannot answer for them.
    const verdict = h.bridge.decide('U1', `ok:${id}`)
    expect(verdict.ok).toBe(false)
    expect(verdict.text).toMatch(/cannot approve/)
    expect(h.queue.pendingCount()).toBe(1)
    h.queue.denyAll()
    await pending
  })

  it('and typing yes is not a way around the button', async () => {
    const h = harness({ paired: 'U1', role: 'member' })
    void h.queue.request({ bot: 'chief', chat: 'C1', tool: 'Write', input: {} }, { ...defaultPolicy(), grants: ['*'] })
    await new Promise((r) => setImmediate(r))

    await h.bridge.inbound('yes', 'C1', true, h.reply, 'U1')
    expect(h.queue.pendingCount()).toBe(1)
    h.queue.denyAll()
  })

  it('an approver’s decision is recorded under their name', async () => {
    const h = harness({ paired: 'U2', role: 'approver' })
    const pending = h.queue.request({ bot: 'chief', chat: 'C1', tool: 'Write', input: {} }, { ...defaultPolicy(), grants: ['*'] })
    await new Promise((r) => setImmediate(r))
    expect(h.bridge.decide('U2', `ok:${h.queue.open()[0].id}`).ok).toBe(true)
    await expect(pending).resolves.toMatchObject({ decision: 'allow', by: 'testchat:U2' })
  })
})

describe('live checklist', () => {
  beforeEach(() => vi.useRealTimers())

  it('posts once and edits in place instead of spamming the thread', async () => {
    const t = fakeTransport()
    const list = new LiveChecklist(t.transport, 'C1', 'working…', 0)
    list.add('browser_navigate')
    list.mark('browser_navigate', 'ok')
    list.add('browser_click')
    list.mark('browser_click', 'wait')
    await list.finish()

    expect(t.sent).toHaveLength(1)
    expect(t.edits.length).toBeGreaterThan(0)
    const final = t.edits.at(-1)!.text
    expect(final).toContain('✓ browser_navigate')
    expect(final).toContain('◷ browser_click')
  })

  it('coalesces edits inside the throttle window, because these platforms rate-limit them', async () => {
    const t = fakeTransport()
    const list = new LiveChecklist(t.transport, 'C1', 'working…', 10_000)
    list.add('a')
    list.add('b')
    list.add('c')
    await new Promise((r) => setTimeout(r, 30))
    expect(t.sent).toHaveLength(1) // one post…
    expect(t.edits).toHaveLength(0) // …and no edit yet: still inside the window
    await list.finish() // the final paint is forced, so the last state always lands
    expect(t.edits.at(-1)!.text).toContain('· c')
  })

  it('says nothing at all when there were no steps', async () => {
    const t = fakeTransport()
    await new LiveChecklist(t.transport, 'C1', 'working…', 0).finish()
    expect(t.sent).toEqual([])
  })
})