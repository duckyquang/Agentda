import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ApprovalQueue,
  DEFAULT_HANDOFF_CAP,
  HookServer,
  loadPersonas,
  openDb,
  type Persona,
  SessionStore,
  tryHandoff,
  TurnRunner,
} from '@agentda/core'
import { ClaudeAdapter } from '@agentda/provider-claude'
import { afterAll, describe, expect, it } from 'vitest'

// Two real bots passing work in one thread, with the cap that stops them
// looping through the user's plan window. Opt-in: real claude turns.
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
const root = mkdtempSync(join(tmpdir(), 'agentda-handoff-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function bot(id: string, prompt: string) {
  const dir = join(root, 'bots', id)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'bot.toml'), `id = "${id}"\nprovider = "claude"\nmode = "ask"\nauto_approve = ["mcp__agentda__memory_read"]\n`)
  writeFileSync(join(dir, 'prompt.md'), prompt)
}

describe.runIf(live)('multi-bot handoff', () => {
  it('one bot hands work to another, the thread shows it, and the cap stops the loop', async () => {
    bot(
      'alpha',
      'You are alpha. You do not do arithmetic yourself — beta does. Reply in one short line, then end your message with exactly: @beta: <the question>',
    )
    bot('beta', 'You are beta. Answer the arithmetic in one short line. Do not hand off to anyone.')
    const personas = loadPersonas(join(root, 'bots'))
    const byId = (id: string) => personas.find((p) => p.id === id)!

    const dbPath = join(root, 'state.db')
    const db = openDb(dbPath)
    const queue = new ApprovalQueue(db, { timeoutMs: 10_000 })
    let currentBot = 'alpha'
    const hook = new HookServer(queue, () => ({ bot: currentBot, chat: 'grp', policy: byId(currentBot).policy, paused: false }), 'hsecret')
    await hook.listen()
    const runner = new TurnRunner({
      db,
      sessions: new SessionStore(dbPath),
      queue,
      hook,
      adapters: new Map([['claude', new ClaudeAdapter()]]),
      settingsPath: hook.writeSettings(join(root, 'run')),
      mcpEntries: (p) => ({
        agentda: {
          command: process.execPath,
          args: [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'packages/mcp-agentda/src/index.ts')],
          env: { AGENTDA_BOT_DIR: p.dir, AGENTDA_SCOPE: '' },
        },
      }),
    })

    // The daemon's handoff loop, in miniature.
    const thread: string[] = []
    const parse = (t: string) => /^@([\w-]+)\s*[::]\s*(.+)$/.exec(t.trim().split('\n').filter(Boolean).pop()?.trim() ?? '')
    let persona: Persona | undefined = byId('alpha')
    let input = 'What is 17 + 25? Get the answer.'
    let hops = 0
    while (persona && hops <= DEFAULT_HANDOFF_CAP + 2) {
      currentBot = persona.id
      const res = await runner.run(persona, 'grp', input, {})
      expect(res.error).toBeUndefined()
      thread.push(`${persona.id}: ${res.text}`)
      const m = parse(res.text)
      if (!m) break
      const target = personas.find((p) => p.id.toLowerCase() === m[1].toLowerCase())
      if (!target || target.id === persona.id) break
      const gate = tryHandoff(db, { chat: 'grp', task: 'sum', from: persona.id, to: target.id, note: m[2] })
      if (!gate.ok) {
        thread.push(`capped: ${gate.reason}`)
        break
      }
      persona = target
      input = `${thread[thread.length - 1].split(':')[0]} handed this to you: ${m[2]}`
      hops++
    }

    await hook.close()

    expect(hops).toBeGreaterThanOrEqual(1) // a real handoff happened
    expect(thread.some((t) => t.startsWith('beta:'))).toBe(true) // beta actually worked
    expect(thread.join(' ')).toContain('42') // and produced the answer
    expect(db.prepare('SELECT count(*) c FROM handoffs').get()).toMatchObject({ c: hops })
    expect(hops).toBeLessThanOrEqual(DEFAULT_HANDOFF_CAP) // never ran away
  }, 300_000)
})
