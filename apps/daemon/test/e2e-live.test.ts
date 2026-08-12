import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ApprovalQueue,
  HookServer,
  loadPersonas,
  openDb,
  type Persona,
  SessionStore,
  TurnRunner,
} from '@agentda/core'
import { ClaudeAdapter } from '@agentda/provider-claude'
import { afterAll, describe, expect, it } from 'vitest'

// Full-stack live tests: real claude binary, real MCP server, real gate. Opt-in
// via AGENTDA_LIVE=1 because they spend subscription tokens. These are what
// prove the Phase 1 exit criteria that don't need Telegram.
const live = process.env.AGENTDA_LIVE === '1' && hasClaude()
function hasClaude() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'agentda-e2e-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function makeBot(id: string, cfg: string, prompt = 'You are a terse test bot. Do exactly what is asked, briefly.'): string {
  const dir = join(root, 'bots', id)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'bot.toml'), cfg)
  writeFileSync(join(dir, 'prompt.md'), prompt)
  return dir
}

function harness(personas: Persona[], opts: { answer?: 'allow' | 'deny' | 'never'; timeoutMs?: number } = {}) {
  const dbPath = join(root, `e2e-${Math.random().toString(36).slice(2)}.db`)
  const db = openDb(dbPath)
  const sessions = new SessionStore(dbPath)
  const asked: string[] = []
  const queue = new ApprovalQueue(db, {
    timeoutMs: opts.timeoutMs ?? 20_000,
    ask: (req) => {
      asked.push(req.tool)
      if (opts.answer && opts.answer !== 'never') {
        setTimeout(() => queue.settle(req.id, { decision: opts.answer as 'allow' | 'deny', source: 'human-tap' }), 200)
      }
    },
  })
  const current = { persona: personas[0] }
  const hook = new HookServer(
    queue,
    () => ({ bot: current.persona.id, chat: 'test', policy: current.persona.policy, paused: false }),
    'e2esecret',
  )
  const runner = () =>
    new TurnRunner({
      db,
      sessions,
      queue,
      hook,
      adapters: new Map([['claude', new ClaudeAdapter()]]),
      settingsPath: hook.writeSettings(join(root, 'run')),
      mcpEntries: (p) => ({
        agentda: {
          command: process.execPath,
          args: [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'packages/mcp-agentda/src/index.ts')],
          env: { AGENTDA_BOT_DIR: p.dir, AGENTDA_SCOPE: p.scope.join(':') },
        },
        ...(p.browser && {
          browser: {
            command: process.execPath,
            args: [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'packages/mcp-browser/src/index.ts')],
            env: { AGENTDA_BROWSER_PROFILE: join(p.dir, 'browser-profile'), AGENTDA_BROWSER_SURFACE: p.browserSurface },
          },
        }),
      }),
    })
  const audit = () => db.prepare('SELECT tool, decision, source, mode FROM audit_log ORDER BY id').all() as any[]
  return { db, hook, queue, runner, audit, asked, current }
}

const GATED_BOT = `
id = "tester"
provider = "claude"
mode = "ask"
agentda_tools = true
auto_approve = ["mcp__agentda__memory_read"]
always_ask = ["Bash"]
`

describe.runIf(live)('Phase 1 end to end, real CLI + real MCP server', () => {
  it('memory survives a "restart": one turn writes it, a brand-new stack reads it back', async () => {
    const dir = makeBot('tester', GATED_BOT)
    const personas = loadPersonas(join(root, 'bots'))
    const h = harness(personas, { answer: 'allow' })
    await h.hook.listen()

    const write = await h
      .runner()
      .run(personas[0], 'test', 'Use memory_write to save a file named fact.md whose entire content is: the sky is teal. Then reply SAVED.')
    expect(write.error).toBeUndefined()
    expect(readFileSync(join(dir, 'memory', 'fact.md'), 'utf8')).toMatch(/teal/i)
    await h.hook.close()

    // A completely fresh stack — new db, new sessions, no provider session to
    // resume — must still know the fact, because memory is files on disk that
    // get injected into the system prompt.
    const fresh = harness(loadPersonas(join(root, 'bots')), { answer: 'allow' })
    await fresh.hook.listen()
    const read = await fresh.runner().run(loadPersonas(join(root, 'bots'))[0], 'other-chat', 'What colour is the sky, per your memory? One word.')
    await fresh.hook.close()
    expect(read.text.toLowerCase()).toContain('teal')
  }, 240_000)

  it('a gated write blocks until approval; denial means the file never appears', async () => {
    makeBot('denier', GATED_BOT.replace('id = "tester"', 'id = "denier"'))
    const personas = loadPersonas(join(root, 'bots')).filter((p) => p.id === 'denier')
    const h = harness(personas, { answer: 'deny' })
    await h.hook.listen()
    await h.runner().run(personas[0], 'test', 'Use memory_write to save a file named nope.md containing hi. If blocked, reply DENIED.')
    await h.hook.close()

    expect(h.asked).toContain('mcp__agentda__memory_write')
    expect(h.audit().some((r) => r.tool === 'mcp__agentda__memory_write' && r.decision === 'deny')).toBe(true)
    expect(() => readFileSync(join(root, 'bots', 'denier', 'memory', 'nope.md'), 'utf8')).toThrow()
  }, 240_000)

  it('auto mode runs a gated tool unattended, and the always-ask list still blocks in auto', async () => {
    makeBot('autobot', GATED_BOT.replace('id = "tester"', 'id = "autobot"').replace('mode = "ask"', 'mode = "auto"'))
    const personas = loadPersonas(join(root, 'bots')).filter((p) => p.id === 'autobot')
    expect(personas[0].policy.mode).toBe('auto')
    // Nobody answers approvals here: anything that blocks will time out, which
    // is exactly what must happen to the always-ask tool and must NOT happen to
    // the ordinary gated one.
    const h = harness(personas, { answer: 'never', timeoutMs: 6_000 })
    await h.hook.listen()
    const res = await h
      .runner()
      .run(personas[0], 'test', 'Use memory_write to save auto.md containing hi. Then reply SAVED.')
    await h.hook.close()

    expect(res.error).toBeUndefined()
    expect(readFileSync(join(root, 'bots', 'autobot', 'memory', 'auto.md'), 'utf8')).toMatch(/hi/i)
    const row = h.audit().find((r) => r.tool === 'mcp__agentda__memory_write')
    expect(row).toMatchObject({ decision: 'allow', source: 'auto-mode', mode: 'auto' })
    expect(h.asked).not.toContain('mcp__agentda__memory_write') // never even asked
  }, 240_000)

  it('auto-approved read-only tools run without asking but are still audited', async () => {
    const personas = loadPersonas(join(root, 'bots')).filter((p) => p.id === 'tester')
    const h = harness(personas, { answer: 'never', timeoutMs: 6_000 })
    await h.hook.listen()
    const res = await h.runner().run(personas[0], 'read-chat', 'Call memory_read and tell me in one short sentence what it says.')
    await h.hook.close()
    expect(res.error).toBeUndefined()
    const row = h.audit().find((r) => r.tool === 'mcp__agentda__memory_read')
    expect(row).toMatchObject({ decision: 'allow', source: 'auto-class' })
    expect(h.asked).not.toContain('mcp__agentda__memory_read')
  }, 240_000)
})
