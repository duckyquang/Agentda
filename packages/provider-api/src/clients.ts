// Thin model clients. Each turns our neutral message/tool shape into one
// vendor's wire format and back. No streaming: the API adapters exist as the
// policy hedge and for local models, where a whole-turn reply is fine.

export interface ToolSpec {
  name: string
  description: string
  schema: Record<string, unknown> // JSON Schema for the arguments
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export type Msg =
  | { role: 'user' | 'assistant' | 'system'; content: string }
  | { role: 'tool'; id: string; name: string; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }

export interface ModelReply {
  text: string
  toolCalls: ToolCall[]
}

export interface ModelClient {
  name: string
  chat(messages: Msg[], tools: ToolSpec[]): Promise<ModelReply>
}

const jsonOrThrow = async (res: Response, who: string) => {
  const body = await res.text()
  if (!res.ok) {
    // Status codes carry the meaning our error taxonomy needs; keep the body
    // because vendors put the useful part there.
    throw Object.assign(new Error(`${who} ${res.status}: ${body.slice(0, 500)}`), { status: res.status })
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`${who} returned non-JSON: ${body.slice(0, 200)}`)
  }
}

// OpenAI's chat-completions shape, which OpenAI, xAI, and Ollama all speak.
// One client, three providers — the reason this is the first one written.
export class OpenAICompatClient implements ModelClient {
  constructor(
    public name: string,
    private opts: { baseUrl: string; model: string; apiKey?: string },
  ) {}

  async chat(messages: Msg[], tools: ToolSpec[]): Promise<ModelReply> {
    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: messages.map(toOpenAI),
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.schema },
              })),
            }
          : {}),
      }),
    })
    const j = await jsonOrThrow(res, this.name)
    const m = j.choices?.[0]?.message ?? {}
    return {
      text: typeof m.content === 'string' ? m.content : '',
      toolCalls: (m.tool_calls ?? []).map((c: any) => ({
        id: c.id ?? c.function?.name ?? 'call',
        name: c.function?.name ?? '',
        input: safeArgs(c.function?.arguments),
      })),
    }
  }
}

function toOpenAI(m: Msg): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.id, content: m.content }
  if ('toolCalls' in m && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      })),
    }
  }
  return { role: m.role, content: m.content }
}

// Models return arguments as a JSON string, and sometimes as a malformed one.
// A bad payload is the model's mistake to hear about, not a crash.
function safeArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __unparsed: raw }
  }
}

export class AnthropicClient implements ModelClient {
  name = 'anthropic'
  constructor(private opts: { apiKey: string; model: string; baseUrl?: string; maxTokens?: number }) {}

  async chat(messages: Msg[], tools: ToolSpec[]): Promise<ModelReply> {
    const system = messages.filter((m) => m.role === 'system').map((m) => (m as any).content).join('\n\n')
    const res = await fetch(`${this.opts.baseUrl ?? 'https://api.anthropic.com/v1'}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: this.opts.maxTokens ?? 4096,
        ...(system ? { system } : {}),
        messages: messages.filter((m) => m.role !== 'system').map(toAnthropic),
        ...(tools.length
          ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) }
          : {}),
      }),
    })
    const j = await jsonOrThrow(res, 'anthropic')
    const blocks: any[] = j.content ?? []
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      toolCalls: blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
    }
  }
}

function toAnthropic(m: Msg): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.id, content: m.content }] }
  }
  if ('toolCalls' in m && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
      ],
    }
  }
  return { role: m.role, content: (m as any).content }
}

// Gemini speaks its own shape; same contract, different envelope.
export class GeminiClient implements ModelClient {
  name = 'gemini'
  constructor(private opts: { apiKey: string; model: string; baseUrl?: string }) {}

  async chat(messages: Msg[], tools: ToolSpec[]): Promise<ModelReply> {
    const base = this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    const system = messages.filter((m) => m.role === 'system').map((m) => (m as any).content).join('\n\n')
    const res = await fetch(`${base}/models/${this.opts.model}:generateContent?key=${this.opts.apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages.filter((m) => m.role !== 'system').map(toGemini),
        ...(tools.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.schema,
                  })),
                },
              ],
            }
          : {}),
      }),
    })
    const j = await jsonOrThrow(res, 'gemini')
    const parts: any[] = j.candidates?.[0]?.content?.parts ?? []
    return {
      text: parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join(''),
      toolCalls: parts
        .filter((p) => p.functionCall)
        .map((p, i) => ({ id: `${p.functionCall.name}-${i}`, name: p.functionCall.name, input: p.functionCall.args ?? {} })),
    }
  }
}

function toGemini(m: Msg): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'user', parts: [{ functionResponse: { name: m.name, response: { result: m.content } } }] }
  }
  if ('toolCalls' in m && m.toolCalls?.length) {
    return {
      role: 'model',
      parts: [
        ...(m.content ? [{ text: m.content }] : []),
        ...m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.input } })),
      ],
    }
  }
  return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: (m as any).content }] }
}
