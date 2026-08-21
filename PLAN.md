# Agentda Implementation Plan

Agentda is an open-source rebuild of the GrokBot idea for everyone who isn't on xAI: long-running AI bots with names, personalities, persistent memory, and scheduled routines, living in the chat apps you already use, asking permission before they do anything risky. There is no hosted service and no pricing page. Agentda drives the agent CLIs you already pay for (Claude Code on a Claude Pro/Max subscription, Codex on a ChatGPT plan) and falls back to plain API keys or local models. Your cost is the subscription you already have. Everything runs on your own machine — which also means bots run only while that machine is awake; true always-on hosting is Phase 5.

One rule shapes the architecture: we only ever spawn the genuine vendor binaries, under the user's own login, on the user's own hardware. We never read credential files, never replay OAuth tokens against vendor APIs, never offer "log in with your subscription" to anyone else. Anthropic enforces that boundary server-side; OpenAI has never clarified its position, and heavy automation on consumer accounts has drawn bans. Staying conservatively on the right side of both is what makes the subscription-auth story viable at all.

Scope anchors, so the PRD's priorities mean something: **v1 = everything through Phase 2. The MVP is Phase 1.** PRD P0 items all land by end of Phase 2; the phase text below says where. This revision deliberately pulls multi-bot collaboration and browser hands into the MVP and adds the Ask/Auto mode system — Phase 1 is now the heaviest phase by some distance, and its pressure valve is named inside it so any future scope cut is a pre-agreed decision, not a fight.

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
- Playwright for browser automation, now an MVP dependency: cross-browser, driven over CDP (the bot never injects OS-level input and can't read other apps; the honest caveat — a visible window can receive input while it holds focus — is handled explicitly in Phase 1), Chromium new headless (`channel: "chromium"`, the full binary without a window) for the shadow surface, and codegen/tracing for Phase 4's watch-and-learn.

Dependency spine, so nobody reorders this casually: the adapter interface (Phase 0) gates everything; the approval flow, audit log, and mode system (Phase 1) are what make shipping browser hands and multi-bot in that same phase defensible — they land first within the phase; the core agent loop (Phase 2) is the hedge that keeps us alive if subscription policy shifts.

## Phase 0: Foundation

**Goal.** Prove the core bet end to end: a TypeScript process can drive Claude Code headlessly on the user's existing Pro/Max login, hold a resumable conversation, and expose it behind a provider-neutral interface.

**Deliverables.**
- pnpm-workspace monorepo: `packages/core` (adapter interface, event types, SQLite helpers), `packages/provider-claude`, `apps/cli`.
- Provider adapter interface: `startTurn(input, {resume}) -> AsyncIterable<AgentEvent>` — the bot/chat→session mapping lives in the session store, not the adapter — capability flags (streaming, tools, mid-turn approval gating — a structured-output flag joins if a Phase 2 adapter actually offers it), and a normalized event set kept exactly as big as the Claude adapter needs today (text delta, tool call, result with session id, warning); tool results and permission requests join when Phase 1's gate demands them.
- Claude Code adapter: spawns the genuine `claude` binary with `-p --output-format stream-json --input-format stream-json --verbose --include-partial-messages`, parses the NDJSON stream into our events, captures `session_id` from the result, resumes with `--resume <id>`.
- `agentda chat`: a readline REPL over the adapter proving the round trip.

**Task checklist.**
- [x] Scaffold the monorepo (pnpm workspaces, shared tsconfig, vitest).
- [x] Define the `AgentEvent` union and `ProviderAdapter` interface in core. Keep it exactly as big as the Claude adapter needs; it grows only when the second adapter demands it in Phase 2.
- [x] Claude adapter: spawn, stream-parse, and an error taxonomy (auth missing or expired, plan limit hit, process killed). The "please run /login" failure surfaces as a clear "run `claude /login` and retry" message.
- [x] Never pass `--bare`: bare mode skips subscription OAuth entirely and would break the whole point. Document this trap in the adapter.
- [x] Warn when `ANTHROPIC_API_KEY` is exported while the user expects subscription auth, since the key silently outranks the login and bills their API org instead.
- [x] Fail-closed tool isolation in chat turns until the Phase 1 gate exists: in testing, a bare `claude -p` turn inherited the machine's global permission settings and edited files mid-chat — the exact ungated action this product exists to prevent. Mechanism (verified against claude 2.1.206's init event: zero tools, zero MCP servers, zero hook events): `--tools ""` disables every built-in, `--strict-mcp-config` with no `--mcp-config` cuts MCP off, and `--setting-sources ""` stops inheriting global settings, whose hooks otherwise run arbitrary shell inside each turn. A name-by-name blocklist was rejected — it fails open on every CLI release. Phase 1 reopens tools deliberately via the FR-11 allowlist discipline.
- [x] Session persistence: provider session ids in SQLite keyed by bot and chat, resumed across process restarts.
- [x] `agentda chat` multi-turn REPL.
- [x] Adapter tests against NDJSON fixtures recorded from real runs (labeled as such; machine-identifying paths and local hook/plugin config were sanitized before commit, documented precisely in the test file — conversation and result content is verbatim).
- [x] README: what Agentda is, the compliance stance, setup (install Claude Code, `claude /login`), and a real demo transcript.
- [x] `pnpm canary` provider health check (NFR-6 made practical; not named "doctor" — that collides with pnpm's own built-in command): checks install and version against the tested range, then spends one cheap real turn asserting the isolation posture still holds — zero built-in tools, zero MCP servers, no hook events, straight from the init event and stream, never from model claims. Run it after every claude upgrade; the canary spawns with the exact same `claudeArgs()` the adapter uses, so what it verifies is what ships.
- [x] CI on every push: typecheck + tests via GitHub Actions. The fixture tests parse recorded streams — no claude binary, no auth, no quota — so `main` provably stays green without touching the subscription question.

**Exit criteria.** On a machine with only a Pro/Max login and no API key exported, `agentda chat` completes a multi-turn conversation and picks it back up after a process restart via resume. **Met 2026-08-12** — real run on `claude` 2.1.206, macOS: two turns in one process, restart, third turn recalled turn-one context in the same session; transcript in the README.

**Riskiest assumption.** Anthropic keeps tolerating local personal wrappers that spawn the genuine CLI on subscription auth. They have blocked raw token reuse and third-party harnesses in stages; the genuine-binary-on-your-own-machine path is the documented mechanics and the de-facto tolerated one, but it's policy, not contract, and nobody has blessed it for a distributed product. The adapter interface exists precisely so a policy change costs us one adapter swap to API-key auth, not a rewrite.

## Phase 1: MVP — bots that chat, browse, and collaborate while your machine is awake

**Goal.** Personas reachable from Telegram, with memory, real starter tools, Ask/Auto interaction modes, browser hands that don't take over your screen, gated approvals with an audit log, scheduled routines, and two bots able to hand work to each other. Still the smallest thing that is actually GrokBot-shaped — but this MVP is deliberately heavier than a minimal chat bot, because screen work and multi-bot are the point of the product, not garnish.

**Pressure valve, decided now.** If this phase drags: the on-screen browser surface and multi-bot threads slip to Phase 2. Shadow browsing, the mode system, approvals, and the audit log do not slip — they are the product's spine and its safety story.

**Build order inside this phase, so the spine can't be cut under deadline pressure:** 1) approval gate + audit log + mode engine, each landing with its break-it test — nothing else starts until a gated tool provably blocks, times out to deny, and logs; 2) Telegram bridge + owner pairing; 3) starter tool recipes through the gate; 4) routines + usage guardrails; 5) shadow browser; 6) multi-bot handoffs; 7) on-screen surface. The order is the pressure valve in action: what slips is whatever hasn't started yet, never the spine.

**Deliverables.**
- `apps/daemon`: a long-running Node process owning SQLite, the provider adapter, the Telegram bridge, and the scheduler, with launchd (macOS) and systemd (Linux) install docs.
- Telegram bridge on grammY using long polling: one BotFather token, no public URL, works from a laptop behind NAT. Owner pairing built in from day one: BotFather bots are publicly discoverable, so the bridge only honors messages — and especially approval button presses — from paired user IDs.
- Approval flow with its audit log: a tool-permission request becomes a Telegram message with Approve/Deny inline keyboard buttons; the press arrives as a `callback_query`, we `answerCallbackQuery`, edit the message to show the outcome, and unblock or cancel the tool call. Implemented for Claude via a PreToolUse hook the daemon answers over loopback ([ADR 0001](docs/adr/0001-approval-gate-mechanism.md) — `--permission-prompt-tool` does not exist in the shipping CLI). Deny by default after a configurable timeout. Every decision — allow, deny, auto, timeout — is written to the audit log from the same code path that enforces it; that co-location is the whole guarantee (PRD NFR-3), which is why the log ships in this phase and not later.
- Per-bot persistent memory as Markdown files in the bot's directory, read and rewritten through a small MCP memory tool, injected at session start via `--append-system-prompt-file`, with provider session resume covering short-term continuity.
- Starter MCP recipes so the bot does real work: filesystem (scoped to chosen directories) and email (IMAP read auto-approved; SMTP send present but gated). Generic MCP attachment — any stdio/HTTP server in the bot's config — comes along for free since this is just the per-run `--mcp-config`.
- Interaction modes per PRD FR-44: Ask by default; Auto opt-in behind a confirmation card that names the tool classes going unattended; per-bot always-ask list seeded with payments, deletions, and bulk sends; `/mode` toggle per thread; `/pause` dropping every bot back to Ask at once; mode recorded on every audit entry.
- Browser hands per PRD FR-42/FR-45: a Playwright-backed MCP browser server with persistent per-bot profiles. Shadow surface by default — Chromium new headless (the full binary, no window), invisible, screenshots posted to the thread as it works. On-screen surface as the per-task override: same automation in a visible window, watchable in real time; the bot never injects OS-level input, and the launch-moment focus grab is handled head-on (pause automation, discard anything typed into the window while it holds focus). Destructive verbs (submit, purchase, post, delete) classified per FR-19 and routed through the gate in Ask or the audited path in Auto.
- Multi-bot shared threads per PRD FR-35–37: several personas in one Telegram group chat, explicit addressing (a bot acts when named or handed work), a handoff task row in SQLite the receiving bot acknowledges in-thread, and a hard per-task cap on bot-to-bot turns.
- Routines: cron-scheduled prompts (node-cron) that run a turn and post the result to a chat, managed with `/routine` chat commands, with a run ledger for at-most-once semantics.
- Shipped personas (directories: config, prompt, memory seed) proving the loop end to end — including one browser-holding persona and one two-bot handoff pair.

**Task checklist.**
- [x] Daemon skeleton: config, SQLite schema (sessions, audit_log, pending_approvals, turn_ledger, routine_runs, handoffs, owners), graceful shutdown that denies open approvals rather than stranding a turn. Memory is NOT a table — it's Markdown in the bot directory.
- [x] grammY long-polling bridge mapping Telegram chat to bot session, with a clear message on the 409 a second poller gets. Verified by unit tests over grammY's own update dispatch; a live run needs a BotFather token.
- [x] Owner pairing: a one-time code printed at daemon start, DMed to the bot to enroll the owner's Telegram user ID; unknown IDs dropped and logged; every `callback_query.from.id` checked before an approval counts. Tested, including that a non-owner's tap leaves the approval open.
- [x] Reply per completed turn rather than streaming edits; live edit-in-place checklists arrive with the Phase 3 bridge abstraction.
- [x] PreToolUse hook gate ([ADR 0001](docs/adr/0001-approval-gate-mechanism.md)): loopback hook server + curl shim + `--settings`, timeout deny, and the pending_approvals table, cleared on restart so no turn waits on a dead process. Hook `timeout` and `MCP_TOOL_TIMEOUT` both set above the approval window so the CLI never cancels a pending approval out from under the human. Live tests (`AGENTDA_LIVE=1`) assert deny / allow / timeout-to-deny against the real binary. Inline-keyboard round trip lands with the bridge below.
- [x] Tool availability vs approval kept separate per PRD FR-11: grants go through `--tools` / `--mcp-config` (+ `--strict-mcp-config`), never `--allowedTools`, so every call reaches the hook. The live deny test is the proof — a granted Write tool still blocked.
- [x] Audit log writer in the gate's own code path — `ApprovalQueue.request()` cannot return a decision without writing the row — covering decision source (tap, timeout, auto-class, auto-mode), plus an `/audit` chat command until the desktop viewer lands in Phase 2.
- [x] Memory tool and context injection (memory files are injected via `--append-system-prompt-file`); a run that read outside content and wrote memory posts a visible notice, since memory is how an injection outlives its session (FR-26).
- [x] Starter recipes: scoped filesystem tools (live-tested) and an IMAP/SMTP email server whose credentials come from the daemon's environment. The email server's own protocol path needs a real mailbox to verify end to end — not yet run.
- [x] Routine scheduler with per-routine enable/disable, a run ledger giving at-most-once firing, skip-on-wake instead of replaying a backlog, and errors recorded without a retry storm.
- [x] Usage guardrails: plan-limit errors relayed in plain words with a remediation hint; per-bot soft budgets per 5-hour window, day, and week (labeled estimates); quiet hours that skip scheduled runs with a logged reason while interactive turns still work.
- [x] Mode engine: per-bot mode persisted in bot.toml, always-ask list with shell wholesale-listed by default, `/mode` confirmation naming what goes unattended, `/pause` and `/resume`, mode stamped on every audit entry. Tests assert an always-ask action still blocks in Auto and times out to deny — live-verified against the real CLI.
- [x] Browser server ADR ([0002](docs/adr/0002-browser-surfaces.md)): thin in-house server, because per-bot profiles, the surface switch, and focus discipline are all ours and none are a general server's concern.
- [x] Shadow surface: Chromium new headless (`channel: "chromium"`), launched with `--use-mock-keychain --no-first-run --no-default-browser-check`, per-bot profile directory, screenshots available to the thread. M7 evidence: a live test browses a real page while sampling the process table and asserts **zero windowed Chromium processes** throughout — a permission-free check, because the osascript route needs macOS Accessibility permission that CI cannot grant. Keystroke-injection-into-a-sink-app on a real GUI session remains the stronger harness and is not yet run.
- [x] On-screen surface: headed launch of the same profile behind `browser_surface = "on-screen"`, a settle delay after launch before the bot acts (the launch-moment focus grab), and no uninvited bringToFront. Docs state the real caveat — the bot never injects OS-level input, but a focused window can receive yours. Not yet exercised by an automated test, since asserting on a visible window needs a real GUI session.
- [x] Multi-bot: addressing by name, `@bot: note` handoffs recorded in a task table with a hard per-task cap, every hop visible in the thread. Live-verified with two real bots completing a task and stopping.
- [x] Persona directory format (bot.toml + prompt.md + memory/*.md) and three example bots: chief, scout (browser-capable), inbox (email-capable).
- [x] Docs: [quickstart](docs/quickstart.md) from zero to a talking bot, covering pairing, modes, browser surfaces, launchd/systemd, and the honest limitation that the machine must stay awake.

**Exit criteria.** Status as of 2026-08-12, all live results from real `claude` 2.1.206 runs on macOS under subscription auth (`pnpm test:live`, 57 tests green):

- ✅ a gated send blocks until a decision, and the audit log shows it — live: a granted-but-gated write is asked, blocked, and only runs after approval; denial means the file never appears.
- ✅ an unanswered approval times out to deny without wedging the turn — live.
- ✅ a bot flipped to Auto completes a gated-class action unattended with mode, action, and result logged, while its always-ask list still blocks and times out to deny — live.
- ✅ auto-approved read-only tools run without asking and are still audited — live.
- ✅ memory survives a restart — live: one stack writes memory, a brand-new stack with no session to resume reads the fact back.
- ✅ a bot works a real web page in shadow mode with zero windows on screen (navigate + read), and a gated click is asked, blocked, and times out to deny while navigation auto-approves — live. Form *typing* is implemented but not yet covered by a test.
- ✅ two bots complete a task with one visible handoff and stop at the turn cap — live, two real bots.
- ✅ a cron routine fires at most once per occurrence and skips (never replays) what was missed during sleep — unit-tested against the ledger; a multi-day unattended run has not been done.
- ⏳ **deferred by the owner (2026-08-13), not abandoned:** a Telegram message from the paired owner is answered while a stranger's is dropped and logged. The access-control rules are tested through grammY's own update dispatch (including that a non-owner's approval tap leaves the request open); a live run needs a BotFather token, tracked in [USER_REQUEST.md](USER_REQUEST.md).
- ⏳ **deferred by the owner (2026-08-13), not abandoned:** the bot reads a real mailbox through the starter email recipe. The server is built and its config guard tested; verifying the IMAP path needs mailbox credentials, tracked in [USER_REQUEST.md](USER_REQUEST.md).

Phase 2 started 2026-08-13 without waiting on either: nothing in it depends on Telegram or a mailbox.

**Riskiest assumption.** Four now, which is itself the cost of the heavier MVP. First, the blocking approval loop: a request nobody answers must never wedge a session or the daemon; timeouts, deny-by-default, and restart-safe pending approvals are load-bearing. Second, quota: an over-eager routine schedule can lock the user out of their own Claude until the window resets, which is why the guardrails ship in this phase and not later. Third, the anti-bot web: shadow mode's headless browser will trip detection on some sites — the on-screen override exists for exactly that, and we claim no specific site works until we've run it. Fourth, bot-to-bot ping-pong burning quota: the per-task turn cap is load-bearing from day one, not polish.

## Phase 2: Second provider, fallbacks, voice, desktop — end of this phase is v1

**Goal.** Break the single-provider dependency so Agentda works for people on ChatGPT plans or plain API keys, then add per-persona chat identities, voice, and the desktop app. (Multiple bots per daemon already ship in Phase 1's multi-bot threads; this phase gives each one its own face.)

**Deliverables.**
- Codex adapter: spawns `codex exec --json` (JSONL events, final message on stdout), resumes with `codex exec resume <id>`, passes config as repeated `-c key=value` overrides plus `--skip-git-repo-check` and `--ignore-user-config`, and never mutates the user's `~/.codex/config.toml`. Auth is the user's own `codex login`, detected with `codex login status`. Sandboxing per bot: default `workspace-write` with `approval_policy = "never"` inside a dedicated per-bot working directory. Approval parity is an open engineering question, not a documentation footnote: the design (PRD FR-20) is that consequential effects are reachable only through Agentda-hosted MCP tools whose handlers block until the human answers — but `codex exec` has been reported to auto-cancel MCP calls awaiting approval in non-interactive runs (openai/codex#24135), so the first task of this adapter is testing whether blocking tools survive a real exec run, with `codex mcp-server` / the Codex SDK as the primary alternative embedding if they don't. Until one of those is proven, Codex bots ship without outbound tools, and the provider matrix says so.
- API-key adapters: Anthropic, OpenAI, xAI, and Gemini (Anthropic/OpenAI are the P0 pair failover depends on; xAI and Gemini ride along because one OpenAI-compatible client covers most of the work). These come with no harness, so core grows its own minimal agent loop (tool-call dispatch against the same MCP tool surface, approval gate trivially in-process) used only by these adapters. This is the real cost of Phase 2 and the hedge against any subscription-policy change. Local Ollama models reuse this loop in Phase 3.
- Provider failover per PRD FR-6: ordered provider list per bot; on auth failure or limit exhaustion the next provider starts a fresh session seeded from memory files plus a restated task, surfaced in-thread as rebuilt (not resumed) context; failover onto a paid API key requires a one-time opt-in.
- Voice input: Telegram voice notes fetched via getFile, OGG/Opus transcribed (ADR resolves PRD Q1: local Whisper-class vs provider routing), transcription shown as the sent message. Free-text and amendment approval replies land here too: "yes", "no", or "approve but cc Anna", with amendments re-rendered as a revised card needing one more tap (PRD FR-21).
- Per-persona chat identities and management: multi-bot per daemon ships in Phase 1, but every bot speaks through the one bridge token; here each persona gets its own BotFather token, name, and avatar via the multi-token registry, plus proper persona management (daemon CRUD and the desktop editor).
- Tauri desktop app mirroring the GrokBot-style layout (bot list with previews and badges, chat pane, bot settings): chat with live checklist rendering from streaming AgentEvents, the bot-screen live preview pane for shadow browser work (CDP screencast with Take over / Hand back), ASK/AUTO badges with the mode toggle, persona create/edit, an approvals inbox, the audit log viewer with filtering, routine run history. It talks to the daemon over a loopback-only, token-authenticated HTTP+WebSocket API, and the daemon ships as a Tauri sidecar.

**Task checklist.**
- [x] Local daemon API on loopback with per-run bearer token, serving state, audit, approvals, mode, pause, and an SSE event stream. Sends are accepted with 202 and answered on the stream, because a turn can pause on an approval for as long as the human takes — an HTTP request must not hold that open.
- [x] ADR first, adapter second ([ADR 0003](docs/adr/0003-codex-gate-and-embedding.md)): `codex exec` wins. Decided by testing the real binary — hooks fire for every tool including MCP, MCP calls are cancelled regardless of configuration, and a denial races the tool it should block. The embedding buys nothing against those.
- [x] Codex adapter: JSONL event mapping into `AgentEvent`, auth detection (`codex login status` reports on **stderr**), limit errors surfaced like Claude's, `--ignore-user-config` so the user's own Codex setup is untouched, and read-only containment enforced by default. Live tests cover containment, conversation, injected memory, and thread resume.
- [x] Core agent loop for API-key adapters, with the gate as a plain in-process call — genuinely mid-turn, no hook and no race. One OpenAI-compatible client covers OpenAI, xAI, and Ollama; Anthropic and Gemini have their own. A hard step cap stops a looping model spending the user's money. Verified live against a local Ollama model calling real MCP tools.
- [x] Failover: ordered provider list, fresh session with context rebuilt from memory (never claimed as resumed), the switch announced in the thread, and metered providers refused without a per-bot opt-in. Only auth and limit failures fail over — retrying a crash elsewhere just spends twice.
- [x] Voice notes ([ADR 0004](docs/adr/0004-voice-transcription.md)): local whisper.cpp by default, hosted only on request, and no silent fallback between them — the transcript can approve a consequential action, so the recording stays on the machine unless you say otherwise. Telegram voice notes and the desktop mic take the same path; the transcript is echoed before it acts. Unit-tested with the network stubbed; not yet run on real audio, because neither ffmpeg nor whisper.cpp is installed here.
- [x] Free-text and amendment approvals: one parser, one queue method, every surface. An amendment is delivered as a denial carrying the instruction rather than a rewrite of the tool input behind the model's back — the model makes the change and asks again, so the human sees a real payload and taps once more, and one mechanism covers all three providers. Live-verified end to end on Ollama, which is how we found that our own loop was dropping the denial reason and swallowing the amendment.
- [x] Persona management: create, edit, and archive from the API and the desktop editor, with providers, model, hands, surface, scope, gate lists and budgets. Edits rewrite bot.toml line by line so the user's comments survive; archiving moves the folder to `.trash` rather than deleting memory. Live-verified against a running daemon.
- [x] Multi-token Telegram registry: one bridge per persona token, tokens in a 0600 file outside the bot directory (a bot folder is meant to be shared; a token is a password), onboarding in the persona editor. Owner pairing is per Telegram account, so a new token needs no new pairing. Unverified against real BotFather tokens — see [USER_REQUEST.md](USER_REQUEST.md).
- [x] Tauri shell plus the full window: roster with mode badges, chat with a live checklist built from streaming AgentEvents, approval cards with Approve/Deny/amend, approvals inbox, audit viewer with filters, routine history, persona editor, mode toggle, reload. The shell starts the daemon, loads the URL it prints, and takes it down with the window — verified, including that killing the window outright leaves nothing behind. Packaging as a `.app` is not done: it needs Node bundled as a sidecar.
- [x] Bot-screen preview: the browser server posts CDP screencast frames to the daemon, which relays them to the window; Take over relaunches the same profile visibly and refuses the bot the page until Hand back. Live-verified against real Chromium.
- [x] Docs: a [provider matrix](docs/providers.md) showing exactly what works where (mid-turn approvals, resume, tools, cost model), with no capability claims we haven't exercised.

**Exit criteria.** Status as of 2026-08-18. Live results this round come from real Ollama (`llama3.1:8b`) runs and real Chromium on macOS; the `claude` and `codex` binaries are not installed on this machine, so anything provider-specific carries its earlier verification date.

- ✅ the same persona definition runs on a Claude subscription, a ChatGPT plan, and an API key by flipping one config field — verified 2026-08-13, with the documented caveat that outbound tools on Codex stay off (ADR 0003).
- ✅ failover from an exhausted subscription to an API key happens visibly and only after opt-in — unit-tested against the chain, verified 2026-08-13.
- ✅ an amendment round-trips: a card, a typed "approve but write X instead", a denial carrying the instruction, a revised card, one more tap, and the right bytes on disk — live on Ollama.
- ⏳ **the same round trip by voice** needs whisper.cpp and ffmpeg, which are not installed here. The pipeline is tested with the network stubbed; the transcriber has not been run on real audio. Tracked in [USER_REQUEST.md](USER_REQUEST.md).
- ✅ a shadow browsing session streams to the desktop and can be taken over mid-run — live: real screencast frames arrive on the stream the window reads, and a navigate during take-over is refused until hand-back.
- ⏳ **two personas under distinct Telegram identities** is built and unit-tested (one bridge per token, replies routed to the right bridge) but has never run against real BotFather tokens. Tracked in [USER_REQUEST.md](USER_REQUEST.md).
- ✅ the desktop app can do everything the chat commands can — bots, mode, pause/resume, audit, routines, reload — and its audit view shows every gated decision with its source.

**Riskiest assumption.** Codex on Plus/Pro. OpenAI documents `codex exec` reusing the saved login and ships an SDK that wraps the same binary, but has never blessed third-party products driving it, Plus/Pro has no sanctioned unattended-automation credential, and heavy automation on consumer accounts has drawn risk-flagging and bans. We keep Codex usage on the user's own machine and login, surface limit errors loudly, and document `CODEX_API_KEY` as the safe valve for heavy schedules.

## Phase 3: More bridges, tool packs, multi-bot polish

**Goal.** Meet users in Slack and Discord, and give bots richer real-world tools through curated MCP packs. (Multi-bot shared threads moved into Phase 1; what remains here is the coordinator pattern, evaluated against real usage.)

**Deliverables.**
- Bridge abstraction shakeout: factor what Telegram, Slack, and Discord share (inbound message, outbound message, approval buttons, sender authentication, message edits) into core; keep platform quirks in each bridge. This is where live edit-in-place checklist rendering lands: Telegram message edits throttled to roughly one per second to respect the rate limit, Slack `chat.update`, Discord message edits — all fed from the same streaming AgentEvents the desktop already renders.
- Slack bridge: Bolt with Socket Mode, which needs no public URL and is fine here because we are not a Marketplace app. Block Kit approve/deny buttons, `ack()` inside Slack's 3-second window, slow agent work async with `chat.update`. Approvals honored only from enrolled Slack user IDs, per the FR-18 parity contract.
- Discord bridge: discord.js over the gateway, buttons with `deferUpdate` then follow-up (same 3-second interaction deadline). A bot can't DM a stranger, so onboarding docs recommend a tiny private guild or a user-installed app; DM-based use needs no privileged Message Content intent. Same sender-auth rule.
- WhatsApp decision point, explicitly a decision and not a build: the official Cloud API means business verification, a dedicated number, and public webhook infra, with user-initiated chats free inside the 24-hour window but bot-initiated pings after it requiring paid pre-approved templates; unofficial Baileys-style bridges risk a permanent number ban. Default answer: skip, revisit only against real demand, recorded in an ADR.
- MCP tool packs: curated, versioned configs pointing at maintained MCP servers for Gmail, Google Sheets, Google Calendar, and similar, extending the Phase 1 starter recipes. Delivered to Claude via `--mcp-config` with `--strict-mcp-config`. On Codex, packs are filtered by verb: read-only servers may attach directly via `-c mcp_servers` overrides, but any server exposing outbound verbs (send, post, external write) attaches only through the Agentda approval proxy that enforces the same queue — a directly-attached send tool on Codex would execute ungated, which is exactly the failure PRD M4 calls a release blocker. Server auth is header- or OAuth-based and completed during pack setup, since headless runs can't do interactive MCP OAuth; claude.ai connectors don't work outside claude.ai login, so packs use open MCP servers only.
- Local model adapter: Ollama and other OpenAI-compatible endpoints through the Phase 2 agent loop, with tool-calling quality caveats surfaced per model.
- Multi-bot polish: the coordinator pattern (PRD FR-38) — a planner bot decomposing and dispatching to specialists — evaluated now that Phase 1's simple handoffs have real usage behind them, always behind the existing per-task turn caps.

**Task checklist.**
- [x] Bridge abstraction in core: sender authentication, pairing, addressing, typed answers to approval cards, and the edit-in-place checklist are one implementation that all three platforms run, so the FR-18 parity contract is a shared code path rather than three copies that drift. Telegram migrated onto it. The checklist had a real race — two updates in flight both posted a message — which is fixed and tested.
- [x] [Slack bridge](docs/slack.md) on Bolt in Socket Mode, Block Kit approve/deny inside the 3-second ack window, `chat.update` for the live checklist, with the [app manifest](examples/slack/app-manifest.yaml) checked in. Never run against a real workspace — see [USER_REQUEST.md](USER_REQUEST.md).
- [x] [Discord bridge](docs/discord.md) on discord.js over the gateway, `deferUpdate` then edit, private-guild onboarding documented. Never run against a real bot token — see [USER_REQUEST.md](USER_REQUEST.md).
- [x] [ADR 0005](docs/adr/0005-whatsapp.md): WhatsApp parked. Business verification, a dedicated number, a public webhook, and Meta-approved templates for anything outside the 24-hour window — which a bot that says arbitrary things at arbitrary times cannot use. The unofficial route risks a permanent ban on someone's real phone number, so it stays out of the repo entirely, examples included.
- [x] [Tool packs](docs/packs.md): format, three packs, and a wizard in the persona editor. Read-only verbs become the auto-approve list and everything else is gated, so a pack that forgets to classify a verb fails closed. Each shipped pack is vetted by launching it and comparing its real tool list against the classification — `files`, `memory-graph` and `thinking` all verified 2026-08-18 that way. Gmail, Sheets and Calendar are deliberately absent: they need OAuth credentials nobody here has, and the rule is that a pack lands after it has been run.
- [x] Approval proxy for outbound-verb servers on Codex — **not built, and the reason is the point**: the proxy would itself be an MCP server, so `codex exec` would cancel it like every other MCP call (ADR 0003). What it was there to guarantee is guaranteed instead by refusing to attach packs on Codex at all, loudly, rather than half-attaching them.
- [x] Ollama on the shared agent loop — shipped in Phase 2 and live-verified there; it is the provider every live run in this phase used.
- [x] Coordinator-pattern spike ([ADR 0006](docs/adr/0006-coordinator-pattern.md)): built, run four times against a local model, and **parked on by default**. The plumbing worked every time and the cap stopped it when spent, but the local planner produced a malformed plan in three runs of four, which degrades the pattern into the Phase 1 chain at the cost of an extra turn. It ships behind `coordinator = true`, off, documented as unproven rather than as a feature.

**Exit criteria.** Status as of 2026-08-18. Live results are from real Ollama (`llama3.1:8b`) runs, real Chromium, and real MCP servers launched from npm on macOS — `AGENTDA_LIVE=1 pnpm test:live`, 150 passing and 13 skipped, the skips being every suite that needs the `claude` or `codex` binary, neither of which is installed on this machine.

- ✅ one persona is reachable from Telegram, Slack, and Discord with identical approve/deny behaviour, identical mode badges, and identical sender authentication — *identical* because it is one implementation in core, tested directly, rather than three that agree today. The Slack and Discord SDK wiring on top of it has not met a real workspace or bot token: ⏳ tracked in [USER_REQUEST.md](USER_REQUEST.md).
- ✅ a pack's read-only verbs run unasked and everything else is gated, with each shipped pack vetted by running it — live.
- ⏳ **a bot reads Gmail through a pack and asks approval before sending mail** needs Google OAuth credentials. The pack is not written, because a pack lands after it has been run.
- ✅ the Codex half of that criterion is settled rather than pending: packs are refused on Codex, because a proxy would be cancelled exactly like the calls it was proxying (ADR 0003), and a send tool that looks attached and runs ungated is the PRD M4 blocker.

**Riskiest assumption.** Third-party MCP server quality. The packs stand on maintained community servers we don't control; each one is vetted by running it, and the outbound-verb proxy on Codex is the safety net when a server's tool surface is broader than its README admits.

## What an adversarial sweep found, 2026-08-21

Phases 1–3 were built and their exit criteria ticked against real runs. A deliberate hunt
for defects in the safety-critical paths afterwards found several, every one of them
reproduced before it was touched. They are listed here because where they were is the
useful part.

- **No Telegram approval could ever have been tapped.** A chat bridge delivers updates one
  at a time; the message handler awaited the turn, the turn blocked on the gate, and the
  Approve press sat in the next update, undeliverable. Every gated action would have timed
  out to deny.
- **The gate judged one bot's action by another bot's policy.** The bot was resolved from a
  session id, which does not exist until a turn ends — so on a session's first tool call it
  fell back to the first bot loaded.
- **The Codex shim overwrote the Claude settings file**, so an approval reached Claude as
  silence while the audit row already said allow.
- **Anything on the machine could read the control token** off the desktop page, and the
  bot's own browser subprocess was handed that same token.
- **A symlink inside an allowed directory walked straight out of a bot's scope.**
- Smaller: the handoff cap was a lifetime cap keyed on the message text; a bot given its own
  token after boot could never be paired; a routine with no chat of its own posted into
  another bot's thread and was recorded as a successful run; approval cards rendered
  attacker-influenced payloads as markup and truncated them without saying so.

Every one of them lived on a path that had never been run end to end — the Telegram bridge
(no token), the daemon's own gate wiring (the live gate tests drive the runner harness, not
the daemon), the desktop page (no browser had ever loaded it). The tests that existed were
good tests of the code they covered. The lesson is the coverage boundary, not the tests, so
this round added: the daemon booted as a real process, the desktop page loaded in a real
browser, the bridge driven through its real polling loop, and the MCP server driven over
real MCP.

ADR 0002's claim that the on-screen browser surface helps against bot detection was also
measured and is mostly wrong; the ADR now carries the numbers.

## Phase 4: Full desktop hands and watch-and-learn

**Goal.** Beyond the browser: bots that can drive a whole desktop when a task needs an app outside the browser — without taking the user's desktop away — and bots that learn routines by watching the user do a task once. (The browser tool itself shipped in Phase 1; this phase is about everything a browser can't reach.)

**Deliverables.**
- Isolated virtual desktop, the default surface for OS-level work: a Linux container image with a lightweight desktop, driven by OS-level input injection, watched live through noVNC embedded in the desktop app's preview pane. The bot gets a whole computer that isn't yours — the same shadow-vs-on-screen philosophy as Phase 1's browser surfaces, extended to full desktops. Driving the user's real desktop — the only case where a bot genuinely takes the mouse and keyboard — exists as an explicit per-session opt-in with an always-on-top stop bar and auto-pause the moment the user touches the input. Platform honesty, because macOS is our lead platform: a Linux container desktop runs Linux and web apps only, and on macOS it needs a user-installed VM runtime (Docker Desktop, OrbStack, or colima — multi-GB installs with real RAM cost while warm; unmeasured, figures published when we have them). The macOS-native apps people actually mean — Mail, Excel — are reachable only through the real-desktop opt-in, since macOS guest VMs are ruled out by licensing and tooling. So on Macs the practical default for native-app work may invert to the opt-in, which strengthens rather than weakens the case for the stop bar and auto-pause.
- Watch-and-learn: record a user session with Playwright codegen and tracing into a draft routine; replay follows the recording, lets the model recover when the page has drifted, and stops for approval at any step marked sensitive.

**Task checklist.**
- [x] Virtual desktop image ([ADR 0008](docs/adr/0008-virtual-desktop.md)): Debian plus Xvfb, fluxbox, x11vnc and noVNC, per-bot state mounted from the bot directory, and the lifecycle question settled by measuring it — **0.8 s** from `docker run` to a usable desktop, so per task, started on first use, and no reason to keep one warm. The measurements also corrected this plan's own guess: the container is 60 MB, and the 807 MB is Docker Desktop sitting behind it. Live-verified end to end.
- [x] OS-level verb classification wired into the existing gate: it needed no new machinery. `desktop_screenshot` and `desktop_where` read; `desktop_launch`, `desktop_click`, `desktop_type` and `desktop_key` act and are gated by default like any unlisted tool. A native app's "send" is a `desktop_click` on a button, which is the same shape as a browser submit — which fell out of naming the verbs honestly rather than out of a classifier.
- [ ] Real-desktop opt-in mode: per-session consent card, always-on-top stop control, auto-pause on user input. **Not built, deliberately.** Injecting input into the user's own desktop is the most dangerous thing in this product, it needs macOS Accessibility permission that cannot be granted or exercised from here, and the parts that make it safe — the stop control and the auto-pause — are exactly the parts that must be *verified* rather than merely written. A half-built version of this is worse than none. The container desktop covers Linux and web work today; native macOS apps stay out of reach until this can be built and tested with a human at the machine.
- [x] Recorder: drives Playwright's own recorder through a private API (pinned exactly, with a canary test whose only job is to fail when a version bump moves it), and compiles a reviewable TOML draft into the bot directory. Running it settled three things a README would not have: a typed password appears in the action AND the aria snapshot, per-session refs mean nothing tomorrow, and a positional selector silently retargets after a sibling is inserted. Each becomes a refusal rather than a footnote.
- [x] Replay engine ([ADR 0007](docs/adr/0007-watch-and-learn.md)): a `ProviderAdapter`, so a recorded step enters through `TurnRunner` and reaches the existing gate under the tool name a model's own call would use — one policy, one audit vocabulary, and `/pause` stops a routine because `denyAll` denies the step it waits on. Finding an element again is a ladder of independent handles; ambiguity and a failed post-condition both stop rather than guess, and a denied step ends the whole routine instead of skipping into a half-filled form. Live-verified against real Chromium including a page redrawn to imitate drift.
- [x] [Docs](docs/watch-and-learn.md) stating plainly what this can't do: 2FA, CAPTCHAs, bot detection, an expired login and a reworded checkout all stop it, and the bot's job then is to say so and hand back the browser where it stopped. No survival rate is published, because none has been measured.
- [ ] Model re-grounding when every recorded handle misses: ask a model for a role and an accessible name from a scoped page snapshot, verify it resolves to exactly one element, then ask the human. Not built — the deterministic ladder handles the drift we have been able to produce, and adding a model to the recovery path before it is needed would put one on the path to acting.

**Exit criteria.** Status as of 2026-08-21.

- ✅ a bot drives a desktop app on the virtual desktop, watched over noVNC, while the user's own machine is untouched — live: an app launched, a click focused it, keystrokes reached it, and the file the typing created was read back from outside the container. The one caveat is what the desktop can hold: a Linux container runs Linux and web apps, so this is not Mail or Excel.
- ✅ a recorded routine replays and survives cosmetic page changes — live, against a page redrawn the way drift redraws one (hashed class renamed, form id changed, banner inserted): the recorded selectors miss and the words on the button do not.
- ⏳ **replays a week later** is a test to run, not a claim to make. What has been measured is one machine, one day, one synthetic drift fixture.
- ✅ the deterministic ladder bridges the gaps we could produce, so the model is not yet on the recovery path at all — which is the safer place for it to not be.

**Riskiest assumption.** Two. The open web and desktop software are hostile to automation: recorded routines rot, some sites and apps will never work, replay is best-effort with a human handback path, and we make no reliability claims we haven't measured. And a containerized desktop is a heavy dependency to ship and support; if it proves too heavy, OS-level work stays a real-desktop opt-in and the isolation story leans on Phase 5's cloud boxes, where every bot naturally has its own screen.

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
- [x] Per-member identity and roles ([docs](docs/teams.md)): owner, approver and member, where being paired is deliberately not the same as being allowed to approve. The role travels with the invite code, so what someone gets is decided before they use it. Every human decision is attributed in the audit row itself rather than a join away, and decisions no human made carry no name — attributing those to somebody would be a lie. The first pairing is still an owner, so nothing changes for one person. Approval **routing** is not built: every approver sees every card.
- [x] Team onboarding docs, including what this does not do yet.

**Exit criteria.** A bot runs for a week on a cloud box with zero laptop involvement, on API-key credentials, with its usage visible to its owner. A second team member chats with a shared bot and approves its actions under their own identity, and the audit log attributes every decision.

**Riskiest assumption.** Cloud plus consumer-subscription auth. Hosted automation on consumer credentials is exactly the pattern both vendors have been tightening against. The cloud option is therefore API-key-first by design; if the consumer-auth side paths close entirely, Phase 5 loses nothing structural, and the rest of the plan survives untouched.
