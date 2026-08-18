# Slack

Agentda talks to Slack over **Socket Mode**: the daemon opens the connection outward, so
there is no public URL, no tunnel, and nothing to expose from your laptop. That is fine
here because this is your own app in your own workspace — Agentda is not a Marketplace app.

## Setting it up

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an
   app manifest**, pick your workspace, and paste
   [`examples/slack/app-manifest.yaml`](../examples/slack/app-manifest.yaml).
2. **Basic Information → App-Level Tokens** → generate a token with the `connections:write`
   scope. That is the `xapp-…` token.
3. **Install App** → install to the workspace. That gives you the `xoxb-…` bot token.
4. Put both in `.env.local`:

   ```
   SLACK_BOT_TOKEN=xoxb-…
   SLACK_APP_TOKEN=xapp-…
   ```

5. Start the daemon. If no Slack owner is paired yet it prints a pairing code:

   ```
   PAIRING CODE (slack): 3f8c21aa
   ```

6. DM the app that code once. That enrolls your Slack user id as the owner.

## Why the pairing step exists

Anyone in your workspace can DM an installed app, and in a channel anyone can press a
button. The approval story is "a specific human said yes", so the bridge checks the sender
of every message and, above all, of every button press against the paired owner list. An
unpaired user's message is dropped and logged; their button press is refused with an
ephemeral note and leaves the approval open.

Pairing is per platform. Being the owner on Telegram does not make you the owner on Slack —
they are different account systems and the daemon has no way to know they are the same
person.

## What it looks like

- DM the app, or mention a bot by name in a channel it is in: `scout: check that page`.
- While a turn runs, one message is edited in place with a checklist of the tools as they
  happen — `chat.update`, throttled, so it never trips Slack's rate limits.
- A gated action posts a card with the full payload and **Approve** / **Deny** buttons. The
  press is acknowledged inside Slack's three-second window; settling the approval is
  in-process and instant, so nothing is being stalled behind that ack.
- You can also just type at the card: `yes`, `no`, or `approve but use the other address`.
  An amendment comes back as a fresh card with the revised payload.

## Status

Built and covered by the shared bridge tests — the rules about who may talk and who may
approve are one implementation, shared with Telegram and Discord, and those are tested
directly. The Slack-specific wiring (Bolt's Socket Mode, Block Kit buttons, `chat.update`)
has **not** been run against a real workspace, because there is no Slack app to run it
against. See [USER_REQUEST.md](../USER_REQUEST.md).
