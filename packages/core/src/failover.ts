import type { AdapterErrorKind } from './index'

// Provider failover (PRD FR-6). Two rules the design insists on:
//
// 1. Sessions are not portable. Falling over to another provider starts a fresh
//    session seeded from memory plus a restatement of the task — so the thread
//    says "context was rebuilt", never "resumed". Pretending otherwise would
//    quietly drop everything the bot had in flight.
// 2. Falling from a subscription onto metered billing changes what the user
//    pays, so it takes a deliberate opt-in rather than happening on its own.

export interface ProviderChoice {
  provider: string
  metered?: boolean // true when using this provider costs money per token
}

export type FailoverReason = Extract<AdapterErrorKind, 'auth' | 'limit'> | 'other'

// Only auth and limit failures are worth another provider. A crash or a bad
// prompt will fail the same way everywhere, and retrying it just spends twice.
export function shouldFailover(kind: AdapterErrorKind): boolean {
  return kind === 'auth' || kind === 'limit'
}

export interface FailoverStep {
  choice: ProviderChoice
  blockedReason?: string // set when this step is skipped rather than tried
}

// Walks the bot's ordered provider list after `from` failed, returning the next
// usable provider or the reason nothing was tried.
export function nextProvider(
  chain: ProviderChoice[],
  from: string,
  opts: { allowMetered?: boolean } = {},
): FailoverStep | undefined {
  const i = chain.findIndex((c) => c.provider === from)
  // A provider that is not in the chain has no "next": slicing from -1 + 1
  // would hand the work to the FIRST provider, which is either the one that
  // just failed or a metered one nobody opted into.
  if (i === -1) return undefined
  for (const choice of chain.slice(i + 1)) {
    if (choice.metered && !opts.allowMetered) {
      return {
        choice,
        blockedReason: `${choice.provider} bills per token — enable metered failover for this bot to use it`,
      }
    }
    return { choice }
  }
  return undefined
}

// The message the thread shows. Says rebuilt, not resumed, because that is what
// actually happened.
export function failoverNotice(from: string, to: string, kind: FailoverReason): string {
  const why = kind === 'limit' ? 'hit its plan limit' : kind === 'auth' ? 'is not logged in' : 'failed'
  return `${from} ${why} — continuing on ${to} with context rebuilt from memory, not resumed.`
}
