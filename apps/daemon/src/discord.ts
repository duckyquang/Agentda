import { Bridge, type BridgeHost, type BridgeTransport, type OutboundRef } from '@agentda/core'
import type { ApprovalRequest } from '@agentda/core'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
  Partials,
} from 'discord.js'

// Discord over the gateway. DMs need no privileged Message Content intent, so
// the recommended setup is a DM or a small private guild — see the onboarding
// docs. Sender authentication and the approval rules are core's Bridge, the
// same ones Telegram and Slack use (FR-18).
export interface DiscordDeps extends Omit<BridgeHost, 'owners' | 'queue'> {
  token: string
  owners: BridgeHost['owners']
  queue: BridgeHost['queue']
}

const CHUNK = 1900 // Discord caps messages at 2000 characters

export function createDiscordBridge(deps: DiscordDeps) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    // Without these a DM arrives as a partial the library will not emit.
    partials: [Partials.Channel, Partials.Message],
  })

  const post = async (chat: string, body: Parameters<typeof sendRaw>[1]) => sendRaw(chat, body)
  const sendRaw = async (chat: string, body: { content: string; components?: unknown[] }): Promise<OutboundRef | undefined> => {
    const channel = await client.channels.fetch(chat)
    if (!channel || !channel.isTextBased() || !('send' in channel)) return undefined
    const msg = await channel.send(body as never)
    return { chat, messageId: msg.id }
  }

  const transport: BridgeTransport = {
    platform: 'discord',
    send: (chat, text) => post(chat, { content: text.slice(0, CHUNK) }),
    edit: async (ref, text) => {
      const channel = await client.channels.fetch(ref.chat)
      if (!channel || !channel.isTextBased()) return
      const msg = await channel.messages.fetch(ref.messageId)
      await msg.edit({ content: text.slice(0, CHUNK) })
    },
    askApproval: (chat, req, body) =>
      post(chat, {
        // The tool name and reason are ours; the payload is content the bot
        // read somewhere, so it goes in unformatted — a backtick inside a code
        // fence closes it, and the rest would render as whatever it likes.
        content: `**${req.bot}** wants to run \`${req.tool}\`\n_${req.reason}_\n\n${body.slice(0, 1500)}`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`ok:${req.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`no:${req.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
          ).toJSON(),
        ],
      }),
    closeCard: async (ref, outcome) => {
      const channel = await client.channels.fetch(ref.chat)
      if (!channel || !channel.isTextBased()) return
      const msg = await channel.messages.fetch(ref.messageId)
      await msg.edit({ content: `Approval ${outcome}`, components: [] })
    },
  }

  const bridge = new Bridge(transport, deps)

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.content) return
    // Group DMs are the one text channel a bot cannot post into, so replies go
    // back through the transport, which resolves the channel the same way the
    // approval cards do.
    const reply = async (text: string) => {
      for (let i = 0; i < text.length; i += CHUNK) await transport.send(message.channelId, text.slice(i, i + CHUNK))
    }
    if (!(await bridge.authenticate(message.author.id, message.content, reply))) return
    await bridge.inbound(message.content, message.channelId, message.channel.type === ChannelType.DM, reply)
  })

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton()) return
    // Discord's three-second interaction deadline: acknowledge first, edit
    // after. Settling the queue is in-process, so nothing is being stalled.
    await interaction.deferUpdate().catch(() => {})
    const verdict = bridge.decide(interaction.user.id, interaction.customId)
    if (!verdict.ok && verdict.text === 'Not your bot.') {
      await interaction.followUp({ content: 'Not your bot — only the paired owner can approve.', ephemeral: true }).catch(() => {})
      return
    }
    await interaction.message
      .edit({ content: `${interaction.message.content}\n\n${verdict.ok ? (verdict.text === 'Approved' ? '✓ approved' : '✗ denied') : '(already resolved)'}`, components: [] })
      .catch(() => {})
  })

  client.once(Events.ClientReady, (c) => console.log(`Discord bridge live as ${c.user.tag}`))

  return {
    client,
    bridge,
    ask: (req: ApprovalRequest, chat: string) => bridge.ask(req, chat),
    closeCard: (id: string, outcome: string) => bridge.closeCard(id, outcome),
    checklist: (chat: string, title: string) => bridge.checklist(chat, title),
    send: (chat: string, text: string) => transport.send(chat, text),
    start: () => client.login(deps.token),
    stop: () => client.destroy(),
  }
}
