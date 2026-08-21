#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const run = promisify(execFile)

// Desktop hands (PLAN Phase 4). The bot gets a whole Linux desktop in a
// container — not yours — and drives it through xdotool over `docker exec`.
//
// Everything that decides anything stays on this side of the container wall.
// The container runs an X server, a window manager and a VNC bridge, and has no
// idea what a gate is; nothing inside it can approve anything or reach the
// daemon. Input goes in, pixels come out.
//
// The verbs are named so the existing gate covers them without learning
// anything new: desktop_screenshot is a read and can be auto-approved, while
// click, type, key and launch are consequential and gated exactly like the
// browser's click and type. A native app's "send" is a desktop_click on a
// button, which is the same shape as a browser submit — which was the point.
const stateDir = process.env.AGENTDA_DESKTOP_STATE
if (!stateDir) {
  console.error('AGENTDA_DESKTOP_STATE is required (a directory for this bot to keep its desktop in)')
  process.exit(1)
}
mkdirSync(stateDir, { recursive: true })

const image = process.env.AGENTDA_DESKTOP_IMAGE ?? 'agentda/desktop:dev'
const container = process.env.AGENTDA_DESKTOP_CONTAINER ?? `agentda-desktop-${process.pid}`
const docker = process.env.AGENTDA_DOCKER ?? 'docker'

let started = false

// Started on first use rather than at attach time: measured at 0.8s to a
// usable desktop, so there is nothing to gain by keeping one warm, and a bot
// that never touches its desktop should not be holding a container open.
async function desktop(): Promise<void> {
  if (started) return
  try {
    await run(docker, ['rm', '-f', container])
  } catch {
    // no such container, which is the normal case
  }
  await run(docker, [
    'run', '-d',
    '--name', container,
    // The desktop's own state lives in the bot's directory, so a login it does
    // survives the container it was done in.
    '-v', `${stateDir}:/home/bot`,
    // Published on loopback only. The desktop is for this machine's owner to
    // watch, not for the network.
    '-p', '127.0.0.1:0:6080',
    image,
  ])
  started = true
}

const x = (args: string[]) => run(docker, ['exec', container, 'sh', '-lc', `DISPLAY=:0 ${args.join(' ')}`])
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const server = new McpServer({ name: 'agentda-desktop', version: '0.1.0' })

server.tool(
  'desktop_screenshot',
  "Look at this bot's desktop. Read-only: it changes nothing.",
  {},
  async () => {
    await desktop()
    await x(['scrot', '-o', '/tmp/agentda.png'])
    const { stdout } = await run(docker, ['exec', container, 'base64', '-w', '0', '/tmp/agentda.png'])
    return { content: [{ type: 'image', data: stdout.trim(), mimeType: 'image/png' }] }
  },
)

server.tool(
  'desktop_where',
  'Where the windows are, so a click can be aimed at one. Read-only.',
  {},
  async () => {
    await desktop()
    const { stdout } = await x(['xdotool', 'search', '--onlyvisible', '--name', quote('.'), '|', 'while read w; do', 'echo', '"$w', '$(xdotool getwindowname $w)', '$(xdotool getwindowgeometry --shell $w | tr \'\\n\' \' \')"; done'])
    return { content: [{ type: 'text', text: stdout.trim() || '(nothing on screen yet)' }] }
  },
)

server.tool(
  'desktop_launch',
  'Start an application on the desktop. Gated: what runs on the machine is a decision.',
  { app: z.string().describe('a command, e.g. chromium or xterm') },
  async ({ app }) => {
    await desktop()
    // Deliberately not a shell: an app name is a name, not a command line.
    await run(docker, ['exec', '-d', container, 'sh', '-lc', `DISPLAY=:0 exec ${quote(app)}`])
    return { content: [{ type: 'text', text: `started ${app}` }] }
  },
)

server.tool(
  'desktop_click',
  'Click at a point on the desktop. Gated: a click can send, buy, or delete.',
  { x: z.number().int(), y: z.number().int(), button: z.enum(['left', 'right', 'middle']).optional() },
  async ({ x: px, y: py, button }) => {
    await desktop()
    const which = button === 'right' ? '3' : button === 'middle' ? '2' : '1'
    await x(['xdotool', 'mousemove', String(px), String(py), 'click', which])
    return { content: [{ type: 'text', text: `clicked ${button ?? 'left'} at ${px},${py}` }] }
  },
)

server.tool(
  'desktop_type',
  'Type into whatever has focus. Gated: typing usually precedes a submit.',
  { text: z.string() },
  async ({ text }) => {
    await desktop()
    await x(['xdotool', 'type', '--delay', '20', '--', quote(text)])
    return { content: [{ type: 'text', text: `typed ${text.length} characters` }] }
  },
)

server.tool(
  'desktop_key',
  'Press a key or a chord, e.g. Return or ctrl+s. Gated: a chord can be a save, a send, or a quit.',
  { keys: z.string() },
  async ({ keys }) => {
    await desktop()
    await x(['xdotool', 'key', '--', quote(keys)])
    return { content: [{ type: 'text', text: `pressed ${keys}` }] }
  },
)

server.tool('desktop_close', "Shut down this bot's desktop.", {}, async () => {
  if (!started) return { content: [{ type: 'text', text: 'no desktop was running' }] }
  await run(docker, ['rm', '-f', container]).catch(() => {})
  started = false
  return { content: [{ type: 'text', text: 'desktop shut down' }] }
})

// A container outliving the turn that started it would keep a desktop, and
// whatever is logged into it, running with nobody watching.
const cleanup = () => {
  if (started) void run(docker, ['rm', '-f', container]).catch(() => {})
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(0)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(0)
})

await server.connect(new StdioServerTransport())
