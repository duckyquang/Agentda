import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalQueue, defaultPolicy, HookServer, openDb } from '@agentda/core'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/index'

// LIVE tests: these spawn the real `claude` binary and spend real subscription
// tokens, so they are opt-in via AGENTDA_LIVE=1 (CI runs without it). They exist
// because the gate's whole value is that it holds against the actual CLI —
// unit tests of our own logic cannot prove that.
const live = process.env.AGENTDA_LIVE === '1' && hasClaude()
function hasClaude() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const dir = mkdtempSync(join(tmpdir(), 'agentda-live-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function runGated(opts: {
  prompt: string
  answer: 'allow' | 'deny' | 'never'
  timeoutMs?: number
}) {
  const db = openDb(join(dir, `live-${Math.random().toString(36).slice(2)}.db`))
  const queue = new ApprovalQueue(db, {
    timeoutMs: opts.timeoutMs ?? 30_000,
    ask: (req) => {
      if (opts.answer !== 'never') {
        // Answer like a human would, a beat later.
        setTimeout(() => queue.settle(req.id, { decision: opts.answer as 'allow' | 'deny', source: 'human-tap' }), 250)
      }
    },
  })
  // Write is granted (available to the bot) but not auto-approved — exactly the
  // case the gate exists for: the tool exists, and still nothing runs until a
  // human says so.
  const policy = { ...defaultPolicy(), grants: ['Write'] }
  const server = new HookServer(queue, () => ({ bot: 'live', chat: null, policy, paused: false }), 'testsecret')
  await server.listen()
  const settings = server.writeSettings(dir)

  const text: string[] = []
  try {
    for await (const ev of new ClaudeAdapter().startTurn(opts.prompt, { tools: ['Write'], settings })) {
      if (ev.type === 'text') text.push(ev.text)
    }
  } finally {
    await server.close()
  }
  const audit = db.prepare('SELECT tool, decision, source, mode FROM audit_log').all() as any[]
  db.close()
  return { text: text.join(''), audit }
}

describe.runIf(live)('gate against the real claude CLI', () => {
  it('denies a gated write: the file is never created and the denial is audited', async () => {
    const target = join(dir, 'denied.txt')
    const { audit } = await runGated({
      prompt: `Use the Write tool to create the file ${target} containing hi. If it is blocked, reply DENIED.`,
      answer: 'deny',
    })
    expect(existsSync(target)).toBe(false) // the gate physically stopped it
    // A model may retry after a denial, so assert on every row rather than a
    // fixed length: what matters is that nothing was ever allowed.
    expect(audit.length).toBeGreaterThan(0)
    expect(audit.every((r) => r.tool === 'Write' && r.decision === 'deny' && r.mode === 'ask')).toBe(true)
  }, 180_000)

  it('allows a gated write only after the human approves', async () => {
    const target = join(dir, 'allowed.txt')
    const { audit } = await runGated({
      prompt: `Use the Write tool to create the file ${target} containing hi. Then reply DONE.`,
      answer: 'allow',
    })
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('hi')
    expect(audit.some((r) => r.tool === 'Write' && r.decision === 'allow' && r.source === 'human-tap')).toBe(true)
  }, 180_000)

  it('an unanswered approval times out to deny without wedging the turn', async () => {
    const target = join(dir, 'timeout.txt')
    const { audit } = await runGated({
      prompt: `Use the Write tool to create the file ${target} containing hi. If blocked, reply DENIED.`,
      answer: 'never',
      timeoutMs: 5_000,
    })
    expect(existsSync(target)).toBe(false)
    expect(audit.length).toBeGreaterThan(0)
    expect(audit.every((r) => r.decision === 'deny')).toBe(true)
    expect(audit.some((r) => r.source === 'timeout')).toBe(true)
  }, 180_000)
})
