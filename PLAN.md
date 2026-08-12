# Agentda Implementation Plan

Agentda is an open-source rebuild of the GrokBot idea for everyone who isn't on xAI: long-running AI bots with names, personalities, persistent memory, and scheduled routines, living in the chat apps you already use, asking permission before they do anything risky. There is no hosted service and no pricing page. Agentda drives the agent CLIs you already pay for (Claude Code on a Claude Pro/Max subscription, Codex on a ChatGPT plan) and falls back to plain API keys or local models. Your cost is the subscription you already have. Everything runs on your own machine — which also means bots run only while that machine is awake; true always-on hosting is Phase 5.

One rule shapes the architecture: we only ever spawn the genuine vendor binaries, under the user's own login, on the user's own hardware. We never read credential files, never replay OAuth tokens against vendor APIs, never offer "log in with your subscription" to anyone else. Anthropic enforces that boundary server-side; OpenAI has never clarified its position, and heavy automation on consumer accounts has drawn bans. Staying conservatively on the right side of both is what makes the subscription-auth story viable at all.

Scope anchors, so the PRD's priorities mean something: **v1 = everything through Phase 2. The MVP is Phase 1.** PRD P0 items all land by end of Phase 2; the phase text below says where.

## Working agreements

- Trunk only. Every feature or change is committed and pushed directly to github.com/duckyquang/Agentda on `main` as it lands. Small commits that leave the repo in a working state; no long-lived feature branches.
- Docs move with code. README, docs, and this plan are updated in the same push as the behavior they describe. A checklist item is not done until its docs are.
- No fabricated numbers. No benchmark, latency, token, or cost figure appears anywhere in this repo unless we actually ran it and state what produced it. Anything unmeasured is labeled a target or an estimate.
- Auth hygiene. No code path reads, copies, or transmits `~/.claude` credentials, keychain items, or `~/.codex/auth.json` contents. Auth setup is always "run the vendor's own login command".

## Tech stack (decided once, revisited only on pain)

