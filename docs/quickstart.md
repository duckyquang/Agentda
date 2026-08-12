# Quickstart

Zero to a bot you can message on Telegram. About ten minutes, most of it waiting on downloads.

Honest limitation first: everything runs on your machine, so bots only work while your
machine is on and awake. Close the lid and scheduled routines don't fire (they're skipped,
not replayed). An always-on host is a later phase.

## What you need

- Node 20+ and pnpm
- Claude Code installed and logged in: run `claude` once and use `/login`. A Pro or Max
  subscription is what pays for your bots' turns; no API key needed.
- A Telegram bot token from [@BotFather](https://t.me/BotFather) — send `/newbot`, pick a
  name, copy the token it gives you.

## 1. Install and check

```bash
git clone https://github.com/duckyquang/Agentda
cd Agentda && pnpm install
pnpm canary   # one cheap turn: proves login works and that bot turns are isolated
```

The canary should print `canary: all good`. If it reports tools or hooks leaking in, stop
and open an issue — that's the isolation the whole product rests on.

## 2. Create your bots

Bots are folders. Copy the examples to get started:

```bash
mkdir -p ~/.agentda
cp -r examples/bots ~/.agentda/bots
```

Each bot is a directory:

```
chief/
  bot.toml       what it can touch, its mode, its schedule
  prompt.md      who it is
  memory/*.md    what it remembers — plain Markdown you can edit
```

Open `~/.agentda/bots/chief/bot.toml` and set `scope` to a directory you're comfortable
letting a bot read and write, e.g. `scope = ["~/Documents/agentda-sandbox"]`. Start with a
sandbox folder, not your whole home directory.

## 3. Start the daemon

```bash
export TELEGRAM_BOT_TOKEN=123456:your-token-here
pnpm daemon
```

On first start it prints a **pairing code**. DM that code to your bot on Telegram. Until
you do, the bot answers nobody — Telegram bot usernames are public, and "a human approved"
has to mean *you*.

Then message it. Ask it something, or tell it to remember a fact and ask again tomorrow.

## 4. Commands

| Command | What it does |
|---|---|
| `/bots` | list your bots and their modes |
| `/mode <bot> ask\|auto` | switch a bot between Ask and Auto |
| `/pause` | every bot back to Ask, pending approvals denied |
| `/resume` | bots use their own modes again |
| `/audit` | last 15 gate decisions |
| `/routines` | scheduled routines |
| `/reload` | re-read the bot folders after editing them |

## Ask vs Auto

**Ask** (default) blocks anything consequential on your tap: you get a card with the exact
action — recipient, subject, body — and Approve/Deny buttons. Unanswered requests expire as
denied after 30 minutes.

**Auto** runs those without asking. It is not a free-for-all: the audit log still records
every action, budgets still apply, tool grants still apply, and the bot's always-ask list
(shell, and whatever else you add) still stops for you. `/pause` drops everything back to
Ask instantly.

Keep bots that read untrusted content — email, the web — in Ask mode. That's the whole
defense against a crafted email talking your bot into something.

## Giving a bot browser hands

Set `browser = true` in its `bot.toml`, then:

```bash
pnpm --filter @agentda/mcp-browser exec playwright install chromium
```

By default the browser runs in the **shadow** surface: a real Chromium with no window, so
the bot browses while you keep working — it never takes your screen or your keyboard. Set
`browser_surface = "on-screen"` to watch it work in a visible window instead (useful when a
site refuses headless traffic).

Navigation and reading are auto-approved; clicking and typing are gated, because a click
can submit or buy something.

## Multi-bot

Put several bots in a group chat and address them by name (`chief: what's on today?`). A
bot passes work along by ending its reply with `@scout: check these three names`. Every
handoff is visible in the thread and capped per task, so two bots can't ping-pong through
your plan quota.

## Running it as a service

macOS (launchd) — `~/Library/LaunchAgents/com.agentda.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.agentda.daemon</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/pnpm</string><string>daemon</string></array>
  <key>WorkingDirectory</key><string>/path/to/Agentda</string>
  <key>EnvironmentVariables</key>
  <dict><key>TELEGRAM_BOT_TOKEN</key><string>your-token</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/com.agentda.daemon.plist`

Linux (systemd) — `~/.config/systemd/user/agentda.service`:

```ini
[Unit]
Description=Agentda daemon
[Service]
WorkingDirectory=/path/to/Agentda
Environment=TELEGRAM_BOT_TOKEN=your-token
ExecStart=/usr/bin/pnpm daemon
Restart=on-failure
[Install]
WantedBy=default.target
```

`systemctl --user enable --now agentda`

Neither keeps a sleeping laptop awake. Scheduled runs missed during sleep are skipped with
a logged reason, not replayed in a burst.

## Tuning usage

Bot turns come out of the same plan window as your own Claude usage, so a chatty schedule
can lock you out of your own subscription. Defaults are deliberately conservative:

- `daily_turn_cap` per bot in `bot.toml`
- `quiet_hours = { start = 23, end = 7 }` to keep routines from firing overnight
- `AGENTDA_TURNS_PER_WINDOW` (default 60) as a global per-5-hour ceiling

All counts are Agentda's own estimates — no vendor publishes real plan metering.
