import { mkdirSync } from 'node:fs'
import { type CompileResult, compileRoutine, type RawAction } from '@agentda/core'
import { type BrowserContext, chromium, type Page } from 'playwright'

// Watching a human do something once (PLAN Phase 4).
//
// This drives Playwright's own recorder rather than reimplementing one, through
// a private entry point — `_enableRecorder({ recorderMode: 'api' })` — that is
// present in the installed build and absent from the public types. That is a
// real dependency risk, so it is pinned exactly and there is a canary test
// whose only job is to fail loudly when a Playwright bump moves it.
//
// The window is headed and uses the bot's own profile: the human needs to see
// what they are doing, and the routine has to be recorded against the same
// logged-in session it will replay against.

interface RecorderContext extends BrowserContext {
  _enableRecorder(
    params: { mode: string; recorderMode: string },
    sink: {
      actionAdded?: (page: Page, data: { action?: RawAction }, code: string) => void
      actionUpdated?: (page: Page, data: { action?: RawAction }, code: string) => void
      signalAdded?: (page: Page, data: unknown) => void
    },
  ): Promise<void>
  _disableRecorder?(): Promise<void>
}

export interface RecordingOptions {
  profileDir: string
  startUrl?: string
  headed?: boolean // false only for tests; a human cannot drive what they cannot see
  onAction?: (action: RawAction, index: number) => void
}

export class RecordingSession {
  private constructor(
    private ctx: BrowserContext,
    private actions: RawAction[],
    private startedAt: string,
    private startUrl?: string,
  ) {}

  static async start(opts: RecordingOptions): Promise<RecordingSession> {
    mkdirSync(opts.profileDir, { recursive: true })
    const ctx = await chromium.launchPersistentContext(opts.profileDir, {
      channel: 'chromium',
      headless: opts.headed === false,
      args: ['--use-mock-keychain', '--no-first-run', '--no-default-browser-check'],
      viewport: { width: 1280, height: 900 },
    })
    const actions: RawAction[] = []

    // The recorder reports an action when it starts and again when it settles.
    // Keyed on position rather than appended twice, or every fill would be two
    // steps — the second one with the final text.
    const upsert = (data: { action?: RawAction }, at?: number) => {
      if (!data.action) return
      const i = at ?? actions.length
      actions[i] = data.action
      opts.onAction?.(data.action, i)
    }
    await (ctx as RecorderContext)._enableRecorder(
      { mode: 'recording', recorderMode: 'api' },
      {
        actionAdded: (_page, data) => upsert(data),
        actionUpdated: (_page, data) => upsert(data, actions.length ? actions.length - 1 : 0),
      },
    )

    const page = ctx.pages()[0] ?? (await ctx.newPage())
    if (opts.startUrl) await page.goto(opts.startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    return new RecordingSession(ctx, actions, new Date().toISOString(), opts.startUrl)
  }

  get page(): Page | undefined {
    return this.ctx.pages()[0]
  }

  get count(): number {
    return this.actions.length
  }

  // Closes the window and hands back a draft. Never writes anything itself:
  // where a routine lives is the daemon's business, and a recording that is
  // not worth keeping should not leave a file behind.
  async stop(): Promise<CompileResult> {
    const url = this.page?.url()
    await (this.ctx as RecorderContext)._disableRecorder?.().catch(() => {})
    await this.ctx.close().catch(() => {})
    return compileRoutine(this.actions, { recordedAt: this.startedAt, recordedUrl: this.startUrl ?? url })
  }

  // For a recording the human abandoned.
  async discard(): Promise<void> {
    await this.ctx.close().catch(() => {})
  }
}
