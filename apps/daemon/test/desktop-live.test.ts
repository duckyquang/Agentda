import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The virtual desktop, for real: a real container, a real X server, real
// xdotool. Skipped unless AGENTDA_LIVE=1 AND a container runtime is actually
// running AND the image has been built — none of which CI can assume, and none
// of which should turn into a green tick when absent.
const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const image = process.env.AGENTDA_DESKTOP_IMAGE ?? 'agentda/desktop:dev'

const live =
  process.env.AGENTDA_LIVE === '1' &&
  (await run('docker', ['image', 'inspect', image]).then(
    () => true,
    () => false,
  ))

vi.setConfig({ testTimeout: 180_000 })

const roots: string[] = []
const containers: string[] = []
afterAll(async () => {
  await Promise.all(containers.map((c) => run('docker', ['rm', '-f', c]).catch(() => {})))
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }))
})

async function desktop() {
  const root = mkdtempSync(join(tmpdir(), 'agentda-desktop-'))
  roots.push(root)
  const container = `agentda-test-${Math.abs(Date.now() % 100000)}`
  containers.push(container)

  const client = new Client({ name: 'agentda-desktop-test', version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'packages/mcp-desktop/src/index.ts')],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        AGENTDA_DESKTOP_STATE: join(root, 'desktop'),
        AGENTDA_DESKTOP_IMAGE: image,
        AGENTDA_DESKTOP_CONTAINER: container,
      },
    }),
  )
  return { client, container, root }
}

const text = (r: unknown) => JSON.stringify(r)

describe.runIf(live)('the bot gets a desktop that is not yours', () => {
  it('starts one on first use and can see it', async () => {
    const d = await desktop()
    const shot = await d.client.callTool({ name: 'desktop_screenshot', arguments: {} })
    // A real PNG of a real X server.
    expect(text(shot)).toContain('"type":"image"')
    expect(text(shot)).toContain('iVBOR')
    await d.client.close()
  })

  it('drives it: launch something, then see it on screen', async () => {
    const d = await desktop()
    await d.client.callTool({ name: 'desktop_launch', arguments: { app: 'xterm' } })
    await new Promise((r) => setTimeout(r, 2500))
    const where = await d.client.callTool({ name: 'desktop_where', arguments: {} })
    expect(text(where).toLowerCase()).toContain('xterm')
    await d.client.close()
  })

  it('types into it and the typing lands', async () => {
    const d = await desktop()
    await d.client.callTool({ name: 'desktop_launch', arguments: { app: 'xterm' } })
    await new Promise((r) => setTimeout(r, 2500))
    // Click to focus first, exactly as a person would — typing goes to
    // whatever has focus, and a window that just opened may not.
    await d.client.callTool({ name: 'desktop_click', arguments: { x: 200, y: 200 } })
    await new Promise((r) => setTimeout(r, 400))
    await d.client.callTool({ name: 'desktop_type', arguments: { text: 'echo agentda-was-here > /home/bot/proof.txt' } })
    await d.client.callTool({ name: 'desktop_key', arguments: { keys: 'Return' } })
    await new Promise((r) => setTimeout(r, 1500))

    // Checked from outside the container: the keystrokes really reached the app.
    const { stdout } = await run('docker', ['exec', d.container, 'cat', '/home/bot/proof.txt'])
    expect(stdout).toContain('agentda-was-here')
    await d.client.close()
  })

  it('keeps the desktop off the network', async () => {
    const d = await desktop()
    await d.client.callTool({ name: 'desktop_screenshot', arguments: {} })
    const { stdout } = await run('docker', ['port', d.container])
    // noVNC is published, and only to loopback: this is for the person at this
    // machine to watch, not for anything else.
    expect(stdout).toMatch(/6080\/tcp -> 127\.0\.0\.1:/)
    expect(stdout).not.toContain('0.0.0.0')
    await d.client.close()
  })

  it('takes the desktop down with the server that started it', async () => {
    const d = await desktop()
    await d.client.callTool({ name: 'desktop_screenshot', arguments: {} })
    await d.client.close()
    // A container outliving its turn would leave a desktop — and whatever is
    // logged into it — running with nobody watching.
    await new Promise((r) => setTimeout(r, 2500))
    const gone = await run('docker', ['inspect', d.container]).then(
      () => false,
      () => true,
    )
    expect(gone).toBe(true)
  })
})
