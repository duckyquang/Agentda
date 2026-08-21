import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApprovalQueue, HookServer, loadPersonas, openDb, SessionStore, TurnRunner } from '@agentda/core'
import { ClaudeAdapter } from '@agentda/provider-claude'
import { afterAll, describe, expect, it } from 'vitest'

// Live browser tests: real claude, real Chromium, real network. Opt-in via
// AGENTDA_LIVE=1.
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
const tsx = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')
const roots: string[] = []
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

// Each test gets its own bots root: a shared one lets an earlier test's persona
// win `personas[0]` and quietly test the wrong bot.
function makeBot(id: string, extra: string) {
  const root = mkdtempSync(join(tmpdir(), 'agentda-browser-'))
  roots.push(root)
  const dir = join(root, 'bots', id)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'bot.toml'), `id = "${id}"\nprovider = "claude"\nbrowser = true\n${extra}`)
  writeFileSync(join(dir, 'prompt.md'), 'You are a terse test bot with browser hands. Report exactly what you observe.')
  return { root, persona: loadPersonas(join(root, 'bots'))[0] }
}

function harness(root: string, persona: ReturnType<typeof loadPersonas>[number], timeoutMs = 20_000) {
  const dbPath = join(root, 'state.db')
  const db = openDb(dbPath)
  const asked: string[] = []
  const queue = new ApprovalQueue(db, { timeoutMs, ask: (r) => void asked.push(r.tool) })
  const hook = new HookServer(queue, () => ({ bot: persona.id, chat: 'test', policy: persona.policy, paused: false }), 'bsecret')
  const runner = () =>
    new TurnRunner({
      db,
      sessions: new SessionStore(dbPath),
      queue,
      hook,
      adapters: new Map([['claude', new ClaudeAdapter()]]),
      mcpEntries: (p) => ({
        browser: {
          command: process.execPath,
          args: [tsx, join(repoRoot, 'packages/mcp-browser/src/index.ts')],
          env: { AGENTDA_BROWSER_PROFILE: join(p.dir, 'browser-profile'), AGENTDA_BROWSER_SURFACE: p.browserSurface },
        },
      }),
    })
  return { db, hook, queue, runner, asked, audit: () => db.prepare('SELECT tool, decision, source FROM audit_log').all() as any[] }
}

// Windowed Chromium processes, counted without needing macOS Accessibility
// permission (which the osascript route requires and CI cannot grant). A
// headless browser has no window, so any windowed Chromium during a shadow run
// is the failure this surface exists to prevent.
function windowedChromiums(profileMarker: string): number {
  try {
    const ps = execFileSync('ps', ['-Ao', 'command'], { maxBuffer: 8 << 20 }).toString()
    return ps
      .split('\n')
      .filter((l) => l.includes(profileMarker))
      .filter((l) => !/--type=/.test(l)) // helpers (renderer, GPU, utility) are not windows
      .filter((l) => !/--headless/.test(l)).length
  } catch {
    return 0
  }
}

const READ_ONLY_AUTO = `auto_approve = ["mcp__browser__browser_navigate", "mcp__browser__browser_read", "mcp__browser__browser_screenshot"]\n`

describe.runIf(live)('browser hands', () => {
  it('shadow surface browses a real page with no window on screen (M7)', async () => {
    const { root, persona } = makeBot('browsebot', `mode = "auto"\nbrowser_surface = "shadow"\n${READ_ONLY_AUTO}`)
    const h = harness(root, persona)
    await h.hook.listen()

    const windowSamples: number[] = []
    const poll = setInterval(() => windowSamples.push(windowedChromiums(join(persona.dir, 'browser-profile'))), 250)
    const res = await h.runner().run(persona, 'test', 'Navigate to https://example.com, then read the page and tell me its exact title.')
    clearInterval(poll)
    await h.hook.close()

    expect(res.error).toBeUndefined()
    expect(res.text.toLowerCase()).toContain('example domain') // it really browsed
    expect(h.audit().some((r) => r.tool === 'mcp__browser__browser_navigate' && r.decision === 'allow')).toBe(true)
    // The promise of the shadow surface: no visible browser window, ever.
    expect(windowSamples.length).toBeGreaterThan(3)
    expect(Math.max(...windowSamples)).toBe(0)
  }, 300_000)

  it('a gated click blocks and times out to deny, while navigation is auto-approved', async () => {
    // Ask mode, nobody answering: the click must die at the gate.
    const { root, persona } = makeBot('clickbot', `mode = "ask"\nbrowser_surface = "shadow"\n${READ_ONLY_AUTO}`)
    const h = harness(root, persona, 8_000)
    await h.hook.listen()
    const res = await h
      .runner()
      .run(persona, 'test', 'Go to https://example.com, read it, then click the "More information..." link. Report DONE or BLOCKED.')
    await h.hook.close()

    expect(res.error).toBeUndefined()
    expect(h.audit().some((r) => r.tool === 'mcp__browser__browser_navigate' && r.decision === 'allow')).toBe(true)
    const clicks = h.audit().filter((r) => r.tool === 'mcp__browser__browser_click')
    expect(clicks.length).toBeGreaterThan(0) // it did try
    expect(clicks.every((c) => c.decision === 'deny' && c.source === 'timeout')).toBe(true)
    expect(h.asked).toContain('mcp__browser__browser_click') // and a human was asked
  }, 300_000)
})
