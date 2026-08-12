# Agentda

AI teammates that do real work in your tools, gated by your approval, running on the AI subscription you already pay for.

## What is Agentda

Agentda runs a roster of AI bot personas on your own machine. Each bot has a job (chief of staff, outbound sales, bug reproduction), its own memory, and access to real tools through MCP: your email, calendar, CRM, repos, spreadsheets. Bots work in the background on schedules or on demand from a chat message, collaborate in shared threads by handing work to each other, and anything consequential stops at an approval queue until you tap Approve. Sending an email, merging a PR, filing an expense: none of it happens silently. When a job needs hands on a screen, a bot browses in its own shadow browser by default — you follow along via screenshots or a live preview while you keep using your machine; it never takes your mouse.

Two commitments shape the whole design:

1. Human-gated by default. Bots draft, research, and prepare. Side effects wait for you. You loosen the gate per bot and per tool, deliberately, not the other way around — up to and including flipping a bot you trust into Auto mode, which trades the tap for a complete audit trail, hard budgets, and an always-ask list for the scary stuff.
2. Bring your own model. Agentda does not resell AI. It drives the official agent CLIs you already have installed and logged into. If you pay for Claude Pro/Max or ChatGPT Plus/Pro, that is your model bill. There is no Agentda subscription and no markup.

## Why

GrokBot proved the product shape: persistent AI staff living in your chat apps, doing real work with real tools. But it is locked to xAI's models and xAI's pricing. We wanted the same thing with the provider as a swappable detail, and with the economics of software you run yourself: open source, local-first, and free beyond the AI subscription you were paying for anyway.

The unlock is that both major vendors now ship headless-capable agent CLIs that authenticate with consumer subscriptions. Claude Code runs non-interactive turns with `claude -p`; Codex does the same with `codex exec`. Agentda orchestrates those binaries instead of reimplementing an agent loop against raw APIs. That means no API keys to get started, and the vendors' own tool-use, sandboxing, and session machinery doing the heavy lifting.

The other thing we refuse to inherit from current agent products: screen work that holds your screen hostage. Every mainstream computer-use feature takes over your browser or desktop while it runs. Agentda's bots do their on-screen work in the background by default, and even when you choose to watch them work in a visible window, the bot never injects OS-level input and can't see your other windows. The honest caveat: a window that just opened holds focus, so keystrokes you have in flight can land in it. On-screen mode waits out that moment before acting and never raises its window uninvited.

Being straight about the subscription path, because we would rather you know this up front:

- Agentda spawns the genuine vendor binaries and lets them authenticate however you configured them. We never read, copy, or transmit your OAuth tokens, and we never call vendor APIs with our own client. To be precise about the footing: headless mode is documented by both vendors, but neither has blessed third-party products orchestrating their CLIs on subscription auth. Anthropic actively enforces server-side against anything that reuses subscription credentials outside the genuine binary; OpenAI has never clarified its position, and heavy automation on consumer ChatGPT accounts has drawn bans. Running the real CLIs locally under your own login is the most defensible version of this pattern, not an officially sanctioned one.
- Bot work draws down the same plan limits as your own usage (both vendors meter in 5-hour rolling windows plus weekly caps). A busy bot is you being busy, as far as your plan is concerned. Agentda will surface limit errors rather than hide them.
- Vendor policy on third-party tools wrapping subscription auth has tightened in stages before and could tighten again. API-key and local-model adapters exist in the plan partly as insurance.

## How it works

The daemon, gate, modes, memory, browser hands, multi-bot, routines, and the Telegram bridge are built and working on Claude today. Paragraphs about Codex, Slack, Discord, and the desktop app describe the design, not shipped code — see [PLAN.md](PLAN.md) for what lands when.

```
Telegram / Slack / Discord / desktop app
        │  (chat bridges)
        ▼
┌─────────────────────────────────────┐
│  Agentda daemon (your machine)      │
│                                     │
│  bot personas ── routines (cron)    │
│       │                             │
│  approval queue ◄── tool-call       │
│       │             interception    │
│  provider adapters                  │
└───────┼─────────────────────────────┘
        ▼
  claude -p ─ stream-json      (your Claude login)
  codex exec --json            (your ChatGPT login)
```

Local daemon. One long-running process on your machine. It owns the bots, their schedules, their memory, and the connections to chat. Local-first because the credentials, the transcripts, and the tool access all live on hardware you control. The honest corollary: bots only run while your machine is on and awake. Sleep means skipped or late runs (the missed-run policy decides which); a truly always-on host is a later phase.

Provider adapters. Each adapter drives an official CLI headless and normalizes its event stream into a common shape (assistant text, tool call, approval request, result). For Claude Code that is `claude -p --output-format stream-json --input-format stream-json`, with `--resume` for session continuity and `--mcp-config`/`--strict-mcp-config` so the daemon fully controls each bot's tool surface. For Codex it is `codex exec --json` (or `codex mcp-server` for the embedding path), with per-invocation `-c key=value` overrides so we never mutate your config file. Adding a provider means writing one adapter, not touching the rest of the system.

