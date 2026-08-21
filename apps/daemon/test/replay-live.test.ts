import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApprovalQueue,
  compileRoutine,
  HookServer,
  loadPersonas,
  loadRoutine,
  openDb,
  type RawAction,
  renderRoutineToml,
  SessionStore,
  TurnRunner,
} from '@agentda/core'
import { ReplayAdapter } from '@agentda/watch'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// A recorded routine replayed for real: real Chromium, a real page, the real
// TurnRunner, the real ApprovalQueue and the real audit log. No provider CLI
// and no API key — replay is its own provider, which is the point of the
// design.
//
// Opt-in via AGENTDA_LIVE=1.
const live = process.env.AGENTDA_LIVE === '1'
vi.setConfig({ testTimeout: 120_000 })

const roots: string[] = []
let server: Server
let base = ''
// The page can be redrawn between tests to stand in for a week of drift.
let variant: 'v1' | 'drifted' | 'ambiguous' = 'v1'

const PAGES = {
  v1: `<!doctype html><meta charset=utf-8><title>Invoices</title><main>
    <form><label for=amt>Amount</label><input id=amt name=amount class="css-1x2y">
    <button type=button id=go>Send payment</button></form>
    <p id=out></p></main>
    <script>go.onclick = () => out.textContent = 'Payment sent'</script>`,
  // Same page a week later: the hashed class is gone, the form id changed, a
  // banner was inserted above the field, and the wording moved on.
  drifted: `<!doctype html><meta charset=utf-8><title>Invoices</title><main>
    <div role=status>We have refreshed this page</div>
    <form id=form-2026><label for=a2>Amount</label><input id=a2 name=amount class="sc-9f2b">
    <button type=button id=g2>Send payment</button></form>
    <p id=out></p></main>
    <script>g2.onclick = () => out.textContent = 'Payment sent'</script>`,
  // Two things answering to the same words.
  ambiguous: `<!doctype html><meta charset=utf-8><title>Invoices</title><main>
    <form><label for=amt>Amount</label><input id=amt name=amount>
    <button type=button>Send payment</button><button type=button>Send payment</button></form>
    <p id=out></p></main>`,
}

beforeAll(async () => {
  if (!live) return
  server = createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGES[variant])
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
})

afterAll(() => {
  server?.close()
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }))
})

// What Playwright's recorder produced for this page, in its real shape.
const recording = (): RawAction[] => [
  { name: 'navigate', url: base },
  { name: 'fill', ref: 'e5', selector: 'internal:role=textbox[name="Amount"i]', text: '42.00' },
  { name: 'click', ref: 'e8', selector: 'internal:role=button[name="Send payment"i]' },
]

