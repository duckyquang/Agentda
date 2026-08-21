# What I need from you

This file is my standing request list. I rewrite it whenever I need something only you can
provide — credentials, an account, a decision, a device. If it says "nothing right now,"
you're not blocking anything.

**Last updated:** 2026-08-21 · **Status:** 8 items, none urgent, none blocking

| # | What | Why it's blocked on you | Time |
|---|---|---|---|
| 1 | A Telegram bot token (ideally two) | I can't create a bot account on your behalf | ~3 min |
| 2 | Mailbox credentials (IMAP/SMTP) | I have no mailbox to read | ~5 min |
| 3 | A Slack app, if you use Slack | Needs your workspace and your admin click | ~5 min |
| 4 | A Discord bot token, if you use Discord | Needs your Discord account | ~4 min |
| 5 | `brew install ffmpeg whisper-cpp` + a model file | Installs software on your machine — your call, not mine | ~5 min |
| 6 | Google OAuth credentials, for the mail/calendar packs | Needs your Google account and consent screen | ~10 min |
| 7 | One API key, if you want | Verifies the hosted providers, and one honest evaluation I couldn't run | ~2 min |
| 8 | `gh auth refresh -s workflow` | Your GitHub token can't touch CI files, and two CI jobs are waiting | ~1 min |

Phases 1, 2 and 3 are built. What's left in each is exactly the parts that need one of the
above, and every one of those is marked ⏳ in [PLAN.md](PLAN.md) rather than quietly ticked.

You can use the whole thing right now with no credentials at all: `pnpm daemon` prints a
URL, or `pnpm --filter @agentda/desktop dev` opens the window, and bots run on your Claude
subscription, your ChatGPT plan, or a local Ollama model.

---

## First: where to put secrets

**Don't paste credentials into our chat.** Put them in a file I can read but git can't see.

```bash
cd ~/Documents/coding/Agentda
touch .env.local
chmod 600 .env.local
```

`.env.local` is already in [.gitignore](.gitignore), and `pnpm daemon` / `pnpm test:live`
load it automatically. Fill in the sections below as you go, then just tell me "done" — I'll
run the verification and report back. I won't print the contents anywhere.

Per-bot Telegram tokens are the one exception: those go through the desktop app, which
stores them in `~/.agentda/telegram.json` with 0600 permissions, deliberately outside the
bot folders so a bot directory stays safe to copy and share.

---

## 1. Telegram bot tokens

**What this unlocks:** the actual product experience — messaging your bots from your phone,
tapping Approve/Deny on real approval cards. The bridge is built and unit-tested, but no
one has ever messaged a real bot.

**A second token is worth it.** Two bots under separate identities is a Phase 2 exit
criterion, and it's the only one still open that isn't about a service I can't reach. With
one token all your bots talk through one account; with two, a group chat with Chief and
Scout looks like two bots, which is the point of the feature.

### Steps

1. Open Telegram and search for **@BotFather** (blue checkmark).
2. Send `/newbot`.
3. It asks for a display name — anything, e.g. `My Agentda`.
4. It asks for a username — must end in `bot`, e.g. `quang_agentda_bot`. If it's taken, try
   another.
5. It replies with a line like:
   `Use this token to access the HTTP API: 8123456789:AAH...` — that long string is the token.
6. Add the first one to `.env.local`:

   ```
   TELEGRAM_BOT_TOKEN=8123456789:AAH-your-actual-token-here
   ```

7. For a second bot, repeat `/newbot`, then paste that token into the desktop app:
   pick the bot → **Settings** → **Telegram identity** → **Add token**. You don't need to
   pair again; pairing is per Telegram account, not per bot.

### Then tell me, and I'll

Start the daemon, which prints a **pairing code**. You DM that code to your bot once — that
enrolls your Telegram account as the owner. After that the bot answers only you, and only
your taps count as approvals (bot usernames are public, so this matters).

I'll then verify: your message gets a real answer, a gated action produces a card with
buttons, tapping Approve runs it, tapping Deny stops it, typing "approve but change X"
comes back as a revised card, the live checklist edits itself in place as tools run, and
the audit log records who decided.

### Good to know

- The token is a password for the bot. If it ever leaks, `/revoke` in BotFather kills it.
- You can delete the whole bot later with `/deletebot`.
- This costs nothing and needs no phone number beyond your existing Telegram account.

---

## 2. Mailbox credentials

**What this unlocks:** the inbox bot doing real work — reading mail, drafting replies,
sending only after you approve. This is also the most security-relevant path in the product,
since email is attacker-controlled text, so I'd like it exercised for real.

### Please use a throwaway or secondary mailbox

I'd genuinely rather you didn't point this at your primary personal inbox yet. A test
account gives us the same signal with none of the risk. Your call.

### Steps (Gmail)

1. Your Google account needs 2-Step Verification on (Google requires it before app
   passwords exist).