- TypeScript/Node for the daemon and bridges: both vendor SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`) and the best bridge libraries are TypeScript-first, so one language covers everything.
- SQLite (better-sqlite3) for operational state — sessions, messages, routines, pending approvals, the audit log: single file, transactional, zero ops on a laptop, trivial to back up. Bot definitions and memory are deliberately NOT in SQLite: they're plain files in the bot's directory so they stay hand-editable and shareable (PRD FR-9/FR-25).
- grammY for Telegram: actively maintained and tracks the current Bot API, unlike telegraf.
- Tauri for desktop: system-webview UI, small binary, and the daemon ships as a sidecar so one install gets both. (This closes PRD Q2.)
- MCP for tools: the one protocol Claude Code and Codex both already speak, so each tool integration is written once.
- Playwright for browser automation: cross-browser, with codegen and tracing built in, which Phase 4's watch-and-learn needs.

Dependency spine, so nobody reorders this casually: the adapter interface (Phase 0) gates everything; the approval flow and audit log (Phase 1) are reused by every later bridge and by the browser tool; the core agent loop (Phase 2) is the hedge that keeps us alive if subscription policy shifts.

## Phase 0: Foundation

**Goal.** Prove the core bet end to end: a TypeScript process can drive Claude Code headlessly on the user's existing Pro/Max login, hold a resumable conversation, and expose it behind a provider-neutral interface.

**Deliverables.**
- pnpm-workspace monorepo: `packages/core` (adapter interface, event types, SQLite helpers), `packages/provider-claude`, `apps/cli`.
- Provider adapter interface: `startTurn(botId, input) -> AsyncIterable<AgentEvent>`, session create/resume, capability flags (streaming, tools, structured output, mid-turn approval gating), and a normalized event set (text delta, tool call, tool result, permission request, turn result with session id).
- Claude Code adapter: spawns the genuine `claude` binary with `-p --output-format stream-json --input-format stream-json --verbose --include-partial-messages`, parses the NDJSON stream into our events, captures `session_id` from the result, resumes with `--resume <id>`.
- `agentda chat`: a readline REPL over the adapter proving the round trip.

**Task checklist.**
- [ ] Scaffold the monorepo (pnpm workspaces, shared tsconfig, vitest).
- [ ] Define the `AgentEvent` union and `ProviderAdapter` interface in core. Keep it exactly as big as the Claude adapter needs; it grows only when the second adapter demands it in Phase 2.
- [ ] Claude adapter: spawn, stream-parse, and an error taxonomy (auth missing or expired, plan limit hit, process killed). The "please run /login" failure surfaces as a clear "run `claude /login` and retry" message.
- [ ] Never pass `--bare`: bare mode skips subscription OAuth entirely and would break the whole point. Document this trap in the adapter.
- [ ] Warn when `ANTHROPIC_API_KEY` is exported while the user expects subscription auth, since the key silently outranks the login and bills their API org instead.
- [ ] Session persistence: provider session ids in SQLite keyed by bot and chat, resumed across process restarts.
- [ ] `agentda chat` multi-turn REPL.
- [ ] Adapter tests against NDJSON fixtures recorded from real runs (labeled as such).
- [ ] README: what Agentda is, the compliance stance, setup (install Claude Code, `claude /login`), and a real demo transcript.

**Exit criteria.** On a machine with only a Pro/Max login and no API key exported, `agentda chat` completes a multi-turn conversation and picks it back up after a process restart via resume.

**Riskiest assumption.** Anthropic keeps tolerating local personal wrappers that spawn the genuine CLI on subscription auth. They have blocked raw token reuse and third-party harnesses in stages; the genuine-binary-on-your-own-machine path is the documented mechanics and the de-facto tolerated one, but it's policy, not contract, and nobody has blessed it for a distributed product. The adapter interface exists precisely so a policy change costs us one adapter swap to API-key auth, not a rewrite.

## Phase 1: MVP — one bot, always reachable while your machine is awake

**Goal.** One persona, reachable from Telegram, with memory, real starter tools, gated approvals, an audit log, and scheduled routines. The smallest thing that is actually GrokBot-shaped.

**Deliverables.**
- `apps/daemon`: a long-running Node process owning SQLite, the provider adapter, the Telegram bridge, and the scheduler, with launchd (macOS) and systemd (Linux) install docs.
- Telegram bridge on grammY using long polling: one BotFather token, no public URL, works from a laptop behind NAT. Owner pairing built in from day one: BotFather bots are publicly discoverable, so the bridge only honors messages — and especially approval button presses — from paired user IDs.
- Approval flow with its audit log: a tool-permission request becomes a Telegram message with Approve/Deny inline keyboard buttons; the press arrives as a `callback_query`, we `answerCallbackQuery`, edit the message to show the outcome, and unblock or cancel the tool call. Implemented for Claude via `--permission-prompt-tool` pointing at an MCP tool the daemon hosts in-process. Deny by default after a configurable timeout. Every decision — allow, deny, auto, timeout — is written to the audit log from the same code path that enforces it; that co-location is the whole guarantee (PRD NFR-3), which is why the log ships in this phase and not later.
- Per-bot persistent memory as Markdown files in the bot's directory, read and rewritten through a small MCP memory tool, injected at session start via `--append-system-prompt-file`, with provider session resume covering short-term continuity.
- Starter MCP recipes so the bot does real work: filesystem (scoped to chosen directories) and email (IMAP read auto-approved; SMTP send present but gated). Generic MCP attachment — any stdio/HTTP server in the bot's config — comes along for free since this is just the per-run `--mcp-config`.
- Routines: cron-scheduled prompts (node-cron) that run a turn and post the result to a chat, managed with `/routine` chat commands, with a run ledger for at-most-once semantics.
- One shipped persona (a directory: config, prompt, memory seed) proving the loop end to end.

**Task checklist.**
- [ ] Daemon skeleton: config file, SQLite schema (bots, chats, sessions, messages, routines, pending_approvals, audit_log), graceful shutdown. Memory is NOT a table — it's files in the bot directory.
- [ ] grammY long-polling bridge mapping Telegram chat to bot session. Telegram allows one `getUpdates` poller per token (a second gets 409), so the daemon takes a lockfile to avoid competing with itself.
- [ ] Owner pairing: a one-time code shown at `agentda init`, DMed to the bot to enroll the owner's Telegram user ID; all updates from unknown IDs dropped and logged; every `callback_query.from.id` checked against the allowlist before an approval counts.
- [ ] Reply per completed turn rather than streaming edits; Telegram's roughly 1 msg/sec per-chat limit makes delta-editing more trouble than it's worth in the MVP. Live edit-in-place checklists arrive with the Phase 3 bridge abstraction.
- [ ] Approval MCP tool plus `--permission-prompt-tool` wiring, inline-keyboard round trip, timeout deny, and the pending_approvals table so a daemon restart doesn't orphan an open request.
- [ ] `--allowedTools` discipline per PRD FR-11: only auto-approved read-only tools listed there; gated tools deliberately absent so they route to the permission prompt. A test asserts a gated tool actually blocks.
- [ ] Audit log writer in the gate's code path, covering decision source (tap, timeout, auto-class, standing rule later), plus a `/audit` chat command for a quick tail until the desktop viewer lands in Phase 2.
- [ ] Memory tool and context injection; when a run ingested untrusted content (email), the memory write's diff is posted to the thread as a visible card (PRD FR-26).
- [ ] Starter recipes: scoped filesystem server config and IMAP/SMTP email recipe, each vetted by actually running it.
- [ ] Routine scheduler with per-routine enable/disable, a run ledger (at-most-once per occurrence, skip-on-wake default), and a run log.
- [ ] Usage guardrails: plan-limit errors relayed to the chat in plain words; per-bot soft budgets per 5-hour window and per week (counts labeled estimates); quiet hours that skip scheduled runs with a logged, visible reason. Every routine draws from the same rolling window and weekly cap as the user's own Claude usage, so these ship now, not later.
- [ ] Persona directory format (bot.toml + prompt.md + memory/*.md) and the first persona.
- [ ] Docs: quickstart from zero to a talking bot, including the honest limitation that the machine must stay awake.

**Exit criteria.** The daemon runs unattended: a Telegram message from the paired owner gets answered while a stranger's message is dropped and logged; the bot reads a real mailbox through the starter email recipe; a gated send blocks until a button press and proceeds or aborts accordingly, and the audit log shows the decision; a cron routine fires on schedule (at most once) and posts its result; memory survives a daemon restart.

**Riskiest assumption.** The blocking approval loop. A request nobody answers must never wedge a session or the daemon; timeouts, deny-by-default, and restart-safe pending approvals are load-bearing. The second risk is quota: an over-eager routine schedule can lock the user out of their own Claude until the window resets, which is why the guardrails ship in this phase and not later.

## Phase 2: Second provider, fallbacks, personas, desktop — end of this phase is v1

**Goal.** Break the single-provider dependency so Agentda works for people on ChatGPT plans or plain API keys, then add multiple personas, voice, and the desktop app.

**Deliverables.**
- Codex adapter: spawns `codex exec --json` (JSONL events, final message on stdout), resumes with `codex exec resume <id>`, passes config as repeated `-c key=value` overrides plus `--skip-git-repo-check` and `--ignore-user-config`, and never mutates the user's `~/.codex/config.toml`. Auth is the user's own `codex login`, detected with `codex login status`. Sandboxing per bot: default `workspace-write` with `approval_policy = "never"` inside a dedicated per-bot working directory. Approval parity is an open engineering question, not a documentation footnote: the design (PRD FR-20) is that consequential effects are reachable only through Agentda-hosted MCP tools whose handlers block until the human answers — but `codex exec` has been reported to auto-cancel MCP calls awaiting approval in non-interactive runs (openai/codex#24135), so the first task of this adapter is testing whether blocking tools survive a real exec run, with `codex mcp-server` / the Codex SDK as the primary alternative embedding if they don't. Until one of those is proven, Codex bots ship without outbound tools, and the provider matrix says so.
- API-key adapters: Anthropic, OpenAI, xAI, and Gemini (Anthropic/OpenAI are the P0 pair failover depends on; xAI and Gemini ride along because one OpenAI-compatible client covers most of the work). These come with no harness, so core grows its own minimal agent loop (tool-call dispatch against the same MCP tool surface, approval gate trivially in-process) used only by these adapters. This is the real cost of Phase 2 and the hedge against any subscription-policy change. Local Ollama models reuse this loop in Phase 3.
- Provider failover per PRD FR-6: ordered provider list per bot; on auth failure or limit exhaustion the next provider starts a fresh session seeded from memory files plus a restated task, surfaced in-thread as rebuilt (not resumed) context; failover onto a paid API key requires a one-time opt-in.
- Voice input: Telegram voice notes fetched via getFile, OGG/Opus transcribed (ADR resolves PRD Q1: local Whisper-class vs provider routing), transcription shown as the sent message. Free-text and amendment approval replies land here too: "yes", "no", or "approve but cc Anna", with amendments re-rendered as a revised card needing one more tap (PRD FR-21).
- Multiple personas: N bots per daemon, each with its own provider binding, memory, routines, and its own Telegram bot token so each persona gets its own name and avatar.
- Tauri desktop app mirroring the GrokBot-style layout (bot list with previews and badges, chat pane, bot settings): chat with live checklist rendering from streaming AgentEvents, persona create/edit, an approvals inbox, the audit log viewer with filtering, routine run history. It talks to the daemon over a loopback-only, token-authenticated HTTP+WebSocket API, and the daemon ships as a Tauri sidecar.

**Task checklist.**
- [ ] Local daemon API (HTTP + WS on loopback, token auth).
- [ ] ADR first, adapter second: `codex exec` vs `codex mcp-server` vs the Codex SDK as the embedding, decided by testing blocking approval MCP tools against the real binary (openai/codex#24135 is the constraint to beat), not by vibes.
- [ ] Codex adapter with event mapping into `AgentEvent`, auth detection, limit errors surfaced the same way as Claude's, and the no-outbound-tools restriction enforced in config until the gate ADR proves otherwise.
- [ ] Core agent loop for API-key adapters. One OpenAI-compatible client covers OpenAI and xAI; Anthropic and Gemini get thin clients of their own.
- [ ] Failover: ordered provider list, fresh-session-with-rebuilt-context semantics, in-thread surfacing, API-key opt-in gate.
- [ ] Voice-note pipeline and the transcription ADR; desktop compose bar gets the mic.
- [ ] Free-text approval parsing and amendment re-render flow.
- [ ] Persona management (daemon CRUD plus desktop UI), per-persona provider, model, and sandbox settings.
- [ ] Multi-token Telegram registry and an onboarding flow for adding a BotFather token per persona (owner pairing carried over per token).
- [ ] Tauri shell, chat UI with live checklist status messages, approvals inbox, audit log viewer, persona editor.
- [ ] Docs: a provider matrix showing exactly what works where (mid-turn approvals, resume, tools, cost model), with no capability claims we haven't exercised.

**Exit criteria.** The same persona definition runs on a Claude subscription, a ChatGPT plan, and an API key by flipping one config field — with the documented caveat that outbound tools on Codex stay off until the gate ADR proves mid-turn blocking. Failover from an exhausted subscription to an API key happens visibly and only after opt-in. Two personas run side by side. A voice-note approval with an amendment round-trips. The desktop app can do everything the chat commands can, and its audit view shows every gated decision.

**Riskiest assumption.** Codex on Plus/Pro. OpenAI documents `codex exec` reusing the saved login and ships an SDK that wraps the same binary, but has never blessed third-party products driving it, Plus/Pro has no sanctioned unattended-automation credential, and heavy automation on consumer accounts has drawn risk-flagging and bans. We keep Codex usage on the user's own machine and login, surface limit errors loudly, and document `CODEX_API_KEY` as the safe valve for heavy schedules.

## Phase 3: More bridges, tool packs, multi-bot

**Goal.** Meet users in Slack and Discord, give bots richer real-world tools through curated MCP packs, and let several bots work one thread together.

**Deliverables.**
- Bridge abstraction shakeout: factor what Telegram, Slack, and Discord share (inbound message, outbound message, approval buttons, sender authentication, message edits) into core; keep platform quirks in each bridge. This is where live edit-in-place checklist rendering lands: Telegram message edits throttled to roughly one per second to respect the rate limit, Slack `chat.update`, Discord message edits — all fed from the same streaming AgentEvents the desktop already renders.
- Slack bridge: Bolt with Socket Mode, which needs no public URL and is fine here because we are not a Marketplace app. Block Kit approve/deny buttons, `ack()` inside Slack's 3-second window, slow agent work async with `chat.update`. Approvals honored only from enrolled Slack user IDs, per the FR-18 parity contract.
- Discord bridge: discord.js over the gateway, buttons with `deferUpdate` then follow-up (same 3-second interaction deadline). A bot can't DM a stranger, so onboarding docs recommend a tiny private guild or a user-installed app; DM-based use needs no privileged Message Content intent. Same sender-auth rule.
- WhatsApp decision point, explicitly a decision and not a build: the official Cloud API means business verification, a dedicated number, and public webhook infra, with user-initiated chats free inside the 24-hour window but bot-initiated pings after it requiring paid pre-approved templates; unofficial Baileys-style bridges risk a permanent number ban. Default answer: skip, revisit only against real demand, recorded in an ADR.
- MCP tool packs: curated, versioned configs pointing at maintained MCP servers for Gmail, Google Sheets, Google Calendar, and similar, extending the Phase 1 starter recipes. Delivered to Claude via `--mcp-config` with `--strict-mcp-config`. On Codex, packs are filtered by verb: read-only servers may attach directly via `-c mcp_servers` overrides, but any server exposing outbound verbs (send, post, external write) attaches only through the Agentda approval proxy that enforces the same queue — a directly-attached send tool on Codex would execute ungated, which is exactly the failure PRD M4 calls a release blocker. Server auth is header- or OAuth-based and completed during pack setup, since headless runs can't do interactive MCP OAuth; claude.ai connectors don't work outside claude.ai login, so packs use open MCP servers only.
- Local model adapter: Ollama and other OpenAI-compatible endpoints through the Phase 2 agent loop, with tool-calling quality caveats surfaced per model.
- Multi-bot shared threads: several personas in one group chat with a simple addressing convention (a bot responds when named or handed work), plus a handoff primitive: a task row in SQLite with owner, status, and thread pointer, transferred by an explicit handoff tool call the receiving bot acknowledges in the thread.

**Task checklist.**
- [ ] Bridge abstraction with sender auth and live-edit checklist rendering in core; Telegram migrated onto it.
- [ ] Slack bridge, approval flow, and onboarding docs with the app manifest checked into the repo.
- [ ] Discord bridge, approval flow, and private-guild onboarding docs.
- [ ] WhatsApp ADR with the cost and ToS table, then park it.
- [ ] Tool pack format (name, servers, required env and auth, permission defaults, outbound-verb classification), the first three packs, and a pack setup wizard in the desktop app. Each pack is vetted by actually running it before it lands.
- [ ] Agentda approval proxy for outbound-verb servers on Codex.
- [ ] Ollama adapter on the shared loop.
- [ ] Handoff tool, task table, group addressing rules, and a hard cap on bot-to-bot turns per task.

**Exit criteria.** One persona is reachable from Telegram, Slack, and Discord with identical approve/deny behavior and identical sender authentication. A bot reads Gmail through a pack and asks approval before sending mail — including on a Codex-backed bot through the proxy. Two bots complete a task with one visible handoff in a shared thread and then stop.

**Riskiest assumption.** Unsupervised bot-to-bot delegation. Two models handing work back and forth can ping-pong and drain the user's plan quota fast. The per-task turn cap and human-visible handoffs are load-bearing, not nice-to-haves.

## Phase 4: Browser hands

**Goal.** Bots that can use web apps with no API the way a person would, and learn routines by watching the user do them once.

**Deliverables.**
- Browser tool: a Playwright-backed MCP server with a persistent browser profile per bot so logins survive between runs, exposing navigate, read, click, type, and screenshot actions, with destructive actions routed through the existing approval flow.
- Watch-and-learn: record a user session with Playwright codegen and tracing into a draft routine; replay follows the recording, lets the model recover when the page has drifted, and stops for approval at any step marked sensitive.

**Task checklist.**
- [ ] ADR: Microsoft's playwright-mcp vs a thin in-house server, judged against our approval hooks and per-bot-profile needs.
- [ ] Per-bot browser profile storage and lifecycle: headed for setup and logins, headless for routine runs.
- [ ] Approval hooks on destructive verbs (submit, purchase, delete, send).
- [ ] Recorder: capture codegen script plus trace, convert to a routine draft with per-step annotations.
- [ ] Replay engine: script-first, model recovery on selector failure, screenshots posted to the chat as it works.
- [ ] Docs stating plainly what this can't do: 2FA, CAPTCHAs, and bot detection will stop it, and the bot's job then is to say so and hand back to the human.

**Exit criteria.** A bot logs into a real web app in a persistent profile and performs a multi-step task with one approval stop. A recorded routine replays a week later and survives cosmetic page changes, with the model bridging the gaps.

**Riskiest assumption.** The open web is hostile to automation. Recorded routines rot, and some sites will never work. Replay is best-effort with a human handback path, and we make no reliability claims we haven't measured.

## Phase 5: Off the laptop

**Goal.** Bots that don't die when the laptop sleeps, a phone-native app, and small-team use.

**Deliverables.**
- Mobile app: a Tauri 2 mobile build of the existing UI if a spike proves it solid, React Native as the fallback; we decide then, not now. It connects to the user's daemon over LAN or a tailnet, or to the cloud option below. Until it ships, Telegram is the mobile client, and honestly it's a good one.
- Optional cloud-hosted bot computers: a container image running the daemon plus the vendor CLIs, provisioned by the user. API keys are the default and recommended cloud credential — the only path either vendor actually sanctions for this. Consumer-subscription auth in the cloud (`claude setup-token`, Codex device-code login where available) is documented for a subscriber's own personal CI/automation, not for hosted always-on bot daemons; if used anyway it sits behind an explicit policy-risk warning, one machine per login, never copying credentials between machines. This is the most policy-fragile thing in this entire plan and the docs say so.
- Team features: shared bots with per-member identity, roles for who may approve and who may edit personas and routines, and approval routing to the right humans. The audit log is not new here — it extends the Phase 1 log with per-member identity on every decision.

**Task checklist.**
- [ ] Mobile spike and ADR: Tauri 2 mobile vs React Native against the existing UI.
- [ ] Remote daemon access, tailnet-style first, since it avoids running public infra.
- [ ] Cloud image (Dockerfile plus docs), API-key-first auth flows, and the consumer-auth policy warning, with the one-login-one-machine rule enforced in docs and checked where the code can.
- [ ] Per-member identity and roles extending the existing audit log schema; approval routing.
- [ ] Team onboarding docs.

**Exit criteria.** A bot runs for a week on a cloud box with zero laptop involvement, on API-key credentials, with its usage visible to its owner. A second team member chats with a shared bot and approves its actions under their own identity, and the audit log attributes every decision.

**Riskiest assumption.** Cloud plus consumer-subscription auth. Hosted automation on consumer credentials is exactly the pattern both vendors have been tightening against. The cloud option is therefore API-key-first by design; if the consumer-auth side paths close entirely, Phase 5 loses nothing structural, and the rest of the plan survives untouched.
