import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ApprovalQueue } from '../src/approvals'
import { openDb } from '../src/db'
import { HookServer } from '../src/hook-server'
import { loadPersonas } from '../src/persona'
import { SessionStore } from '../src/store'
import { TurnRunner } from '../src/runner'
import { AdapterError, type AgentEvent, type ProviderAdapter } from '../src/index'

const root = mkdtempSync(join(tmpdir(), 'agentda-failover-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// Adapters that fail or succeed on command, so the chain logic is tested
// without spending a single real token.
function adapter(name: string, behavior: 'ok' | 'limit' | 'auth' | 'boom'): ProviderAdapter {
  return {
    name,
    capabilities: { streaming: false, tools: false, midTurnGating: true },
    async *startTurn(): AsyncGenerator<AgentEvent> {
      if (behavior === 'ok') {
        yield { type: 'text', text: `answered by ${name}` }
        yield { type: 'result', sessionId: `${name}-session`, raw: {} }
        return
      }
      if (behavior === 'boom') throw new AdapterError('other', `${name} exploded`)
      throw new AdapterError(behavior, `${name} ${behavior}`)
    },
  }
}

let n = 0
function setup(chainToml: string, adapters: Record<string, ProviderAdapter>) {
  const dir = join(root, `bots-${n++}`, 'bot')
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'bot.toml'), `id = "bot"\n${chainToml}\n`)
  writeFileSync(join(dir, 'prompt.md'), 'test bot')
  const persona = loadPersonas(join(dir, '..'))[0]
  const dbPath = join(dir, 'state.db')
  const db = openDb(dbPath)
  const queue = new ApprovalQueue(db, {})
  const runner = new TurnRunner({
    db,
    sessions: new SessionStore(dbPath),
    queue,
    hook: new HookServer(queue, () => ({ bot: 'bot', chat: null, policy: persona.policy, paused: false }), 's'),
    adapters: new Map(Object.entries(adapters)),
    settingsPath: join(dir, 'settings.json'),
  })
  return { persona, runner }
}

describe('provider failover', () => {
  it('falls over to the next provider on a plan limit and says context was rebuilt', async () => {
    const s = setup('providers = ["claude", "codex"]', {
      claude: adapter('claude', 'limit'),
      codex: adapter('codex', 'ok'),
    })
    const res = await s.runner.run(s.persona, 'chat', 'hello')
    expect(res.text).toBe('answered by codex')
    expect(res.notices?.join(' ')).toMatch(/plan limit/)
    expect(res.notices?.join(' ')).toMatch(/rebuilt/)
  })

  it('does not fall over for failures another provider cannot fix', async () => {
    const s = setup('providers = ["claude", "codex"]', {
      claude: adapter('claude', 'boom'),
      codex: adapter('codex', 'ok'),
    })
    const res = await s.runner.run(s.persona, 'chat', 'hello')
    expect(res.error?.message).toMatch(/claude exploded/)
    expect(res.text).toBe('') // codex was never tried
  })

  it('refuses to spend money on a metered provider without opt-in', async () => {
    const s = setup('providers = ["claude", "anthropic-api"]', {
      claude: adapter('claude', 'limit'),
      'anthropic-api': adapter('anthropic-api', 'ok'),
    })
    const res = await s.runner.run(s.persona, 'chat', 'hello')
    expect(res.error?.kind).toBe('limit')
    expect(res.notices?.join(' ')).toMatch(/bills per token/)
    expect(res.text).toBe('') // and it really did not run
  })

  it('uses the metered provider once the bot opts in', async () => {
    const s = setup('providers = ["claude", "anthropic-api"]\nallow_metered_failover = true', {
      claude: adapter('claude', 'limit'),
      'anthropic-api': adapter('anthropic-api', 'ok'),
    })
    const res = await s.runner.run(s.persona, 'chat', 'hello')
    expect(res.text).toBe('answered by anthropic-api')
  })

  it('reports the last failure when the whole chain is exhausted', async () => {
    const s = setup('providers = ["claude", "codex"]', {
      claude: adapter('claude', 'limit'),
      codex: adapter('codex', 'auth'),
    })
    const res = await s.runner.run(s.persona, 'chat', 'hello')
    expect(res.error?.kind).toBe('auth')
    expect(res.notices?.join(' ')).toMatch(/continuing on codex/)
  })
})
