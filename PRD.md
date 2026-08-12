# Agentda — Product Requirements Document

Status: draft v1 · Last updated 2026-08-12 · Owner: Quang Bui

## 1. Overview and background

GrokBot is xAI's consumer agent product: you spin up named bots, each with its own persona, tools, and schedule, and talk to them in a chat app. A bot can check your email in the morning, watch a topic, run an errand online, and ping you when it needs a decision. It works, and the interaction model is right. The problem is that it only runs on Grok, and you pay xAI for it.

Meanwhile most of the people who want this already pay $20–200/month for Claude Pro/Max or ChatGPT Plus/Pro, and those subscriptions now ship official agent harnesses: Claude Code and Codex CLI. Both run headless, both speak structured JSON over stdio, both support MCP tools, and both authenticate with the subscription the user already has. Nobody has wrapped them in a GrokBot-style product.

Agentda is that product: an open-source, local-first personal agent app. You create bots with personas, tools, memories, and schedules, and talk to them from a desktop app or from Telegram. Under the hood each bot turn is a headless run of the genuine Claude Code or Codex CLI binary on the user's own machine, under the user's own login. There is no Agentda backend, no Agentda API key, and no pricing page. The user's cost is the AI subscription they already pay for, or API-key usage if they prefer that.

Two gaps we are closing:

1. Provider lock-in. GrokBot works only with Grok. Agentda treats the model provider as a pluggable layer: Claude Code, Codex CLI, direct API keys, local models.
2. API-key friction. Every "build your own agent" framework starts with "get an API key and set up billing." Most consumers won't. Subscription auth through the official CLIs removes that step entirely: if `claude` or `codex` is logged in, Agentda works.

The compliance line we hold throughout this document: we drive the official binaries and only the official binaries. We never read, extract, or replay OAuth credentials, and we never call provider backends with our own client under subscription auth. Anthropic enforces that boundary server-side (enforcement tightened in stages through early 2026) and it is the pattern that got OpenCode-style tools killed. Details in Risks (section 10).

## 2. Goals

- G1: A non-developer who already has Claude Code or Codex CLI installed and logged in can create a working bot in under 10 minutes, with zero API keys and zero new accounts (target, unmeasured).
- G2: Bots can act in the real world (email, calendar, files, web) through MCP tools, with every consequential action gated behind human approval by default.
- G3: The whole system runs on the user's machine. Credentials, memory, transcripts, and the audit log never leave it except through channels the user explicitly configures (e.g. the Telegram bridge).
- G4: Scheduled routines run reliably from a long-lived local daemon and report results into the bot's chat thread.
- G5: Provider-portable: the same bot definition runs on Claude Code, Codex, an API key, or a local model, with a per-bot failover order. Portability is of the definition, not of in-flight sessions: switching providers rebuilds context from memory files rather than resuming the old provider's transcript (see FR-6).
- G6: Open source, self-hosted, no Agentda-operated services required for core function.

## 3. Non-goals

- NG1: No hosted/cloud version of Agentda in v1. No multi-tenant server, no accounts.
- NG2: No native iOS/Android app in v1. Mobile access goes through the Telegram bridge.
- NG3: No "log in to Agentda with your Claude/ChatGPT subscription" feature. We never handle provider OAuth ourselves; the user logs into the official CLIs directly. This is a hard compliance boundary, not a deferral.
- NG4: No reverse-engineered messaging clients in the supported product (no Baileys/whatsmeow WhatsApp, no iMessage chat.db bridge). See Risks.
- NG5: No autonomous mode without approval gates. "Full yolo" is not a setting we ship in v1.
- NG6: No fine-tuning, no model hosting, no RAG infrastructure beyond flat-file bot memory in v1.
- NG7: No team/multi-user features in v1. One machine, one human.

## 4. Target users

- Subscription power users: pay for Claude Max or ChatGPT Pro, live in chat apps, want their subscription to do background work for them without learning a framework. Primary persona.
- Developers/tinkerers: comfortable with CLIs and MCP, want a durable home for the agents they currently run as ad-hoc scripts and cron jobs. They contribute bots, MCP recipes, and bridge code back.
- Privacy-sensitive users: want agent capabilities but refuse cloud agent products on principle; local-first design and the no-exfiltration guarantees are the draw. Some will run local models only.

