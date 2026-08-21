import { Bridge, type BridgeHost, type BridgeTransport, fetchAudio, type OutboundRef, transcribe, VoiceUnavailable } from '@agentda/core'
import type { ApprovalRequest, VoiceConfig } from '@agentda/core'
import { Bot, InlineKeyboard } from 'grammy'

// Telegram: long polling, so no public URL and it works from a laptop behind
// NAT. Everything about who may talk and who may approve lives in core's
// Bridge — this file is the Telegram dialect and nothing else.
export interface TelegramDeps extends Omit<BridgeHost, 'owners' | 'queue'> {
  token: string
  owners: BridgeHost['owners']
  queue: BridgeHost['queue']
  voice: VoiceConfig
}

const CHUNK = 4000 // Telegram caps messages at 4096

export function createBridge(deps: TelegramDeps) {
  const bot = new Bot(deps.token)

  const transport: BridgeTransport = {
    platform: 'telegram',
    send: async (chat, text) => {
      const msg = await bot.api.sendMessage(chat, text.slice(0, CHUNK))
      return { chat: String(msg.chat.id), messageId: String(msg.message_id) }
    },
    edit: async (ref, text) => {
      await bot.api.editMessageText(ref.chat, Number(ref.messageId), text.slice(0, CHUNK))
    },
    askApproval: async (chat, req, body) => {
      const kb = new InlineKeyboard().text('Approve', `ok:${req.id}`).text('Deny', `no:${req.id}`)
      // No parse_mode. The payload is content the bot read from somewhere, and
      // a backtick in it closes the code fence early — after which the rest
      // renders as formatting and can describe the action as something other
      // than what will run. The human sees the exact bytes instead.
      const msg = await bot.api.sendMessage(
        chat,
        `${req.bot} wants to run ${req.tool}\n\n${body}\n\n${req.reason}`,
        { reply_markup: kb },
      )
      return { chat: String(msg.chat.id), messageId: String(msg.message_id) }
    },
    closeCard: async (ref, outcome) => {
      await bot.api.editMessageText(ref.chat, Number(ref.messageId), `Approval ${outcome}`)
    },
  }

  const bridge = new Bridge(transport, deps)

  const replyTo = (ctx: { reply: (s: string) => Promise<unknown> }) => async (s: string) => {
    for (let i = 0; i < s.length; i += CHUNK) await ctx.reply(s.slice(i, i + CHUNK))
  }

  bot.on('callback_query:data', async (ctx) => {
    const verdict = bridge.decide(ctx.from?.id === undefined ? undefined : String(ctx.from.id), ctx.callbackQuery.data)
    await ctx.answerCallbackQuery({ text: verdict.text })
    if (verdict.text === 'Not your bot.') return
    // Edit the card so the buttons can't be pressed twice and the outcome is visible.
    await ctx
      .editMessageText(`${ctx.callbackQuery.message?.text ?? 'Approval'}\n\n${verdict.ok ? (verdict.text === 'Approved' ? '✓ approved' : '✗ denied') : '(already resolved)'}`)
      .catch(() => {})
  })

  bot.on('message:text', async (ctx) => {
    const reply = replyTo(ctx)
    if (!(await bridge.authenticate(ctx.from?.id === undefined ? undefined : String(ctx.from.id), ctx.message.text, reply))) return
    await bridge.inbound(ctx.message.text, String(ctx.chat.id), ctx.chat.type === 'private', reply)
  })

  // Voice notes (ADR 0004). The transcript is echoed before it does anything:
  // when the thing being transcribed is "yes" to an approval card, the human
  // has to see what was heard.
  bot.on('message:voice', async (ctx) => {
    const reply = replyTo(ctx)
    if (!(await bridge.authenticate(ctx.from?.id === undefined ? undefined : String(ctx.from.id), undefined, reply))) return
    try {
      const file = await ctx.api.getFile(ctx.message.voice.file_id)
      if (!file.file_path) throw new VoiceUnavailable('Telegram returned no path for that voice note')
      const audio = await fetchAudio(`https://api.telegram.org/file/bot${deps.token}/${file.file_path}`)
      const text = await transcribe(audio, deps.voice)
      await reply(`🎤 "${text}"`)
      await bridge.inbound(text, String(ctx.chat.id), ctx.chat.type === 'private', reply, String(ctx.from?.id ?? ''))
    } catch (err) {
      await reply(
        err instanceof VoiceUnavailable
          ? `I couldn't transcribe that: ${err.message}`
          : `Voice note failed: ${(err as Error).message}`,
      )
    }
  })

  return {
    bot,
    bridge,
    ask: (req: ApprovalRequest, chat: string) => bridge.ask(req, chat),
    closeCard: (id: string, outcome: string) => bridge.closeCard(id, outcome),
    checklist: (chat: string, title: string) => bridge.checklist(chat, title),
    send: (chat: string, text: string): Promise<OutboundRef | undefined> => transport.send(chat, text),
    start: (onStart: (me: { username: string }) => void) => bot.start({ drop_pending_updates: true, onStart }),
    stop: () => bot.stop(),
  }
}
