import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApprovalQueue, defaultPolicy, openDb } from '@agentda/core'
import { afterAll, describe, expect, it } from 'vitest'
import { ApiAdapter, OpenAICompatClient } from '../src/index'

// LIVE, but free: a local Ollama model with real MCP tools. This is the only
// provider in the API family that can be verified end to end without anyone's
// billing details, so it carries the proof that the loop — and its in-process
// gate — actually work against a real tool-calling model.
const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/v1'
const model = process.env.OLLAMA_MODEL ?? 'llama3.1:8b'
const live = process.env.AGENTDA_LIVE === '1' && (await reachable())
async function reachable() {
  try {
    const r = await fetch(base.replace(/\/v1$/, '') + '/api/tags', { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'agentda-ollama-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function setup(answer: 'allow' | 'deny') {
  const botDir = join(root, `bot-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(botDir, 'memory'), { recursive: true })
  const db = openDb(join(botDir, 'state.db'))
  const queue = new ApprovalQueue(db, {
    timeoutMs: 10_000,
    ask: (req) => {
      setTimeout(() => queue.settle(req.id, { decision: answer, source: 'human-tap' }), 20)
    },
  })
  const policy = { ...defaultPolicy(), grants: ['mcp__agentda__*'] }
  const mcpConfig = join(botDir, 'mcp.json')
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        agentda: {
          command: process.execPath,
          args: [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'packages/mcp-agentda/src/index.ts')],
          env: { AGENTDA_BOT_DIR: botDir, AGENTDA_SCOPE: botDir },
        },
      },
    }),
  )
  // The gate the runner would supply: same queue, same policy, same audit log
  // as the CLI providers — the whole point of the shared design.
  const gate = async (tool: string, input: unknown) => {
    const r = await queue.request({ bot: 'ollamabot', tool, input }, policy)
    return { decision: r.decision, reason: r.reason }
  }
  const audit = () => db.prepare('SELECT tool, decision, source FROM audit_log').all() as any[]
  return { botDir, mcpConfig, gate, audit, db }
}

const adapter = () => new ApiAdapter(new OpenAICompatClient('ollama', { baseUrl: base, model }))

describe.runIf(live)('agent loop against a real local model (Ollama)', () => {
  it('holds a conversation', async () => {
    const s = setup('allow')
    let text = ''
    for await (const ev of adapter().startTurn('Reply with exactly the word: pineapple')) {
      if (ev.type === 'text') text += ev.text
    }
    expect(text.toLowerCase()).toContain('pineapple')
  }, 180_000)

  it('runs an approved MCP tool for real, and audits it', async () => {
    const s = setup('allow')
    const seen: string[] = []
    for await (const ev of adapter().startTurn(
      'Use the mcp__agentda__memory_write tool to save a file named fact.md whose content is exactly: sky is teal. Then reply DONE.',
      { mcpConfig: s.mcpConfig, gate: s.gate },
    )) {
      if (ev.type === 'tool_call') seen.push(ev.name)
    }
    expect(seen).toContain('mcp__agentda__memory_write')
    expect(readFileSync(join(s.botDir, 'memory', 'fact.md'), 'utf8')).toMatch(/teal/i)
    expect(s.audit().some((a) => a.tool === 'mcp__agentda__memory_write' && a.decision === 'allow')).toBe(true)
  }, 300_000)

  it('a denied tool never touches the disk', async () => {
    const s = setup('deny')
    for await (const ev of adapter().startTurn(
      'Use the mcp__agentda__memory_write tool to save a file named nope.md containing hi. Then reply DONE.',
      { mcpConfig: s.mcpConfig, gate: s.gate },
    )) {
      void ev
    }
    expect(existsSync(join(s.botDir, 'memory', 'nope.md'))).toBe(false)
    // A vacuous pass would be worthless: require the gate actually ran.
    expect(s.audit().length).toBeGreaterThan(0)
    expect(s.audit().every((a) => a.decision === 'deny')).toBe(true)
  }, 300_000)
})
