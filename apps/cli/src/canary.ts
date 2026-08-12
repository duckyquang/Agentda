import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { claudeArgs, TESTED_CLAUDE_PREFIX } from '@agentda/provider-claude'

// Provider canary (PRD NFR-6 made practical). Run after every claude upgrade:
// checks install/version, then spends ONE cheap real turn to prove the
// isolation posture still holds — asserting on the machinery (init event,
// hook lines), never on what the model claims about itself, since a model with
// zero tools will happily hallucinate a toolbox.

let failed = false
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? '  ok' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}
const warn = (label: string) => console.log(`warn  ${label}`)

const version = await new Promise<string>((resolve) => {
  const c = spawn('claude', ['--version'])
  let out = ''
  c.stdout.on('data', (d) => (out += d))
  c.on('error', () => resolve(''))
  c.on('close', () => resolve(out.trim()))
})
check(!!version, 'claude CLI installed', version || 'not found — install Claude Code, run it once, /login')
if (version && !version.startsWith(TESTED_CLAUDE_PREFIX)) {
  warn(`untested claude generation (adapter verified against ${TESTED_CLAUDE_PREFIX}x) — the checks below tell you if it still behaves`)
}
if (process.env.ANTHROPIC_API_KEY) {
  warn('ANTHROPIC_API_KEY is set — turns bill your API org, not your subscription')
}

if (version) {
  console.log('running one isolated turn (cheap, real, billed to your plan)…')
  const child = spawn('claude', claudeArgs(), { stdio: ['pipe', 'pipe', 'pipe'] })
  const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.stdin.on('error', () => {})
  child.stdin.write(
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] } }) + '\n',
  )
  child.stdin.end()

  const lines: any[] = []
  for await (const line of createInterface({ input: child.stdout })) {
    try {
      lines.push(JSON.parse(line))
    } catch {}
  }
  clearTimeout(killer)

  const init = lines.find((l) => l.type === 'system' && l.subtype === 'init')
  const result = lines.find((l) => l.type === 'result')
  const hooks = lines.filter((l) => l.type === 'system' && String(l.subtype).startsWith('hook_'))

  check(!!init, 'stream has an init event')
  check(init?.tools?.length === 0, 'isolation: zero built-in tools', init ? `saw ${init.tools?.length}` : '')
  check(init?.mcp_servers?.length === 0, 'isolation: zero MCP servers', init ? `saw ${init.mcp_servers?.length}` : '')
  check(hooks.length === 0, 'isolation: no hooks ran', hooks.length ? `saw ${hooks.length} hook events` : '')
  check(result != null && result.is_error !== true, 'turn completed', result?.result ?? 'no result event')
  if (init?.apiKeySource && init.apiKeySource !== 'none') {
    warn(`auth source: ${init.apiKeySource} (subscription users expect 'none')`)
  }
  if (typeof result?.total_cost_usd === 'number') {
    console.log(`      canary cost: ~$${result.total_cost_usd.toFixed(2)} (CLI's own estimate)`)
  }
}

console.log(failed ? '\ncanary: FAIL — do not trust bot isolation on this setup' : '\ncanary: all good')
// not process.exit(): that truncates unflushed stdout when piped
process.exitCode = failed ? 1 : 0
