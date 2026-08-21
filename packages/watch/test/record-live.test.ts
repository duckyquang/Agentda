import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderRoutineToml } from '@agentda/core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RecordingSession } from '../src/record'

// The canary for a private Playwright API.
//
// The recorder is driven through `_enableRecorder({ recorderMode: 'api' })`,
// which is in the installed build and not in the public types. When a
// Playwright bump moves or removes it, this is the test that says so — rather
// than a user finding out that recording silently captures nothing.
//
// Opt-in via AGENTDA_LIVE=1: it launches Chromium.
const live = process.env.AGENTDA_LIVE === '1'
vi.setConfig({ testTimeout: 120_000 })

const roots: string[] = []
let server: Server
let base = ''

const PAGE = `<!doctype html><meta charset=utf-8><title>Invoices</title><main>
  <form>
    <label for=amt>Amount</label><input id=amt name=amount placeholder="0.00">
    <label for=pw>Password</label><input id=pw type=password name=secret>
    <button type=button id=go>Send payment</button>
  </form></main>`

beforeAll(async () => {
  if (!live) return
  server = createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
})

afterAll(() => {
  server?.close()
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }))
})

const profile = () => {
  const root = mkdtempSync(join(tmpdir(), 'agentda-record-'))
  roots.push(root)
  return join(root, 'browser-profile')
}

describe.runIf(live)('recording a session', () => {
  it('captures what was done, with handles that survive the page changing', async () => {
    const session = await RecordingSession.start({ profileDir: profile(), startUrl: base, headed: false })
    const page = session.page!
    // Driven by Playwright rather than by hand; the recorder sees these the
    // same way it sees a human, which is what makes this testable at all.
    await page.fill('#amt', '42.00')
    await page.click('#go')
    await page.waitForTimeout(800)

    const { routine } = await session.stop()
    expect(routine.steps.map((s) => s.verb)).toEqual(['navigate', 'type', 'click'])
    const click = routine.steps.at(-1)!
    // The words on the button, not a hashed class or a position.
    expect(click).toMatchObject({ role: 'button', name: 'Send payment' })
    expect(routine.steps[1]).toMatchObject({ role: 'textbox', name: 'Amount', text: '42.00' })
  })

  it('keeps a typed password out of the file entirely', async () => {
    const session = await RecordingSession.start({ profileDir: profile(), startUrl: base, headed: false })
    const page = session.page!
    await page.fill('#pw', 'hunter2')
    await page.waitForTimeout(800)

    const { routine, notes } = await session.stop()
    const file = renderRoutineToml(routine, notes)
    // The recorder puts the typed value in the action AND inside the aria
    // snapshot. Neither may survive into something written to disk.
    expect(file).not.toContain('hunter2')
    expect(JSON.stringify(routine)).not.toContain('hunter2')
    expect(routine.steps.some((s) => s.verb === 'handback')).toBe(true)
  })

  it('writes a draft that will not run until somebody has read it', async () => {
    const session = await RecordingSession.start({ profileDir: profile(), startUrl: base, headed: false })
    await session.page!.fill('#amt', '1.00')
    await session.page!.waitForTimeout(600)
    const { routine } = await session.stop()
    expect(routine.reviewed).toBe(false)
  })
})
