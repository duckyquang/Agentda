import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendRoutine, type Persona, renderRoutineToml } from '@agentda/core'
import { RecordingSession } from '@agentda/watch'

// The daemon's side of watch-and-learn: one recording at a time per bot, and
// never while that bot is doing anything else.
//
// The exclusion is not politeness. A recording opens the bot's own browser
// profile so the routine is recorded against the same logged-in session it will
// replay against — and Chromium will not open one profile twice.

export interface Recording {
  bot: string
  startedAt: string
  session: RecordingSession
}

export class Recordings {
  private open = new Map<string, Recording>()

  has(bot: string): boolean {
    return this.open.has(bot)
  }

  list(): { bot: string; startedAt: string; steps: number }[] {
    return [...this.open.values()].map((r) => ({ bot: r.bot, startedAt: r.startedAt, steps: r.session.count }))
  }

  async start(persona: Persona, startUrl?: string, onAction?: (n: number) => void): Promise<void> {
    if (this.open.has(persona.id)) throw new Error(`${persona.id} is already recording`)
    const session = await RecordingSession.start({
      profileDir: join(persona.dir, 'browser-profile'),
      startUrl,
      onAction: (_a, i) => onAction?.(i + 1),
    })
    this.open.set(persona.id, { bot: persona.id, startedAt: new Date().toISOString(), session })
  }

  // Stops, writes the draft next to the bot, and adds a switched-off routine
  // pointing at it. Returns what the human needs to hear before they turn it on.
  async stop(persona: Persona, routineId: string, cron: string): Promise<{ path: string; steps: number; notes: string[] }> {
    const recording = this.open.get(persona.id)
    if (!recording) throw new Error(`${persona.id} is not recording`)
    this.open.delete(persona.id)

    const { routine, notes } = await recording.session.stop()
    const file = `${routineId}.toml`
    writeFileSync(join(persona.dir, file), renderRoutineToml(routine, notes))
    appendRoutine(persona, {
      id: routineId,
      cron,
      prompt: `replay the recorded routine "${routineId}"`,
      steps: file,
    })
    return { path: join(persona.dir, file), steps: routine.steps.length, notes }
  }

  async discard(bot: string): Promise<boolean> {
    const recording = this.open.get(bot)
    if (!recording) return false
    this.open.delete(bot)
    await recording.session.discard()
    return true
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((bot) => this.discard(bot)))
  }
}
