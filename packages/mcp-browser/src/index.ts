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

async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page
  ctx = await chromium.launchPersistentContext(profile, {
    // The full browser binary without a window — NOT the default
    // chromium-headless-shell, which renders differently enough to matter.
    channel: 'chromium',
    headless: !onScreen,
    args: [
      '--use-mock-keychain', // no OS keychain prompt: a real focus-steal vector
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width: 1280, height: 900 },
  })
  page = ctx.pages()[0] ?? (await ctx.newPage())
  if (onScreen) {
    // A window that just opened holds focus, so keystrokes the user has in
    // flight land in the bot's page. Wait it out before touching anything, and
    // never call bringToFront: the window is visible, not stealing.
    await page.waitForTimeout(1500)
  }
  return page
}

const server = new McpServer({ name: 'agentda-browser', version: '0.1.0' })

server.tool('browser_navigate', 'Open a URL in this bot\'s browser.', { url: z.string().url() }, async ({ url }) => {
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
  await ctx?.close()
  ctx = undefined
  page = undefined
  return { content: [{ type: 'text', text: 'closed' }] }
})

process.on('exit', () => void ctx?.close())
await server.connect(new StdioServerTransport())