## 5. User stories

- U1: As a Claude Max subscriber, I create a "Morning Brief" bot that at 7:30 reads my inbox (and calendar, once the calendar recipe lands) via MCP and posts a summary to my Telegram, so I read one message instead of thirty.
- U2: As a user, when my email bot wants to send a reply it drafted, I get the draft in chat with Approve/Deny buttons, and nothing is sent until I tap Approve or type "yes, but drop the last paragraph."
- U3: As a user, I tell my research bot "watch for new papers on X weekly"; it becomes a scheduled routine I can see, edit, and delete.
- U4: As a user whose Claude 5-hour window is exhausted, my bot tells me it hit the plan limit and either waits for reset or falls over to my configured API key, per my failover settings, never silently.
- U5: As a tinkerer, I define a bot as a directory (prompt, tools, schedule, memory) and share it on GitHub; someone else drops it into their Agentda and it runs on their provider.
- U6: As a user, I put a planner bot and a coder bot in one thread and watch them hand a task between themselves, with every outbound action still routed to me for approval.
- U7: As a privacy-focused user, I audit exactly what my bots did last week: every tool call, its input, its result, and who approved it, from a local append-only log.
- U8: As a user on my phone, I answer an approval prompt by voice note ("yeah go ahead but cc Anna"); the bot shows me the amended action as a revised approval card, and one more tap sends it.

## 6. Functional requirements

Priorities, mapped explicitly to [PLAN.md](PLAN.md) so "must ship" means something: **v1 = everything through Phase 2 of the plan; the MVP is the Phase 1 subset.** P0 = must ship in v1 (by end of Phase 2), P1 = should ship by Phase 3 (may land earlier when cheap), P2 = later, P3 = exploratory.

### 6.1 Provider layer

