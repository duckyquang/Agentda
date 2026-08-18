import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ApprovalQueue, defaultPolicy, openDb, type Persona } from '@agentda/core'
import { afterAll, describe, expect, it } from 'vitest'
import { ControlApi } from '../src/api'

// The bot-screen preview end to end: a real Chromium, real CDP screencast
// frames, and the real control API they are posted to. No provider CLI is
// involved — the browser server is driven directly over MCP, which is exactly
// what the CLI does to it. Opt-in via AGENTDA_LIVE=1.
const live = process.env.AGENTDA_LIVE === '1'
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const roots: string[] = []
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

const persona = (id: string, dir: string): Persona => ({
  id,
  dir,
  name: id,
  prompt: '',
  provider: 'claude',
  providers: [{ provider: 'claude' }],
  allowMeteredFailover: false,
  policy: defaultPolicy(),
  tools: [],
  agentdaTools: true,
  browser: true,
  email: false,
  browserSurface: 'shadow',
  scope: [],
  routines: [],
  packs: [],
})

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'agentda-preview-'))
  roots.push(root)
  const db = openDb(join(root, 'state.db'))
  const p = persona('screenbot', root)
  const api = new ControlApi({
    db,
    queue: new ApprovalQueue(db, {}),
    personas: () => [p],
    pending: () => [],
    send: () => {},
    voiceNote: async () => '',
    setMode: () => {},
    pause: () => {},
    isPaused: () => false,
    createBot: () => p,
    updateBot: () => p,
    archiveBot: () => '',
    setToken: () => {},
    clearToken: () => {},
    tokenIds: () => [],
    reload: () => 1,
    packs: () => [],
  })
  await api.listen(0)

  const browser = new Client({ name: 'preview-test', version: '0' })
  await browser.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'packages/mcp-browser/src/index.ts')],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AGENTDA_BROWSER_PROFILE: join(root, 'browser-profile'),
        AGENTDA_BROWSER_SURFACE: 'shadow',
        AGENTDA_PREVIEW_URL: api.previewUrl('screenbot'),
      },
    }),
  )
  return { api, browser, root }
}

// The desktop's own view of the stream, so this exercises the path the app
// uses rather than an internal hook. Read with fetch rather than EventSource,
// which Node does not expose here.
async function watchFrames(api: ControlApi): Promise<{ frames: string[]; stop: () => void }> {
  const frames: string[] = []
  const stop = new AbortController()
  const res = await fetch(`${base(api)}/api/events?token=${token(api)}`, { signal: stop.signal })
  void (async () => {
    let buffer = ''
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(chunk).toString()
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          if (!block.startsWith('event: frame')) continue
          frames.push(JSON.parse(block.slice(block.indexOf('data: ') + 6)).jpeg)
        }
      }
    } catch {
      // aborted at the end of the test
    }
  })()
  return { frames, stop: () => stop.abort() }
}

const base = (api: ControlApi) => api.url().split('/?')[0]
const token = (api: ControlApi) => api.url().split('token=')[1]

describe.runIf(live)('bot-screen preview', () => {
  it('streams real screencast frames to the desktop while the bot browses', async () => {
    const h = await harness()
    const watcher = await watchFrames(h.api)
    await new Promise((r) => setTimeout(r, 300)) // let the stream attach

    await h.browser.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } })
    await new Promise((r) => setTimeout(r, 2500))

    expect(watcher.frames.length).toBeGreaterThan(0)
    // JPEG, base64: every real frame starts with the same magic bytes.
    expect(watcher.frames[0].startsWith('/9j/')).toBe(true)

    watcher.stop()
    await h.browser.callTool({ name: 'browser_close', arguments: {} })
    await h.browser.close()
    await h.api.close()
  }, 180_000)

  it('taking over stops the bot touching the page until it is handed back', async () => {
    const h = await harness()
    await h.browser.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } })

    const control = (c: string) =>
      fetch(`${base(h.api)}/api/preview/screenbot/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token(h.api)}` },
        body: JSON.stringify({ control: c }),
      })

    await control('take-over')
    // The browser server learns about it on its next frame or its idle poll.
    await new Promise((r) => setTimeout(r, 3500))

    const blocked = await h.browser.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.org' } })
    expect(JSON.stringify(blocked)).toMatch(/taken over/i)

    await control('hand-back')
    await new Promise((r) => setTimeout(r, 3500))
    const allowed = await h.browser.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.org' } })
    expect(JSON.stringify(allowed)).toMatch(/example\.org/)

    await h.browser.callTool({ name: 'browser_close', arguments: {} })
    await h.browser.close()
    await h.api.close()
  }, 180_000)
})
