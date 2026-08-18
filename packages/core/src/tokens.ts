import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Per-persona Telegram tokens (PLAN Phase 2). Each bot gets its own BotFather
// identity — its own name, avatar, and username — so a group chat with three of
// your bots looks like three bots.
//
// Tokens deliberately do NOT live in bot.toml. A bot directory is meant to be
// copied and shared (PRD FR-9); a bot token is a password for an account. So
// they sit in one 0600 file in the daemon's home, keyed by bot id, and the bot
// directory stays safe to hand to someone.
export class TokenStore {
  constructor(private path: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      // A corrupt registry must not stop the daemon booting: the bots that use
      // the default token still work, and the UI can write a fresh one.
      return {}
    }
  }

  private write(all: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(all, null, 2), { mode: 0o600 })
    chmodSync(this.path, 0o600) // an existing file keeps its old mode otherwise
  }

  get(botId: string): string | undefined {
    return this.read()[botId]
  }

  // Which bots have their own identity. Ids only — nothing that prints a token
  // to a log or an API response by accident.
  ids(): string[] {
    return Object.keys(this.read())
  }

  set(botId: string, token: string): void {
    if (!/^\d+:[\w-]{30,}$/.test(token.trim())) {
      throw new Error('that does not look like a BotFather token (expected 123456789:AA...)')
    }
    this.write({ ...this.read(), [botId]: token.trim() })
  }

  remove(botId: string): void {
    const all = this.read()
    delete all[botId]
    this.write(all)
  }
}