2. Go to **myaccount.google.com → Security → App passwords**.
3. Create one named `Agentda`. Google shows a 16-character password — copy it. It is *not*
   your Google password, and you can revoke it independently.
4. Make sure IMAP is on: Gmail → Settings → **Forwarding and POP/IMAP** → Enable IMAP.
5. Add to `.env.local`:

   ```
   AGENTDA_IMAP_HOST=imap.gmail.com
   AGENTDA_IMAP_PORT=993
   AGENTDA_IMAP_USER=youraddress@gmail.com
   AGENTDA_IMAP_PASS=your-16-char-app-password
   AGENTDA_SMTP_HOST=smtp.gmail.com
   AGENTDA_SMTP_PORT=587
   ```

### Steps (iCloud)

1. **appleid.apple.com → Sign-In and Security → App-Specific Passwords**, generate one.
2. Add to `.env.local`:

   ```
   AGENTDA_IMAP_HOST=imap.mail.me.com
   AGENTDA_IMAP_PORT=993
   AGENTDA_IMAP_USER=youraddress@icloud.com
   AGENTDA_IMAP_PASS=your-app-specific-password
   AGENTDA_SMTP_HOST=smtp.mail.me.com
   AGENTDA_SMTP_PORT=587
   ```

### Steps (anything else)

I need host, port, username, password for IMAP, and the same for SMTP if you want sending
tested. Most providers document these under "IMAP settings." Nearly all of them want an
app-specific password rather than your login password.

### Then tell me, and I'll

Verify the inbox bot can list and read recent mail, and confirm that a send attempt stops at
an approval card showing the exact recipient, subject, and body before anything leaves.

**I will not send any email without asking you first**, including during testing. If you
want the send path verified end to end, tell me an address to send a test message to —
otherwise I'll verify that sending is correctly *blocked* and leave it there.

---

## 3. A Slack app — only if you actually use Slack

**What this unlocks:** the same bots, same approval cards, same rules, in Slack. The bridge
is written and the shared rules (who may talk, who may approve, what a typed "yes" means)
are tested, but the Slack-specific wiring has never met a real workspace.

Skip this without a second thought if Slack isn't somewhere you live.

### Steps

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app
   manifest** → pick your workspace → paste
   [`examples/slack/app-manifest.yaml`](examples/slack/app-manifest.yaml). It's checked into
   the repo so you don't have to click through twenty scope checkboxes.
2. **Basic Information → App-Level Tokens** → generate one with the `connections:write`
   scope. That's the `xapp-…`.
3. **Install App** → install to the workspace. That's the `xoxb-…`.
4. Add both to `.env.local`:

   ```
   SLACK_BOT_TOKEN=xoxb-…
   SLACK_APP_TOKEN=xapp-…
   ```

If your workspace requires admin approval to install apps and you're not an admin, this one
is genuinely blocked and not worth chasing — say so and I'll leave it marked unverified.

### Then tell me, and I'll

Verify a DM gets an answer, a gated action posts a Block Kit card with the payload, Approve
and Deny both work, a press from a non-owner is refused and leaves the approval open, and
the checklist updates in place.

---

## 4. A Discord bot token — only if you use Discord

**What this unlocks:** the same, in Discord. Same status: shared rules tested, gateway
wiring unrun.

### Steps

