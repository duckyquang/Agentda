import { describe, expect, it } from 'vitest'
import { failoverNotice, nextProvider, shouldFailover } from '../src/failover'

const chain = [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'anthropic-api', metered: true }]

describe('failover policy', () => {
  it('only auth and limit failures are worth another provider', () => {
    expect(shouldFailover('limit')).toBe(true)
    expect(shouldFailover('auth')).toBe(true)
    // A crash or a bad prompt fails the same way everywhere; retrying spends twice.
    expect(shouldFailover('other')).toBe(false)
    expect(shouldFailover('killed')).toBe(false)
  })

  it('moves to the next free provider in order', () => {
    expect(nextProvider(chain, 'claude')?.choice.provider).toBe('codex')
  })

  it('stops at a metered provider unless the user opted in', () => {
    const step = nextProvider(chain, 'codex')
    expect(step?.choice.provider).toBe('anthropic-api')
    expect(step?.blockedReason).toMatch(/bills per token/)

    const opted = nextProvider(chain, 'codex', { allowMetered: true })
    expect(opted?.blockedReason).toBeUndefined()
  })

  it('returns nothing when the chain is exhausted', () => {
    expect(nextProvider(chain, 'anthropic-api', { allowMetered: true })).toBeUndefined()
  })

  it('tells the user context was rebuilt, never resumed', () => {
    const note = failoverNotice('claude', 'codex', 'limit')
    expect(note).toMatch(/plan limit/)
    expect(note).toMatch(/rebuilt/)
    expect(note).not.toMatch(/resumed the/i)
  })

  it('has no next provider for one that is not in the chain', () => {
    // Not knowing where you are in the chain is not the same as being at the
    // start of it. Slicing from findIndex -1 + 1 starts at zero, which hands
    // the work to the FIRST provider — possibly the one that just failed, and
    // for a provider that was never in the chain at all (a replayed routine,
    // say) it means handing that work to a model as prose.
    expect(nextProvider(chain, 'not-in-chain')).toBeUndefined()
  })
})