Chat bridges. Thin translators between a messaging platform and the daemon: inbound messages become bot prompts, bot output becomes replies, approval requests become buttons. Telegram is first because it is the least infrastructure (one BotFather token, long polling, no public URL, first-class inline keyboards). Every bridge authenticates the human too: only paired owner accounts can talk to a bot or tap Approve.

Bot personas. A persona is configuration, not code: a system prompt, a provider and model, an MCP tool list, memory, routines, and approval rules, all living as plain files in one folder per bot. Creating a bot is writing a folder. Sharing a bot is copying that folder.

Approval queue. Tool calls get intercepted before execution and parked until you decide. On Claude Code the gate is a PreToolUse hook the daemon answers over loopback, so the CLI itself blocks mid-turn until you decide ([ADR 0001](docs/adr/0001-approval-gate-mechanism.md)). Codex's exec mode has no interactive prompter, so there the gate moves into the tools themselves: consequential actions are only reachable through Agentda-hosted MCP tools that hold the call until you approve, with the OS-level sandbox (Seatbelt on macOS, bwrap/seccomp on Linux) containing everything else — and until we have proven that holds in practice, Codex bots simply do not get outbound tools. Decisions arrive as button taps in chat: Telegram inline keyboards, Slack Block Kit, Discord components. Per-bot policies mark genuinely read-only tools as auto-approved so the queue only holds things that matter.

Modes. Every bot runs in Ask or Auto. Ask (the default) blocks gated actions on your tap. Auto runs them unattended — but never invisibly: the same audit log, the same tool and domain allowlists, the same budgets, plus a per-bot always-ask list (payments, deletions, bulk sends out of the box) that keeps asking even in Auto. Flipping a bot to Auto shows you exactly what it will now do without you; one global pause drops everything back to Ask.

Browser hands. Bots get a real browser from the MVP onward, on one of two surfaces. Shadow (default): an isolated headless browser — nothing on your screen, no stolen focus; the bot can take screenshots and describe what it sees; posting them as images in the thread, and the desktop live preview, come with Phase 2. On-screen: the same automation in a visible window, for when you want to watch or a site refuses headless. Either way the bot drives the browser over CDP — it never injects OS-level input and can't see your other windows; the caveat is that a visible window can receive your typing while it holds focus, so on-screen mode waits out the launch moment before acting. Full OS-level desktop control comes later (Phase 4) and defaults to an isolated virtual desktop, not your real one.

Multi-bot threads. Several bots can share one thread, from the MVP onward. Addressing is explicit — a bot acts when named or handed work — handoffs are visible in the thread and capped per task so two models can't ping-pong through your quota, and approvals always route to you, never to another bot.

Memory. Two layers. Session transcripts come free from the CLIs (`claude --resume`, `codex exec resume`), giving each bot conversational continuity. On top, each bot keeps durable notes as plain Markdown files in its folder (contacts, preferences, running state of long tasks), injected into context each run and editable like any other file on your disk.

Routines. Cron-style schedules per bot: the morning briefing at 7am, the inbox sweep every hour, the weekly expense roll-up. A routine is just a scheduled prompt to a persona, so everything above (tools, memory, approvals) applies unchanged. Routines fire only while the machine is awake, and they respect quiet hours and token budgets.

## Providers

| Provider | Auth | Marginal cost | Status |
|---|---|---|---|
| Claude Code (Pro/Max subscription) | your own `claude` login on your machine | none beyond your Claude plan | **working** |
| Codex (ChatGPT Plus/Pro subscription) | your own `codex login` | none beyond your ChatGPT plan | planned (Phase 2) |
| Anthropic API (Agent SDK + `ANTHROPIC_API_KEY`) | API key | per-token API billing | planned (Phase 2) |
| OpenAI API (`CODEX_API_KEY`) | API key | per-token API billing | planned (Phase 2) |
| xAI API (Grok) | API key | per-token API billing | planned (Phase 2) |
| Google Gemini API | API key | per-token API billing | planned (Phase 2) |
| Local models (Ollama and friends) | none | your electricity | planned (Phase 3) |

The API-key rows matter for anyone running bots hard enough to hit plan windows, and for Business/Enterprise setups where the sanctioned automation credential is an API key or access token anyway.

## Interfaces

| Interface | Notes | Status |
|---|---|---|
| Telegram | long polling, inline-keyboard approvals, owner pairing; voice notes arrive in Phase 2 | **built** — needs your token for a live run |
| Desktop app | daemon dashboard: bot roster, chat, approval queue, audit log, config | planned (Phase 2) |
| Slack | Socket Mode, so no public URL; workspace-scoped, best for work bots | planned (Phase 3) |
| Discord | good buttons; bots can only DM users who share a server, so onboarding runs through a small private guild | planned (Phase 3) |
| WhatsApp | would be official Cloud API only (no Baileys: linked-number bans are real); business verification and webhook infra fight our local-first design | decision deferred, default skip — see PLAN.md Phase 3 ADR |
| Mobile | native app in Phase 5; until then Telegram is the mobile client, and honestly a good one | Phase 5 |

