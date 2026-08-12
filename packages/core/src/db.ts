import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

// One SQLite file for all daemon state (PLAN Phase 1). Memory is deliberately NOT
// here — it lives as Markdown files in each bot's directory so it stays
// hand-editable and shareable (PRD FR-9/FR-25). The sessions table matches
// SessionStore's own definition so the CLI and daemon can share a file.
export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      bot TEXT NOT NULL, chat TEXT NOT NULL, provider TEXT NOT NULL,
      session_id TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (bot, chat, provider)
    );

    -- Append-only decision trail. The gate writes here in the SAME code path that
    -- enforces the decision (NFR-3): an unlogged action is an ungated one, so
    -- there is no way to act without a row landing here first.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      bot TEXT NOT NULL,
      chat TEXT,
      tool TEXT NOT NULL,
      input_json TEXT NOT NULL,
      decision TEXT NOT NULL,          -- allow | deny
      source TEXT NOT NULL,            -- auto-class | auto-mode | human-tap | human-text | timeout | standing-rule
      mode TEXT NOT NULL,              -- ask | auto (bot mode at decision time)
      reason TEXT
    );

    -- Our own turn counts, for the soft budgets. Local estimates only: no vendor
    -- publishes real plan metering, so we never claim these are that.
    CREATE TABLE IF NOT EXISTS turn_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot TEXT NOT NULL,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turn_ledger_bot_ts ON turn_ledger (bot, ts);

    -- At-most-once scheduling across sleep and crash (NFR-4): a routine
    -- occurrence is claimed here before it runs, so a restart cannot re-fire it.
    CREATE TABLE IF NOT EXISTS routine_runs (
      bot TEXT NOT NULL,
      routine TEXT NOT NULL,
      occurrence TEXT NOT NULL,
      ran_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY (bot, routine, occurrence)
    );

    -- Multi-bot handoffs: visible work transfer with a hard turn cap so two
    -- models cannot ping-pong through the user's quota (FR-35..37).
    CREATE TABLE IF NOT EXISTS handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat TEXT NOT NULL,
      task TEXT NOT NULL,
      from_bot TEXT NOT NULL,
      to_bot TEXT NOT NULL,
      note TEXT,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Approvals outlive the process: a request parked here is reloaded and
    -- re-denied on restart rather than orphaning a blocked provider turn.
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      bot TEXT NOT NULL,
      chat TEXT,
      tool TEXT NOT NULL,
      input_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
  `)
  return db
}

export type Db = ReturnType<typeof openDb>
