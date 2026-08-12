import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { AdapterError, type AdapterErrorKind, type AgentEvent, type ProviderAdapter } from '@agentda/core'

// Failure taxonomy (PLAN Phase 0). The CLI's own structured result fields decide
// first — api_error_status carries the HTTP status when the backend refused — and
// the regexes only catch pre-result crashes where stderr text is all we have.
export function classifyError(text: string, raw?: Record<string, any>): AdapterErrorKind {
  const status = raw?.api_error_status
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'limit'
  if (/run \/login|not logged in|invalid api key|authentication|oauth token (expired|revoked)/i.test(text)) {
    return 'auth'
  }
  if (/usage limit|rate.?limit|limit (reached|will reset)|overloaded|too many requests/i.test(text)) {
    return 'limit'
  }
  return 'other'
}

// Remediation lives with the provider that knows its own login story; surfaces
// (REPL today, daemon/bridges later) just print kind + hint.
const HINTS: Partial<Record<AdapterErrorKind, string>> = {
  auth: 'Not logged in — run `claude` once, use /login, then retry.',
  limit: 'Plan limit hit — bot turns share your Claude window; wait for the reset.',
}

// One NDJSON line from `claude -p --output-format stream-json --verbose
// --include-partial-messages` -> zero or more AgentEvents. Unknown event types
// are deliberately dropped: real streams carry hook/status/rate_limit lines and
// whatever future CLIs add. Failed results (is_error) are also dropped here —
// the throw at the end of startTurn is the one failure signal, so a yielded
// result always means the turn succeeded.
export function mapLine(line: unknown): AgentEvent[] {
  const j = line as Record<string, any>
  if (!j || typeof j !== 'object') return []

  if (j.type === 'stream_event' && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta') {
    return [{ type: 'text', text: j.event.delta.text }]
  }

  if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
    // Text already arrived as deltas; the whole-message event matters for tool
    // use — one event per block, so an audit log never undercounts a turn.
    return j.message.content
      .filter((b: any) => b?.type === 'tool_use')
      .map((b: any) => ({ type: 'tool_call' as const, name: b.name, input: b.input }))
  }

  if (j.type === 'result' && j.is_error !== true && typeof j.session_id === 'string') {
    return [
      {
        type: 'result',
        sessionId: j.session_id,
        resultText: typeof j.result === 'string' ? j.result : undefined,
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
        numTurns: typeof j.num_turns === 'number' ? j.num_turns : undefined,
        raw: j,
      },
    ]
  }

  return []
}

export class ClaudeAdapter implements ProviderAdapter {
  name = 'claude'
  capabilities = { streaming: true, tools: true, midTurnGating: true }
  private warnedAboutKey = false

  constructor(private bin = 'claude') {}

  async *startTurn(input: string, opts: { resume?: string } = {}): AsyncGenerator<AgentEvent> {
    // FR-8: a stray key silently outranks subscription login and bills the API org.
    if (!this.warnedAboutKey && process.env.ANTHROPIC_API_KEY) {
      this.warnedAboutKey = true
      yield {
        type: 'warning',
        message:
          'ANTHROPIC_API_KEY is set: this run bills your API org, not your subscription. Unset it to use your plan.',
      }
    }

    // NEVER add --bare here: bare mode skips the CLI's own credential chain, so a
    // subscription (/login) user would fail with "no API key" instead of using
    // their plan. That trap is the whole reason this comment exists (PLAN Phase 0).
    //
    // Fail-closed isolation, verified against claude 2.1.206 (init reports
    // tools: [], mcp_servers: [], and no hook events): --tools "" disables every
    // built-in, --strict-mcp-config with no --mcp-config yields zero MCP servers,
    // and --setting-sources "" stops inheriting the machine's global settings —
    // whose hooks otherwise run arbitrary shell inside every turn, and whose
    // permission allows let a bare turn edit files mid-chat (observed live).
    // Phase 1 reopens tools deliberately via --mcp-config + the FR-11 gate.
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
    ]
    if (opts.resume) args.push('--resume', opts.resume)

    const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    let spawnErr: AdapterError | undefined
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnErr = new AdapterError(
        'other',
        err.code === 'ENOENT'
          ? `'${this.bin}' not found — install Claude Code and run it once to log in`
          : `failed to spawn '${this.bin}': ${err.message}`,
      )
    })
    // EPIPE lands here when the child dies before reading stdin (bad flag, spawn
    // failure); without a listener it would crash the whole process.
    child.stdin.on('error', () => {})

    child.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: input }] } }) + '\n',
    )
    child.stdin.end()

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16_384) stderr += chunk
    })

    let rawResult: Record<string, any> | undefined
    const lines = createInterface({ input: child.stdout })
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        let parsed: any
        try {
          parsed = JSON.parse(line)
        } catch {
          continue // partial or non-JSON line; the result event is what must parse
        }
        if (parsed?.type === 'result') rawResult = parsed
        yield* mapLine(parsed)
      }

      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on('close', (code, signal) => resolve({ code, signal }))
          child.on('error', () => resolve({ code: null, signal: null })) // spawn failures may never reach 'close'
          if (child.exitCode !== null || spawnErr) resolve({ code: child.exitCode, signal: child.signalCode })
        },
      )

      if (spawnErr) throw spawnErr
      if (signal) throw new AdapterError('killed', `claude was killed by ${signal}`)
      if (code !== 0 || rawResult?.is_error === true) {
        const detail =
          [typeof rawResult?.result === 'string' ? rawResult.result : undefined, stderr.trim()]
            .filter(Boolean)
            .join(' — ') || `claude exited with code ${code}`
        const kind = classifyError(detail, rawResult)
        throw new AdapterError(kind, detail, HINTS[kind])
      }
      if (!rawResult) {
        throw new AdapterError(
          'other',
          'claude exited cleanly but produced no result event — stream-json format drift? Check the CLI version against the adapter.',
        )
      }
    } finally {
      lines.close()
      // A consumer that breaks out mid-stream must not leave claude finishing the
      // turn in the background on the user's quota.
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
    }
  }
}
