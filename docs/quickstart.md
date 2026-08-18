# Quickstart

Zero to a bot you can message on Telegram. About ten minutes, most of it waiting on downloads.

Honest limitation first: everything runs on your machine, so bots only work while your
machine is on and awake. Close the lid and scheduled routines don't fire (they're skipped,
not replayed). An always-on host is a later phase.

## What you need

- Node 20+ and pnpm
- One provider. Any of:
  - **Claude Code** installed and logged in — run `claude` once and use `/login`. A Pro or
    Max subscription pays for your bots' turns; no API key needed. This is the one with the
    most capability behind it (see the [provider matrix](providers.md)).
  - **Codex** logged in with `codex login`, if you're on a ChatGPT plan. Read-only, and the
    matrix says exactly why.
  - **[Ollama](https://ollama.com)** for a local model — costs nothing but electricity.
  - An API key for Anthropic, OpenAI, xAI, or Gemini.
- Optional: a Telegram bot token from [@BotFather](https://t.me/BotFather) — send
  `/newbot`, pick a name, copy the token. Without one the daemon still runs and the desktop
  app still works; you just talk to your bots there instead of on your phone.

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
pnpm daemon
```

It prints a URL for the desktop UI. Open it in a browser, or run
`pnpm --filter @agentda/desktop dev` to get it as a proper window — that builds the Tauri
shell, starts the daemon itself, and shuts it down again when you close it.

No chat token is needed to start. To reach your bots from your phone, add one:

```bash
export TELEGRAM_BOT_TOKEN=123456:your-token-here   # from @BotFather
pnpm daemon
```

Now it also prints a **pairing code**. DM that code to your bot on Telegram. Until you do,
the bot answers nobody — bot usernames are public, and "a human approved" has to mean *you*.

Then message it. Ask it something, or tell it to remember a fact and ask again tomorrow.

## 3b. The desktop app

Everything the chat commands do, plus what a chat window cannot show:

- the bot roster with mode badges and a marker when something is waiting on you
- a chat pane with a live checklist that fills in as tools run
- approval cards with the full payload, Approve, Deny, or a typed amendment
- an approvals inbox across every bot, and the audit log with filters
- routine definitions and their run history
- the persona editor: providers, model, hands, scope, gate lists, budgets, tool packs, and
  adding a per-bot Telegram token
- **Screen**: a live view of a bot's browser while it works, with Take over — which puts
  the same session in a window you drive and stops the bot touching the page until you hand
  it back
- a mic, for the same voice notes Telegram takes

The API it talks to is loopback-only and token-authenticated, and the token is per run.

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

You can also just answer an approval card by typing at it: `yes`, `no`, or
`approve but use the other address`. An amendment is passed to the bot as the reason its
call was refused, so it makes the change and asks again — you see a fresh card with the
real payload and tap once more. Anything the parser is not sure about stays an ordinary
message rather than becoming a decision nobody made.

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

## Tool packs

A pack is a curated pointer at an MCP server someone else maintains, with its verbs
classified so the gate knows which ones reach the outside world. Turn one on in the desktop
app's persona editor, or by id in `bot.toml`:

```toml
packs = ["files", "thinking"]
```

Read-only verbs run unasked; everything else is gated, including tools a pack forgot to
mention. Three packs ship, each vetted by actually running it — see [packs](packs.md).

## Other chat apps

Telegram is not the only option, and the rules are identical on all three: same pairing,
same approval buttons, same typed answers, same audit trail.

- **Slack** — [docs/slack.md](slack.md). Socket Mode, so no public URL. The app manifest is
  checked into the repo.
- **Discord** — [docs/discord.md](discord.md). Gateway plus buttons; easiest in a small
  private server.

Pairing is per platform: being the owner on Telegram does not make you the owner on Slack.

## Voice notes

Send a voice note instead of typing, including to answer an approval card. Transcription
runs on your machine by default, because the thing being transcribed might be the word
that approves a payment ([ADR 0004](adr/0004-voice-transcription.md)):

```bash
brew install ffmpeg whisper-cpp
mkdir -p ~/.agentda/models
curl -L -o ~/.agentda/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
export AGENTDA_WHISPER_MODEL=~/.agentda/models/ggml-base.en.bin
```

The transcript is always shown before it does anything. If you would rather not install
anything, `AGENTDA_VOICE=openai` with an `OPENAI_API_KEY` sends the audio to a vendor
instead — metered, off your machine, and never a silent fallback: if the local tools are
missing, the bot tells you what is missing rather than quietly uploading your voice.

## Multi-bot

Put several bots in a group chat and address them by name (`chief: what's on today?`). A
bot passes work along by ending its reply with `@scout: check these three names`. Every
handoff is visible in the thread and capped per task, so two bots can't ping-pong through
your plan quota.

Give each bot its own BotFather token in the persona editor and they get their own names
and avatars, so a group chat with three of them looks like three bots rather than one
account talking to itself.

There is also a planner pattern — `coordinator = true` lets one bot split work across
several in a single turn — but it is off by default and honestly unproven; the runs behind
that decision are in [ADR 0006](adr/0006-coordinator-pattern.md).

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
