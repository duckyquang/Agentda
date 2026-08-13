import { describe, expect, it } from 'vitest'
import { ApiAdapter, classifyError, type ModelClient, type Msg, type ToolSpec } from '../src/index'

// A scripted model: each entry is what the model "replies" on that step. Lets
// the loop's own behavior be tested exactly, with no network and no vendor.
function scripted(replies: Array<{ text?: string; toolCalls?: any[] }>): ModelClient & { seen: Msg[][] } {
  let i = 0
  const seen: Msg[][] = []
  return {
    name: 'scripted',
    seen,
    async chat(messages: Msg[], _tools: ToolSpec[]) {
      seen.push(structuredClone(messages))
      const r = replies[Math.min(i++, replies.length - 1)]
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] }
    },
  }
}

const collect = async (gen: AsyncIterable<any>) => {
  const out: any[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('agent loop gating', () => {
  it('a plain answer ends the turn with a result', async () => {
    const events = await collect(new ApiAdapter(scripted([{ text: 'hello' }])).startTurn('hi'))
    expect(events.map((e) => e.type)).toEqual(['text', 'result'])
    expect(events[0].text).toBe('hello')
  })

  it('refuses every tool when no gate is supplied — fail closed', async () => {
    const model = scripted([
      { toolCalls: [{ id: '1', name: 'mcp__x__write', input: { a: 1 } }] },
      { text: 'understood' },
    ])
    const events = await collect(new ApiAdapter(model).startTurn('do it'))
    expect(events.some((e) => e.type === 'tool_call')).toBe(true)
    // The model is told, in the transcript, that a human refused.
    const toolMsg = model.seen[1].find((m: any) => m.role === 'tool') as any
    expect(toolMsg.content).toMatch(/denied/i)
  })

  it('a denied tool never executes and the model hears the refusal', async () => {
    const model = scripted([
      { toolCalls: [{ id: '1', name: 'mcp__x__send', input: { to: 'a@b.c' } }] },
      { text: 'ok, stopping' },
    ])
    let asked = ''
    await collect(
      new ApiAdapter(model).startTurn('send it', {
        gate: async (tool) => {
          asked = tool
          return 'deny'
        },
      }),
    )
    expect(asked).toBe('mcp__x__send')
    const toolMsg = model.seen[1].find((m: any) => m.role === 'tool') as any
    expect(toolMsg.content).toMatch(/denied/i)
  })

  it('every tool call is offered to the gate, one at a time', async () => {
    const model = scripted([
      {
        toolCalls: [
          { id: '1', name: 'mcp__x__read', input: {} },
          { id: '2', name: 'mcp__x__write', input: {} },
        ],
      },
      { text: 'done' },
    ])
    const asked: string[] = []
    await collect(
      new ApiAdapter(model).startTurn('go', {
        gate: async (t) => {
          asked.push(t)
          return 'deny'
        },
      }),
    )
    expect(asked).toEqual(['mcp__x__read', 'mcp__x__write'])
  })

  it('stops at the step cap and says so, instead of looping on the user’s money', async () => {
    const model = scripted([{ toolCalls: [{ id: '1', name: 'mcp__x__loop', input: {} }] }]) // always calls a tool
    const events = await collect(new ApiAdapter(model).startTurn('go', { gate: async () => 'deny', maxSteps: 3 }))
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(3)
    expect(events.some((e) => e.type === 'warning' && /stopped after 3/.test(e.message))).toBe(true)
    expect(events.at(-1).type).toBe('result')
  })

  it('surfaces provider failures with the right kind', async () => {
    const boom: ModelClient = {
      name: 'boom',
      async chat() {
        throw Object.assign(new Error('nope'), { status: 429 })
      },
    }
    await expect(collect(new ApiAdapter(boom).startTurn('hi'))).rejects.toMatchObject({ kind: 'limit' })
  })
})

describe('classifyError', () => {
  it('maps status codes first, then wording', () => {
    expect(classifyError('whatever', 401)).toBe('auth')
    expect(classifyError('whatever', 429)).toBe('limit')
    expect(classifyError('invalid api key')).toBe('auth')
    expect(classifyError('rate limit exceeded')).toBe('limit')
    expect(classifyError('segfault')).toBe('other')
  })
})
