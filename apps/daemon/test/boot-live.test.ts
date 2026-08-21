import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// The daemon's entry point is a 600-line script that wires a gate server, a
// control API, a scheduler and up to three chat bridges at module top level.
// Nothing else can import it — so nothing else notices when it stops starting.
//
// This boots the real process and watches what it says. It needs no provider,
// no token and no network: a daemon with one local bot and no bridges is a
// complete, running daemon.
const live = process.env.AGENTDA_LIVE === '1'
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const roots: string[] = []
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

function botHome(extra = '') {
  const root = mkdtempSync(join(tmpdir(), 'agentda-boot-'))
  roots.push(root)
  mkdirSync(join(root, 'bots', 'tester', 'memory'), { recursive: true })
  writeFileSync(join(root, 'bots', 'tester', 'bot.toml'), `id = "tester"\nname = "Tester"\nprovider = "ollama"\nmode = "ask"\n${extra}`)
  writeFileSync(join(root, 'bots', 'tester', 'prompt.md'), 'You are terse.')
  return root
}

function boot(root: string, env: Record<string, string> = {}) {
  const child = spawn(
    process.execPath,
    [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'apps/daemon/src/index.ts')],
    {
      cwd: repoRoot,
      env: { ...process.env, AGENTDA_HOME: root, AGENTDA_BOTS: join(root, 'bots'), AGENTDA_API_PORT: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (out += c))
  const waitFor = (re: RegExp, ms = 60_000) =>
    new Promise<RegExpMatchArray>((resolve, reject) => {
      const started = Date.now()
      const tick = setInterval(() => {
        const m = out.match(re)
        if (m) {
          clearInterval(tick)
          resolve(m)
        } else if (Date.now() - started > ms) {
          clearInterval(tick)
          reject(new Error(`never saw ${re}. Output so far:\n${out}`))
        }
      }, 100)
    })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, waitFor, exited, output: () => out }
}

describe.runIf(live)('the daemon actually starts', () => {
  it('comes up with no token at all and serves the desktop API', async () => {
    const d = boot(botHome())
    const [, url] = await d.waitFor(/desktop UI at (\S+)/)
    expect(d.output()).toContain('gate listening on 127.0.0.1')
    // Optional means optional: no Telegram, no Slack, no Discord, still a daemon.
    expect(d.output()).toContain('running desktop-only')

    const base = url.split('/?')[0]
    const token = url.split('token=')[1]
    const state = await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json()
    expect(state.bots.map((b: { id: string }) => b.id)).toEqual(['tester'])

    d.child.kill('SIGTERM')
    expect(await d.exited).toBe(0)
    // Graceful, not killed: the shutdown path has to run, or approvals are
    // stranded and the database is left mid-write.
    expect(d.output()).toContain('shutting down')
  }, 120_000)

  it('prints a pairing code per platform in use, and none when no bridge is running', async () => {
    const d = boot(botHome())
    await d.waitFor(/desktop UI at/)
    expect(d.output()).not.toContain('PAIRING CODE')
    d.child.kill('SIGTERM')
    await d.exited
  }, 120_000)

  it('attaches a bot’s packs at boot and says so when one cannot work', async () => {
    // `mailer` is not installed, so the daemon has to name it rather than start
    // a bot that quietly has fewer tools than its config claims.
    const d = boot(botHome('packs = ["thinking", "mailer"]\n'))
    const [, url] = await d.waitFor(/desktop UI at (\S+)/)
    expect(d.output()).toContain('tester: tester names a pack that is not installed: mailer')

    const base = url.split('/?')[0]
    const token = url.split('token=')[1]
    const bot = await (await fetch(`${base}/api/bots/tester`, { headers: { authorization: `Bearer ${token}` } })).json()
    expect(bot.autoApprove).toContain('mcp__thinking__sequentialthinking')

    d.child.kill('SIGTERM')
    await d.exited
  }, 120_000)

  it('exits with a message when there are no bots, rather than idling as a daemon with nothing to run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentda-boot-empty-'))
    roots.push(root)
    mkdirSync(join(root, 'bots'), { recursive: true })
    const d = boot(root)
    expect(await d.exited).toBe(1)
    expect(d.output()).toContain('no bots found in')
  }, 120_000)

  it('shuts down with its parent when the desktop shell asks it to', async () => {
    const d = boot(botHome(), { AGENTDA_EXIT_WITH_PARENT: '1' })
    await d.waitFor(/desktop UI at/)
    // The window being killed outright is the case this exists for: no signal
    // arrives, only the pipe closing.
    d.child.stdin.end()
    expect(await d.exited).toBe(0)
    expect(d.output()).toContain('shutting down')
  }, 120_000)
})
