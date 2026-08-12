import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyError, mapLine } from '../src/index'

// Fixtures were recorded from real runs of `claude` 2.1.206 on 2026-08-12 (macOS,
// subscription auth, no ANTHROPIC_API_KEY exported — see apiKeySource:"none" in init):
//   echo '{"type":"user","message":{...}}' | claude -p --input-format stream-json \
//     --output-format stream-json --verbose --include-partial-messages [--resume <id>]
// Sanitized before commit, because raw recordings embed the recording machine's
// local setup: in the system/init line, cwd was replaced with a neutral path and
// the memory/plugin/skill/slash-command/agent rosters emptied; in hook lines, the
// hook output/command text was replaced with placeholders. Everything else —
// event sequence, event structure, stream deltas, assistant messages, result
// payloads with usage and cost — is verbatim from the recordings. The
// classifyError and failed-result cases below are hand-written (synthetic, not
// recordings): producing real auth/limit failures would mean logging out or
// exhausting the plan.

function fixtureLines(name: string): any[] {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

const fixtureEvents = (name: string) => fixtureLines(name).flatMap((l) => mapLine(l))

describe('mapLine against recorded streams', () => {
  it('maps a fresh session: text deltas then a result with a session id', () => {
    const events = fixtureEvents('fixture-fresh.ndjson')
    const text = events.filter((e) => e.type === 'text').map((e) => (e as any).text).join('')
    const result = events.find((e) => e.type === 'result') as any

    expect(result).toBeDefined()
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(text).toBe(result.resultText) // deltas reassemble to the final answer
    expect(result.resultText).toContain('4')
    expect(result.numTurns).toBe(1)
    expect(typeof result.costUsd).toBe('number')
  })

  it('maps a resumed session: same session id, recalled context', () => {
    const fresh = fixtureEvents('fixture-fresh.ndjson').find((e) => e.type === 'result') as any
    const events = fixtureEvents('fixture-resume.ndjson')
    const result = events.find((e) => e.type === 'result') as any
    const text = events.filter((e) => e.type === 'text').map((e) => (e as any).text).join('')

    expect(result.sessionId).toBe(fresh.sessionId)
    expect(text).toContain('what is 2+2?') // proves the resumed turn saw turn one
  })

  it('drops hook, status, and rate_limit noise instead of crashing', () => {
    const dropped = fixtureLines('fixture-fresh.ndjson')
      .filter((j) => mapLine(j).length === 0)
      .map((j) => j.type)
    expect(dropped).toContain('system') // init + hooks all dropped
    expect(dropped).toContain('rate_limit_event')
    expect(mapLine({ type: 'something_from_a_future_cli' })).toEqual([])
    expect(mapLine('not an object')).toEqual([])
  })

  it('never yields a result for failed or malformed result lines (synthetic)', () => {
    // Hand-written shapes, not recordings: the throw in startTurn is the one
    // failure signal, so a yielded result must always mean success.
    expect(mapLine({ type: 'result', is_error: true, session_id: 'x', result: 'limit reached' })).toEqual([])
    expect(mapLine({ type: 'result', is_error: false })).toEqual([]) // session_id missing
  })
})

describe('classifyError (synthetic inputs)', () => {
  it('prefers the structured api_error_status over prose', () => {
    expect(classifyError('anything', { api_error_status: 401 })).toBe('auth')
    expect(classifyError('anything', { api_error_status: 429 })).toBe('limit')
  })
  it('auth from wording', () => {
    expect(classifyError('Invalid API key · Please run /login')).toBe('auth')
    expect(classifyError('OAuth token expired')).toBe('auth')
  })
  it('limit from wording', () => {
    expect(classifyError('Claude usage limit reached. Your limit will reset at 5pm')).toBe('limit')
  })
  it('other', () => {
    expect(classifyError('segmentation fault')).toBe('other')
    expect(classifyError('port 4290 unreachable')).toBe('other') // digits alone must not read as 429
  })
})
