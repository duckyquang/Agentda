import { randomBytes } from 'node:crypto'
import type { Db } from './db'

// Owner pairing (PLAN Phase 1). A BotFather bot is publicly discoverable: anyone
// who finds the username can message it. Since the entire safety story is "a
// human approves", the bridge must know WHICH human — so every inbound update
// and every approval tap is checked against this allowlist, and unknown senders
// are dropped and logged rather than answered.
// What a paired person may do (PLAN Phase 5). Roles rather than a flag,
// because "may talk to the bots" and "may approve what they do" are genuinely
// different permissions once a second person exists — and the second one is the
// whole safety story.
export type Role = 'owner' | 'approver' | 'member'

// owner  — everything, including inviting people and editing bots
// approver — may answer approval cards, and talk
// member — may talk; their taps do not count
const CAN_APPROVE: Role[] = ['owner', 'approver']
const CAN_ADMIN: Role[] = ['owner']

export class Owners {
  constructor(private db: Db) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owners (
        platform TEXT NOT NULL,
        user_id TEXT NOT NULL,
        label TEXT,
        paired_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (platform, user_id)
      );
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        used_at TEXT
      );
    `)
    // Everyone paired before roles existed was the sole owner, so that is what
    // they stay.
    const columns = (this.db.prepare('PRAGMA table_info(owners)').all() as { name: string }[]).map((c) => c.name)
    if (!columns.includes('role')) this.db.exec(`ALTER TABLE owners ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'`)
    const codeColumns = (this.db.prepare('PRAGMA table_info(pairing_codes)').all() as { name: string }[]).map((c) => c.name)
    if (!codeColumns.includes('role')) this.db.exec(`ALTER TABLE pairing_codes ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'`)
  }

  role(platform: string, userId: string | number): Role | undefined {
    return (
      this.db.prepare('SELECT role FROM owners WHERE platform = ? AND user_id = ?').get(platform, String(userId)) as
        | { role: Role }
        | undefined
    )?.role
  }

  // The check that matters. A paired person is not automatically someone whose
  // tap counts.
  canApprove(platform: string, userId: string | number): boolean {
    const role = this.role(platform, userId)
    return !!role && CAN_APPROVE.includes(role)
  }

  canAdmin(platform: string, userId: string | number): boolean {
    const role = this.role(platform, userId)
    return !!role && CAN_ADMIN.includes(role)
  }

  setRole(platform: string, userId: string | number, role: Role): void {
    this.db.prepare('UPDATE owners SET role = ? WHERE platform = ? AND user_id = ?').run(role, platform, String(userId))
  }

  isOwner(platform: string, userId: string | number): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM owners WHERE platform = ? AND user_id = ?')
      .get(platform, String(userId))
  }

  count(platform: string): number {
    return (this.db.prepare('SELECT count(*) c FROM owners WHERE platform = ?').get(platform) as { c: number }).c
  }

  // Whether a code is already waiting to be used on this platform. A bridge
  // that starts later — a bot given its own token from the app — needs a code
  // too, but it does not need a fresh one printed per bridge.
  hasUnusedCode(platform: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM pairing_codes WHERE platform = ? AND used_at IS NULL')
      .get(platform)
  }

  // A short, single-use code the human DMs to the bot to prove which account is
  // theirs. Short because it's typed by hand and lives for one pairing.
  mintCode(platform: string, role: Role = 'owner'): string {
    const code = randomBytes(4).toString('hex')
    this.db.prepare('INSERT INTO pairing_codes (code, platform, role) VALUES (?, ?, ?)').run(code, platform, role)
    return code
  }

  // Single-use by construction: the UPDATE only matches an unused row, so two
  // racing claims cannot both succeed.
  claim(platform: string, code: string, userId: string | number, label?: string): boolean {
    // The role travels with the code, so an invite decides what the person
    // gets before they ever use it.
    const invite = this.db
      .prepare(`SELECT role FROM pairing_codes WHERE code = ? AND platform = ? AND used_at IS NULL`)
      .get(code.trim(), platform) as { role: Role } | undefined
    const r = this.db
      .prepare(`UPDATE pairing_codes SET used_at = datetime('now') WHERE code = ? AND platform = ? AND used_at IS NULL`)
      .run(code.trim(), platform)
    if (r.changes === 0) return false
    this.db
      .prepare('INSERT OR REPLACE INTO owners (platform, user_id, label, role) VALUES (?, ?, ?, ?)')
      .run(platform, String(userId), label ?? null, invite?.role ?? 'owner')
    return true
  }

  list(platform: string): { user_id: string; label: string | null; role: Role }[] {
    return this.db.prepare('SELECT user_id, label, role FROM owners WHERE platform = ?').all(platform) as any[]
  }
}
