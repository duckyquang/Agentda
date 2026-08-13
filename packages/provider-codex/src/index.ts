import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { AdapterError, type AdapterErrorKind, type AgentEvent, type ProviderAdapter } from '@agentda/core'

// The CLI generation these flags and event shapes were verified against.
export const TESTED_CODEX_PREFIX = '0.146.'

export interface CodexTurnOptions {
  resume?: string
  hookCommand?: string // the gate shim; see ADR 0003
  systemPromptFile?: string
  cwd?: string
  // Leave unset. Anything looser than read-only opts out of the only reliable
  // containment Codex offers — see ADR 0003 before changing it.
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

const HINTS: Partial<Record<AdapterErrorKind, string>> = {
  auth: 'Codex is not logged in — run `codex login` and retry.',
  limit: 'ChatGPT plan limit hit — bot turns share your own quota; wait for the reset.',
}

export function classifyError(text: string): AdapterErrorKind {
  if (/not logged in|unauthorized|401|auth.*(expired|invalid)|run `?codex login/i.test(text)) return 'auth'
  if (/usage limit|rate.?limit|quota|429|too many requests/i.test(text)) return 'limit'
  return 'other'
}

// One JSONL line from `codex exec --json` -> zero or more AgentEvents.
//
// Codex reports whole items rather than token deltas, so a turn's text arrives
// as one agent_message rather than a stream. We surface it as a single text
// event: the shape callers already handle, just coarser than Claude's.
export function mapLine(line: unknown): AgentEvent[] {
  const j = line as Record<string, any>
  if (!j || typeof j !== 'object') return []

  if (j.type === 'item.completed' && j.item) {
    const item = j.item
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      return [{ type: 'text', text: item.text }]
    }
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      // Codex's hook payload calls the shell tool "Bash", same as Claude's, so
      // the thread, the gate, and the audit log all use one name.
      return [{ type: 'tool_call', name: 'Bash', input: { command: item.command, exit_code: item.exit_code } }]
    }
    if (item.type === 'mcp_tool_call') {
      return [{ type: 'tool_call', name: item.tool ?? item.name ?? 'mcp', input: item.arguments ?? item.input ?? {} }]
    }
    // Codex reports operational notices as `error` items even when the turn is
    // fine (hook-trust warnings, context-budget notes). They are warnings, not
    // failures: the turn's real outcome comes from turn.completed/turn.failed.
    if (item.type === 'error' && typeof item.message === 'string') {
      return [{ type: 'warning', message: item.message }]
    }
  }

  return []
}

export class CodexAdapter implements ProviderAdapter {
  name = 'codex'
  // midTurnGating is false on purpose: hooks fire and are audited, but a denial
  // can lose the race against the tool it should block (ADR 0003). Callers must
  // not grant this provider anything whose misuse the sandbox cannot contain.
  capabilities = { streaming: false, tools: true, midTurnGating: false }

  constructor(private bin = 'codex') {}

  async *startTurn(input: string, opts: CodexTurnOptions = {}): AsyncGenerator<AgentEvent> {
    if (process.env.CODEX_API_KEY) {
      yield {
        type: 'warning',
        message: 'CODEX_API_KEY is set: this run bills the API, not your ChatGPT plan. Unset it to use your plan.',
      }
    }

    const child = spawn(this.bin, codexArgs(input, opts), {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
    })

    let spawnErr: AdapterError | undefined
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnErr = new AdapterError(
        'other',
        err.code === 'ENOENT'
          ? `'${this.bin}' not found — install the Codex CLI and run \`codex login\``
          : `failed to spawn '${this.bin}': ${err.message}`,
      )
    })
    child.stdin.on('error', () => {})
    // exec reads stdin when it is not a TTY and hangs forever waiting for EOF.
    child.stdin.end()

    let stderr = ''
    child.stderr.on('data', (c) => {
      if (stderr.length < 16_384) stderr += c
    })

    let threadId: string | undefined
    let completed = false
    let failure: string | undefined
    const text: string[] = []

    const lines = createInterface({ input: child.stdout })
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        let parsed: any
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (parsed?.type === 'thread.started' && typeof parsed.thread_id === 'string') threadId = parsed.thread_id
        if (parsed?.type === 'turn.completed') completed = true
        if (parsed?.type === 'turn.failed') {
          failure = parsed.error?.message ?? parsed.message ?? 'turn failed'
        }
        for (const ev of mapLine(parsed)) {
          if (ev.type === 'text') text.push(ev.text)
          yield ev
        }
      }

      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }))
        child.on('error', () => resolve({ code: null, signal: null }))
        if (child.exitCode !== null || spawnErr) resolve({ code: child.exitCode, signal: child.signalCode })
      })

      if (spawnErr) throw spawnErr
      if (signal) throw new AdapterError('killed', `codex was killed by ${signal}`)
      if (failure || code !== 0) {
        const detail = [failure, stderr.trim()].filter(Boolean).join(' — ') || `codex exited with code ${code}`
        const kind = classifyError(detail)
        throw new AdapterError(kind, detail, HINTS[kind])
      }
      if (!threadId || !completed) {
        throw new AdapterError(
          'other',
          'codex exited cleanly but produced no completed turn — JSONL format drift? Check the CLI version against the adapter.',
        )
      }

      yield { type: 'result', sessionId: threadId, resultText: text.join('\n') || undefined, raw: { threadId } }
    } finally {
      lines.close()
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
    }
  }
}

// One source of truth for the spawn args, so the canary tests what ships.
//
// Gate wiring per ADR 0003: `--enable hooks` (without it hooks are silently
// ignored), inline `-c hooks.PreToolUse=...` so we never write to the user's
// ~/.codex, and `--dangerously-bypass-hook-trust` because the hook is one we
// generated this run pointing at our own loopback gate — the alternative is
// persisting a trust record in the user's config, which is more invasive.
//
// `--ignore-user-config` keeps the user's own settings out of bot turns; auth
// still resolves from CODEX_HOME, so subscription login keeps working.
export function codexArgs(prompt: string, opts: CodexTurnOptions = {}): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config']
  // read-only by default, and that default is the safety guarantee: Codex's
  // PreToolUse deny races with the tool it is meant to block (ADR 0003), so a
  // human-latency gate cannot be trusted to stop a write. The OS sandbox can.
  args.push('--sandbox', opts.sandbox ?? 'read-only')

  if (opts.hookCommand) {
    args.push(
      '--enable',
      'hooks',
      '--dangerously-bypass-hook-trust',
      '-c',
      `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(opts.hookCommand)}}]}]`,
    )
  }
  // Deliberately NOT wiring MCP servers: in codex exec 0.146.x an MCP tool call
  // is cancelled before it runs, with or without hooks and even with
  // approval_policy="never" (openai/codex#24135, evidence table in ADR 0003).
  // Attaching them would give a bot tools it can never actually use, which
  // reads as "the bot is broken" rather than "this provider can't do that yet".
  // Codex bots do their file work through gated shell instead.
  args.push('-c', 'approval_policy="never"') // the hook is the gate; the CLI must not also ask

  // Codex has no --append-system-prompt-file, so persona and memory ride in
  // front of the user's message. Fenced so a bot cannot be confused about which
  // part is instruction and which is the human talking.
  const composed = opts.systemPromptFile
    ? `${readFileSafe(opts.systemPromptFile)}\n\n---\n\n${prompt}`
    : prompt

  if (opts.resume) args.push('resume', opts.resume, composed)
  else args.push(composed)
  return args
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
