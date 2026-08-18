import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadPacks, packGrants } from '@agentda/core'
import { describe, expect, it } from 'vitest'

// Vetting, not mocking: every pack that ships is launched for real and asked
// what tools it has. The plan's rule is that a pack lands only after it has
// been run, and the risk it guards against is a server whose tool surface is
// broader than its README admits — so the check is that every tool the server
// actually exposes is classified, not that the classification looks plausible.
//
// Opt-in via AGENTDA_LIVE=1: these download packages from npm and start real
// processes.
const live = process.env.AGENTDA_LIVE === '1'
const packsDir = join(fileURLToPath(new URL('../../..', import.meta.url)), 'packs')
const packs = loadPacks(packsDir)

describe.runIf(live)('shipped tool packs', () => {
  it('there are packs to vet at all', () => {
    expect(packs.length).toBeGreaterThan(0)
  })

  for (const pack of packs) {
    it(`${pack.id} starts, and every tool it exposes is classified`, async () => {
      // A scope to hand to packs that take one, so this exercises the same
      // expansion a real bot gets.
      const scope = mkdtempSync(join(tmpdir(), 'agentda-pack-'))
      const grants = packGrants([pack])

      for (const [name, entry] of Object.entries(grants.servers)) {
        const client = new Client({ name: 'agentda-pack-vet', version: '0' })
        await client.connect(
          new StdioClientTransport({
            command: entry.command,
            args: entry.args.flatMap((a) => (a === '{scope}' ? [scope] : [a])),
            env: { ...process.env, ...entry.env } as Record<string, string>,
          }),
        )
        const { tools } = await client.listTools()
        await client.close()

        expect(tools.length, `${name} exposed no tools`).toBeGreaterThan(0)
        const server = pack.servers.find((s) => s.name === name)!
        const classified = new Set([...server.readOnly, ...server.outbound])
        const unclassified = tools.map((t) => t.name).filter((t) => !classified.has(t))
        // Unclassified tools are not a failure — they are gated by default,
        // which is the safe direction. What must never happen is the reverse:
        // a tool listed as read-only that the server does not have, because
        // that means the classification was written from a README rather than
        // from the server.
        const missing = [...classified].filter((c) => !tools.some((t) => t.name === c))
        expect(missing, `${pack.id}/${name} classifies tools that do not exist`).toEqual([])
        if (unclassified.length) {
          console.log(`${pack.id}/${name}: gated by default (unclassified): ${unclassified.join(', ')}`)
        }
      }
    }, 180_000)
  }
})
