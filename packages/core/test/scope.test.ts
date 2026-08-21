import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveInScope, safeMemoryName } from '../src/index'

// The file tools' whole promise is "this bot touches these directories and
// nothing else". These are the ways that promise breaks.
function world() {
  const root = mkdtempSync(join(tmpdir(), 'agentda-scope-'))
  mkdirSync(join(root, 'work', 'sub'), { recursive: true })
  mkdirSync(join(root, 'secrets'), { recursive: true })
  writeFileSync(join(root, 'work', 'notes.md'), 'fine')
  writeFileSync(join(root, 'secrets', 'keys.txt'), 'TOP SECRET')
  return { root, scope: [join(root, 'work')] }
}

describe('path containment', () => {
  it('allows what is genuinely inside, including a file that does not exist yet', () => {
    const w = world()
    expect(resolveInScope(join(w.root, 'work', 'notes.md'), w.scope)).toContain('notes.md')
    expect(resolveInScope(join(w.root, 'work', 'sub', 'new.txt'), w.scope)).toContain('new.txt')
    expect(resolveInScope(join(w.root, 'work'), w.scope)).toBeTruthy()
  })

  it('refuses traversal and a sibling whose name merely starts the same', () => {
    const w = world()
    expect(() => resolveInScope(join(w.root, 'work', '..', 'secrets', 'keys.txt'), w.scope)).toThrow(/outside/)
    expect(() => resolveInScope(join(w.root, 'secrets', 'keys.txt'), w.scope)).toThrow(/outside/)
    // A sibling directory whose name starts the same must not pass.
    mkdirSync(join(w.root, 'work-secrets'))
    writeFileSync(join(w.root, 'work-secrets', 'x'), 'no')
    expect(() => resolveInScope(join(w.root, 'work-secrets', 'x'), w.scope)).toThrow(/outside/)
  })

  it('refuses a symlink inside the scope that points out of it', () => {
    // The one that shipped broken: a string-prefix check sees a path inside the
    // scope and the read follows the link straight out of the machine's
    // boundaries. Symlinked folders are ordinary, so this needs no attacker.
    const w = world()
    symlinkSync(join(w.root, 'secrets'), join(w.root, 'work', 'link'))
    expect(() => resolveInScope(join(w.root, 'work', 'link', 'keys.txt'), w.scope)).toThrow(/outside/)
    expect(() => resolveInScope(join(w.root, 'work', 'link'), w.scope)).toThrow(/outside/)
  })

  it('refuses a symlinked file too, not just a symlinked directory', () => {
    const w = world()
    symlinkSync(join(w.root, 'secrets', 'keys.txt'), join(w.root, 'work', 'innocent.txt'))
    expect(() => resolveInScope(join(w.root, 'work', 'innocent.txt'), w.scope)).toThrow(/outside/)
  })

  it('refuses a write through a symlinked directory, where the file does not exist yet', () => {
    const w = world()
    symlinkSync(join(w.root, 'secrets'), join(w.root, 'work', 'out'))
    expect(() => resolveInScope(join(w.root, 'work', 'out', 'planted.sh'), w.scope)).toThrow(/outside/)
  })

  it('still works when the scope itself is a symlink, which is how most home directories look', () => {
    const w = world()
    symlinkSync(join(w.root, 'work'), join(w.root, 'shortcut'))
    const viaLink = [join(w.root, 'shortcut')]
    expect(resolveInScope(join(w.root, 'shortcut', 'notes.md'), viaLink)).toContain('notes.md')
    // And the real path under the same scope is fine as well.
    expect(resolveInScope(join(w.root, 'work', 'notes.md'), viaLink)).toContain('notes.md')
  })

  it('refuses everything when the bot has no scope at all', () => {
    const w = world()
    expect(() => resolveInScope(join(w.root, 'work', 'notes.md'), [])).toThrow(/no directories in scope/)
  })
})

describe('memory file names', () => {
  it('adds .md and accepts ordinary names', () => {
    expect(safeMemoryName('contacts')).toBe('contacts.md')
    expect(safeMemoryName('notes.md')).toBe('notes.md')
  })

  it('refuses anything that would leave the memory directory', () => {
    for (const bad of ['../escape', '/etc/passwd', 'a/b', '..', 'x .md', '']) {
      expect(() => safeMemoryName(bad), bad).toThrow(/invalid memory file name/)
    }
  })
})
