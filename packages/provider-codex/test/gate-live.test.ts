import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalQueue, defaultPolicy, HookServer, openDb } from '@agentda/core'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/index'

// LIVE: spawns the real codex binary on the user's ChatGPT plan. Opt-in via
// AGENTDA_LIVE=1.
//
// These assert the guarantee ADR 0003 actually settled on: Codex bots are
// contained by the OS sandbox, not by the hook — whose denial can lose a race
// against the tool it is meant to stop. The gate still runs and still audits,
// and that is tested too, but as defence in depth rather than the promise.
const live = process.env.AGENTDA_LIVE === '1' && loggedIn()
function loggedIn() {
  // `codex login status` reports on stderr and exits 0 either way, so reading
  // stdout alone calls a perfectly good session "not logged in".
  const r = spawnSync('codex', ['login', 'status'], { encoding: 'utf8' })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.toLowerCase().includes('logged in')
}

const root = mkdtempSync(join(tmpdir(), 'agentda-codex-live-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function harness(answer: 'allow' | 'deny' | 'never', timeoutMs = 15_000) {
  const botDir = join(root, `bot-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(botDir, 'memory'), { recursive: true })
  writeFileSync(join(botDir, 'memory', 'notes.md'), 'The project codename is Halibut.')
  const db = openDb(join(botDir, 'state.db'))
  const asked: string[] = []
  const queue = new ApprovalQueue(db, {
    timeoutMs,
    ask: (req) => {
      asked.push(req.tool)
      if (answer !== 'never') setTimeout(() => queue.settle(req.id, { decision: answer, source: 'human-tap' }), 100)
    },
  })
  // Codex names its shell tool 'Bash' and its file writer 'apply_patch'.
  const policy = { ...defaultPolicy(), grants: ['Bash', 'apply_patch'], alwaysAsk: ['Bash', 'apply_patch'] }
  const server = new HookServer(queue, () => ({ bot: 'codexbot', chat: null, policy, paused: false }), 'codexsecret')
  const audit = () => db.prepare('SELECT tool, decision, source FROM audit_log').all() as any[]
  return { botDir, db, queue, server, asked, audit }
}

async function run(h: ReturnType<typeof harness>, prompt: string, opts: { resume?: string; systemPromptFile?: string } = {}) {
  await h.server.listen()
  const text: string[] = []
  let sessionId: string | undefined
  try {
    for await (const ev of new CodexAdapter().startTurn(prompt, {
      hookCommand: h.server.shimPath(join(h.botDir, 'run'), 'codex'),
      cwd: h.botDir,
      ...opts,
    })) {
      if (ev.type === 'text') text.push(ev.text)
      if (ev.type === 'result') sessionId = ev.sessionId
    }
  } finally {
    await h.server.close()
  }
  return { text: text.join('\n'), sessionId }
}

describe.runIf(live)('codex adapter against the real CLI (ADR 0003)', () => {
  it('cannot write anything: the read-only sandbox is the guarantee, not the gate', async () => {
    const h = harness('deny')
    await run(h, 'Create a file named nope.txt containing hi. Then say DONE or BLOCKED.')
    expect(existsSync(join(h.botDir, 'nope.txt'))).toBe(false)
    // The gate saw the attempt and logged it — defence in depth on top of the
    // sandbox, and the reason an operator can review what a bot tried to do.
    expect(h.asked.length + h.audit().length).toBeGreaterThan(0)
  }, 300_000)

  it('still refuses to write even when the human approves, because the sandbox does not negotiate', async () => {
    const h = harness('allow')
    await run(h, 'Create a file named yes.txt containing hi. Then say DONE or BLOCKED.')
    expect(existsSync(join(h.botDir, 'yes.txt'))).toBe(false)
  }, 300_000)

  it('holds a conversation, reads its injected memory, and resumes the same thread', async () => {
    const h = harness('allow')
    const sys = join(h.botDir, 'system.md')
    writeFileSync(sys, 'You are a terse test bot.\n\n# Memory\nThe project codename is Halibut.')

    const first = await run(h, 'What is the project codename? One word.', { systemPromptFile: sys })
    expect(first.text.toLowerCase()).toContain('halibut') // memory reached the model
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/)

    const second = await run(h, 'What did I just ask you? One short line.', { resume: first.sessionId })
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.text.toLowerCase()).toContain('codename')
  }, 600_000)
})
