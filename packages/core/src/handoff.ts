import type { Db } from './db'

// Multi-bot work transfer (FR-35..37). Two rules keep this from becoming a
// runaway: handoffs are always visible in the thread, and a task has a hard cap
// on bot-to-bot turns. Two models passing work back and forth is the fastest
// way to burn a plan window, so the cap is load-bearing, not polish.
export const DEFAULT_HANDOFF_CAP = 4

export interface Handoff {
  chat: string
  task: string
  from: string
  to: string
  note?: string
}

export function recordHandoff(db: Db, h: Handoff): void {
  db.prepare('INSERT INTO handoffs (chat, task, from_bot, to_bot, note) VALUES (?, ?, ?, ?, ?)').run(
    h.chat,
    h.task,
    h.from,
    h.to,
    h.note ?? null,
  )
}

export function handoffCount(db: Db, chat: string, task: string): number {
  return (db.prepare('SELECT count(*) c FROM handoffs WHERE chat = ? AND task = ?').get(chat, task) as { c: number }).c
}

// Returns null when the cap is reached: the caller tells the humans and stops
// rather than letting the bots keep going.
export function tryHandoff(db: Db, h: Handoff, cap = DEFAULT_HANDOFF_CAP): { ok: true } | { ok: false; reason: string } {
  const n = handoffCount(db, h.chat, h.task)
  if (n >= cap) {
    return { ok: false, reason: `handoff cap reached (${cap} for task "${h.task}") — stopping and handing back to you` }
  }
  recordHandoff(db, h)
  return { ok: true }
}

// Handoffs are the trailing lines of a reply: "@scout: check these names".
// One line is the Phase 1 chain; several is the coordinator pattern (FR-38),
// where a planner splits work across specialists in a single turn. Parsing
// stops at the first line that is not a handoff, so a bot cannot smuggle one
// into the middle of its prose.
export function parseHandoffs(text: string): { to: string; note: string }[] {
  const lines = text.trim().split('\n').filter((l) => l.trim())
  const found: { to: string; note: string }[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^@([\w-]+)\s*[::]\s*(.+)$/.exec(lines[i].trim())
    if (!m) break
    found.unshift({ to: m[1], note: m[2] })
  }
  return found
}

