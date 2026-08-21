import { mkdirSync } from 'node:fs'
import type { AgentEvent, ProviderAdapter, Routine, RoutineStep } from '@agentda/core'
import { parseExpect, validateRoutine, verbTool } from '@agentda/core'
import { type BrowserContext, chromium, type Locator, type Page } from 'playwright'
import { describeRung, resolveStep, type Rung } from './ladder'

// Replay is a provider.
//
// That is the whole design. A recorded routine runs as a turn like any other,
// so it goes through TurnRunner, through the budget, through the same gate
// closure, and every step it takes reaches ApprovalQueue.request under the
// SAME tool name the model's own browser call would use. There is no second
// permission system to keep in step with the first, and no second audit trail.
//
// What replay adds is refusal. A script written days ago, running against a
// page that may have changed, with nobody watching, has to be much readier to
// stop than a model is: an ambiguous element, a failed post-condition, a
// missing handle and a denied step all end the routine rather than continuing
// into a half-finished form.

export interface ReplayOptions {
  routine: Routine
  profileDir: string
  // Where to post screencast frames, so a replay is watchable in the app
  // exactly like a model-driven session.
  previewUrl?: string
  headed?: boolean
  // Called when the routine gives up, so the daemon can hand the human the
  // browser where it stopped.
  onHandback?: (reason: string) => void | Promise<void>
}

type Gate = (
  tool: string,
  input: unknown,
  opts?: { forceAsk?: boolean },
) => Promise<{ decision: 'allow' | 'deny'; reason?: string }>

export class ReplayAdapter implements ProviderAdapter {
  name = 'replay'
  // Not streaming and not resumable: a routine is a script, and half a script
  // is not a session to pick up again.
  capabilities = { streaming: false, tools: true, midTurnGating: true }

  async *startTurn(input: string, opts: Record<string, unknown> = {}): AsyncIterable<AgentEvent> {
    const replay = opts.replay as ReplayOptions | undefined
    const gate = opts.gate as Gate | undefined
    if (!replay) throw new Error('the replay provider needs a routine to replay')
    if (!gate) throw new Error('the replay provider will not run without a gate')

    const problems = validateRoutine(replay.routine)
    if (problems.length) {
      // Before a browser is opened: a routine that cannot be replayed safely
      // should not get as far as a page.
      yield { type: 'text', text: `I did not run this routine:\n${problems.map((p) => `- ${p}`).join('\n')}` }
      yield { type: 'result', sessionId: 'replay', raw: {} }
      return
    }

    mkdirSync(replay.profileDir, { recursive: true })
    const ctx = await chromium.launchPersistentContext(replay.profileDir, {
      channel: 'chromium',
      headless: !replay.headed,
      args: ['--use-mock-keychain', '--no-first-run', '--no-default-browser-check'],
      viewport: { width: 1280, height: 900 },
    })
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await streamTo(ctx, page, replay.previewUrl)
    const done: string[] = []

    // A stop is both something the human reads and something the live
    // checklist marks, so it is said twice on purpose.
    const stop = async function* (this: void, reason: string): AsyncGenerator<AgentEvent> {
      yield { type: 'warning', message: reason }
      yield { type: 'text', text: reason }
      await replay.onHandback?.(reason)
    }

    try {
      for (const step of replay.routine.steps) {
        if (step.verb === 'handback') {
          yield* stop(`Step ${step.n} is yours: ${step.note ?? 'the recording stops here'}. The browser is where I left it.`)
          break
        }

        const tool = verbTool(step.verb)!
        let target: Locator | undefined
        let how = ''

        if (step.verb !== 'navigate') {
          const found = await resolveStep(step, (rung) => locate(page, rung).count())
          if (!found.ok) {
            yield* stop(`${found.reason}. Stopping rather than guessing — the browser is where I left it.`)
            break
          }
          target = locate(page, found.rung)
          how = describeRung(found.rung) + (found.recovered ? ' (the page changed; found it another way)' : '')
        }

        // Resolved BEFORE asking, so the card names the element that will
        // actually be touched rather than the one that was recorded.
        const cardInput = {
          step: step.n,
          of: replay.routine.steps.length,
          ...(step.url ? { url: step.url } : {}),
          ...(how ? { element: how } : {}),
          ...(step.text !== undefined ? { text: step.text } : {}),
          recorded: replay.routine.recordedAt,
        }
        yield { type: 'tool_call', name: tool, input: cardInput }

        // An element the ladder had to work for is not the one the human
        // recorded, so it asks even in Auto — same switch a sensitive step uses.
        const verdict = await gate(tool, cardInput, { forceAsk: step.sensitive || how.includes('another way') })
        if (verdict.decision === 'deny') {
          // Aborts the routine. A model can be told no and carry on; a script
          // cannot — skipping "fill the amount" and going on to "click submit"
          // submits a form with the old amount in it.
          yield* stop(`Step ${step.n} was not approved${verdict.reason ? `: ${verdict.reason}` : ''}. I stopped the whole routine there rather than carrying on to the next step.`)
          break
        }

        try {
          await act(page, step, target)
        } catch (err) {
          yield* stop(`Step ${step.n} failed: ${(err as Error).message}. The browser is where I left it.`)
          break
        }

        const wrong = await checkExpect(page, step, target)
        if (wrong) {
          // The only thing standing between "typed into the wrong box" and a
          // routine that reports success.
          yield* stop(`Step ${step.n} did not do what the recording did: ${wrong}. Stopping here.`)
          break
        }
        done.push(`${step.n}. ${step.verb}${how ? ` ${how}` : step.url ? ` ${step.url}` : ''}`)
      }
    } finally {
      await ctx.close().catch(() => {})
    }

    yield {
      type: 'text',
      text: done.length
        ? `Replayed ${done.length} of ${replay.routine.steps.length} steps:\n${done.join('\n')}`
        : 'I did not get past the first step.',
    }
    yield { type: 'result', sessionId: 'replay', raw: {} }
  }
}