1. [discord.com/developers/applications](https://discord.com/developers/applications) →
   **New Application** → **Bot** → **Reset Token**, copy it.
2. **Bot → Privileged Gateway Intents** → turn on **Message Content Intent**.
3. Make a private server for yourself, then **OAuth2 → URL Generator** → scope `bot`,
   permissions *Send Messages*, *Read Message History*, *Embed Links* → open the URL and add
   it. (A Discord bot can't DM a stranger, so it has to share a server with you or be
   installed as a user app — there's no way around that step.)
4. Add to `.env.local`:

   ```
   DISCORD_BOT_TOKEN=…
   ```

Full walkthrough in [docs/discord.md](docs/discord.md).

---

## 5. Voice: two binaries and a model file

**What this unlocks:** answering an approval card by voice — "yes", or "approve but cc
Anna" — from your phone. The pipeline is built and tested with the network stubbed, but the
transcriber has never been run on real audio, because neither tool is installed here.

This one isn't a credential; it's software on your machine, which is why I'm asking rather
than doing it. **Say the word and I'll run it for you** — or run it yourself:

```bash
brew install ffmpeg whisper-cpp
mkdir -p ~/.agentda/models
curl -L -o ~/.agentda/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Then add to `.env.local`:

```
AGENTDA_WHISPER_MODEL=/Users/you/.agentda/models/ggml-base.en.bin
```

That's about 150 MB of model and a couple hundred MB of ffmpeg. Everything stays on your
machine — that's the whole reason local is the default
([ADR 0004](docs/adr/0004-voice-transcription.md)).

**If you'd rather not install anything**, set `AGENTDA_VOICE=openai` and use item 7's key
instead. It's metered and your recordings go to a vendor, which is exactly why it isn't the
default, but it's two lines and it works.

---

## 6. Google OAuth, for the mail and calendar packs

**What this unlocks:** the Gmail, Sheets, and Calendar tool packs — a bot that reads your
mail through a maintained MCP server and asks before sending.

Those three packs are **not in the repo**, on purpose. The rule I set is that a pack lands
only after it's been run, and I can't run these without credentials. Writing three unvetted
pack files would be exactly the thing the rule exists to prevent. Three packs that *are*
vetted ship today — see [docs/packs.md](docs/packs.md).

### Steps

1. [console.cloud.google.com](https://console.cloud.google.com) → new project (or reuse one).
2. **APIs & Services → Library** → enable Gmail API, Google Calendar API, Google Sheets API
   (only the ones you want).
3. **OAuth consent screen** → External → add yourself as a test user. You do not need to
   publish or get verified for personal use.
4. **Credentials → Create credentials → OAuth client ID → Desktop app** → download the JSON.
5. Save it somewhere outside the repo, e.g. `~/.agentda/google-oauth.json`, and add to
   `.env.local`:

   ```
   GOOGLE_OAUTH_CREDENTIALS=/Users/you/.agentda/google-oauth.json
   ```

### Then tell me, and I'll

Pick the maintained MCP servers, run each one, classify every verb it actually exposes
(not what its README claims), complete the one-time OAuth handshake, and ship the packs with
the run that vetted them recorded in the file. Then verify a bot reads real mail and stops
at an approval card before sending anything.

Same promise as item 2: **no mail leaves without you saying so**, testing included.

---

## 7. One API key, if you want

**What this unlocks:** two things.

First, proof that the hosted API providers work. Agentda's agent loop and its approval gate
are verified end to end against a local Ollama model — approved tool calls execute and land
in the audit log, denied ones never touch disk, and an amendment round-trips into a revised
card. The Anthropic, OpenAI, xAI, and Gemini clients are written to each vendor's documented
request shape and unit-tested, but none has been run against a real key.

Second, the one evaluation I couldn't finish. The coordinator pattern — a planner bot
splitting work across specialists — is built and I ran it four times on a local 8B model.
The plumbing worked every time; the *plans* were malformed three times in four, so I parked
it on by default rather than claim a benefit I hadn't seen
([ADR 0006](docs/adr/0006-coordinator-pattern.md)). A single clean run on a real model
settles it either way, and costs pennies.

Any *one* key does both. Add whichever you already have to `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY=sk-...  /  XAI_API_KEY=xai-...  /  GEMINI_API_KEY=...
```

Skip this happily if you'd rather not spend anything: subscription and local providers cover
the product's actual pitch, and the API adapters exist mainly as the policy hedge.

---

## 8. One GitHub scope, so CI can grow two jobs

**What this unlocks:** the two CI jobs that would have caught most of what a sweep found by
hand on 2026-08-21 — `cargo check` on the Tauri shell, which nothing else looks at, and a
browser job running every live suite that needs no credentials (the desktop page in a real
browser, the screencast preview, every shipped tool pack launched and checked).

Your `gh` token has `gist, read:org, repo`. GitHub refuses any push containing a change to
`.github/workflows/`, so the commit carrying those jobs could not go up — I replayed the
branch without it so the rest could land. Nothing is lost: the change is on the local
`backup-with-ci` branch and as a patch in my scratchpad.

```bash
gh auth refresh -s workflow
```

Then tell me and I'll re-apply the two jobs in one commit. Or if you would rather not widen
the token, say so and I will leave CI as it is — everything those jobs run is already
runnable locally with `AGENTDA_LIVE=1 pnpm test:live`.

---

## One thing that isn't a credential

`claude` and `codex` aren't installed on this machine any more, so this round's live runs
went through Ollama and real Chromium instead. Everything provider-specific — the Claude
hook gate, Codex containment, session resume — still carries its verification from
2026-08-13 and I haven't re-run it. If you reinstall either CLI, tell me and I'll re-verify
the whole matrix rather than leaving it on a stale date.

## What I'll never do with any of these

- Print them in chat, commit them, or copy them anywhere outside `.env.local` and the 0600
  token registry.
- Send email, or post anything anywhere, without your explicit go-ahead.
- Touch a mailbox folder other than reading INBOX during verification.

To revoke at any time: BotFather `/revoke` for Telegram, the Slack app's settings page,
Discord's Reset Token, your provider's app password page for the mailbox, Google's
credentials page, the vendor's console for an API key. Then delete `.env.local`.

---

## If you'd rather not do any of these

That's genuinely fine and nothing stalls. The affected paths stay marked ⏳ in
[PLAN.md](PLAN.md) — "built but unverified against the real service", stated plainly rather
than quietly. Phase 4 (full desktop hands, watch-and-learn) doesn't depend on any of them.
