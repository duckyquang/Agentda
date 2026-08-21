import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalQueue, defaultPolicy, openDb, type Persona, type PersonaPatch } from '@agentda/core'
import { type Browser, chromium, devices, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ControlApi } from '../src/api'

// The desktop UI, loaded in a real browser against a real control API.
//
// Everything else tests the daemon's side of that boundary. This tests the
// side the user actually looks at: that the token in the URL works, that the
// event stream reaches the page, that an approval card renders the payload and
// that pressing Approve settles the same queue a Telegram tap would. A page
// that renders nothing answers every server-side test perfectly.
//
// Opt-in via AGENTDA_LIVE=1: it launches Chromium.
const live = process.env.AGENTDA_LIVE === '1'

// These drive a real browser over a real HTTP server; the default 5s is a
// stopwatch on Chromium's startup, not on the thing being tested.
vi.setConfig({ testTimeout: 30_000 })

const dir = mkdtempSync(join(tmpdir(), 'agentda-ui-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const persona = (id: string, over: Partial<Persona> = {}): Persona =>
  ({
    id,
    dir: join(dir, id),
    name: id === 'chief' ? 'Chief' : id,
    prompt: `You are ${id}.`,
    provider: 'ollama',
    providers: [{ provider: 'ollama' }],
    allowMeteredFailover: false,
    policy: { ...defaultPolicy(), grants: ['*'] },
    tools: [],
    agentdaTools: true,
    browser: true,
    email: false,
    browserSurface: 'shadow',
    scope: [],
    routines: [{ id: 'pay', cron: '0 9 * * 1', prompt: 'pay', enabled: false, steps: '/tmp/pay.toml' }],
    packs: [],
    coordinator: false,
    ...over,
  }) as Persona

let browser: Browser
let page: Page
let api: ControlApi
let queue: ApprovalQueue
const started: string[] = []
let recordedSource = [
  'version = 1',
  'reviewed = false',
  '',
  '[[steps]]',
  'n = 1',
  'verb = "click"',
  'name = "Send payment"',
  'sensitive = true',
  'fragile = false',
  'expect = "text:Paid"',
].join('\n')
const sent: { bot: string; text: string }[] = []
const patched: { bot: string; patch: PersonaPatch }[] = []

beforeAll(async () => {
  if (!live) return
  const db = openDb(join(dir, 'ui.db'))
  queue = new ApprovalQueue(db, { timeoutMs: 60_000 })
  db.prepare(
    `INSERT INTO audit_log (bot, chat, tool, input_json, decision, source, mode, reason)
     VALUES ('chief', 'c1', 'mcp__email__email_send', '{}', 'deny', 'timeout', 'ask', 'no answer before the timeout')`,
  ).run()
  const bots = [persona('chief'), persona('scout')]
  api = new ControlApi({
    db,
    queue,
    personas: () => bots,
    pending: () => queue.open(),
    send: (bot, text) => void sent.push({ bot, text }),
    voiceNote: async () => 'transcribed',
    setMode: () => {},
    pause: () => {},
    isPaused: () => false,
    createBot: (spec) => persona(spec.id),
    updateBot: (bot, patch) => {
      patched.push({ bot, patch })
      return persona(bot)
    },
    archiveBot: (bot) => join(dir, '.trash', bot),
    setToken: () => {},
    clearToken: () => {},
    tokenIds: () => [],
    reload: () => bots.length,
    recordings: () => [],
    startRecording: async (bot) => void started.push(bot),
    stopRecording: async () => ({ path: '/tmp/pay.toml', steps: 3, notes: ['step 2 types into what looks like a password field'] }),
    discardRecording: async () => true,
    routineSteps: () => ({ path: '/tmp/pay.toml', source: recordedSource }),
    reviewRoutine: (_bot, _routine, reviewed) => {
      recordedSource = recordedSource.replace(/^reviewed = (true|false)$/m, `reviewed = ${reviewed}`)
    },
    packs: () => [
      { id: 'files', name: 'Files', description: 'read and edit scoped files', verified: '2026-08-18: launched it', missing: [], outbound: [] },
      { id: 'mailer', name: 'Mailer', description: 'sends mail', missing: ['MAILER_TOKEN'], outbound: ['mcp__mailer__send'] },
    ],
  })
  await api.listen(0)
  browser = await chromium.launch({ channel: 'chromium' })
  page = await browser.newPage()
  page.on('pageerror', (err) => {
    throw new Error(`the page threw: ${err.message}`)
  })
  await page.goto(api.url())
  await page.waitForSelector('.bot')
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await api?.close()
})

describe.runIf(live)('desktop UI in a real browser', () => {
  it('renders the roster with mode badges', async () => {
    expect(await page.locator('.bot').count()).toBe(2)
    expect(await page.locator('.bot .name').first().textContent()).toBe('Chief')
    expect(await page.locator('.bot .tag').first().textContent()).toBe('ASK')
  })

  it('sends a message through the API and shows it in the thread', async () => {
    await page.locator('.bot', { hasText: 'Chief' }).click()
    await page.fill('#text', 'hello there')
    await page.click('#composer button.primary')
    await expect.poll(() => sent.at(-1)?.text, { timeout: 10_000 }).toBe('hello there')
    expect(await page.locator('.msg.me').last().textContent()).toBe('hello there')
  })

  it('shows a bot reply that arrives on the event stream', async () => {
    api.emit('message-out', { bot: 'chief', text: 'I looked and it is clear.' })
    await expect.poll(() => page.locator('.msg', { hasText: 'it is clear' }).count(), { timeout: 10_000 }).toBe(1)
  })

  it('draws the live checklist from activity events as tools run', async () => {
    api.emit('activity', { bot: 'chief', kind: 'start' })
    api.emit('activity', { bot: 'chief', kind: 'tool', name: 'mcp__browser__browser_navigate' })
    await expect.poll(() => page.locator('.checklist', { hasText: 'browser_navigate' }).count(), { timeout: 10_000 }).toBe(1)
    api.emit('activity', { bot: 'chief', kind: 'end' })
  })

  it('renders an approval card with the full payload and settles the queue on Approve', async () => {
    const pending = queue.request(
      { bot: 'chief', chat: 'desktop:chief', tool: 'mcp__email__email_send', input: { to: 'anna@example.com', subject: 'the thing' } },
      { ...defaultPolicy(), grants: ['*'] },
    )
    await new Promise((r) => setImmediate(r))
    const req = queue.open()[0]
    api.emit('approval', { id: req.id, bot: req.bot, tool: req.tool, input: req.input, reason: req.reason })

    await page.waitForSelector(`[data-approve="${req.id}"]`)
    // The payload has to be visible at the moment of decision, not summarised.
    expect(await page.locator('.card pre').textContent()).toContain('anna@example.com')
    await page.click(`[data-approve="${req.id}"]`)
    await expect(pending).resolves.toMatchObject({ decision: 'allow', source: 'human-tap' })
    // The card goes away on its own; waiting for that is what keeps the next
    // test from typing into a card that is on its way out.
    await page.waitForSelector('.card', { state: 'detached' })
  })

  it('sends an amendment back as a denial carrying the instruction', async () => {
    const pending = queue.request(
      { bot: 'chief', chat: 'desktop:chief', tool: 'mcp__email__email_send', input: { to: 'a@b.c' } },
      { ...defaultPolicy(), grants: ['*'] },
    )
    await new Promise((r) => setImmediate(r))
    const req = queue.open()[0]
    api.emit('approval', { id: req.id, bot: req.bot, tool: req.tool, input: req.input, reason: req.reason })

    await page.waitForSelector(`[data-amend="${req.id}"]`)
    await page.fill(`[data-amend="${req.id}"]`, 'cc anna@example.com')
    await page.press(`[data-amend="${req.id}"]`, 'Enter')
    const res = await pending
    expect(res.decision).toBe('deny')
    expect(res.reason).toContain('cc anna@example.com')
  })

  it('shows the audit log, and its filters actually filter', async () => {
    await page.click('[data-view="audit"]')
    await page.waitForSelector('table')
    const all = await page.locator('table tr').count()
    expect(all).toBeGreaterThan(1) // header plus the rows this run produced

    await page.selectOption('#f-decision', 'deny')
    await expect.poll(() => page.locator('td.allow').count(), { timeout: 10_000 }).toBe(0)
    expect(await page.locator('td.deny').count()).toBeGreaterThan(0)

    // Nothing has this tool, so the filter has to come up empty rather than
    // quietly showing everything.
    await page.fill('#f-tool', 'no_such_tool_anywhere')
    await expect.poll(() => page.locator('.empty', { hasText: 'Nothing matches' }).count(), { timeout: 10_000 }).toBe(1)
  })

  it('renders a screencast frame and hands the browser over', async () => {
    // A 1x1 JPEG: enough to prove the frame reaches an <img>, and small enough
    // to write down.
    const jpeg =
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
    await page.click('[data-view="screen"]')
    await page.waitForSelector('#take-over')
    api.emit('frame', { bot: 'chief', jpeg })
    await expect.poll(() => page.locator('.screen img').count(), { timeout: 5_000 }).toBe(1)

    await page.click('#take-over')
    await expect.poll(() => page.locator('.filters .hint').textContent(), { timeout: 5_000 }).toContain('The window is yours')
  })

  it('opens the persona editor, shows packs with what they still need, and saves a patch', async () => {
    await page.click('[data-view="settings"]')
    await page.waitForSelector('#e-name')
    expect(await page.inputValue('#e-prompt')).toBe('You are chief.')
    // A pack that cannot work yet is shown and disabled rather than hidden.
    expect(await page.locator('.packrow', { hasText: 'Mailer' }).textContent()).toContain('MAILER_TOKEN')
    expect(await page.locator('[data-pack="mailer"]').isDisabled()).toBe(true)

    await page.check('[data-pack="files"]')
    await page.fill('#e-name', 'Chief of Staff')
    await page.click('#e-save')
    await expect.poll(() => patched.at(-1)?.patch.name, { timeout: 10_000 }).toBe('Chief of Staff')
    expect(patched.at(-1)?.patch.packs).toEqual(['files'])
  })

  it('records a routine and refuses to let it run until it has been read', async () => {
    await page.locator('.bot', { hasText: 'Chief' }).click()
    await page.click('[data-view="record"]')
    await page.waitForSelector('#rec-start')
    await page.fill('#rec-url', 'https://example.test/invoices')
    await page.click('#rec-start')
    await expect.poll(() => started, { timeout: 10_000 }).toEqual(['chief'])

    await page.waitForSelector('#rec-stop')
    await page.fill('#rec-name', 'pay')
    page.once('dialog', (d) => void d.accept())
    await page.click('#rec-stop')

    // Straight to the routines list, where the recorded one can be read.
    await page.waitForSelector('[data-review="pay"]')
    await page.click('[data-review="pay"]')
    await page.waitForSelector('#r-src')
    // The human sees the actual script, not a summary of it.
    expect(await page.inputValue('#r-src')).toContain('sensitive = true')
    expect(await page.locator('#r-review').count()).toBe(1)

    await page.click('#r-review')
    await expect.poll(() => page.locator('#r-unreview').count(), { timeout: 10_000 }).toBe(1)
    expect(recordedSource).toContain('reviewed = true')
  })

  it('is usable on a phone, which is the only reason a mobile app is cheap', async () => {
    // Measured before this was fixed: the 280px sidebar left the chat pane 77px
    // wide, the approval card was narrower than its own Approve button, seven
    // tabs stacked into a 392px header, and the page scrolled sideways. The app
    // worked; the layout did not.
    const phone = await browser.newContext({ ...devices['iPhone 15'] })
    const small = await phone.newPage()
    const errors: string[] = []
    small.on('pageerror', (e) => errors.push(e.message))
    await small.goto(api.url())
    await small.waitForSelector('.bot')
    await small.locator('.bot').first().click()

    const pending = queue.request(
      { bot: 'chief', chat: 'desktop:chief', tool: 'mcp__email__email_send', input: { to: 'anna@example.com' } },
      { ...defaultPolicy(), grants: ['*'] },
    )
    await new Promise((r) => setImmediate(r))
    const req = queue.open()[0]
    api.emit('approval', { id: req.id, bot: req.bot, tool: req.tool, input: req.input, reason: req.reason })
    await small.waitForSelector('.card')

    const width = await small.evaluate('window.innerWidth')
    const overflow = await small.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    expect(overflow).toBe(0) // nothing scrolls sideways

    const card = (await small.locator('.card').first().boundingBox())!
    // The card is the thing you came to the phone for. It gets the screen.
    expect(card.width).toBeGreaterThan((width as number) * 0.8)

    const header = (await small.locator('header').boundingBox())!
    expect(header.height).toBeLessThan(120)

    // And it still works, not just fits.
    await small.click(`[data-approve="${req.id}"]`)
    await expect(pending).resolves.toMatchObject({ decision: 'allow' })
    expect(errors).toEqual([])
    await phone.close()
  })
})

