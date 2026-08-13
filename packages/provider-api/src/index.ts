import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync } from 'node:fs'
import { AdapterError, type AdapterErrorKind, type AgentEvent, type ProviderAdapter } from '@agentda/core'
import type { ModelClient, Msg, ToolCall, ToolSpec } from './clients'

export * from './clients'

// The agent loop for API-key and local providers. Unlike the vendor CLIs, these
// come with no harness — so the loop is ours, which means the approval gate is
// simply a function call before executing a tool. No hooks, no shims, no races
// (compare ADR 0001 and ADR 0003): a tool cannot run unless `gate` says so.
//
// This is also the policy hedge. If a vendor ever closes the subscription path,
// bots keep working through here on metered billing.

export interface ApiTurnOptions {
  resume?: string
  mcpConfig?: string
  systemPromptFile?: string
  // Supplied per turn by the runner, which knows the bot's policy. Returning
  // 'deny' means the tool never executes; the model is told it was refused.
  gate?: (tool: string, input: unknown) => Promise<'allow' | 'deny'>
  maxSteps?: number
}

export function classifyError(text: string, status?: number): AdapterErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'limit'
  if (/invalid.*api key|unauthorized|authentication/i.test(text)) return 'auth'
  if (/rate.?limit|quota|too many requests/i.test(text)) return 'limit'
  return 'other'
}

const HINTS: Partial<Record<AdapterErrorKind, string>> = {
  auth: 'The API key for this provider is missing or rejected — check the key in your config.',
  limit: 'API rate limit or quota hit — this is metered billing, not your subscription.',
}

export class ApiAdapter implements ProviderAdapter {
  name: string
  // Gating is in-process here, so it is genuinely mid-turn and cannot race.
  capabilities = { streaming: false, tools: true, midTurnGating: true }

  constructor(
    private client: ModelClient,
    name?: string,
  ) {
    this.name = name ?? client.name
  }

  async *startTurn(input: string, opts: ApiTurnOptions = {}): AsyncGenerator<AgentEvent> {
    const tools = await MpcTools.open(opts.mcpConfig)
    const messages: Msg[] = []
    const system = opts.systemPromptFile ? safeRead(opts.systemPromptFile) : ''
    if (system) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: input })

    const specs = tools.specs()
    // A hard step cap: without one, a model that keeps calling tools burns the
    // user's money in a loop nobody asked for.
    const maxSteps = opts.maxSteps ?? 8

    try {
      for (let step = 0; step < maxSteps; step++) {
        let reply
        try {
          reply = await this.client.chat(messages, specs)
        } catch (err) {
          const e = err as { message: string; status?: number }
          const kind = classifyError(e.message, e.status)
          throw new AdapterError(kind, e.message, HINTS[kind])
        }

        if (reply.text) yield { type: 'text', text: reply.text }
        if (!reply.toolCalls.length) {
          yield { type: 'result', sessionId: 'api', resultText: reply.text || undefined, raw: {} }
          return
        }

        messages.push({ role: 'assistant', content: reply.text, toolCalls: reply.toolCalls })

        for (const call of reply.toolCalls) {
          yield { type: 'tool_call', name: call.name, input: call.input }
          const decision = opts.gate ? await opts.gate(call.name, call.input) : 'deny'
          if (decision === 'deny') {
            // The model hears the refusal and can respond to it, exactly like
            // a denied tool on the CLI providers.
            messages.push({ role: 'tool', id: call.id, name: call.name, content: 'Denied: the human refused this action.' })
            continue
          }
          messages.push({ role: 'tool', id: call.id, name: call.name, content: await tools.call(call) })
        }
      }

      // Out of steps: say so rather than pretending the turn finished cleanly.
      yield {
        type: 'warning',
        message: `stopped after ${maxSteps} tool steps — the task may be unfinished`,
      }
      yield { type: 'result', sessionId: 'api', raw: {} }
    } finally {
      await tools.close()
    }
  }
}

// MCP servers for the loop: connect, list tools, call them. Tool names are
// prefixed mcp__<server>__<tool> so one gate policy covers every provider.
class MpcTools {
  private constructor(
    private clients: Map<string, Client>,
    private tools: ToolSpec[],
    private route: Map<string, { server: string; tool: string }>,
  ) {}

  static async open(configPath?: string): Promise<MpcTools> {
    const clients = new Map<string, Client>()
    const tools: ToolSpec[] = []
    const route = new Map<string, { server: string; tool: string }>()
    if (!configPath) return new MpcTools(clients, tools, route)

    let servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {}
    try {
      servers = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers ?? {}
    } catch {
      return new MpcTools(clients, tools, route)
    }

    for (const [name, cfg] of Object.entries(servers)) {
      try {
        const client = new Client({ name: 'agentda', version: '0.1.0' }, { capabilities: {} })
        await client.connect(
          new StdioClientTransport({
            command: cfg.command,
            args: cfg.args ?? [],
            env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
          }),
        )
        clients.set(name, client)
        for (const t of (await client.listTools()).tools) {
          const prefixed = `mcp__${name}__${t.name}`
          tools.push({
            name: prefixed,
            description: t.description ?? '',
            schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          })
          route.set(prefixed, { server: name, tool: t.name })
        }
      } catch {
        // A server that will not start is reported through its absent tools
        // rather than killing the turn.
      }
    }
    return new MpcTools(clients, tools, route)
  }

  specs(): ToolSpec[] {
    return this.tools
  }

  async call(call: ToolCall): Promise<string> {
    const target = this.route.get(call.name)
    if (!target) return `No such tool: ${call.name}`
    try {
      const res: any = await this.clients.get(target.server)!.callTool({ name: target.tool, arguments: call.input })
      const parts = (res.content ?? []).map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`))
      return parts.join('\n') || '(no output)'
    } catch (err) {
      return `Tool failed: ${(err as Error).message}`
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})))
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
