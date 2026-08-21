import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, describe, expect, it } from 'vitest'

// Agentda's own MCP server, driven the way the CLI drives it. The containment
// logic has unit tests; this checks the thing that actually runs on the other
// end of a bot's file_read — a guard that is right in a module and wrong in the
// server is still a bot reading your keys.
//
// Opt-in via AGENTDA_LIVE=1: it spawns a real server process.
const live = process.env.AGENTDA_LIVE === '1'
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const roots: string[] = []
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

async function server() {
  const root = mkdtempSync(join(tmpdir(), 'agentda-mcp-'))
  roots.push(root)
  mkdirSync(join(root, 'bot', 'memory'), { recursive: true })
  mkdirSync(join(root, 'work'), { recursive: true })
  mkdirSync(join(root, 'secrets'), { recursive: true })
  writeFileSync(join(root, 'work', 'notes.md'), 'this one is fine')
  writeFileSync(join(root, 'secrets', 'keys.txt'), 'TOP SECRET')
  // An ordinary symlink, the kind a synced folder or a dotfile manager leaves
  // lying around. No attacker required.
  symlinkSync(join(root, 'secrets'), join(root, 'work', 'link'))

  const client = new Client({ name: 'agentda-mcp-test', version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'packages/mcp-agentda/src/index.ts')],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AGENTDA_BOT_DIR: join(root, 'bot'),
        AGENTDA_SCOPE: join(root, 'work'),
      },
    }),
  )
  return { root, client }
}

const text = (r: unknown) => JSON.stringify(r)

describe.runIf(live)('agentda MCP server containment', () => {
  it('reads what is in scope', async () => {
    const s = await server()
    const r = await s.client.callTool({ name: 'file_read', arguments: { path: join(s.root, 'work', 'notes.md') } })
    expect(text(r)).toContain('this one is fine')
    await s.client.close()
  }, 120_000)

  it('will not follow a symlink out of the scope', async () => {
    const s = await server()
    const r = await s.client.callTool({ name: 'file_read', arguments: { path: join(s.root, 'work', 'link', 'keys.txt') } })
    expect(text(r)).not.toContain('TOP SECRET')
    expect(text(r)).toMatch(/outside this bot/i)
    await s.client.close()
  }, 120_000)

  it('will not write through a symlink out of the scope', async () => {
    const s = await server()
    const r = await s.client.callTool({
      name: 'file_write',
      arguments: { path: join(s.root, 'work', 'link', 'planted.sh'), content: 'rm -rf /' },
    })
    expect(text(r)).toMatch(/outside this bot/i)
    await s.client.close()
  }, 120_000)

  it('refuses the plain ways out as well', async () => {
    const s = await server()
    for (const path of [join(s.root, 'secrets', 'keys.txt'), join(s.root, 'work', '..', 'secrets', 'keys.txt')]) {
      const r = await s.client.callTool({ name: 'file_read', arguments: { path } })
      expect(text(r), path).toMatch(/outside this bot/i)
    }
    await s.client.close()
  }, 120_000)

  it('keeps memory writes inside the memory directory', async () => {
    const s = await server()
    const bad = await s.client.callTool({ name: 'memory_write', arguments: { file: '../../escaped', content: 'no' } })
    expect(text(bad)).toMatch(/invalid memory file name/i)

    await s.client.callTool({ name: 'memory_write', arguments: { file: 'facts', content: 'the sky is blue' } })
    const read = await s.client.callTool({ name: 'memory_read', arguments: {} })
    expect(text(read)).toContain('the sky is blue')
    await s.client.close()
  }, 120_000)
})
