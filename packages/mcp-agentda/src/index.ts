#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveInScope, safeMemoryName } from '@agentda/core'
import { z } from 'zod'

// Agentda's own MCP server: the bot's memory, plus scoped file access. Runs as a
// stdio child of the claude CLI, one per turn. Every call still passes the
// PreToolUse gate — this server holds no permission logic of its own, by design:
// one gate, one audit trail (NFR-3).
//
// AGENTDA_BOT_DIR is the bot's own directory (memory lives there); AGENTDA_SCOPE
// is a colon-separated allowlist of directories the file tools may touch.
const botDir = process.env.AGENTDA_BOT_DIR
if (!botDir) {
  console.error('AGENTDA_BOT_DIR is required')
  process.exit(1)
}
const memDir = join(botDir, 'memory')
mkdirSync(memDir, { recursive: true })
const scopes = (process.env.AGENTDA_SCOPE ?? '').split(':').filter(Boolean).map((p) => resolve(p))

// Containment and name validation live in core, next to their tests: a symlink
// inside an allowed directory used to walk straight out of the scope, and that
// is not a thing to reimplement per server.
const inScope = (p: string) => resolveInScope(p, scopes)
const safeName = safeMemoryName

const server = new McpServer({ name: 'agentda', version: '0.1.0' })

server.tool(
  'memory_read',
  'Read this bot\'s durable memory (Markdown files the user can also edit by hand).',
  {},
  async () => {
    const files = readdirSync(memDir).filter((f) => f.endsWith('.md')).sort()
    const body = files.map((f) => `## ${f}\n${readFileSync(join(memDir, f), 'utf8')}`).join('\n\n')
    return { content: [{ type: 'text', text: body || '(memory is empty)' }] }
  },
)

server.tool(
  'memory_write',
  'Create or replace one memory file. Use for durable facts worth remembering across sessions.',
  { file: z.string().describe('file name, e.g. contacts.md'), content: z.string() },
  async ({ file, content }) => {
    const path = join(memDir, safeName(file))
    const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
    writeFileSync(path, content)
    // The daemon watches for this marker to post a visible diff card when the
    // run ingested untrusted content (FR-26): memory is how an injection would
    // persist, so a write is never silent in that case.
    process.stderr.write(`AGENTDA_MEMORY_WRITE ${JSON.stringify({ file: safeName(file), bytesBefore: before.length, bytesAfter: content.length })}\n`)
    return { content: [{ type: 'text', text: `wrote ${safeName(file)} (${content.length} bytes)` }] }
  },
)

server.tool(
  'file_read',
  'Read a file inside the directories this bot is allowed to touch.',
  { path: z.string() },
  async ({ path }) => ({ content: [{ type: 'text', text: readFileSync(inScope(path), 'utf8').slice(0, 100_000) }] }),
)

server.tool(
  'file_list',
  'List files in an allowed directory.',
  { path: z.string() },
  async ({ path }) => ({
    content: [{ type: 'text', text: readdirSync(inScope(path), { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)' }],
  }),
)

server.tool(
  'file_write',
  'Write a file inside the allowed directories. Gated: the human approves before this runs.',
  { path: z.string(), content: z.string() },
  async ({ path, content }) => {
    const abs = inScope(path)
    writeFileSync(abs, content)
    return { content: [{ type: 'text', text: `wrote ${abs}` }] }
  },
)

await server.connect(new StdioServerTransport())
