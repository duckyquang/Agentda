#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { type BrowserContext, chromium, type Page } from 'playwright'
import { z } from 'zod'

// Browser hands (ADR 0002). Two surfaces, one automation path:
//   shadow    — Chromium new headless: nothing on screen, no focus taken
//   on-screen — the same profile, visible, for watching or when a site refuses headless
// Either way Playwright drives the page over CDP, so the bot never injects
// OS-level input and cannot see the user's other windows.
//
// Approval is NOT handled here: every call goes through Agentda's PreToolUse
// gate, so this server stays a pair of hands with no opinions (one gate, one
// audit trail).
const profileDir = process.env.AGENTDA_BROWSER_PROFILE
if (!profileDir) {
  console.error('AGENTDA_BROWSER_PROFILE is required')
  process.exit(1)
}
const profile: string = profileDir
const onScreen = process.env.AGENTDA_BROWSER_SURFACE === 'on-screen'
mkdirSync(profile, { recursive: true })

let ctx: BrowserContext | undefined
let page: Page | undefined

// Bot-screen preview (PLAN Phase 2). The daemon cannot reach into this process
// — the CLI spawned it — so frames go out to the daemon and the only thing that
// comes back is whether the human has taken the page over.
const previewUrl = process.env.AGENTDA_PREVIEW_URL
const preview = previewUrl ? new URL(previewUrl) : undefined
// The same endpoint with /control on the path; the token stays in the query.
const controlUrl = preview && new URL(`${preview.pathname}/control${preview.search}`, preview.origin).href
let handedOver = false
let visible = onScreen // the surface actually in use, which take-over changes
let idlePoll: NodeJS.Timeout | undefined

async function applyControl(control: string | null): Promise<void> {
  if (control === 'take-over' && !handedOver) {
    handedOver = true
    // Same profile, now on screen: the cookies and the session are on disk, so
    // the human lands exactly where the bot was.
    await relaunch(true)
  } else if (control === 'hand-back' && handedOver) {
    handedOver = false
    await relaunch(onScreen)
  }
}

async function postFrame(data: string): Promise<void> {
  if (!previewUrl) return
  try {
    const res = await fetch(previewUrl, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: data })
    if (res.ok) await applyControl((await res.json()).control ?? null)
  } catch {
    // The daemon going away must not break the bot's browsing.
  }
}

// Frames only arrive when the page changes, so a still page would never learn
// it had been taken over.
function watchControl(): void {
  if (!previewUrl || idlePoll) return
  idlePoll = setInterval(async () => {
    try {
      const res = await fetch(controlUrl!)
      if (res.ok) await applyControl((await res.json()).control ?? null)
    } catch {
      // same as above
    }
  }, 2000)
  idlePoll.unref?.()
}

async function startScreencast(p: Page): Promise<void> {
  if (!previewUrl || !ctx) return
  try {
    const cdp = await ctx.newCDPSession(p)
    cdp.on('Page.screencastFrame', async (frame: { data: string; sessionId: number }) => {
      await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      await postFrame(frame.data)
    })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1024, maxHeight: 768, everyNthFrame: 2 })
  } catch {
    // No preview is a missing convenience, not a broken browser.
  }
}

async function relaunch(headed: boolean): Promise<void> {
  const url = page && !page.isClosed() ? page.url() : undefined
  visible = headed
  await ctx?.close().catch(() => {})
  ctx = undefined
  page = undefined
  const p = await getPage()
  if (url && url !== 'about:blank') await p.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
}

// Every acting tool goes through here first. Taking over means the bot stops
// touching the page — not that it queues up and pounces when you look away.
function assertNotHandedOver(): void {
  if (handedOver) {
    throw new Error('the human has taken over this browser window — ask them to hand it back before you continue')
  }
}

async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page
  ctx = await chromium.launchPersistentContext(profile, {
    // The full browser binary without a window — NOT the default
    // chromium-headless-shell, which renders differently enough to matter.
    channel: 'chromium',
    headless: !visible,
    args: [
      '--use-mock-keychain', // no OS keychain prompt: a real focus-steal vector
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width: 1280, height: 900 },
  })
  page = ctx.pages()[0] ?? (await ctx.newPage())
  await startScreencast(page)
  watchControl()
  if (visible) {
    // A window that just opened holds focus, so keystrokes the user has in
    // flight land in the bot's page. Wait it out before touching anything, and
    // never call bringToFront: the window is visible, not stealing.
    await page.waitForTimeout(1500)
  }
  return page
}

const server = new McpServer({ name: 'agentda-browser', version: '0.1.0' })

server.tool('browser_navigate', 'Open a URL in this bot\'s browser.', { url: z.string().url() }, async ({ url }) => {
  assertNotHandedOver()
  const p = await getPage()
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  return { content: [{ type: 'text', text: `at ${p.url()} — ${await p.title()}` }] }
})

server.tool('browser_read', 'Read the current page as text, with the interactive elements listed.', {}, async () => {
  const p = await getPage()
  const text = (await p.evaluate(() => document.body?.innerText ?? '')).slice(0, 20_000)
  // Names the model can actually act on, rather than raw selectors it has to guess.
  const controls = await p.evaluate(() =>
    [...document.querySelectorAll('a,button,input,textarea,select,[role=button]')]
      .slice(0, 100)
      .map((el, i) => {
        const e = el as HTMLElement & { name?: string; type?: string; placeholder?: string }
        const label = (e.innerText || e.getAttribute('aria-label') || e.placeholder || e.name || '').trim().slice(0, 60)
        return `${i}. <${e.tagName.toLowerCase()}${e.type ? ` type=${e.type}` : ''}> ${label}`
      }),
  )
  return { content: [{ type: 'text', text: `URL: ${p.url()}\n\n${text}\n\n## Interactive\n${controls.join('\n')}` }] }
})

server.tool(
  'browser_click',
  'Click an element by CSS selector or visible text. Gated: a click can submit or purchase.',
  { selector: z.string().describe('CSS selector, or text="..." to match visible text') },
  async ({ selector }) => {
    assertNotHandedOver()
    const p = await getPage()
    await p.locator(selector.startsWith('text=') ? selector : selector).first().click({ timeout: 15_000 })
    await p.waitForLoadState('domcontentloaded').catch(() => {})
    return { content: [{ type: 'text', text: `clicked ${selector} — now at ${p.url()}` }] }
  },
)

server.tool(
  'browser_type',
  'Type into a field. Gated: typing usually precedes a submit.',
  { selector: z.string(), text: z.string(), submit: z.boolean().optional() },
  async ({ selector, text, submit }) => {
    assertNotHandedOver()
    const p = await getPage()
    const el = p.locator(selector).first()
    await el.fill(text, { timeout: 15_000 })
    if (submit) await el.press('Enter')
    return { content: [{ type: 'text', text: `typed into ${selector}${submit ? ' and submitted' : ''}` }] }
  },
)

server.tool('browser_screenshot', 'Screenshot the current page.', {}, async () => {
  const p = await getPage()
  const buf = await p.screenshot({ type: 'png', fullPage: false })
  return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] }
})

server.tool('browser_close', 'Close the browser.', {}, async () => {
  clearInterval(idlePoll)
  idlePoll = undefined
  await ctx?.close()
  ctx = undefined
  page = undefined
  return { content: [{ type: 'text', text: 'closed' }] }
})

process.on('exit', () => void ctx?.close())
await server.connect(new StdioServerTransport())
