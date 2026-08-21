import { parseHandoffs, type Persona } from '@agentda/core'

// The daemon's entry point is a script: it wires servers, holds process state,
// and cannot be imported without starting all of that. So the decisions it
// makes live here instead, as plain functions over plain values — these are the
// parts that decide who acts and who speaks, and they are worth testing.

export interface Dispatch {
  targets: { persona: Persona; note: string }[]
  // Handoff-looking lines that were NOT at the end of the reply and so were not
  // acted on. Reported rather than dropped: a planner producing stray ones is
  // the difference between a whole plan and half of one.
  ignored: number
  // Names that looked like handoffs but match no bot the daemon knows.
  unknown: string[]
}

const HANDOFF_LINE = /^@[\w-]+\s*[::]\s*.+$/

// Who a reply hands work to. One trailing line is the ordinary chain; a
// coordinator may name several in one turn (FR-38). Only trailing lines ever
// count, so nothing can smuggle a handoff into the middle of prose — including
// text the bot is quoting back from a page or an email.
export function planDispatch(text: string, from: Persona, known: Persona[]): Dispatch {
  const all = parseHandoffs(text)
  const looksLikeHandoff = text.split('\n').filter((l) => HANDOFF_LINE.test(l.trim())).length
  const chosen = from.coordinator ? all : all.slice(-1)
  const targets: Dispatch['targets'] = []
  const unknown: string[] = []
  for (const h of chosen) {
    const persona = known.find((p) => p.id.toLowerCase() === h.to.toLowerCase())
    // A bot handing work to itself is a loop with extra steps.
    if (!persona || persona.id === from.id) {
      if (!persona) unknown.push(h.to)
      continue
    }
    targets.push({ persona, note: h.note })
  }
  return { targets, ignored: Math.max(0, looksLikeHandoff - all.length), unknown }
}

// A bridge the daemon can speak through. Kept structural so this file does not
// depend on any platform's SDK.
export interface Speaker {
  platform: string
  send: (chat: string, text: string) => Promise<unknown>
  stop: () => Promise<unknown>
}

// Which bridge reaches a given bot in a given thread.
//
// Two rules, in order: a bot with its own Telegram identity always speaks as
// itself, and otherwise a reply goes back the way the message came. A thread
// the daemon has never heard from has no speaker at all — which is correct, not
// a failure: desktop turns carry a chat id no chat platform can post to.
export class Speakers<S extends Speaker> {
  private byChat = new Map<string, S>()
  private telegram = new Map<string, S>() // bot id, or '' for the shared token
  private all = new Set<S>()

  static readonly SHARED = ''

  add(speaker: S, telegramKey?: string): S {
    this.all.add(speaker)
    if (telegramKey !== undefined) this.telegram.set(telegramKey, speaker)
    return speaker
  }

  remove(speaker: S): void {
    this.all.delete(speaker)
    for (const [key, s] of this.telegram) if (s === speaker) this.telegram.delete(key)
    for (const [chat, s] of this.byChat) if (s === speaker) this.byChat.delete(chat)
  }

  removeTelegram(key: string): S | undefined {
    const speaker = this.telegram.get(key)
    if (speaker) this.remove(speaker)
    return speaker
  }

  hasTelegram(key: string): boolean {
    return this.telegram.has(key)
  }

  // The bridges currently running, which is what a sync has to walk: a token
  // that was removed is gone from the registry, so iterating the registry would
  // never notice the bridge it left behind.
  telegramKeys(): string[] {
    return [...this.telegram.keys()]
  }

  // Called whenever a message arrives, so the daemon learns where a thread is.
  remember(chat: string, speaker: S): void {
    this.byChat.set(chat, speaker)
  }

  knows(chat: string): boolean {
    return this.byChat.has(chat)
  }

  for(botId: string, chat: string): S | undefined {
    const via = this.byChat.get(chat)
    if (via?.platform === 'telegram') return this.telegram.get(botId) ?? via
    return via
  }

  get size(): number {
    return this.all.size
  }

  list(): S[] {
    return [...this.all]
  }

  platforms(): string[] {
    return [...new Set([...this.all].map((s) => s.platform))]
  }
}

// Work for one key runs one item at a time, and never on the caller's stack.
//
// Off the stack because a chat bridge that waits for a turn cannot deliver the
// button press the turn is blocked on. One at a time because two turns for the
// same bot share one browser profile and one memory directory, and Chromium
// will not open a profile twice.
export class Serial {
  private chains = new Map<string, Promise<unknown>>()

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const queued = (this.chains.get(key) ?? Promise.resolve())
      .catch(() => {}) // a failed item must not poison the ones behind it
      .then(work)
    this.chains.set(key, queued)
    void queued.catch(() => {}).finally(() => {
      if (this.chains.get(key) === queued) this.chains.delete(key)
    })
    return queued
  }

  get busy(): number {
    return this.chains.size
  }

  // Whether THIS key has work in flight. The count above answers a different
  // question, and using it to decide whether one bot may start something meant
  // any bot being busy blocked every other one.
  isBusy(key: string): boolean {
    return this.chains.has(key)
  }
}

