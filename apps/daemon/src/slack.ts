import { Bridge, type BridgeHost, type BridgeTransport, type OutboundRef } from '@agentda/core'
import type { ApprovalRequest } from '@agentda/core'
import { App } from '@slack/bolt'

// Slack over Socket Mode: no public URL, which is the same reason Telegram uses
// long polling. Socket Mode is fine here because Agentda is not a Marketplace
// app — it is your own app in your own workspace.
//
// Who may talk and who may approve is core's Bridge, identical to Telegram's
// (FR-18). This file is the Slack dialect.
export interface SlackDeps extends Omit<BridgeHost, 'owners' | 'queue'> {
  botToken: string // xoxb-…
  appToken: string // xapp-…, Socket Mode
  owners: BridgeHost['owners']
  queue: BridgeHost['queue']
}

const CHUNK = 3000 // Slack's block text limit is 3000 characters

export function createSlackBridge(deps: SlackDeps) {
  const app = new App({ token: deps.botToken, appToken: deps.appToken, socketMode: true })

  const transport: BridgeTransport = {
    platform: 'slack',
    send: async (chat, text) => {
      const res = await app.client.chat.postMessage({ channel: chat, text: text.slice(0, CHUNK) })
      return res.ts ? { chat, messageId: res.ts } : undefined
    },
    edit: async (ref, text) => {
      await app.client.chat.update({ channel: ref.chat, ts: ref.messageId, text: text.slice(0, CHUNK) })
    },
    askApproval: async (chat, req, body) => {
      const res = await app.client.chat.postMessage({
        channel: chat,
        text: `${req.bot} wants to run ${req.tool}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${req.bot}* wants to run \`${req.tool}\`\n_${req.reason}_` } },
          { type: 'section', text: { type: 'mrkdwn', text: '```\n' + body.slice(0, 2800) + '\n```' } },
          {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'agentda_approve', value: `ok:${req.id}` },
              { type: 'button', text: { type: 'plain_text', text: 'Deny' }, style: 'danger', action_id: 'agentda_deny', value: `no:${req.id}` },
            ],
          },
        ],
      })
      return res.ts ? { chat, messageId: res.ts } : undefined
    },
    closeCard: async (ref, outcome) => {
      await app.client.chat.update({ channel: ref.chat, ts: ref.messageId, text: `Approval ${outcome}`, blocks: [] })
    },
  }

  const bridge = new Bridge(transport, deps)

  const replyTo = (channel: string) => async (text: string) => {
    for (let i = 0; i < text.length; i += CHUNK) await transport.send(channel, text.slice(i, i + CHUNK))
  }

  app.message(async ({ message }) => {
    // Only plain user messages: edits, joins, and the bot's own posts are not
    // instructions.
    const m = message as { subtype?: string; user?: string; text?: string; channel: string; channel_type?: string }
    if (m.subtype || !m.user || !m.text) return
    const reply = replyTo(m.channel)
    if (!(await bridge.authenticate(m.user, m.text, reply))) return
    await bridge.inbound(m.text, m.channel, m.channel_type === 'im', reply)
  })

  for (const action of ['agentda_approve', 'agentda_deny']) {
    app.action(action, async ({ ack, body, client }) => {
      // Slack wants an ack inside three seconds; settling the queue is
      // in-process and instant, so this is honest rather than a stall.
      await ack()
      const b = body as { user: { id: string }; actions: { value: string }[]; channel?: { id: string }; message?: { ts: string } }
      const verdict = bridge.decide(b.user.id, b.actions[0].value)
      if (b.channel?.id && b.message?.ts) {
        await client.chat
          .update({
            channel: b.channel.id,
            ts: b.message.ts,
            text: `Approval ${verdict.ok ? verdict.text.toLowerCase() : 'already resolved'}`,
            blocks: [],
          })
          .catch(() => {})
      }
      if (!verdict.ok && verdict.text === 'Not your bot.') {
        await client.chat
          .postEphemeral({ channel: b.channel?.id ?? '', user: b.user.id, text: 'Not your bot — only the paired owner can approve.' })
          .catch(() => {})
      }
    })
  }

  return {
    app,
    bridge,
    ask: (req: ApprovalRequest, chat: string) => bridge.ask(req, chat),
    closeCard: (id: string, outcome: string) => bridge.closeCard(id, outcome),
    checklist: (chat: string, title: string) => bridge.checklist(chat, title),
    send: (chat: string, text: string): Promise<OutboundRef | undefined> => transport.send(chat, text),
    start: () => app.start(),
    stop: () => app.stop(),
  }
}