- FR-1 (P0): Claude Code adapter. Each bot turn spawns the genuine `claude` binary in headless mode: `claude -p` with `--input-format stream-json --output-format stream-json`, parsing the NDJSON event stream (system/init, assistant messages, result) to drive the UI live. Auth is whatever the user's Claude Code already has, resolved by the CLI's own credential chain; for subscription users that is their `/login` credential. Agentda never reads the keychain or `~/.claude/.credentials.json`, never sets or handles OAuth tokens, and never calls api.anthropic.com itself. Note: `--bare` mode does not read subscription credentials, so the adapter must not use `--bare` when the user is on subscription auth; we get equivalent isolation with explicit `--settings`, `--strict-mcp-config`, and `--system-prompt` instead.
- FR-2 (P0): Codex adapter. Each bot turn runs `codex exec --json` (or the official Codex SDK / `codex mcp-server`, which wrap the same binary), reusing the saved `codex login` session. Config is passed per-invocation with `--ignore-user-config` plus `-c key=value` overrides so we never mutate the user's `~/.codex/config.toml`. Default run posture: `--sandbox workspace-write`, network off inside the sandbox, `approval_policy = "never"` at the CLI level because approvals are enforced by Agentda's own gate (FR-20), not by the CLI prompter that doesn't exist in exec mode. Known upstream constraint: `codex exec` has been reported to auto-cancel MCP tool calls that await approval in non-interactive runs (openai/codex#24135), so the adapter's first task is verifying that Agentda-hosted blocking MCP tools survive a real exec run, with the `codex mcp-server` / SDK embedding as the primary alternative if they don't. Until mid-turn gating is proven on Codex, Codex bots are not granted outbound tools (FR-20). We detect auth state with `codex login status` and never open, parse, or copy `auth.json`.
- FR-3 (P0): Session continuity. A bot thread maps to a provider session: Claude via `--session-id`/`--resume` (session IDs captured from the JSON result), Codex via `codex exec resume <SESSION_ID>`. Restarting the daemon must not lose thread context.
- FR-4 (P0 for Anthropic/OpenAI, P1 for xAI/Gemini): API-key adapters. Direct Anthropic and OpenAI API adapters are required in v1 because failover (FR-6) needs somewhere to fail over to; xAI and Gemini adapters follow (and may land alongside, since one OpenAI-compatible client covers most of them). Also: API-key passthrough into the same CLIs (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`) for users who want CLI behavior on API billing. API keys are stored in the OS keychain, referenced by name in bot config, never written to bot files.
- FR-5 (P2): Local model adapter. Any OpenAI-compatible endpoint (Ollama, llama.cpp server, LM Studio). Reduced capability is acceptable and surfaced (tool-calling quality varies by model).
- FR-6 (P0): Failover. Each bot has an ordered provider list. On auth failure or plan-limit exhaustion the run fails over to the next entry. Failover semantics are honest about what transfers: provider sessions are not portable, so the fallback provider starts a fresh session seeded from the bot's memory files plus a restatement of the in-flight task, and the thread message says context was rebuilt, not resumed ("Claude limit hit — continuing on Codex with rebuilt context"). Failover from a subscription provider to a paid API key requires a one-time explicit opt-in because it changes what the user is billed.
- FR-7 (P0): Auth/limit status surface. A status panel shows, per provider: logged in or not, auth method in use, and any expiry warnings the CLIs themselves report (exact warning behavior is version-dependent; we surface whatever the CLI emits rather than hardcoding assumptions about it). Plan-limit errors from the CLIs are shown to the user verbatim, with the reset time when the provider supplies one. We display usage figures from the CLIs' own metadata (e.g. Claude's `total_cost_usd` and token counts) labeled as estimates, because that is what they are.
- FR-8 (P0): Stale-key trap detection. If `ANTHROPIC_API_KEY` is set in the daemon's environment while the user believes they are on subscription auth, warn: the key silently outranks subscription login in Claude Code's precedence chain and bills the API org.

### 6.2 Bots and personas

- FR-9 (P0): A bot is: name, avatar, system prompt, provider preference list, tool allowlist, memory store, schedule list, and approval policy. All of it lives as plain files in one directory per bot, editable by hand, importable/exportable by copying the directory.
- FR-10 (P0): The system prompt is injected per run (`--system-prompt` on Claude; prompt assembly on Codex), so a bot behaves identically across restarts and providers to the extent the underlying models allow.
- FR-11 (P0): Tool availability and tool approval are separate mechanisms, and conflating them is a gate bypass. Availability comes only from the MCP config: Claude via `--mcp-config` + `--strict-mcp-config`, Codex via per-invocation `mcp_servers` config with `--ignore-user-config`, so the run sees exactly the servers the bot is granted and nothing from the user's global config. On Claude, `--allowedTools` lists only the auto-approved read-only class from FR-19; gated tools are deliberately absent from `--allowedTools` so they route to `--permission-prompt-tool` and block. (Tools named in `--allowedTools` are pre-approved by Claude Code and never reach the permission prompt — putting a send tool there would silently un-gate it.) The adapter test suite must assert that a gated tool omitted from allowedTools actually blocks. A bot with no email tool cannot call email no matter what its prompt says.
- FR-12 (P1): Bot templates. Ship 3–5 starter bots (morning brief, inbox triage, research watcher, file organizer) as example directories, not code.

### 6.3 Chat interfaces

- FR-13 (P0, lands in Phase 2): Desktop app. Bundles the standalone daemon as a sidecar and provides the full chat UI (section 8), bot management, the approval queue, the audit log viewer, and settings. It reaches full feature parity in Phase 2; until then, the CLI and the Telegram bridge are the reference surfaces.
- FR-14 (P0): Telegram bridge. One BotFather token, long polling via grammY, no public URL needed, so it runs from the same laptop as the daemon. Sender authentication is mandatory: at setup the owner pairs by DMing the bot a one-time code, which records their Telegram user ID in an owner allowlist; updates from any other user ID are dropped and logged, and every `callback_query` is honored only if `from.id` is on the allowlist — a BotFather bot is publicly discoverable, and "a human approves" must mean this human. Full parity for chatting and approvals (inline keyboards, section 6.4). Status checklists render per completed turn in v1; live edit-in-place arrives with the Phase 3 bridge rework. Voice notes (incoming OGG/Opus fetched via getFile and transcribed; see Open Questions on the engine) arrive in Phase 2, inside v1. Telegram is the mobile story for v1.
- FR-15 (P2): Slack bridge via Bolt in Socket Mode (no public endpoint; two tokens). Block Kit buttons for approvals; interactive payloads acked within Slack's 3-second window with agent work done async. Positioned for work-context bots. Socket Mode restricts us to internal distribution, which is fine for a self-hosted product.
- FR-16 (P2): Discord bridge. Buttons and interactions are first-class; the constraint is that bots cannot DM arbitrary users, so onboarding is "DM the bot first" or a small private guild, and slow runs must use deferReply within the 3-second interaction window.
- FR-17 (P3): WhatsApp via the official Business Cloud API only — and only if the Phase 3 ADR reverses its default answer of "skip" (see PLAN.md). Viable mechanically for an agent (user-initiated conversations are free inside the 24-hour service window; quick-reply buttons cover approve/deny) but requires business verification, a dedicated number, and public webhook infra, which fights our local-first design. Unofficial WhatsApp libraries are explicitly out (NG4, Risks R2).
- FR-18 (P0): Bridge parity contract. Every bridge must support: plain messages both ways, approval prompts with tappable buttons plus natural-language fallback, rendering of checklist status messages (per-turn in v1, live-edit where the platform allows from Phase 3), and sender authentication — only paired/allowlisted accounts can talk to a bot or answer an approval. A bridge that can't gate approvals, or can't tell who is answering, doesn't ship.

### 6.4 Human-in-the-loop approvals

- FR-19 (P0): Action classification. Read-only actions inside the bot's allowlist (read email, read files in scoped dirs, calendar read) run automatically. Web fetch is read-only for the server but not for the world — an arbitrary GET can exfiltrate data through the URL itself (query strings to an attacker domain), so fetch is auto-approved only against a per-bot domain allowlist; fetches to unlisted domains are gated like outbound actions for any bot that also reads untrusted content (email, web). Anything outbound or mutating (send/reply email, calendar write, file write outside the workspace, purchases, posting anywhere, shell commands beyond the sandbox) is gated. The classification is per-tool-and-verb, defined in the bot's approval policy, defaulting to gated when unknown.
- FR-20 (P0): Approval mechanics, per provider. On Claude the gate is implemented natively: `--permission-prompt-tool` points at an MCP tool Agentda hosts, and/or a PreToolUse hook that returns allow/deny/escalate, so the CLI itself blocks mid-turn until Agentda answers. On Codex there is no interactive prompter in exec mode, so the gate moves into the tools: consequential effects are reachable only through Agentda-hosted MCP tools whose handlers hold the call until the human decides, while the sandbox (workspace-write, network off) contains everything else; third-party MCP servers with outbound verbs are never attached directly to Codex bots (they route through an Agentda proxy that enforces the same queue). This design has a known upstream risk (FR-2, openai/codex#24135) — until blocking MCP tools are proven to survive `codex exec`, or the `codex mcp-server`/SDK embedding provides the equivalent, Codex bots are not granted outbound tools at all, and the provider matrix says so plainly. On API-key adapters the loop is ours, so the gate is trivially in-process. In every case the model cannot race past the gate.
- FR-21 (P0): Approval UX. The pending action renders in the thread with full concrete detail (recipient, subject, body for an email; command line for a shell action), Approve and Deny buttons, and free-text response support: "yes", "no", or an amendment ("approve but change the time to 3pm"). An amendment does not execute sight-unseen: it produces a revised approval card showing the amended payload, and one more tap sends it — fast, since the diff is small, and it preserves the guarantee that the human saw the exact action that ran. Bots may mark narrowly-scoped amendment classes as exempt from the second tap only via an explicit standing rule (FR-23); the default is see-then-send. In Telegram, buttons are an inline keyboard; the callback_query is acked and the message edited to show the outcome so the buttons can't be double-pressed.
- FR-22 (P0): Timeout and default-deny. Unanswered approvals expire (default 30 minutes, configurable) as denied; the bot is told the request timed out and the thread shows it.
- FR-23 (P1): Standing approvals. "Always allow this bot to do X" creates a scoped standing rule, listed in a review UI, revocable in one click, and recorded in the audit log both when created and each time it fires.
- FR-24 (P0): Audit log. Every tool call attempt (allowed, denied, auto-approved, standing-rule-approved) is appended to a local log with timestamp, bot, tool, full input, result summary, decision, and decision source (human tap, human text, standing rule, auto-class). The log is append-only from the app's perspective and viewable/filterable in the desktop app. This ships in Phase 1 with the gate itself, not later — see NFR-3 for why they must be the same code path.

### 6.5 Memory and context

- FR-25 (P0): Per-bot durable memory as plain Markdown files in the bot directory, injected into context each run. The user can open and edit them like any file.
- FR-26 (P0): Memory writes happen through an Agentda-provided memory tool, so they appear in the audit log. Memory writes are auto-approved by default, with one exception: when the current run ingested untrusted content (per the bot's tool classes — email, web), the memory write posts its diff to the thread as a visible card. Memory is how an injection persists past the session that carried it (see R3); a poisoned durable note shapes every future run, so writes from tainted runs stay auto-approved but never invisible, and the user can flip them to fully gated per bot.
- FR-27 (P0): Context assembly per run: system prompt + persona memory + provider session history (via resume). Cross-thread carryover happens only through the memory files, never through hidden state.
- FR-28 (P1): Memory size management. When memory files exceed a size threshold, the bot is prompted (as a normal, visible run) to compact them; the user sees the diff. No silent summarization.
- FR-29 (P2): Shared memory spaces that multiple bots can be granted read or read/write access to, for collaboration scenarios.

### 6.6 Scheduled routines

- FR-30 (P0): Cron-style schedules per bot, created either in the UI or conversationally ("every weekday at 7:30"), always materialized as an editable schedule entry the user can see, pause, or delete. Conversational creation confirms the parsed schedule before saving.
- FR-31 (P0): The daemon triggers scheduled runs headlessly and posts the transcript summary and any results to the bot's thread (and bridge, if connected), exactly as if the user had asked.
- FR-32 (P0): Scheduled runs obey the same approval gates. A routine that hits a gated action posts the approval request and waits (subject to FR-22 timeout); it does not get elevated permissions for being scheduled.
- FR-33 (P0): Budget- and quiet-hours-aware. Scheduled runs are skipped, with a logged and visible reason, when a token budget guard (NFR-5) or user-configured quiet hours say no.
- FR-34 (P1): Missed-run policy per routine. v1 ships the safe default: a run ledger giving at-most-once firing, and skip-to-next-occurrence on wake after sleep. The per-routine "run once late" catch-up option is the P1 refinement. Never replay a backlog of missed occurrences.

### 6.7 Multi-bot collaboration threads

- FR-35 (P1): A thread can contain multiple bots. Turn-taking is explicit: the user @-mentions a bot, or a bot ends its turn by handing off to a named other bot. No free-for-all; exactly one bot runs at a time per thread.
- FR-36 (P1): Each bot in a shared thread keeps its own provider, tools, allowlist, and memory. A handoff passes the thread transcript, not the other bot's credentials or tools.
- FR-37 (P1): Handoffs and inter-bot messages are recorded in the audit log; approval requests always route to the human, never to another bot.
- FR-38 (P2): A coordinator pattern: a planner bot that decomposes a task and dispatches to specialist bots, bounded by a per-task handoff limit to prevent loops.

### 6.8 Tool integrations

- FR-39 (P0): MCP-first. Any stdio or HTTP MCP server can be attached to a bot; generic attachment lands in Phase 1. Agentda composes the per-run MCP config (Claude: `--mcp-config` + `--strict-mcp-config`; Codex: `mcp_servers` via `-c` overrides) so the run's tool surface is exactly the bot's grant. On Codex, servers exposing outbound verbs (send, post, write-to-external) are not attached directly; they go through the Agentda approval proxy (FR-20). MCP server startup errors reported in the provider's init event are surfaced in the thread rather than failing silently.
- FR-40 (P0 for the starter pair, P1 for the rest): Starter integrations as MCP recipes (documented configs for existing open-source servers, not our own forks where possible). The Phase 1 starter pair is filesystem (scoped to chosen directories) and email (IMAP read; SMTP send present but gated by default) — enough to make the MVP do real work and to exercise the gate on something that matters. Calendar and web fetch/search recipes, and the curated packs (Gmail, Sheets, Calendar via OAuth), follow in Phase 3. Where a decent server doesn't exist we write a minimal one.
- FR-41 (P1): MCP auth handling. Remote servers using header/bearer auth are supported via config; servers requiring interactive OAuth must be pre-authenticated by the user in the CLI's own flow, and Agentda detects and explains that state rather than half-working.
- FR-42 (P2): Browser automation via a Playwright-style MCP server, off by default, always gated per-action for anything that submits, purchases, or posts. This is the highest-risk tool class we ship and it lands only after the approval and audit layers have soaked.

### 6.9 Watch-and-learn (later phase)

- FR-43 (P3): Demonstration capture: the user performs a task in the browser, captured with Playwright codegen and tracing (the same machinery as PLAN.md Phase 4; possibly screen recording much later), and Agentda drafts a routine from the recording. The output is always a human-readable draft routine the user reviews and edits before it can run; capture never produces an agent that acts unreviewed. Out of scope for v1; listed so the architecture (routines as editable files) doesn't preclude it.

## 7. Non-functional requirements

- NFR-1 (P0): Credentials never leave the machine, and Agentda never possesses provider credentials at all when on subscription auth: the official CLIs hold them, Agentda only spawns the CLIs. API keys the user adds are stored in the OS keychain. No Agentda telemetry containing message content, memory, or credentials; any opt-in crash reporting is content-free.
- NFR-2 (P0): No credential exfiltration paths by construction: bots have no tool that can read the keychain, `~/.claude`, or `~/.codex`; the filesystem MCP server refuses those paths regardless of scoping; bridge messages are composed from thread content only.
- NFR-3 (P0): Audit log completeness, honestly scoped. For every action Agentda mediates — every MCP tool call, every approval decision — the gate and the logger are the same code path, so an unlogged action is also an ungated one, and we treat any such bug as a release blocker. Actions inside a provider's own sandbox that never cross Agentda's boundary (Codex sandbox-internal shell and file operations) are logged from the provider's JSON event stream as best-effort telemetry, clearly marked as such — the sandbox, not our log, is the containment there.
- NFR-4 (P0): Daemon reliability: survives sleep/wake and crash-restart with sessions resumable (FR-3); scheduled runs fire at-most-once per occurrence via a run ledger (no double-fire after crash recovery); a stuck provider process is killed after a per-run wall-clock timeout and reported in the thread. Target: no missed scheduled run while the machine is awake, measured by the daemon's own run ledger once we have one (target, unmeasured).
- NFR-5 (P0): Token-budget guards. Both Claude and ChatGPT plans meter usage in 5-hour rolling windows plus weekly caps, shared with the user's own interactive use, and neither vendor publishes exact numbers. So: per-bot and global soft budgets (runs and estimated tokens) per window and per week, configurable; scheduled runs pause at the soft cap; interactive runs warn; on a provider rate-limit error all runs for that provider back off until the reported reset. All local counts are labeled estimates. The default budgets ship conservative, because burning a user's chat quota overnight is the fastest way to lose them.
- NFR-6 (P0): Provider CLI version tolerance: adapters pin a tested CLI version range, detect the installed version at startup, and degrade with a clear message rather than misbehave when flags change (e.g. Claude Code has signaled `--bare` may become the `-p` default, which would break subscription auth if we ever inherited it silently).
- NFR-7 (P1): Everything user-facing is inspectable: bots, memory, schedules, and the audit log are files or SQLite on disk in documented formats.
- NFR-8 (P1): Single-machine performance: the daemon idle footprint is negligible; concurrent bot runs are limited by a configurable cap (default small) since each run is a full CLI process.

## 8. UI specification

Reference: the GrokBot chat UI. It's the right shape and we mirror it deliberately.

- Left sidebar: the bot list. Each row is avatar, bot name, one-line preview of the last message in that bot's thread, and a relative timestamp. Unread and pending-approval states get badges; a bot awaiting approval sorts to the top. Below the list, a "new bot" affordance.
- Main pane: the selected bot's chat thread. It reads like a messaging app, not a console: user messages right-aligned or styled distinctly, bot messages with the bot's avatar.
- Status/checklist messages: when a bot executes a multi-step task, it posts one status message rendered as a checklist, each completed step a ✓ line ("✓ Fetched 34 emails", "✓ Drafted 2 replies", current step shown in progress). On desktop this is fed live by the provider's streaming events. On bridges it renders per completed turn in v1; edit-in-place live updates (Telegram message edits, Slack chat.update, Discord edits) arrive with the Phase 3 bridge rework.
- Approval prompts: rendered inline in the thread as a distinct card: what the bot wants to do, the full concrete payload, Approve and Deny buttons. Answerable by tap or by typing/speaking a natural-language reply; amendments re-render as a revised card per FR-21. After resolution the card collapses to a one-line record of the decision.
- Compose bar: text input, attachment button, and a microphone for voice input; a held mic records, releases sends, and the transcription is shown as the sent message. On Telegram, native voice notes serve the same role.
- Bot settings: reachable from the thread header: persona prompt, provider order, tool grants, standing approvals, schedules, memory files (opens the actual files), and the bot's slice of the audit log.
- Global: a status bar showing provider auth state and estimated usage against the soft budgets (labeled as estimates), and the full audit log viewer.

## 9. Success metrics

All figures are targets, not measurements; nothing here has been benchmarked.

- M1: Time from install (CLIs already logged in) to first bot reply: under 10 minutes for a non-developer.
- M2: First scheduled routine created within the first session for at least half of retained users (measurable only via opt-in, content-free analytics or self-report; may remain a qualitative target).
- M3: Approval round-trip (bot requests → user taps in Telegram → bot proceeds) under 15 seconds of system overhead, excluding human think time.
- M4: Zero incidents of credential exposure or ungated outbound actions in any release; this is a release gate, not a statistic we tolerate a nonzero value of.
- M5: Scheduled-run reliability while the machine is awake: at or above 99% fired-as-scheduled, per the daemon's run ledger.
- M6: Community signal for an open-source project: external contributors, shared bot directories, and MCP recipes contributed within the first months. No download-count vanity targets.

## 10. Risks and mitigations

- R1: Provider ToS around subscription-auth automation. Anthropic blocks subscription OAuth outside the genuine Claude Code binary (server-side enforcement, tightened in stages through early 2026), and its compliance guidance bars consumer OAuth tokens in any other product including the Agent SDK. OpenAI has never blessed third-party apps driving a ChatGPT-signed-in Codex, has declined to clarify when asked directly, and heavy automation on Plus/Pro accounts has drawn risk flags and bans. Mitigation: Agentda runs entirely on the user's machine, under the user's own login, by spawning the official binaries; we never touch tokens, never re-implement API clients, and never offer subscription login as a feature of our product. API-key adapters (FR-4) are the fully sanctioned fallback and the documented path for heavy automation; budget guards (NFR-5) keep usage patterns close to normal interactive use. Residual risk is real and disclosed in the README: either vendor could tighten policy and cut the subscription path off, which is exactly why the provider layer is pluggable.
- R2: WhatsApp unofficial-API bans. Baileys-style linked-device bridges violate Meta's ToS regardless of content and get numbers permanently banned even at low volume. Mitigation: we do not ship or document unofficial WhatsApp support (NG4); WhatsApp arrives only via the official Cloud API (FR-17) or not at all. Telegram covers the mobile-chat need without any of this risk.
- R3: Prompt injection plus tool access — the lethal trifecta. A bot that reads untrusted content (email, web pages), holds tool access, and can send data out is one crafted email away from exfiltrating whatever it can reach. This is the central security risk of the product, and it has more than one exit: the obvious one (an outbound tool call) and two quieter ones — fetch-based exfiltration, where "read-only" web requests smuggle data out in the URL, and memory poisoning, where an injected instruction is written into durable memory and steers every future run long after the poisoned session ends. Mitigations, layered: approval gates on all outbound actions (FR-19/FR-20) so injected instructions dead-end at a human; web fetch auto-approved only against per-bot domain allowlists (FR-19); memory writes from untrusted-content runs always visible as diffs in the thread (FR-26); per-bot tool allowlists enforced at the provider boundary (FR-11), so the email-reader bot simply has no web-post tool; no credential exfiltration paths by construction (NFR-2); approval cards always show the full concrete payload so a poisoned "send this summary to attacker@..." is visible at the moment of decision; and the audit log (FR-24) for after-the-fact forensics. We do not claim prompt injection is solved; we claim an injected bot cannot act consequentially without a human seeing the concrete action first.
- R4: Runaway token consumption against plan limits. A looping bot or an over-eager schedule can drain a shared 5-hour window and the weekly cap, taking the user's own chat access down with it. Mitigations: NFR-5 soft budgets with conservative defaults, per-run wall-clock and turn limits, backoff on rate-limit errors, scheduled runs pause first, and failover to API billing only by explicit opt-in (FR-6).
- R5: CLI churn. Both adapters sit on fast-moving CLIs with changing flags and defaults. Mitigation: NFR-6 version detection and pinned tested ranges; adapter code isolated behind one interface per provider so a breaking change is one module's problem.
- R6: Laptop-grade reliability. A "daemon" on a machine that sleeps is not a server. Mitigation: FR-34 missed-run policies, honest surfacing of skipped runs, and documentation that positions an always-on mini PC as the ideal host without requiring one.
- R7: Approval fatigue. If everything asks, users stop reading and tap Approve reflexively, which quietly defeats R3's main mitigation. Mitigation: auto-approve genuinely read-only actions (FR-19), standing approvals for repetitive safe patterns (FR-23), and payload-forward approval cards that make the one decision that matters fast to read.

## 11. Open questions

- Q1: Voice transcription engine: local Whisper-class model (private, heavier install) vs. routing audio through the provider. Leaning local; decided as an ADR when voice lands in Phase 2.
- Q2: Resolved in PLAN.md: Tauri for the desktop app, with the daemon as a standalone sidecar process the app bundles and talks to over loopback.
- Q3: Claude login expiry (renewal is interactive) will eventually stall an unattended daemon until the user re-runs `/login`. Warning surfaces exist (FR-7); is push-style nagging via the Telegram bridge enough?
- Q4: Codex on Plus/Pro has no sanctioned unattended-automation credential (access tokens are Business/Enterprise only). Do we add first-class `CODEX_ACCESS_TOKEN` support for workspace users in v1, or defer?
- Q5: Multi-machine story: people will want the daemon on a home server and the UI on a laptop. Local network split of UI and daemon is plausible; syncing two full installs is not. How soon does this matter?
- Q6: Memory compaction policy (FR-28): user-triggered only, or bot-proposed on threshold? Where's the line before "the bot edits its own memory" becomes a surprise? Related: is the FR-26 visible-diff treatment for tainted-run memory writes enough, or should those default to fully gated once we've watched real usage?
- Q7: Bundled MCP servers: recipes pointing at existing open-source servers keep us thin but put setup friction on users; bundling binaries fattens the install and makes us a maintainer. Where's the cut?
- Q8: Do multi-bot threads (6.7) justify their complexity in v1, or does a single bot spawning provider-native subagents (both CLIs support them) cover the real use cases first?
