import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalQueue, defaultPolicy, openDb, type Persona } from '@agentda/core'
import { afterAll, describe, expect, it } from 'vitest'
import { ControlApi } from '../src/api'

const dir = mkdtempSync(join(tmpdir(), 'agentda-api-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const persona = (id: string): Persona => ({
  id,
  dir: join(dir, id),
  name: id,
  prompt: '',
  provider: 'claude',
  providers: [{ provider: 'claude' }],
  allowMeteredFailover: false,
  policy: defaultPolicy(),
  tools: [],
  agentdaTools: true,
  browser: false,
  email: false,
  browserSurface: 'shadow',
  scope: [],
  routines: [],
  packs: [],
  coordinator: false,
})

let n = 0
async function serve(over: Partial<ConstructorParameters<typeof ControlApi>[0]> = {}) {
  const db = openDb(join(dir, `api${n++}.db`))
  const queue = new ApprovalQueue(db, {})
  const sent: { bot: string; text: string }[] = []
  const deps: ConstructorParameters<typeof ControlApi>[0] = {
    db,
    queue,
    personas: () => [persona('chief')],
    pending: () => [],
    send: (bot, text) => void sent.push({ bot, text }),
    setMode: () => {},
    pause: () => {},
    isPaused: () => false,
    voiceNote: async () => 'transcript',
    createBot: (spec) => persona(spec.id),
    updateBot: (id) => persona(id),
    archiveBot: (id) => join(dir, '.trash', id),
    setToken: () => {},
    clearToken: () => {},
    tokenIds: () => [],
    reload: () => 1,
    packs: () => [],
    ...over,
  }
  const api = new ControlApi(deps)
  const port = await api.listen(0)
  const url = (p: string) => `http://127.0.0.1:${port}${p}`
  const auth = { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }
  return { api, db, deps, queue, sent, url, auth }
}

