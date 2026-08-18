# ADR 0006: the coordinator pattern ships behind a flag, and stays off by default

Status: accepted, 2026-08-18

## Context

Phase 1 shipped simple handoffs: a bot ends its reply with `@scout: check these names`, the
next bot picks the work up, every hop is visible in the thread and counted against a hard
per-task cap. PRD FR-38 asks for something more ambitious — a planner bot that decomposes a
request and dispatches it to several specialists, then makes sense of what comes back.

Phase 3's task was to spike it against real usage and then adopt or park it.

## What was built

About thirty lines on top of what already existed. A persona with `coordinator = true` may
name several bots in its trailing handoff lines instead of one; each dispatch goes through
the same `tryHandoff` cap and is announced in the thread the same way; when two or more come
back, the coordinator gets one final turn to answer the original request, and that turn is
forbidden from handing off again. Handoff lines that are not at the end of the reply are
ignored — otherwise a bot could smuggle one into the middle of prose — and the thread now
says when that happened rather than silently acting on half a plan.

## What was actually run

Four turns, three bots (`chief` planning, `scout` and `ledger` specialising), local Ollama
`llama3.1:8b`, on this machine. No frontier model: there is no `claude` or `codex` binary
here and no API key.

| Run | What the planner produced | What happened |
|---|---|---|
| 1 | Two handoffs with a malformed `@mcp__agentda__memory_read {}` line between them | Only the trailing block dispatched — one specialist |
| 2 | Two clean handoffs, but `90 euros` became `0.9 euros a euro per night` | Both specialists ran and answered; the arithmetic was answered as asked, on a mangled number |
| 3 | Two clean handoffs | Refused: the per-task cap was already spent by the earlier runs of the same task, so it stopped and handed back |
| 4 | Two handoffs with a stray `@mcp__agentda__memory_read:` line between them | One specialist |

The synthesis turn did not fire in any of the four, because it needs two results and only
run 2 produced two.

## Decision

**Keep the mechanism, leave it off, and do not promote it as a feature.** `coordinator =
true` is opt-in per bot, documented as unproven, and every hop it makes is still capped,
audited, and visible.

The mechanism is not the problem — the plumbing worked in all four runs, and run 3 is a
small demonstration that the cap is load-bearing rather than decorative. The problem is that
the pattern's value lives entirely in the quality of one model's plan, and on an 8B local
model the plan was malformed three times in four. When that happens the pattern degrades
into the Phase 1 chain, which is what we already had, at the cost of an extra turn.

Adopting it as a default would be claiming a benefit we have not observed. Deleting it would
throw away thirty working lines and the harness to evaluate them on a better model.

## What would change this

One clean evaluation on a frontier model — the same three bots, the same questions, on a
Claude subscription or an API key — showing the planner producing well-formed plans and the
synthesis turn adding something the sequential chain does not. That is a short run, and it
is blocked only on a provider this machine does not have
([USER_REQUEST.md](../../USER_REQUEST.md)).

## Consequences

- `coordinator = true` exists, is off, and is documented as unproven rather than as a feature.
- The per-task turn cap covers coordinators exactly as it covers chains: a planner that
  fans out to four specialists spends the cap four times as fast, and stops.
- One improvement came straight out of the runs and applies to every bot: handoff lines
  that are not at the end of a reply are now reported instead of silently dropped.
