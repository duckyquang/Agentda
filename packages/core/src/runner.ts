import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalQueue } from './approvals'
import { checkBudget, type Guardrails, recordTurn } from './budget'
import type { Db } from './db'
import type { HookServer } from './hook-server'
import type { AgentEvent, ProviderAdapter } from './index'
import { type Persona, readMemory } from './persona'
import type { SessionStore } from './store'

export interface TurnResult {
  text: string
  toolCalls: string[]
  sessionId?: string
  skipped?: string // set when a guardrail refused the turn
  error?: { kind: string; message: string; hint?: string }
}

// Runs one bot turn: budget check, context assembly, provider call through the
// gate. Everything a surface (Telegram, CLI, scheduler) needs, in one place, so
// the safety wiring can't be accidentally bypassed by a new caller.
export class TurnRunner {
  constructor(
    private deps: {
      db: Db
      sessions: SessionStore
      queue: ApprovalQueue
      hook: HookServer
      adapters: Map<string, ProviderAdapter>
      guardrails?: Guardrails
      settingsPath: string
      // How to launch Agentda's own MCP servers for a bot. Injected so core
      // stays free of assumptions about where the packages live.
      mcpEntries?: (p: Persona) => Record<string, { command: string; args: string[]; env?: Record<string, string> }>
    },
  ) {}

  async run(
    persona: Persona,
    chat: string,
    input: string,
    opts: { scheduled?: boolean; onEvent?: (e: AgentEvent) => void } = {},
  ): Promise<TurnResult> {
    const guard = { ...this.deps.guardrails, ...personalGuardrails(persona) }
    // Interactive turns bypass quiet hours: the human is right there asking.
    const effective = opts.scheduled ? guard : { ...guard, quietHours: undefined }
    const verdict = checkBudget(this.deps.db, persona.id, effective)
    if (!verdict.ok) return { text: '', toolCalls: [], skipped: verdict.reason }

    const adapter = this.deps.adapters.get(persona.provider)
    if (!adapter) return { text: '', toolCalls: [], error: { kind: 'other', message: `no adapter for ${persona.provider}` } }

    const runDir = mkdtempSync(join(tmpdir(), 'agentda-run-'))
    const memory = readMemory(persona)
    const mcpConfig = this.materializeMcpConfig(persona, runDir)
    const systemFile = join(runDir, 'system.md')
    writeFileSync(
      systemFile,
      [persona.prompt.trim(), toolBriefing(persona, mcpConfig), memory && `# Memory\n${memory}`]
        .filter(Boolean)
        .join('\n\n'),
    )

    recordTurn(this.deps.db, persona.id)
    const resume = this.deps.sessions.get(persona.id, chat, adapter.name)
    const text: string[] = []
    const toolCalls: string[] = []
    let sessionId: string | undefined

    try {
      for await (const ev of adapter.startTurn(input, {
        resume,
        tools: persona.tools,
        mcpConfig,
        settings: this.deps.settingsPath,
        appendSystemPromptFile: systemFile,
      })) {
        opts.onEvent?.(ev)
        if (ev.type === 'text') text.push(ev.text)
        else if (ev.type === 'tool_call') toolCalls.push(ev.name)
        else if (ev.type === 'result') {
          sessionId = ev.sessionId
          this.deps.sessions.set(persona.id, chat, adapter.name, ev.sessionId)
        }
      }
    } catch (err) {
      const e = err as { kind?: string; message: string; hint?: string }
      // A stale session id must not wedge the bot forever: drop it so the next
      // turn starts clean.
      if (/no conversation found/i.test(e.message)) this.deps.sessions.clear(persona.id, chat, adapter.name)
      return { text: text.join(''), toolCalls, error: { kind: e.kind ?? 'other', message: e.message, hint: e.hint } }
    }

    return { text: text.join(''), toolCalls, sessionId }
  }

  // Built fresh each turn so bot dir, scope, and server path are always right —
  // no placeholder config for the user to hand-edit, and no stale paths.
  private materializeMcpConfig(persona: Persona, runDir: string): string | undefined {
    const servers: Record<string, unknown> = { ...this.deps.mcpEntries?.(persona) }
    if (persona.mcpConfig && existsSync(persona.mcpConfig)) {
      const extra = JSON.parse(readFileSync(persona.mcpConfig, 'utf8'))
      Object.assign(servers, extra.mcpServers ?? {})
    }
    if (!Object.keys(servers).length) return undefined
    const path = join(runDir, 'mcp.json')
    writeFileSync(path, JSON.stringify({ mcpServers: servers }))
    return path
  }
}

function personalGuardrails(p: Persona): Guardrails {
  return { perDay: p.dailyTurnCap, quietHours: p.quietHours }
}

// MCP tools are deferred: they don't appear in the model's initial tool list, so
// a bot that doesn't think to search will flatly claim it has no memory. Naming
// the tools up front makes discovery reliable instead of a coin flip.
function toolBriefing(p: Persona, mcpConfig: string | undefined): string {
  if (!mcpConfig) return ''
  const lines = ['# Your tools', 'These are provided by MCP servers and load on demand — call ToolSearch to load one before first use. Never claim a listed tool does not exist; search for it.']
  if (p.agentdaTools) {
    lines.push(
      '- `mcp__agentda__memory_read` / `mcp__agentda__memory_write`: your durable memory across sessions.',
      p.scope.length
        ? `- \`mcp__agentda__file_read\` / \`file_list\` / \`file_write\`: files under ${p.scope.join(', ')}.`
        : '- file tools exist but no directories are in scope, so they will fail.',
    )
  }
  if (p.browser) {
    lines.push(
      `- \`mcp__browser__navigate\` / \`read\` / \`click\` / \`type\` / \`screenshot\`: a real browser, running ${
        p.browserSurface === 'shadow' ? 'invisibly in the background' : 'in a visible window'
      }. Read the page before clicking; selectors you did not read are guesses.`,
    )
  }
  lines.push(
    'Consequential actions pause for your human to approve. If a call is denied, say so plainly and stop — do not work around it with another tool.',
  )
  return lines.join('\n')
}
