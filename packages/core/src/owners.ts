import { randomBytes } from 'node:crypto'
import type { Db } from './db'

// Owner pairing (PLAN Phase 1). A BotFather bot is publicly discoverable: anyone
// who finds the username can message it. Since the entire safety story is "a
// human approves", the bridge must know WHICH human — so every inbound update
// and every approval tap is checked against this allowlist, and unknown senders
// are dropped and logged rather than answered.
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
  mintCode(platform: string): string {
    const code = randomBytes(4).toString('hex')
    this.db.prepare('INSERT INTO pairing_codes (code, platform) VALUES (?, ?)').run(code, platform)
    return code
  }

  // Single-use by construction: the UPDATE only matches an unused row, so two
  // racing claims cannot both succeed.
  claim(platform: string, code: string, userId: string | number, label?: string): boolean {
    const r = this.db
      .prepare(`UPDATE pairing_codes SET used_at = datetime('now') WHERE code = ? AND platform = ? AND used_at IS NULL`)
      .run(code.trim(), platform)
    if (r.changes === 0) return false
    this.db
      .prepare('INSERT OR REPLACE INTO owners (platform, user_id, label) VALUES (?, ?, ?)')
      .run(platform, String(userId), label ?? null)
    return true
  }

  list(platform: string): { user_id: string; label: string | null }[] {
    return this.db.prepare('SELECT user_id, label FROM owners WHERE platform = ?').all(platform) as any[]
  }
}