describe('control API', () => {
  it('refuses every data route without the token — anything on the box could ask otherwise', async () => {
    const s = await serve()
    for (const path of ['/api/state', '/api/audit']) {
      expect((await fetch(s.url(path))).status).toBe(401)
    }
    expect((await fetch(s.url('/api/send'), { method: 'POST', body: '{}' })).status).toBe(401)
    // A wrong token is no better than none.
    expect((await fetch(s.url('/api/state'), { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    await s.api.close()
  })

  it('serves state with the token', async () => {
    const s = await serve()
    const body = await (await fetch(s.url('/api/state'), { headers: s.auth })).json()
    expect(body.bots[0]).toMatchObject({ id: 'chief', mode: 'ask' })
    await s.api.close()
  })

  it('accepts a send immediately rather than holding the request while a bot thinks', async () => {
    const s = await serve()
    const res = await fetch(s.url('/api/send'), {
      method: 'POST',
      headers: s.auth,
      body: JSON.stringify({ bot: 'chief', text: 'hello' }),
    })
    // 202: a turn can pause on an approval for as long as the human takes, so
    // the reply comes back on the event stream instead.
    expect(res.status).toBe(202)
    expect(s.sent).toEqual([{ bot: 'chief', text: 'hello' }])
    await s.api.close()
  })

  it('an approval tap from the desktop settles the same queue as Telegram', async () => {
    const s = await serve()
    let id = ''
    const q = new ApprovalQueue(s.db, { ask: (r) => void (id = r.id) })
    const api2 = new ControlApi({ ...s.deps, queue: q })
    const port = await api2.listen(0)
    const pending = q.request({ bot: 'chief', tool: 'mcp__x__send', input: {} }, { ...defaultPolicy(), grants: ['*'] })
    await new Promise((r) => setImmediate(r))

    await fetch(`http://127.0.0.1:${port}/api/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api2.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, decision: 'allow' }),
    })
    await expect(pending).resolves.toMatchObject({ decision: 'allow', source: 'human-tap' })
    await api2.close()
    await s.api.close()
  })

  it('lets EventSource authenticate by query param, since it cannot set headers', async () => {
    const s = await serve()
    // Without this the browser's stream 401s and every reply is lost — the UI
    // looks alive and silently never updates.
    const res = await fetch(s.url(`/api/events?token=${s.api.token}`))
    expect(res.status).toBe(200)
    await res.body!.cancel()
    expect((await fetch(s.url('/api/events?token=wrong'))).status).toBe(401)
    await s.api.close()
  })

  it('refuses a non-loopback Host, so a rebinding page cannot read the token', async () => {
    const s = await serve()
    const port = Number(new URL(s.url('/')).port)
    // fetch forbids setting Host, so this needs a raw request.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example.com', ...s.auth } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
    await s.api.close()
  })

  it('survives a nonsense audit limit instead of taking the daemon down', async () => {
    const s = await serve()
    for (const q of ['abc', '-1', '999999']) {
      const res = await fetch(s.url(`/api/audit?limit=${q}`), { headers: s.auth })
      expect(res.status).toBe(200)
      expect((await res.json()).rows).toEqual([])
    }
    await s.api.close()
  })

  it('close() returns even with an open event stream', async () => {
    const s = await serve()
    const res = await fetch(s.url(`/api/events?token=${s.api.token}`))
    void res.body!.getReader().read()
    // server.close() waits on active connections and an SSE response never
    // ends on its own, so shutdown must end the streams itself.
    await expect(Promise.race([s.api.close(), new Promise((_, r) => setTimeout(() => r(new Error('hung')), 3000))]))
      .resolves.toBeUndefined()
  })

  it('streams events to a connected client', async () => {
    const s = await serve()
    const res = await fetch(s.url('/api/events'), { headers: s.auth })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    expect(dec.decode((await reader.read()).value)).toContain(': connected') // stream is live
    s.api.emit('approval', { id: 'x1', bot: 'chief', tool: 'mcp__x__send' })
    const chunk = dec.decode((await reader.read()).value)
    expect(chunk).toContain('event: approval')
    expect(chunk).toContain('"id":"x1"')
    await reader.cancel()
    await s.api.close()
  })
})

describe('persona management over the API', () => {
  it('creates, edits, and archives a bot, and reports a bad id as a 400', async () => {
    const created: string[] = []
    const patched: unknown[] = []
    const s = await serve({
      createBot: (spec) => {
        if (spec.id === 'Bad Id') throw new Error('bot id must be lowercase letters, digits or dashes (max 32)')
        created.push(spec.id)
        return persona(spec.id)
      },
      updateBot: (id, patch) => {
        patched.push({ id, patch })
        return persona(id)
      },
      archiveBot: (id) => `/tmp/.trash/${id}`,
    })

    const post = (path: string, body: unknown) =>
      fetch(s.url(path), { method: 'POST', headers: s.auth, body: JSON.stringify(body) })

    expect((await post('/api/bots', { id: 'scout', name: 'Scout' })).status).toBe(200)
    expect(created).toEqual(['scout'])

    const bad = await post('/api/bots', { id: 'Bad Id' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/lowercase/)

    expect((await post('/api/bots/chief', { mode: 'auto', browser: true })).status).toBe(200)
    expect(patched).toEqual([{ id: 'chief', patch: { mode: 'auto', browser: true } }])

    const gone = await fetch(s.url('/api/bots/chief'), { method: 'DELETE', headers: s.auth })
    expect((await gone.json()).archivedTo).toContain('.trash')
  })

  it('serves the editor everything it needs, including the prompt', async () => {
    const p = { ...persona('chief'), prompt: 'You are Chief.', model: 'llama3.1:8b' }
    const s = await serve({ personas: () => [p], tokenIds: () => ['chief'] })
    const detail = await (await fetch(s.url('/api/bots/chief'), { headers: s.auth })).json()
    expect(detail).toMatchObject({ id: 'chief', prompt: 'You are Chief.', model: 'llama3.1:8b', ownIdentity: true })
    expect((await fetch(s.url('/api/bots/nobody'), { headers: s.auth })).status).toBe(404)
  })

  it('takes a bot token in and never hands one back out', async () => {
    const stored: Record<string, string> = {}
    const s = await serve({ setToken: (bot, token) => void (stored[bot] = token), tokenIds: () => Object.keys(stored) })
    await fetch(s.url('/api/bots/chief/token'), {
      method: 'POST',
      headers: s.auth,
      body: JSON.stringify({ token: '8123456789:AAHfake-token-material-that-is-long' }),
    })
    expect(stored.chief).toContain('8123456789')
    const state = await (await fetch(s.url('/api/state'), { headers: s.auth })).json()
    expect(JSON.stringify(state)).not.toContain('8123456789')
    expect(state.bots[0].ownIdentity).toBe(true)
  })

  it('rejects a token the registry would not accept, without pretending it worked', async () => {
    const s = await serve({
      setToken: () => {
        throw new Error('that does not look like a BotFather token (expected 123456789:AA...)')
      },
    })
    const r = await fetch(s.url('/api/bots/chief/token'), { method: 'POST', headers: s.auth, body: JSON.stringify({ token: 'nope' }) })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/BotFather/)
  })
})

describe('amendments and preview frames', () => {
  it('an amendment denies the call and hands the model the instruction', async () => {
    const s = await serve()
    const q = new ApprovalQueue(s.db, {})
    const api2 = new ControlApi({ ...s.deps, queue: q })
    const port = await api2.listen(0)
    const pending = q.request({ bot: 'chief', tool: 'mcp__email__email_send', input: {} }, { ...defaultPolicy(), grants: ['*'] })
    await new Promise((r) => setImmediate(r))
    const id = q.open()[0].id

    await fetch(`http://127.0.0.1:${port}/api/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api2.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, decision: 'amend', instruction: 'cc anna@example.com' }),
    })
    const res = await pending
    expect(res.decision).toBe('deny')
    expect(res.source).toBe('human-text')
    expect(res.reason).toContain('cc anna@example.com')
    await api2.close()
    await s.api.close()
  })

  it('refuses a preview frame that is not base64, since the page renders it into an img', async () => {
    const s = await serve()
    const post = (body: string) =>
      fetch(s.url('/api/preview/chief'), { method: 'POST', headers: { authorization: `Bearer ${s.api.token}` }, body })
    expect((await post('" onerror="alert(1)')).status).toBe(400)
    expect((await post('/9j/4AAQSkZJRg==')).status).toBe(200)
    await s.api.close()
  })

  it('take over and hand back are readable by the browser server that has to obey them', async () => {
    const s = await serve()
    const control = (c: string) =>
      fetch(s.url('/api/preview/chief/control'), { method: 'POST', headers: s.auth, body: JSON.stringify({ control: c }) })
    const read = async () => (await (await fetch(s.url('/api/preview/chief/control'), { headers: s.auth })).json()).control

    expect(await read()).toBeNull()
    await control('take-over')
    expect(await read()).toBe('take-over')
    // A frame POST answers with the same state, so a working browser learns it
    // was taken over without a second request.
    const framed = await fetch(s.url('/api/preview/chief'), {
      method: 'POST',
      headers: { authorization: `Bearer ${s.api.token}` },
      body: '/9j/4AAQ',
    })
    expect((await framed.json()).control).toBe('take-over')
    await control('hand-back')
    expect(await read()).toBe('hand-back')
    await s.api.close()
  })
})