// The same CDP screencast the browser server uses, so a routine replaying
// unattended is watchable in the app rather than a black box that reports
// afterwards.
async function streamTo(ctx: BrowserContext, page: Page, previewUrl?: string): Promise<void> {
  if (!previewUrl) return
  try {
    const cdp = await ctx.newCDPSession(page)
    cdp.on('Page.screencastFrame', async (frame: { data: string; sessionId: number }) => {
      await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      await fetch(previewUrl, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: frame.data }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1024, maxHeight: 768, everyNthFrame: 2 })
  } catch {
    // Not being watchable is a missing convenience, not a reason to refuse to
    // replay.
  }
}

function locate(page: Page, rung: Rung): Locator {
  switch (rung.kind) {
    case 'selector':
      return page.locator(rung.value)
    case 'role':
      return page.getByRole(rung.role as Parameters<Page['getByRole']>[0], rung.name ? { name: rung.name, exact: rung.exact } : {})
    case 'label':
      return page.getByLabel(rung.value)
    case 'placeholder':
      return page.getByPlaceholder(rung.value)
    case 'testId':
      return page.getByTestId(rung.value)
    case 'text':
      return page.getByText(rung.value)
  }
}

async function act(page: Page, step: RoutineStep, target?: Locator): Promise<void> {
  if (step.verb === 'navigate') {
    await page.goto(step.url!, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return
  }
  if (!target) throw new Error('nothing to act on')
  if (step.verb === 'type') await target.fill(step.text ?? '', { timeout: 15_000 })
  else if (step.verb === 'select') await target.selectOption(step.text ?? '', { timeout: 15_000 })
  else await target.click({ timeout: 15_000 })
  await page.waitForLoadState('domcontentloaded').catch(() => {})
}

// Returns what is wrong, or undefined when the step did what it was supposed to.
async function checkExpect(page: Page, step: RoutineStep, target?: Locator): Promise<string | undefined> {
  const want = step.expect ? parseExpect(step.expect) : undefined
  if (!want) return undefined
  try {
    if (want.kind === 'title') {
      const title = await page.title()
      return title.includes(want.value) ? undefined : `the page is called "${title}", not something containing "${want.value}"`
    }
    if (want.kind === 'url') {
      return page.url().includes(want.value) ? undefined : `we ended up at ${page.url()}, which does not contain "${want.value}"`
    }
    if (want.kind === 'text') {
      const body = await page.locator('body').innerText({ timeout: 5_000 })
      return body.includes(want.value) ? undefined : `the page never said "${want.value}"`
    }
    if (want.kind === 'value') {
      const value = await (target ?? page.locator('body')).inputValue({ timeout: 5_000 }).catch(() => undefined)
      return value === want.value ? undefined : `the field holds ${JSON.stringify(value)}, not ${JSON.stringify(want.value)}`
    }
    const visible = await page.locator(want.value).first().isVisible({ timeout: 5_000 })
    return visible ? undefined : `${want.value} never appeared`
  } catch (err) {
    return `could not check: ${(err as Error).message}`
  }
}