## Example bot personas

The kind of staff we are building toward, borrowed from what GrokBot demonstrated works:

- Chief of Staff: triages your inbox and calendar, drafts replies, preps a morning briefing, chases loose ends. Approval gates on every outbound email.
- Sales Outbound: researches prospects, drafts personalized sequences, logs to the CRM. You approve each send; it handles the drudgery.
- Talent Scout: monitors job boards and GitHub for candidates matching a brief, assembles profiles, drafts outreach.
- Expense Manager: reads receipts out of email, categorizes, fills the report, flags anomalies. Submission is gated.
- Bug Repro: watches the issue tracker, attempts to reproduce new reports in a sandboxed checkout, posts a minimal repro or asks the reporter for what is missing. Comment posting is gated until you trust it.

Each of these is a persona folder: prompt, tools, routines, gates. The daemon does not care what the job is.

## Project status

Alpha. Phase 0 and Phase 1 are built: the daemon, the approval gate with its audit log, Ask/Auto modes, per-bot memory, browser hands on both surfaces, multi-bot handoffs, scheduled routines, usage guardrails, and a Telegram bridge with owner pairing.

Verified against the real `claude` CLI (`pnpm test:live` — 57 tests, all green): gated actions block and only run on approval, denials stop the action, unanswered approvals time out to deny, Auto mode runs unattended while the always-ask list still blocks, memory survives a restart, a bot browses a real page with zero windows on screen, and two bots complete a task with a visible handoff and stop at the cap.

Two things still need credentials to prove end to end: a live Telegram run (needs a BotFather token) and the email recipe (needs a mailbox). Both are built and unit-tested; neither has been run against the real service — see [USER_REQUEST.md](USER_REQUEST.md) for the two short setup guides. Read [PRD.md](PRD.md) for what we are building and why, and [PLAN.md](PLAN.md) for the phased build order. Roughly: Phase 0 proves the Claude Code adapter headless; Phase 1 is the MVP — daemon, Telegram bridge, real starter tools, Ask/Auto modes, browser hands (shadow surface by default, on-screen optional), multi-bot handoffs, and the approval queue with its audit log; Phase 2 adds the Codex adapter, API-key providers, voice, and the desktop app with the live bot-screen preview; later phases add more bridges, full desktop hands on an isolated virtual desktop, and mobile.

## Quickstart

Full walkthrough in [docs/quickstart.md](docs/quickstart.md). The short version — Node 20+, pnpm, and the `claude` CLI logged in (`claude`, then `/login`):

```bash
git clone https://github.com/duckyquang/Agentda
cd Agentda && pnpm install
pnpm canary                       # one cheap turn: login works, bot turns are isolated

mkdir -p ~/.agentda
cp -r examples/bots ~/.agentda/bots

export TELEGRAM_BOT_TOKEN=...     # from @BotFather
pnpm daemon                       # prints a pairing code — DM it to your bot
```

Until you pair, the bot answers nobody: Telegram usernames are public, and "a human approved" has to mean you.

There's also `pnpm chat`, a bare REPL against your subscription with no bots, tools, or Telegram involved — useful for checking the provider path in isolation. `/new` starts a fresh session, `/quit` exits.

Real transcript (recorded 2026-08-12, `claude` 2.1.206, subscription auth, no API key exported; costs are the CLI's own estimates):

```
agentda chat · claude adapter · new session
you> My favorite color is teal. Just reply OK, one word.
OK
(session 47161a41 · ~$0.03 est)
you> What is 1+1? One short sentence.
1 + 1 equals 2.
(session 47161a41 · ~$0.03 est)

===== process restarted =====
agentda chat · claude adapter · resuming session 47161a41…
you> What did I say my favorite color was? One word.
Teal.
(session 47161a41 · ~$0.00 est)
```

What's next: the Codex adapter on ChatGPT-plan auth, API-key providers, voice, and the desktop app — see [PLAN.md](PLAN.md) Phase 2.

## Contributing

The most useful contributions right now are design review, not code: read the PRD and the plan, and open an issue where you disagree. Once Phase 1 lands, the surfaces meant for outside contribution are provider adapters and chat bridges, both deliberately narrow interfaces.

Ground rules already in effect:

- No synthetic demo data presented as real. If a number in a doc or PR was not measured, it is labeled as an estimate.
- Anything touching vendor auth follows the compliant path described above. PRs that read credential files or call vendor APIs with subscription tokens will be rejected regardless of how well they work.

## License

MIT. See [LICENSE](LICENSE).
