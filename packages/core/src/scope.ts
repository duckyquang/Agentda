import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

// Path containment for the file tools: the bot may touch what it was given and
// nothing else.
//
// Resolving with path.resolve alone is not enough, and the gap is not
// theoretical: a symlink sitting inside an allowed directory and pointing
// anywhere on the machine passes a string-prefix check and then reads whatever
// it points at. Symlinks in a home directory are ordinary — synced folders,
// dotfile managers, /tmp on macOS — so this is a hole an ordinary setup opens,
// not one an attacker has to engineer.
//
// So the real path is what gets checked. A file that does not exist yet (a
// write) is resolved through its deepest existing ancestor, because that is
// where a symlink would be.

function realDeep(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  // Walk up to something that exists, resolve that for real, then put the
  // non-existent tail back on.
  for (;;) {
    if (existsSync(current)) return [realpathSync(current), ...tail.reverse()].join(sep)
    const parent = dirname(current)
    if (parent === current) return resolve(path) // nothing on this path exists
    tail.push(current.slice(parent.length + 1))
    current = parent
  }
}

const inside = (child: string, root: string) => child === root || child.startsWith(root + sep)

// Throws unless `path` really lives inside one of `scopes`. Returns the
// resolved path, which is what callers should use — resolving twice is how the
// check and the operation end up disagreeing.
export function resolveInScope(path: string, scopes: string[]): string {
  if (!scopes.length) throw new Error('this bot has no directories in scope, so it cannot touch files')
  const target = realDeep(path)
  // A scope that is itself a symlink (~/Documents often is) has to resolve too,
  // or every legitimate path under it looks like an escape.
  const roots = scopes.map((s) => realDeep(s))
  if (!roots.some((root) => inside(target, root))) {
    throw new Error(`path outside this bot's allowed directories: ${resolve(path)}`)
  }
  return target
}

// Memory files are named by the model, so the name is untrusted input: it has
// to stay a plain file directly inside the bot's own memory directory.
export function safeMemoryName(file: string): string {
  if (!/^[\w.-]+$/.test(file) || file.includes('..') || isAbsolute(file)) {
    throw new Error(`invalid memory file name: ${file}`)
  }
  return file.endsWith('.md') ? file : `${file}.md`
}
