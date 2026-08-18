import type { ApprovalQueue, ApprovalRequest, Owners, Persona, VoiceConfig } from '@agentda/core'
import { fetchAudio, transcribe, VoiceUnavailable } from '@agentda/core'
import { Bot, InlineKeyboard } from 'grammy'

const PLATFORM = 'telegram'

export interface BridgeDeps {
  token: string
  owners: Owners
  queue: ApprovalQueue
  personas: () => Persona[]
  onMessage: (persona: Persona, chat: string, text: string, reply: (s: string) => Promise<void>) => Promise<void>
  onCommand: (cmd: string, args: string, chat: string, reply: (s: string) => Promise<void>) => Promise<void>
  logDropped: (userId: string, why: string) => void
  voice: VoiceConfig
}

// Telegram bridge: long polling, so no public URL and it works from a laptop
// behind NAT. Every inbound update and every button press is checked against the
// owner allowlist first — the bot username is public, so "a human approved" has
// to mean a specific, paired human.
export function createBridge(deps: BridgeDeps) {
  const bot = new Bot(deps.token)
  const pendingMsgs = new Map<string, { chatId: number; messageId: number }>()

  const guard = async (userId: number | undefined, ctx: { reply: (s: string) => Promise<unknown> }, text?: string) => {
    if (userId && deps.owners.isOwner(PLATFORM, userId)) return true
    // First contact with no owners yet: allow pairing, nothing else.
    if (deps.owners.count(PLATFORM) === 0 && text) {
      const code = text.trim().split(/\s+/).pop() ?? ''
      if (userId && deps.owners.claim(PLATFORM, code, userId)) {
        await ctx.reply('Paired. This account is now the owner — only you can talk to these bots or answer approvals.')
        return false
      }
      await ctx.reply('Send the pairing code the daemon printed at startup to claim this bot.')
      return false
    }
    deps.logDropped(String(userId ?? 'unknown'), 'not a paired owner')
    return false
  }

  bot.on('callback_query:data', async (ctx) => {
    // The security-critical check: a button press is only an approval if the
    // person pressing it is the owner. Anyone in a group could tap otherwise.
    if (!ctx.from || !deps.owners.isOwner(PLATFORM, ctx.from.id)) {
      deps.logDropped(String(ctx.from?.id ?? 'unknown'), 'callback_query from non-owner')
      await ctx.answerCallbackQuery({ text: 'Not your bot.' })
      return
    }
    const [action, id] = ctx.callbackQuery.data.split(':')
    const decision = action === 'ok' ? 'allow' : 'deny'
    const settled = deps.queue.settle(id, { decision, source: 'human-tap' })
    await ctx.answerCallbackQuery({ text: settled ? (decision === 'allow' ? 'Approved' : 'Denied') : 'Already resolved' })
    // Edit the card so the buttons can't be pressed twice and the outcome is visible.
    await ctx.editMessageText(
      `${ctx.callbackQuery.message?.text ?? 'Approval'}\n\n${settled ? (decision === 'allow' ? '✓ approved' : '✗ denied') : '(already resolved)'}`,
    ).catch(() => {})
    pendingMsgs.delete(id)
  })

  // One route for every inbound message, whatever carried it. A transcribed
  // voice note has to be able to answer an approval card exactly like typed
  // text does, so there is one place where "yes" becomes a decision (FR-21).
  const route = async (text: string, chat: string, isPrivate: boolean, reply: (s: string) => Promise<void>) => {
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/)
      await deps.onCommand(cmd.split('@')[0], rest.join(' '), chat, reply)
      return
    }

    // A card is open in this thread and you typed at it: answer it rather than
    // starting a turn (FR-21). Only text the parser is sure about counts —
    // anything else is an ordinary message, because misreading a sentence as
    // "yes" would run something nobody approved.
    const answered = deps.queue.answerByText(text, { chat })
    if (answered) {
      await reply(
        answered.amendment
          ? `Sent back for a change: ${answered.amendment}\nYou'll get a new card with the revised ${answered.tool} call.`
          : `${answered.decision === 'allow' ? 'Approved' : 'Denied'} — ${answered.tool}.`,
      )
      return
    }

    const personas = deps.personas()
    // Explicit addressing in group chats (FR-35): a bot acts when named. In a
    // 1:1 chat the single bot answers, or the first one if several are loaded.
    const named = personas.find((p) => new RegExp(`(^|\\s)@?${p.id}\\b`, 'i').test(text))
    const persona = named ?? (isPrivate ? personas[0] : undefined)
    if (!persona) {
      if (personas.length) await reply(`Name a bot: ${personas.map((p) => p.id).join(', ')}`)
      return
    }
    await deps.onMessage(persona, chat, text, reply)
  }

  // Telegram caps messages at 4096 chars.
  const replyTo = (ctx: { reply: (s: string) => Promise<unknown> }) => async (s: string) => {
    for (let i = 0; i < s.length; i += 4000) await ctx.reply(s.slice(i, i + 4000))
  }

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    if (!(await guard(ctx.from?.id, ctx, text))) return
    await route(text, String(ctx.chat.id), ctx.chat.type === 'private', replyTo(ctx))
  })

  // Voice notes (ADR 0004). The transcript is echoed before it does anything:
  // when the thing being transcribed is "yes" to an approval card, the human
  // has to see what was heard.
  bot.on('message:voice', async (ctx) => {
    if (!(await guard(ctx.from?.id, ctx))) return
    const reply = replyTo(ctx)
    try {
      const file = await ctx.api.getFile(ctx.message.voice.file_id)
      if (!file.file_path) throw new VoiceUnavailable('Telegram returned no path for that voice note')
      const audio = await fetchAudio(`https://api.telegram.org/file/bot${deps.token}/${file.file_path}`)
      const text = await transcribe(audio, deps.voice)
      await reply(`🎤 "${text}"`)
      await route(text, String(ctx.chat.id), ctx.chat.type === 'private', reply)
    } catch (err) {
      await reply(
        err instanceof VoiceUnavailable
          ? `I couldn't transcribe that: ${err.message}`
          : `Voice note failed: ${(err as Error).message}`,
      )
    }
  })

  // Renders an approval as a card with tappable buttons. Payload is shown in
  // full: the human must see the concrete action at the moment of decision.
  const ask = async (req: ApprovalRequest, chatId: string) => {
    const body = JSON.stringify(req.input ?? {}, null, 2)
    const kb = new InlineKeyboard().text('Approve', `ok:${req.id}`).text('Deny', `no:${req.id}`)
    const msg = await bot.api.sendMessage(
      chatId,
      `${req.bot} wants to run *${req.tool}*\n\n\`\`\`\n${body.slice(0, 3000)}\n\`\`\`\n_${req.reason}_`,
      { parse_mode: 'Markdown', reply_markup: kb },
    )
    pendingMsgs.set(req.id, { chatId: msg.chat.id, messageId: msg.message_id })
  }

  // When an approval resolves without a tap (timeout, /pause, shutdown), the
  // card must stop showing live buttons.
  const closeCard = async (id: string, outcome: string) => {
    const m = pendingMsgs.get(id)
    if (!m) return
    pendingMsgs.delete(id)
    await bot.api.editMessageText(m.chatId, m.messageId, `Approval ${outcome}`).catch(() => {})
  }

  return { bot, ask, closeCard }
}
