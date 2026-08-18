import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archivePersona, createPersona, loadPersona, loadPersonas, setConfigValues, updatePersona } from '../src/index'

const botsDir = () => mkdtempSync(join(tmpdir(), 'agentda-bots-'))

describe('creating and editing a bot from the app', () => {
  it('creates a directory a human can read, and loads it straight back', () => {
    const bots = botsDir()
    const p = createPersona(bots, { id: 'scout', name: 'Scout', browser: true, providers: ['codex', 'claude'] })
    expect(p.name).toBe('Scout')
    expect(p.browser).toBe(true)
    expect(p.providers.map((x) => x.provider)).toEqual(['codex', 'claude'])
    expect(existsSync(join(bots, 'scout', 'prompt.md'))).toBe(true)
    expect(loadPersonas(bots).map((x) => x.id)).toEqual(['scout'])
  })

  it('refuses ids that would not survive being a directory name or a mention', () => {
    const bots = botsDir()
    for (const id of ['../evil', 'Has Spaces', '', 'UPPER']) {
      expect(() => createPersona(bots, { id }), id).toThrow()
    }
    createPersona(bots, { id: 'chief' })
    expect(() => createPersona(bots, { id: 'chief' })).toThrow(/already exists/)
  })

  it('keeps the comments and layout the user wrote', () => {
    const bots = botsDir()
    const p = createPersona(bots, { id: 'chief' })
    const cfg = join(bots, 'chief', 'bot.toml')
    writeFileSync(cfg, '# my notes bot\nid = "chief"\nname = "Chief"\nmode = "ask"\n\n# runs every morning\n[[routines]]\nid = "am"\ncron = "0 9 * * *"\nprompt = "check the inbox"\n')

    updatePersona(loadPersona(join(bots, 'chief')), { mode: 'auto', browser: true })
    const after = readFileSync(cfg, 'utf8')
    expect(after).toContain('# my notes bot')
    expect(after).toContain('# runs every morning')
    expect(after).toContain('mode = "auto"')
    // The new key must land above the routine table, or it silently becomes
    // part of the routine instead of the bot.
    expect(after.indexOf('browser = true')).toBeLessThan(after.indexOf('[[routines]]'))
    const reloaded = loadPersona(join(bots, 'chief'))
    expect(reloaded.routines).toHaveLength(1)
    expect(reloaded.browser).toBe(true)
  })

  it('writes the prompt to prompt.md, not into the config', () => {
    const bots = botsDir()
    const p = updatePersona(createPersona(bots, { id: 'chief' }), { prompt: 'You are terse.' })
    expect(p.prompt).toBe('You are terse.')
    expect(readFileSync(join(bots, 'chief', 'bot.toml'), 'utf8')).not.toContain('You are terse')
  })

  it('clears a value by patching it to null', () => {
    const bots = botsDir()
    const p = updatePersona(createPersona(bots, { id: 'chief' }), { model: 'llama3.1:8b', dailyTurnCap: 20 })
    expect(p.model).toBe('llama3.1:8b')
    expect(updatePersona(p, { model: null, dailyTurnCap: null }).model).toBeUndefined()
  })

  it('archives instead of deleting, because memory is the user\'s own writing', () => {
    const bots = botsDir()
    const p = createPersona(bots, { id: 'chief' })
    writeFileSync(join(p.dir, 'memory', 'notes.md'), 'remember this')
    const dest = archivePersona(bots, p, 'stamp')
    expect(loadPersonas(bots)).toEqual([])
    expect(readFileSync(join(dest, 'memory', 'notes.md'), 'utf8')).toBe('remember this')
  })

  it('refuses to archive anything that is not a bot directory under the bots folder', () => {
    const bots = botsDir()
    const elsewhere = createPersona(botsDir(), { id: 'chief' })
    expect(() => archivePersona(bots, elsewhere)).toThrow(/refusing/)
  })

  it('does not confuse a key with one that merely starts the same', () => {
    const bots = botsDir()
    const cfg = join(bots, 'chief', 'bot.toml')
    createPersona(bots, { id: 'chief' })
    setConfigValues(cfg, { model: 'a', model_notes: 'b' })
    setConfigValues(cfg, { model: 'c' })
    const src = readFileSync(cfg, 'utf8')
    expect(src).toContain('model = "c"')
    expect(src).toContain('model_notes = "b"')
  })
})
