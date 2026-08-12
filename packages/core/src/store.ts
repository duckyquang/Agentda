import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

// Provider session ids keyed by (bot, chat, provider), so a daemon or REPL
// restart picks a conversation back up via resume. PLAN Phase 0.
export class SessionStore {
  private db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      bot TEXT NOT NULL,
      chat TEXT NOT NULL,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (bot, chat, provider)
    )`)
  }

  get(bot: string, chat: string, provider: string): string | undefined {
    const row = this.db
      .prepare('SELECT session_id FROM sessions WHERE bot = ? AND chat = ? AND provider = ?')
      .get(bot, chat, provider) as { session_id: string } | undefined
    return row?.session_id
  }

  set(bot: string, chat: string, provider: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (bot, chat, provider, session_id, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(bot, chat, provider) DO UPDATE SET
           session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(bot, chat, provider, sessionId)
  }

  clear(bot: string, chat: string, provider: string): void {
    this.db.prepare('DELETE FROM sessions WHERE bot = ? AND chat = ? AND provider = ?').run(bot, chat, provider)
  }

  close(): void {
    this.db.close()
  }
}