function bot(opts: { mode?: 'ask' | 'auto'; alwaysAsk?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentda-replay-'))
  roots.push(root)
  const dir = join(root, 'bots', 'runner')
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(
    join(dir, 'bot.toml'),
    `id = "runner"\nprovider = "replay"\nmode = "${opts.mode ?? 'ask'}"\nbrowser = true\n${opts.alwaysAsk ?? ''}`,
  )
  writeFileSync(join(dir, 'prompt.md'), 'You replay recorded routines.')

  const { routine, notes } = compileRoutine(recording(), { recordedAt: '2026-08-21T09:00:00Z', recordedUrl: base })
  // What the human does in the app: read it, then say yes.
  const path = join(dir, 'pay.toml')
  writeFileSync(path, renderRoutineToml(routine, notes).replace('reviewed = false', 'reviewed = true'))

  const dbPath = join(root, 'state.db')
  const db = openDb(dbPath)
  const asked: string[] = []
  const decisions = new Map<string, 'allow' | 'deny'>()
  const queue = new ApprovalQueue(db, {
    timeoutMs: 8_000,
    ask: (r) => {
      asked.push(r.tool)
      // Stand in for the human, immediately.
      const verdict = decisions.get(r.tool) ?? 'allow'
      setTimeout(() => queue.settle(r.id, { decision: verdict, source: 'human-tap' }), 10)
    },
  })
  const persona = loadPersonas(join(root, 'bots'))[0]
  const hook = new HookServer(queue, () => ({ bot: persona.id, chat: 'test', policy: persona.policy, paused: false }), 'replaysecret')
  const handbacks: string[] = []

  const runner = new TurnRunner({
    db,
    sessions: new SessionStore(dbPath),
    queue,
    hook,
    adapters: new Map([['replay', new ReplayAdapter()]]),
  })

  const run = () =>
    runner.run(persona, 'test', 'pay the invoice', {
      provider: 'replay',
      adapterOptions: {
        replay: {
          routine: loadRoutine(path),
          profileDir: join(dir, 'browser-profile'),
          onHandback: (reason: string) => void handbacks.push(reason),
        },
      },
    })

  const audit = () => db.prepare('SELECT tool, decision, source, mode FROM audit_log ORDER BY id').all() as any[]
  return { run, audit, asked, decisions, handbacks, db, persona, path }
}

describe.runIf(live)('replaying a recorded routine', () => {
  it('runs every step through the real gate and audits each one', async () => {
    variant = 'v1'
    const b = bot()
    const res = await b.run()

    expect(res.error).toBeUndefined()
    expect(res.text).toContain('Replayed 3 of 3 steps')
    // Each step reaches the queue under the same tool name a model's own call
    // would use — one policy, one audit vocabulary.
    expect(b.audit().map((r) => r.tool)).toEqual([
      'mcp__browser__browser_navigate',
      'mcp__browser__browser_type',
      'mcp__browser__browser_click',
    ])
    expect(b.audit().every((r) => r.decision === 'allow')).toBe(true)
    // One turn, not three: a routine is one piece of work the bot did.
    expect((b.db.prepare('SELECT count(*) c FROM turn_ledger').get() as { c: number }).c).toBe(1)
  })

  it('a denied step stops the whole routine rather than skipping it', async () => {
    variant = 'v1'
    const b = bot()
    b.decisions.set('mcp__browser__browser_click', 'deny')
    const res = await b.run()

    // Skipping the click and carrying on would leave a filled form nobody
    // submitted; skipping a fill and carrying on would submit the old value.
    expect(res.text).not.toContain('Replayed 3 of 3')
    expect(b.audit().map((r) => r.decision)).toEqual(['allow', 'allow', 'deny'])
    expect(b.handbacks.join(' ')).toMatch(/stopped the whole routine/)
  })

  it('a step the human marked sensitive still asks in Auto', async () => {
    variant = 'v1'
    // Auto, and the click is NOT on the always-ask list — an ordinary click
    // would run unattended here.
    const b = bot({ mode: 'auto', alwaysAsk: 'always_ask = ["Bash"]\n' })
    await b.run()

    const click = b.audit().find((r) => r.tool === 'mcp__browser__browser_click')
    expect(b.asked).toContain('mcp__browser__browser_click')
    // And the row says ask, because that is what happened.
    expect(click).toMatchObject({ decision: 'allow', source: 'human-tap', mode: 'ask' })
    // The unremarkable step went through unattended, so the difference really
    // is the sensitivity and not the mode.
    expect(b.audit().find((r) => r.tool === 'mcp__browser__browser_type')).toMatchObject({ source: 'auto-mode' })
  })

  it('survives a page that has been redrawn since the recording', async () => {
    variant = 'drifted'
    const b = bot()
    const res = await b.run()

    // The recorded selectors are gone; the words on the field and the button
    // are not.
    expect(res.text).toContain('Replayed 3 of 3 steps')
    expect(res.text).toMatch(/found it another way|role=/)
  })

  it('stops rather than guessing when two things answer to the same words', async () => {
    variant = 'ambiguous'
    const b = bot()
    const res = await b.run()

    expect(res.text).not.toContain('Replayed 3 of 3')
    expect(b.handbacks.join(' ')).toMatch(/matches 2 elements/)
    // It never asked about the click, because there was nothing honest to ask.
    expect(b.asked).not.toContain('mcp__browser__browser_click')
  })

  it('refuses a routine nobody has reviewed, before opening a browser', async () => {
    variant = 'v1'
    const b = bot()
    const unreviewed = loadRoutine(b.path)
    unreviewed.reviewed = false
    const res = await new TurnRunner({
      db: b.db,
      sessions: new SessionStore(':memory:'),
      queue: new ApprovalQueue(b.db, {}),
      hook: new HookServer(new ApprovalQueue(b.db, {}), () => ({ bot: 'runner', chat: null, policy: b.persona.policy, paused: false }), 's'),
      adapters: new Map([['replay', new ReplayAdapter()]]),
    }).run(b.persona, 'test', 'go', {
      provider: 'replay',
      adapterOptions: { replay: { routine: unreviewed, profileDir: join(tmpdir(), 'never-used') } },
    })
    expect(res.text).toMatch(/nobody has reviewed/)
  })
})
