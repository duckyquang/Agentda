import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalQueue, type ApprovalRequest } from '../src/approvals'
import { openDb } from '../src/db'
import { defaultPolicy } from '../src/gate'

const dir = mkdtempSync(join(tmpdir(), 'agentda-approvals-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
const fresh = (opts: ConstructorParameters<typeof ApprovalQueue>[1] = {}) => {
  const db = openDb(join(dir, `q${n++}.db`))
  return { db, q: new ApprovalQueue(db, opts) }
}
const rows = (db: ReturnType<typeof openDb>) => db.prepare('SELECT * FROM audit_log ORDER BY id').all() as any[]

describe('the gate blocks, logs, and cannot be bypassed', () => {
  it('a gated tool blocks until a human answers — and the answer is what runs', async () => {
    let asked: ApprovalRequest | undefined
    const { db, q } = fresh({ ask: (r) => void (asked = r) })

    const pending = q.request({ bot: 'b', chat: 'c', tool: 'mcp__mail__send', input: { to: 'x@y.z' } }, defaultPolicy())
    await new Promise((r) => setImmediate(r))

    expect(asked).toBeDefined() // it really asked
    expect(q.pendingCount()).toBe(1) // and it is really blocked
    expect(rows(db)).toHaveLength(0) // nothing logged yet: no decision has been made

    q.settle(asked!.id, { decision: 'allow', source: 'human-tap' })
    await expect(pending).resolves.toMatchObject({ decision: 'allow', source: 'human-tap' })

    expect(rows(db)).toMatchObject([{ tool: 'mcp__mail__send', decision: 'allow', source: 'human-tap', mode: 'ask' }])
  })

  it('deny is honored and logged', async () => {
    let asked: ApprovalRequest | undefined
    const { db, q } = fresh({ ask: (r) => void (asked = r) })
    const pending = q.request({ bot: 'b', tool: 'Write', input: {} }, defaultPolicy())
    await new Promise((r) => setImmediate(r))
    q.settle(asked!.id, { decision: 'deny', source: 'human-tap', reason: 'nope' })
    await expect(pending).resolves.toMatchObject({ decision: 'deny' })
    expect(rows(db)[0]).toMatchObject({ decision: 'deny', source: 'human-tap' })
  })

  it('times out to DENY, never to allow (FR-22)', async () => {
    const { db, q } = fresh({ timeoutMs: 40 })
    const res = await q.request({ bot: 'b', tool: 'mcp__mail__send', input: {} }, defaultPolicy())
    expect(res).toMatchObject({ decision: 'deny', source: 'timeout' })
    expect(rows(db)[0]).toMatchObject({ decision: 'deny', source: 'timeout', mode: 'ask' })
    expect(q.pendingCount()).toBe(0)
  })

  it('auto mode runs gated tools unattended but ALWAYS-ASK still blocks and times out to deny', async () => {
    const { db, q } = fresh({ timeoutMs: 40 })
    const auto = defaultPolicy('auto')

    await expect(q.request({ bot: 'b', tool: 'mcp__mail__send', input: {} }, auto)).resolves.toMatchObject({
      decision: 'allow',
      source: 'auto-mode',
    })
    // Bash is on the always-ask list: in Auto it must still block, and with
    // nobody answering it must expire as denied — not sail through.
    await expect(q.request({ bot: 'b', tool: 'Bash', input: { command: 'rm -rf /' } }, auto)).resolves.toMatchObject({
      decision: 'deny',
      source: 'timeout',
    })

    expect(rows(db).map((r) => [r.tool, r.decision, r.source, r.mode])).toEqual([
      ['mcp__mail__send', 'allow', 'auto-mode', 'auto'],
      ['Bash', 'deny', 'timeout', 'auto'],
    ])
  })

  it('every decision lands in the audit log — auto-approved reads included (NFR-3)', async () => {
    const { db, q } = fresh()
    await q.request({ bot: 'b', tool: 'mcp__fs__read_file', input: {} }, { ...defaultPolicy(), autoApprove: ['mcp__fs__read_*'] })
    expect(rows(db)).toMatchObject([{ decision: 'allow', source: 'auto-class' }])
  })

  it('pending approvals are cleared on restart so no turn waits on a dead process', async () => {
    const path = join(dir, 'restart.db')
    const db1 = openDb(path)
    const q1 = new ApprovalQueue(db1, { timeoutMs: 60_000 })
    void q1.request({ bot: 'b', tool: 'Write', input: {} }, defaultPolicy())
    await new Promise((r) => setImmediate(r))
    expect(db1.prepare('SELECT count(*) c FROM pending_approvals').get()).toMatchObject({ c: 1 })
    db1.close()

    const db2 = openDb(path) // fresh daemon
    new ApprovalQueue(db2, {})
    expect(db2.prepare('SELECT count(*) c FROM pending_approvals').get()).toMatchObject({ c: 0 })
    db2.close()
  })

  it('shutdown denies everything still open instead of hanging', async () => {
    const { q } = fresh({ timeoutMs: 60_000 })
    const pending = q.request({ bot: 'b', tool: 'Write', input: {} }, defaultPolicy())
    await new Promise((r) => setImmediate(r))
    q.denyAll()
    await expect(pending).resolves.toMatchObject({ decision: 'deny' })
  })

  it('a stale settle() cannot resurrect or double-resolve a decision', async () => {
    let asked: ApprovalRequest | undefined
    const { q } = fresh({ ask: (r) => void (asked = r) })
    const pending = q.request({ bot: 'b', tool: 'Write', input: {} }, defaultPolicy())
    await new Promise((r) => setImmediate(r))
    expect(q.settle(asked!.id, { decision: 'deny', source: 'human-tap' })).toBe(true)
    expect(q.settle(asked!.id, { decision: 'allow', source: 'human-tap' })).toBe(false) // too late
    await expect(pending).resolves.toMatchObject({ decision: 'deny' })
  })
})
