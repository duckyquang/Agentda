import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApprovalQueue, defaultPolicy, openDb, parseApprovalReply } from '../src/index'

describe('parseApprovalReply', () => {
  it('reads the ways people actually say yes', () => {
    for (const s of ['yes', 'Y', 'ok', 'sure', 'go ahead', 'do it', 'approve', 'send it', '👍', 'Yes.']) {
      expect(parseApprovalReply(s), s).toEqual({ kind: 'allow' })
    }
  })

  it('reads the ways people say no', () => {
    for (const s of ['no', 'nope', 'stop', "don't", 'deny', 'cancel', '👎']) {
      expect(parseApprovalReply(s), s).toEqual({ kind: 'deny' })
    }
  })

  it('pulls the instruction out of an amendment', () => {
    expect(parseApprovalReply('approve but cc anna@example.com')).toEqual({
      kind: 'amend',
      instruction: 'cc anna@example.com',
    })
    expect(parseApprovalReply('yes, and use the shorter subject')).toEqual({
      kind: 'amend',
      instruction: 'use the shorter subject',
    })
  })

  it('treats a qualified no as a plain no, never an amendment', () => {
    // "don't send it but cc anna" approves nothing; reading it as an amendment
    // would turn a refusal into a modified go-ahead.
    for (const s of ['no, but cc anna', "don't send that", 'stop — wrong address', 'cancel it']) {
      expect(parseApprovalReply(s), s).toEqual({ kind: 'deny' })
    }
  })

  it('leaves ordinary messages alone', () => {
    // "no idea" starts with a no and still is not an answer, which is why a
    // bare no needs a punctuation break to count.
    for (const s of ['what does that command do?', 'yesterday I asked you to stop', '', 'ok so what happened', 'no idea what that does']) {
      expect(parseApprovalReply(s), s).toBeUndefined()
    }
  })
})

describe('answering a card by text', () => {
  const setup = () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'agentda-reply-')), 'd.db'))
    const policy = { ...defaultPolicy('ask'), grants: ['Write'] }
    return { db, policy }
  }

  it('approves the newest open card in the same thread and audits the source', async () => {
    const { db, policy } = setup()
    const q = new ApprovalQueue(db, { timeoutMs: 2000 })
    const pending = q.request({ bot: 'b', chat: 'c1', tool: 'Write', input: { path: 'x' } }, policy)
    await new Promise((r) => setTimeout(r, 10))
    expect(q.answerByText('yes', { chat: 'c1' })?.decision).toBe('allow')
    expect((await pending).source).toBe('human-text')
    const row = db.prepare('SELECT source, decision FROM audit_log ORDER BY id DESC LIMIT 1').get() as any
    expect(row).toMatchObject({ source: 'human-text', decision: 'allow' })
  })

  it('turns an amendment into a denial the model is told to act on', async () => {
    const { db, policy } = setup()
    const q = new ApprovalQueue(db, { timeoutMs: 2000 })
    const pending = q.request({ bot: 'b', chat: 'c1', tool: 'Write', input: {} }, policy)
    await new Promise((r) => setTimeout(r, 10))
    expect(q.answerByText('approve but write it to notes.md', { chat: 'c1' })?.amendment).toBe('write it to notes.md')
    const res = await pending
    expect(res.decision).toBe('deny')
    expect(res.reason).toContain('write it to notes.md')
  })

  it('ignores text that is not an answer, and cards in other threads', async () => {
    const { db, policy } = setup()
    const q = new ApprovalQueue(db, { timeoutMs: 2000 })
    void q.request({ bot: 'b', chat: 'c1', tool: 'Write', input: {} }, policy)
    await new Promise((r) => setTimeout(r, 10))
    expect(q.answerByText('what would that do?', { chat: 'c1' })).toBeUndefined()
    expect(q.answerByText('yes', { chat: 'other' })).toBeUndefined()
    expect(q.pendingCount()).toBe(1)
    q.denyAll()
  })
})
