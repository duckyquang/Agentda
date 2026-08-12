import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { AdapterError, SessionStore } from '@agentda/core'
import { ClaudeAdapter } from '@agentda/provider-claude'

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s)

const store = new SessionStore(process.env.AGENTDA_DB ?? join(homedir(), '.agentda', 'agentda.db'))
const adapter = new ClaudeAdapter()
const [bot, chat] = ['default', 'local']

let session = store.get(bot, chat, adapter.name)
console.log(dim(`agentda chat · ${adapter.name} adapter · ${session ? `resuming session ${session.slice(0, 8)}…` : 'new session'}`))
console.log(dim(`/new starts a fresh session, /quit exits`))

// The async iterator (unlike question()) buffers lines that arrive mid-turn, so
// piped multi-line input runs every turn instead of dropping the queued ones.
const rl = createInterface({ input: process.stdin, output: process.stdout })

process.stdout.write('you> ')
for await (const raw of rl) {
  const line = raw.trim()
  if (!process.stdin.isTTY && line) console.log(line) // piped input isn't echoed; transcripts should show it
  if (line === '/quit') break
  if (line === '/new') {
    store.clear(bot, chat, adapter.name)
    session = undefined
    console.log(dim('started a fresh session'))
  } else if (line) {
    try {
      let streamed = false
      for await (const ev of adapter.startTurn(line, { resume: session })) {
        if (ev.type !== 'text' && streamed) {
          process.stdout.write('\n')
          streamed = false
        }
        if (ev.type === 'text') {
          streamed = true
          process.stdout.write(ev.text)
        } else if (ev.type === 'tool_call') {
          console.log(dim(`[tool] ${ev.name}`))
        } else if (ev.type === 'warning') {
          console.log(dim(`! ${ev.message}`))
        } else if (ev.type === 'result') {
          session = ev.sessionId
          store.set(bot, chat, adapter.name, ev.sessionId)
          const cost = ev.costUsd !== undefined ? ` · ~$${ev.costUsd.toFixed(2)} est` : ''
          console.log(dim(`(session ${ev.sessionId.slice(0, 8)}${cost})`))
        }
      }
    } catch (err) {
      if (!(err instanceof AdapterError)) throw err
      console.error(`\n${err.kind}: ${err.hint ?? err.message}`)
      if (err.hint) console.error(dim(err.message))
      if (session && /no conversation found/i.test(err.message)) {
        store.clear(bot, chat, adapter.name)
        session = undefined
        console.error(dim('stored session was gone — cleared it; send your message again to start fresh'))
      }
    }
  }
  process.stdout.write('you> ')
}

rl.close()
store.close()
