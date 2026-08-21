import { defaultPolicy, type Persona } from '@agentda/core'
import { describe, expect, it } from 'vitest'
import { planDispatch, Serial, type Speaker, Speakers } from '../src/routing'

const persona = (id: string, coordinator = false): Persona =>
  ({
    id,
    dir: `/tmp/${id}`,
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
    coordinator,
  }) as Persona

const chief = persona('chief')
const planner = persona('chief', true)
const scout = persona('scout')
const ledger = persona('ledger')
const bots = [chief, scout, ledger]

describe('who a reply hands work to', () => {
  it('an ordinary bot hands off once, to the last line only', () => {
    const plan = planDispatch('Looked into it.\n@scout: check the names\n@ledger: add it up', chief, bots)
    expect(plan.targets.map((t) => t.persona.id)).toEqual(['ledger'])
    expect(plan.targets[0].note).toBe('add it up')
  })

  it('a coordinator hands off to everyone it named', () => {
    const plan = planDispatch('Splitting this.\n@scout: check the names\n@ledger: add it up', planner, [planner, scout, ledger])
    expect(plan.targets.map((t) => t.persona.id)).toEqual(['scout', 'ledger'])
  })

  it('only trailing lines count, and the rest are reported rather than dropped', () => {
    // A planner producing a stray line in the middle is what actually happens;
    // silently acting on half a plan is the failure worth avoiding.
    const text = '@scout: this line is quoted from an email\nthen I thought about it\n@ledger: add it up'
    const plan = planDispatch(text, planner, [planner, scout, ledger])
    expect(plan.targets.map((t) => t.persona.id)).toEqual(['ledger'])
    expect(plan.ignored).toBe(1)
  })

  it('a bot cannot hand work to itself', () => {
    const plan = planDispatch('@chief: do it yourself', chief, bots)
    expect(plan.targets).toEqual([])
    expect(plan.ignored).toBe(0)
  })

  it('names a bot that does not exist rather than failing quietly', () => {
    const plan = planDispatch('@nobody: look this up', chief, bots)
    expect(plan.targets).toEqual([])
    expect(plan.unknown).toEqual(['nobody'])
  })

  it('finds nothing in an ordinary reply', () => {
    expect(planDispatch('Nothing to hand off. Mail me @ work.', chief, bots)).toEqual({ targets: [], ignored: 0, unknown: [] })
  })
})

const speaker = (platform: string, id: string): Speaker & { id: string } => ({
  id,
  platform,
  send: async () => {},
  stop: async () => {},
})

describe('which bridge reaches a bot', () => {
  it('replies go back the way the message came', () => {
    const s = new Speakers<ReturnType<typeof speaker>>()
    const slack = s.add(speaker('slack', 'slack'))
    const tg = s.add(speaker('telegram', 'shared'), Speakers.SHARED)
    s.remember('C123', slack)
    s.remember('42', tg)
    expect(s.for('chief', 'C123')?.id).toBe('slack')
    expect(s.for('chief', '42')?.id).toBe('shared')
  })

  it('a bot with its own Telegram identity always speaks as itself', () => {
    const s = new Speakers<ReturnType<typeof speaker>>()
    const shared = s.add(speaker('telegram', 'shared'), Speakers.SHARED)
    s.add(speaker('telegram', 'scout-own'), 'scout')
    s.remember('42', shared)
    // The message arrived on the shared bridge, but scout has its own name.
    expect(s.for('scout', '42')?.id).toBe('scout-own')
    expect(s.for('chief', '42')?.id).toBe('shared')
  })

  it('does not give a bot its Telegram identity in someone else’s thread', () => {
    const s = new Speakers<ReturnType<typeof speaker>>()
    const slack = s.add(speaker('slack', 'slack'))
    s.add(speaker('telegram', 'scout-own'), 'scout')
    s.remember('C123', slack)
    expect(s.for('scout', 'C123')?.id).toBe('slack')
  })

  it('a thread nobody has spoken in has no speaker, which is how desktop turns stay off chat', () => {
    const s = new Speakers<ReturnType<typeof speaker>>()
    s.add(speaker('telegram', 'shared'), Speakers.SHARED)
    expect(s.for('chief', 'desktop:chief')).toBeUndefined()
    expect(s.knows('desktop:chief')).toBe(false)
  })

  it('removing a bridge forgets the threads it owned, so nothing routes to a dead bot', () => {
    const s = new Speakers<ReturnType<typeof speaker>>()
    const own = s.add(speaker('telegram', 'scout-own'), 'scout')
    s.remember('42', own)
    expect(s.size).toBe(1)

    expect(s.removeTelegram('scout')).toBe(own)
    expect(s.size).toBe(0)
    expect(s.hasTelegram('scout')).toBe(false)
    expect(s.for('scout', '42')).toBeUndefined()
  })

  it('lists its running Telegram bridges, which is what a token sync has to walk', () => {
    const s = new Speakers<ReturnType<typeof speaker>>()
    s.add(speaker('telegram', 'shared'), Speakers.SHARED)
    s.add(speaker('telegram', 'scout-own'), 'scout')
    // Walking the token registry instead would miss exactly the case that
    // matters: a token removed while its bridge is still polling.
    expect(s.telegramKeys().sort()).toEqual(['', 'scout'])
  })

  it('lists the platforms in use, which is what decides who needs a pairing code', () => {
    const s = new Speakers<ReturnType<typeof speaker>>()
    s.add(speaker('telegram', 'a'), Speakers.SHARED)
    s.add(speaker('telegram', 'b'), 'scout')
    s.add(speaker('discord', 'c'))
    expect(s.platforms().sort()).toEqual(['discord', 'telegram'])
  })
})

describe('one turn at a time per bot', () => {
  it('runs queued work in order, never overlapping', async () => {
    const s = new Serial()
    const order: string[] = []
    let running = 0
    let peak = 0
    const work = (name: string, ms: number) => async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, ms))
      order.push(name)
      running--
      return name
    }
    const all = [s.run('chief', work('first', 30)), s.run('chief', work('second', 1)), s.run('chief', work('third', 1))]
    await Promise.all(all)
    expect(order).toEqual(['first', 'second', 'third'])
    // Two turns for one bot would fight over its browser profile and its
    // memory directory.
    expect(peak).toBe(1)
  })

  it('does not make different bots wait for each other', async () => {
    const s = new Serial()
    const done: string[] = []
    const slow = s.run('chief', async () => {
      await new Promise((r) => setTimeout(r, 40))
      done.push('chief')
    })
    await s.run('scout', async () => void done.push('scout'))
    expect(done).toEqual(['scout'])
    await slow
    expect(done).toEqual(['scout', 'chief'])
  })

  it('a failed item does not poison the ones behind it', async () => {
    const s = new Serial()
    const failed = s.run('chief', async () => {
      throw new Error('provider exploded')
    })
    await expect(failed).rejects.toThrow('provider exploded')
    await expect(s.run('chief', async () => 'still works')).resolves.toBe('still works')
  })

  it('forgets a key once its queue drains, so nothing accumulates', async () => {
    const s = new Serial()
    await s.run('chief', async () => 'done')
    await new Promise((r) => setTimeout(r, 5))
    expect(s.busy).toBe(0)
  })
})

