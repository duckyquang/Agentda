import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApprovalQueue, type BotPolicy, defaultPolicy, HookServer, openDb } from '../src/index'

// The gate has to know WHICH bot is asking. It cannot learn that from the
// session id: a session id is only known to us once a turn produces a result,
// which is the end of the turn, so on a session's first tool call there is
// nothing to look up.
const bots: Record<string, { policy: BotPolicy; chat: string }> = {
  // Permissive: in Auto, and allowed to write.
  chief: { policy: { ...defaultPolicy('auto'), grants: ['Write'] }, chat: 'chief-chat' },
  // Restrictive: in Ask, and granted nothing at all.
  scout: { policy: { ...defaultPolicy('ask'), grants: [] }, chat: 'scout-chat' },
}

let open: HookServer | undefined
afterEach(async () => {
  await open?.close()
  open = undefined
})

async function gate() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'agentda-hook-')), 'd.db'))
  const asked: string[] = []
  const queue = new ApprovalQueue(db, { timeoutMs: 500, ask: (r) => void asked.push(`${r.bot}/${r.chat}`) })
  const seen = new Map<string, string>() // what the daemon knows: nothing, on a first call
  const hook = new HookServer(
    queue,
    (sessionId, fromUrl) => {
      const id = fromUrl ?? seen.get(sessionId)
      const bot = id ? bots[id] : undefined
      if (!bot || !id) throw new Error(`gate could not tell which bot is asking (session ${sessionId})`)
      return { bot: id, chat: bot.chat, policy: bot.policy, paused: false }
    },
    'secret',
  )
  open = hook
  const port = await hook.listen()
  const call = (path: string, tool = 'Write') =>
    fetch(`http://127.0.0.1:${port}/hook/secret/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'a-brand-new-session', tool_name: tool, tool_input: { path: '/tmp/x' } }),
    })
  const audit = () => db.prepare('SELECT bot, chat, decision, source, mode FROM audit_log ORDER BY id DESC LIMIT 1').get() as any
  return { hook, call, asked, audit, db, port }
}

describe('the gate knows which bot is asking', () => {
  it('judges a bot by its own policy on the very first call of a session', async () => {
    const g = await gate()
    // scout is granted nothing, so this is refused outright — not escalated,
    // and above all not auto-allowed under the other bot's Auto mode.
    const verdict = await (await g.call('claude/scout')).json()
    expect(verdict.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(g.audit()).toMatchObject({ bot: 'scout', chat: 'scout-chat', decision: 'deny', mode: 'ask' })
  })

  it('the same call under the permissive bot is allowed, so the difference is really the policy', async () => {
    const g = await gate()
    const verdict = await (await g.call('claude/chief')).json()
    expect(verdict.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(g.audit()).toMatchObject({ bot: 'chief', decision: 'allow', source: 'auto-mode' })
  })

  it('fails closed when the bot cannot be identified at all', async () => {
    const g = await gate()
    // No bot in the path and no session mapping: the old code fell back to the
    // first bot loaded, which is how one bot's action got another's policy.
    const verdict = await (await g.call('claude')).json()
    expect(verdict.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(verdict.hookSpecificOutput.permissionDecisionReason).toMatch(/gate error/i)
    expect(g.asked).toEqual([])
  })

  it('bakes the bot into the settings file each turn hands its CLI', async () => {
    const g = await gate()
    const dir = mkdtempSync(join(tmpdir(), 'agentda-settings-'))
    const settings = g.hook.writeSettings(dir, 'claude', 'scout')
    expect(readFileSync(join(dir, 'gate-claude.mjs'), 'utf8')).toContain(`/hook/secret/claude/scout`)
    expect(readFileSync(settings, 'utf8')).toContain('gate-claude.sh')
  })

  it('keeps the two providers’ settings apart, even in one directory', async () => {
    const g = await gate()
    // Every turn writes both into its own run directory. They used to share a
    // filename, so the codex call replaced the file `claude --settings` was
    // given — and Claude then ran the codex shim, whose way of saying
    // "approved" is to print nothing, which is also what a broken shim does.
    const dir = mkdtempSync(join(tmpdir(), 'agentda-settings-'))
    const claude = g.hook.writeSettings(dir, 'claude', 'scout')
    g.hook.shimPath(dir, 'codex', 'scout')
    expect(readFileSync(claude, 'utf8')).toContain('gate-claude.sh')
    expect(readFileSync(claude, 'utf8')).not.toContain('gate-codex.sh')
  })

  it('survives a bot id that is not URL-safe, since bot.toml is hand-written', async () => {
    const g = await gate()
    const dir = mkdtempSync(join(tmpdir(), 'agentda-settings-'))
    g.hook.writeSettings(dir, 'codex', 'odd/name')
    expect(readFileSync(join(dir, 'gate-codex.mjs'), 'utf8')).toContain('odd%2Fname')
  })

  it('still answers codex in its own dialect', async () => {
    const g = await gate()
    // On Codex an approval is silence, expressed as an explicit marker the shim
    // turns into silence — a dead server has to stay a deny.
    const res = await g.call('codex/chief')
    expect(await res.text()).toBe('AGENTDA_ALLOW')
  })
})
