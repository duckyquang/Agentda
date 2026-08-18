import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultPolicy, loadPacks, missingEnv, type Persona, packGrants, refuseOnCodex, withPacks } from '../src/index'

const packsRoot = () => mkdtempSync(join(tmpdir(), 'agentda-packs-'))

function writePack(root: string, id: string, body: string) {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(join(root, id, 'pack.toml'), body)
}

const READER = `
id = "reader"
name = "Reader"
description = "reads things"
[[servers]]
name = "reader"
command = "npx"
args = ["-y", "some-reader", "{scope}"]
env_required = []
read_only = ["fetch_page", "list_feeds"]
outbound = []
`

const MAILER = `
id = "mailer"
name = "Mailer"
description = "sends things"
[[servers]]
name = "mailer"
command = "npx"
args = ["-y", "some-mailer"]
env_required = ["MAILER_TOKEN"]
read_only = ["list_messages"]
outbound = ["send_message"]
`

const persona = (over: Partial<Persona> = {}): Persona =>
  ({
    id: 'chief',
    dir: '/tmp/chief',
    name: 'chief',
    prompt: '',
    provider: 'claude',
    providers: [{ provider: 'claude' }],
    allowMeteredFailover: false,
    policy: { ...defaultPolicy(), grants: ['mcp__agentda__*'] },
    tools: [],
    agentdaTools: true,
    browser: false,
    email: false,
    browserSurface: 'shadow',
    scope: ['/tmp/work'],
    routines: [],
    packs: [],
    ...over,
  }) as Persona

describe('tool packs', () => {
  it('loads packs from a directory, later directories winning', () => {
    const a = packsRoot()
    const b = packsRoot()
    writePack(a, 'reader', READER)
    writePack(b, 'reader', READER.replace('name = "Reader"', 'name = "My Reader"'))
    expect(loadPacks(a, b).map((p) => p.name)).toEqual(['My Reader'])
  })

  it('auto-approves only what the pack calls read-only', () => {
    const root = packsRoot()
    writePack(root, 'mailer', MAILER)
    const grants = packGrants(loadPacks(root), { MAILER_TOKEN: 'x' } as NodeJS.ProcessEnv)
    expect(grants.grants).toEqual(['mcp__mailer__*'])
    expect(grants.autoApprove).toEqual(['mcp__mailer__list_messages'])
    // The send verb is granted but never auto-approved: that is the whole
    // reason the classification exists.
    expect(grants.autoApprove).not.toContain('mcp__mailer__send_message')
    expect(grants.outbound).toEqual(['mcp__mailer__send_message'])
  })

  it('expands {scope} to the bot’s own directories', () => {
    const root = packsRoot()
    writePack(root, 'reader', READER)
    const p = withPacks(persona({ packs: ['reader'] }), loadPacks(root))
    expect(p.packServers!.reader.args).toEqual(['-y', 'some-reader', '/tmp/work'])
  })

  it('refuses to attach a pack whose credentials are missing, and says which', () => {
    const root = packsRoot()
    writePack(root, 'mailer', MAILER)
    const packs = loadPacks(root)
    expect(missingEnv(packs[0], {} as NodeJS.ProcessEnv)).toEqual(['MAILER_TOKEN'])
    const p = withPacks(persona({ packs: ['mailer'] }), packs, {} as NodeJS.ProcessEnv)
    expect(Object.keys(p.packServers ?? {})).toEqual([])
    expect(p.packNotices!.join(' ')).toContain('MAILER_TOKEN')
  })

  it('says so when a bot names a pack that is not installed', () => {
    const p = withPacks(persona({ packs: ['nope'] }), [])
    expect(p.packNotices!.join(' ')).toContain('nope')
  })

  it('refuses packs on Codex, where an MCP call cannot run at all', () => {
    const root = packsRoot()
    writePack(root, 'mailer', MAILER)
    const packs = loadPacks(root)
    expect(refuseOnCodex(packs)).toMatch(/outbound verbs/)
    const p = withPacks(persona({ provider: 'codex', packs: ['mailer'] }), packs, { MAILER_TOKEN: 'x' } as NodeJS.ProcessEnv)
    expect(Object.keys(p.packServers ?? {})).toEqual([])
    expect(p.policy.grants).not.toContain('mcp__mailer__*')
    expect(p.packNotices!.join(' ')).toContain('ADR 0003')
  })

  it('leaves a bot with no packs exactly as it was', () => {
    const before = persona()
    expect(withPacks(before, [])).toBe(before)
  })
})
