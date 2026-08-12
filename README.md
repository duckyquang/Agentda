# Agentda

AI teammates that do real work in your tools, gated by your approval, running on the AI subscription you already pay for.

## What is Agentda

Agentda runs a roster of AI bot personas on your own machine. Each bot has a job (chief of staff, outbound sales, bug reproduction), its own memory, and access to real tools through MCP: your email, calendar, CRM, repos, spreadsheets. Bots work in the background on schedules or on demand from a chat message, and anything consequential stops at an approval queue until you tap Approve. Sending an email, merging a PR, filing an expense: none of it happens silently.

Two commitments shape the whole design:

1. Human-gated by default. Bots draft, research, and prepare. Side effects wait for you. You loosen the gate per bot and per tool, deliberately, not the other way around.
2. Bring your own model. Agentda does not resell AI. It drives the official agent CLIs you already have installed and logged into. If you pay for Claude Pro/Max or ChatGPT Plus/Pro, that is your model bill. There is no Agentda subscription and no markup.

## Why

GrokBot proved the product shape: persistent AI staff living in your chat apps, doing real work with real tools. But it is locked to xAI's models and xAI's pricing. We wanted the same thing with the provider as a swappable detail, and with the economics of software you run yourself: open source, local-first, and free beyond the AI subscription you were paying for anyway.

The unlock is that both major vendors now ship headless-capable agent CLIs that authenticate with consumer subscriptions. Claude Code runs non-interactive turns with `claude -p`; Codex does the same with `codex exec`. Agentda orchestrates those binaries instead of reimplementing an agent loop against raw APIs. That means no API keys to get started, and the vendors' own tool-use, sandboxing, and session machinery doing the heavy lifting.

Being straight about the subscription path, because we would rather you know this up front:

- Agentda spawns the genuine vendor binaries and lets them authenticate however you configured them. We never read, copy, or transmit your OAuth tokens, and we never call vendor APIs with our own client. To be precise about the footing: headless mode is documented by both vendors, but neither has blessed third-party products orchestrating their CLIs on subscription auth. Anthropic actively enforces server-side against anything that reuses subscription credentials outside the genuine binary; OpenAI has never clarified its position, and heavy automation on consumer ChatGPT accounts has drawn bans. Running the real CLIs locally under your own login is the most defensible version of this pattern, not an officially sanctioned one.
- Bot work draws down the same plan limits as your own usage (both vendors meter in 5-hour rolling windows plus weekly caps). A busy bot is you being busy, as far as your plan is concerned. Agentda will surface limit errors rather than hide them.
- Vendor policy on third-party tools wrapping subscription auth has tightened in stages before and could tighten again. API-key and local-model adapters exist in the plan partly as insurance.

## How it works

None of this is built yet. This is the plan of record; details live in [PLAN.md](PLAN.md) and [PRD.md](PRD.md).

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

Approval queue. Tool calls get intercepted before execution and parked until you decide. On Claude Code the gate is native: `--permission-prompt-tool` points at an MCP tool the daemon hosts, so the CLI itself blocks mid-turn until you answer. Codex's exec mode has no interactive prompter, so there the gate moves into the tools themselves: consequential actions are only reachable through Agentda-hosted MCP tools that hold the call until you approve, with the OS-level sandbox (Seatbelt on macOS, bwrap/seccomp on Linux) containing everything else — and until we have proven that holds in practice, Codex bots simply do not get outbound tools. Decisions arrive as button taps in chat: Telegram inline keyboards, Slack Block Kit, Discord components. Per-bot policies mark genuinely read-only tools as auto-approved so the queue only holds things that matter.

Memory. Two layers. Session transcripts come free from the CLIs (`claude --resume`, `codex exec resume`), giving each bot conversational continuity. On top, each bot keeps durable notes as plain Markdown files in its folder (contacts, preferences, running state of long tasks), injected into context each run and editable like any other file on your disk.

Routines. Cron-style schedules per bot: the morning briefing at 7am, the inbox sweep every hour, the weekly expense roll-up. A routine is just a scheduled prompt to a persona, so everything above (tools, memory, approvals) applies unchanged. Routines fire only while the machine is awake, and they respect quiet hours and token budgets.

## Providers

| Provider | Auth | Marginal cost | Status |
|---|---|---|---|
| Claude Code (Pro/Max subscription) | your own `claude` login on your machine | none beyond your Claude plan | first target, in design |
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
| Telegram | long polling, inline-keyboard approvals, owner pairing; voice notes arrive in Phase 2 | first bridge, planned |
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

Pre-alpha. There is no runnable code yet; the repo currently holds design documents. Read [PRD.md](PRD.md) for what we are building and why, and [PLAN.md](PLAN.md) for the phased build order. Roughly: Phase 0 proves the Claude Code adapter headless; Phase 1 adds the daemon, the Telegram bridge, real starter tools, and the approval queue; Phase 2 adds the Codex adapter, API-key providers, and the desktop app; later phases add more bridges, multi-bot threads, browser hands, and mobile.

## Quickstart

Nothing to run yet. For honesty's sake, here is what Phase 1 is designed to feel like, so you can judge whether the shape is right:

```bash
# ILLUSTRATIVE ONLY: none of this exists yet
git clone https://github.com/duckyquang/Agentda
cd Agentda && npm install

# prerequisites you bring:
#   - claude CLI installed and logged in (run `claude` once, use /login)
#   - a Telegram bot token from @BotFather

npx agentda init      # writes agentda.toml, asks for the Telegram token
npx agentda up        # starts the daemon, begins polling Telegram
```

Then you pair your Telegram account with a one-time code, message your bot, and approval requests show up as Approve/Deny buttons. Remember the machine has to stay awake for schedules to fire. If that flow does not sound right to you, now is the cheapest possible time to open an issue.

(Stack note: Node/TypeScript is the likely choice, since grammY and both vendors' SDKs are TypeScript-first, but PLAN.md is the source of truth.)

## Contributing

The most useful contributions right now are design review, not code: read the PRD and the plan, and open an issue where you disagree. Once Phase 1 lands, the surfaces meant for outside contribution are provider adapters and chat bridges, both deliberately narrow interfaces.

Ground rules already in effect:

- No synthetic demo data presented as real. If a number in a doc or PR was not measured, it is labeled as an estimate.
- Anything touching vendor auth follows the compliant path described above. PRs that read credential files or call vendor APIs with subscription tokens will be rejected regardless of how well they work.

## License

MIT. See [LICENSE](LICENSE).
