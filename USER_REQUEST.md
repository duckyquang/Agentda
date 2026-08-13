# What I need from you

This file is my standing request list. I rewrite it whenever I need something only you can
provide — credentials, an account, a decision, a device. If it says "nothing right now,"
you're not blocking anything.

**Last updated:** 2026-08-13 · **Status:** 3 items, all credentials — none urgent

| # | What | Why it's blocked on you | Time |
|---|---|---|---|
| 1 | A Telegram bot token | I can't create a bot account on your behalf | ~3 min |
| 2 | Mailbox credentials (IMAP/SMTP) | I have no mailbox to read | ~5 min |
| 3 | One API key, if you want (optional) | Verifies the hosted API providers | ~2 min |

None of these block progress — Phase 1 and most of Phase 2 are built and verified without
them. You can work on the desktop app right now with no credentials at all:
`pnpm daemon` prints a URL, and bots run on your Claude subscription, your ChatGPT plan, or
a local Ollama model.

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

---

## 1. Telegram bot token

**What this unlocks:** the actual product experience — messaging your bots from your phone,
tapping Approve/Deny on real approval cards. The bridge is built and unit-tested, but no
one has ever messaged a real bot.

### Steps

1. Open Telegram and search for **@BotFather** (blue checkmark).
2. Send `/newbot`.
3. It asks for a display name — anything, e.g. `My Agentda`.
4. It asks for a username — must end in `bot`, e.g. `quang_agentda_bot`. If it's taken, try
   another.
5. It replies with a line like:
   `Use this token to access the HTTP API: 8123456789:AAH...` — that long string is the token.
6. Add it to `.env.local`:

   ```
   TELEGRAM_BOT_TOKEN=8123456789:AAH-your-actual-token-here
   ```

### Then tell me, and I'll

Start the daemon, which prints a **pairing code**. You DM that code to your bot once — that
enrolls your Telegram account as the owner. After that the bot answers only you, and only
your taps count as approvals (bot usernames are public, so this matters).

I'll then verify: your message gets a real answer, a gated action produces a card with
buttons, tapping Approve runs it, tapping Deny stops it, and the audit log records who
decided.

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

## 3. One API key (optional)

**What this unlocks:** proof that the hosted API providers work. Agentda's agent loop and
its approval gate are verified end to end against a local Ollama model — approved tool calls
execute and land in the audit log, denied ones never touch disk. The Anthropic, OpenAI, xAI,
and Gemini clients are written to each vendor's documented request shape and unit-tested,
but none has been run against a real key, because there are none on this machine.

Any *one* key proves the shape works; the others follow the same pattern. Add whichever you
already have to `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY=sk-...  /  XAI_API_KEY=xai-...  /  GEMINI_API_KEY=...
```

Then tell me and I'll run one cheap turn through it, confirm tool calls pass the gate, and
update the provider matrix from "unverified" to "verified".

Skip this happily if you'd rather not spend anything: subscription and local providers cover
the product's actual pitch, and the API adapters exist mainly as the policy hedge.

## What I'll never do with these

- Print them in chat, commit them, or copy them anywhere outside `.env.local`.
- Send email, or post anything anywhere, without your explicit go-ahead.
- Touch a mailbox folder other than reading INBOX during verification.

To revoke at any time: BotFather `/revoke` for the Telegram token, your provider's app
password page for the mailbox, the vendor's console for an API key. Then delete `.env.local`.

---

## If you'd rather not do any of these

That's genuinely fine and nothing stalls. The affected paths stay marked ⏳ in
[PLAN.md](PLAN.md) — "built but unverified against the real service", stated plainly rather
than quietly. Phase 3 (Slack, Discord, tool packs) doesn't depend on any of them either.
