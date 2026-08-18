# Discord

Agentda connects to Discord over the gateway with `discord.js`. DMs need no privileged
intent, so the least-effort setup is a bot you talk to in a DM, or in a small private guild
you make for yourself.

## Setting it up

1. [discord.com/developers/applications](https://discord.com/developers/applications) →
   **New Application** → **Bot** → **Reset Token**, and copy it.
2. Under **Bot → Privileged Gateway Intents**, turn on **Message Content Intent** if you
   want the bot to read messages in a guild channel. For DMs it is not required, but the
   library asks for it in the current setup, so leave it on unless you are DM-only and want
   to trim it.
3. Add it somewhere you can talk to it. Either:
   - **A private guild** (recommended): make a server just for yourself, then
     **OAuth2 → URL Generator** → scopes `bot`, permissions *Send Messages*, *Read Message
     History*, *Embed Links* — open the URL and add it to that server; or
   - **A user-installed app**, if you would rather have it only in your DMs.

   A bot cannot DM a stranger on Discord — the user has to share a guild with it or install
   it — which is why one of these steps is unavoidable.
4. Put the token in `.env.local`:

   ```
   DISCORD_BOT_TOKEN=…
   ```

5. Start the daemon and DM the pairing code it prints:

   ```
   PAIRING CODE (discord): 91b0c4de
   ```

## Approvals

Buttons are `deferUpdate` first, then the message is edited — Discord gives an interaction
three seconds, and Agentda's own settle is in-process, so the ack is honest rather than a
placeholder. A press from anyone who is not the paired owner is refused with an ephemeral
reply and leaves the approval open. Typing `yes`, `no`, or `approve but …` at the card
works exactly as it does on Telegram and Slack.

## Status

The shared rules — sender authentication, approvals, addressing, amendments — are one
implementation across all three platforms and are tested directly. The Discord-specific
wiring (gateway events, button interactions, message edits) has **not** been run against a
real bot token. See [USER_REQUEST.md](../USER_REQUEST.md).
