import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyError, codexArgs, mapLine } from '../src/index'

// fixture-turn.ndjson was recorded from a real `codex exec --json` run on
// codex-cli 0.146.1, macOS, ChatGPT-plan auth, 2026-08-13. Sanitized before
// commit: machine paths replaced with neutral ones and one local-environment
// notice removed. Event sequence and structure are verbatim.
const lines = () =>
  readFileSync(join(__dirname, 'fixture-turn.ndjson'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

describe('mapLine against a recorded codex turn', () => {
  it('surfaces the agent message as text and the shell call as a tool call', () => {
    const events = lines().flatMap(mapLine)
    const text = events.filter((e) => e.type === 'text').map((e) => (e as any).text).join('')
    expect(text).toContain('DONE')
    const tools = events.filter((e) => e.type === 'tool_call') as any[]
    expect(tools.some((t) => t.name === 'Bash')).toBe(true)
  })

  it('treats codex operational notices as warnings, not turn failures', () => {
    const warnings = lines().flatMap(mapLine).filter((e) => e.type === 'warning')
    expect(warnings.length).toBeGreaterThan(0) // hook-trust notice rides along
  })

  it('carries the thread id used for resume', () => {
    const started = lines().find((l) => l.type === 'thread.started')
    expect(started.thread_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('drops unknown and future event types instead of crashing', () => {
    expect(mapLine({ type: 'something.new' })).toEqual([])
    expect(mapLine('not an object')).toEqual([])
    expect(mapLine({ type: 'item.completed', item: { type: 'unknown_thing' } })).toEqual([])
  })
})

describe('codexArgs', () => {
  it('never writes to the user config, and keeps their settings out of bot turns', () => {
    const args = codexArgs('hi')
    expect(args).toContain('--ignore-user-config')
    expect(args.join(' ')).not.toContain('.codex/hooks.json') // config stays untouched
    expect(args).toContain('--json')
  })

  it('never attaches MCP servers: codex exec cancels MCP calls outright (ADR 0003)', () => {
    // Attaching them would hand a bot tools it can never use, which reads as a
    // broken bot rather than an unsupported provider capability.
    expect(codexArgs('hi').some((a) => a.startsWith('mcp_servers.'))).toBe(false)
  })

  it('disables the CLI prompter so our hook is the only approver', () => {
    expect(codexArgs('hi')).toContain('approval_policy="never"')
  })

  it('wires the gate per ADR 0003: opt-in flag, inline hook, no persisted trust', () => {
    const args = codexArgs('hi', { hookCommand: '/tmp/gate.sh' })
    // Without --enable hooks the CLI silently ignores hooks and the bot runs ungated.
    expect(args).toContain('--enable')
    expect(args).toContain('hooks')
    expect(args).toContain('--dangerously-bypass-hook-trust')
    const inline = args.find((a) => a.startsWith('hooks.PreToolUse='))
    expect(inline).toContain('"/tmp/gate.sh"')
  })

  it('omits all hook wiring when no gate is supplied, rather than half-configuring one', () => {
    const args = codexArgs('hi')
    expect(args).not.toContain('--dangerously-bypass-hook-trust')
    expect(args.some((a) => a.startsWith('hooks.'))).toBe(false)
  })

  it('defaults to read-only, the containment ADR 0003 relies on', () => {
    // The gate races on Codex, so the sandbox — not the hook — is what actually
    // stops a write. Changing this default silently un-protects every Codex bot.
    expect(codexArgs('hi')).toContain('read-only')
    expect(codexArgs('hi', { sandbox: 'workspace-write' })).toContain('workspace-write')
  })

  it('resume puts the thread id before the prompt', () => {
    const args = codexArgs('next question', { resume: 'thread-123' })
    expect(args[args.indexOf('resume') + 1]).toBe('thread-123')
    expect(args[args.length - 1]).toBe('next question')
  })
})

describe('classifyError', () => {
  it('auth and limit get their own kinds, everything else stays other', () => {
    expect(classifyError('You are not logged in. Run `codex login`')).toBe('auth')
    expect(classifyError('429 too many requests')).toBe('limit')
    expect(classifyError('usage limit reached for your plan')).toBe('limit')
    expect(classifyError('segmentation fault')).toBe('other')
  })
})
