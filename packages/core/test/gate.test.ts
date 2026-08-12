import { describe, expect, it } from 'vitest'
import { decide, defaultPolicy, matches } from '../src/gate'

describe('matches', () => {
  it('exact and glob', () => {
    expect(matches('Bash', 'Bash')).toBe(true)
    expect(matches('Bash', 'BashOutput')).toBe(false)
    expect(matches('mcp__fs__*', 'mcp__fs__read_file')).toBe(true)
    expect(matches('mcp__*__shell*', 'mcp__box__shell_exec')).toBe(true)
    expect(matches('mcp__fs__*', 'mcp__mail__send')).toBe(false)
  })

  it('does not let regex metacharacters in a tool name widen a pattern', () => {
    expect(matches('mcp__fs__read', 'mcp__fs_read')).toBe(false) // '_' is literal, not a wildcard
    expect(matches('a.b', 'axb')).toBe(false) // '.' is literal
  })
})

describe('decide', () => {
  // Grants are what a bot may touch at all; most tests grant everything so they
  // can exercise the approval logic itself.
  const policy = (over: Partial<ReturnType<typeof defaultPolicy>> = {}) => ({ ...defaultPolicy(), grants: ['*'], ...over })

  it('gates unknown tools by default — fail closed', () => {
    expect(decide('SomeNewToolFromAFutureCLI', policy()).kind).toBe('approve')
  })

  it('denies outright anything the bot was never granted, without bothering the human', () => {
    const p = policy({ grants: ['mcp__agentda__*'] })
    expect(decide('Bash', p)).toMatchObject({ kind: 'deny' })
    expect(decide('mcp__mail__send', p)).toMatchObject({ kind: 'deny' })
    expect(decide('mcp__agentda__memory_write', p).kind).toBe('approve') // granted, still gated
  })

  it('a bot with no grants can do nothing at all', () => {
    expect(decide('Read', { mode: 'auto', grants: [], autoApprove: ['Read'], alwaysAsk: [] })).toMatchObject({ kind: 'deny' })
  })

  it('auto-approves only what the policy names read-only', () => {
    const p = policy({ autoApprove: ['mcp__fs__read_*'] })
    expect(decide('mcp__fs__read_file', p)).toMatchObject({ kind: 'allow', source: 'auto-class' })
    expect(decide('mcp__fs__write_file', p).kind).toBe('approve')
  })

  it('auto mode allows gated tools but NOT always-ask ones', () => {
    const p = policy({ mode: 'auto' })
    expect(decide('mcp__mail__send', p)).toMatchObject({ kind: 'allow', source: 'auto-mode' })
    expect(decide('Bash', p).kind).toBe('approve') // shell is wholesale always-ask
  })

  it('global pause forces ask even for an auto bot', () => {
    const p = policy({ mode: 'auto' })
    expect(decide('mcp__mail__send', p, true).kind).toBe('approve')
  })

  it('auto-approve wins over always-ask only when explicitly listed as read-only', () => {
    // A tool the user marked read-only is not second-guessed; that is their call
    // (FR-19), and the always-ask list exists for the gated classes.
    const p = policy({ mode: 'ask', autoApprove: ['Bash'] })
    expect(decide('Bash', p)).toMatchObject({ kind: 'allow' })
  })
})
