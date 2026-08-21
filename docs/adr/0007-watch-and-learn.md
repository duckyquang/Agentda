# ADR 0007: replay is a provider, and a recording is a file you read

Status: accepted, 2026-08-21

## Context

PLAN Phase 4 asks for watch-and-learn: record a user doing a task once, replay it later on
a schedule. The interesting question is not how to record — Playwright already does that —
but where a replayed step meets the approval gate. A replayed step is an action nobody is
watching, taken from a script a human produced days ago, on a page that may have changed.

## Decision

**Replay is a `ProviderAdapter`.** A recorded routine runs as a turn: it enters through
`TurnRunner.run`, counts against the same budget, and every step reaches
`ApprovalQueue.request` through the gate closure that already exists — under the same tool
name (`mcp__browser__browser_click` and friends) the model's own call would use.

The alternative was a `TurnRunner.replay()` sibling that calls the queue itself. That makes
replay the *third* caller of the gate, and it would have to re-derive the budget check, the
turn ledger, the chat resolution and the pause switch by hand. One of those forgotten is a
step that runs ungated. As a provider there is nothing to re-derive: replay is a new
producer of tool names flowing into machinery that already exists.

Three consequences fall out of that choice for free: one policy covers a bot's model turns
and its recorded ones, `/pause` stops a replay mid-routine because `denyAll` denies the step
it is waiting on, and the audit log needs no second vocabulary.

**Per-step sensitivity rides the switch that already exists.** `decide()`'s third argument
means "drop this call back to Ask whatever the bot's mode says" — which is exactly what a
sensitive step needs. No new tool name, no branch inside `decide()`, and the audit row
honestly reads `mode = ask`. A step the resolution ladder had to *recover* asks too: an
element found another way is not the element the human recorded.

**A recording is a TOML file with one step per table.** Not a database row and not an
opaque blob, because the user is being asked to approve it in advance, and approving
something you cannot read is not approving it. It ships `reviewed = false` and refuses to
replay until a human has opened it and said otherwise.

**Replay refuses much more readily than a model does.** A denied step ends the whole
routine — a model can be told no and carry on, but skipping "fill the amount" and going on
to "click submit" submits the form with the old value in it. An element that now matches
two things is a stop, not a coin flip, and an ambiguous rung never climbs to a looser one
because looser matches more. Every acting step checks a post-condition afterwards, without
which a routine that typed into the wrong field reports success.

## What was measured, not assumed

Recording drives Playwright's private `_enableRecorder({ recorderMode: 'api' })`, which is
present in the installed 1.62.1 build and absent from its public types. So the version is
pinned exactly and `packages/watch/test/record-live.test.ts` exists to fail loudly when a
Playwright bump moves it — rather than a user discovering that recording silently captured
nothing.

Running it also settled three things a README would not have:

- **The typed value of a password field appears twice** — in the recorded action and again
  inside the aria snapshot. Scrubbing one and not the other would have left the password in
  the file. Those steps become a `handback`: the browser is handed to the human at that
  point instead.
- **The recorded `ref=e5` handles are per-session** and mean nothing tomorrow, so they are
  dropped rather than stored.
- **A positional selector silently resolves to a different element** after a sibling is
  inserted, and nothing throws. There is no failure to recover from, only a wrong click —
  so those steps are marked fragile and refuse to act at all.

## What this cannot do

2FA, CAPTCHAs, bot detection, an expired login, a challenge page, a payment confirmation
that changes its wording. Replay's job then is to say so and hand back the browser where it
stopped, which it does through the same take-over path the desktop's button uses — so the
human lands on the right page, already logged in.

**No survival rate is published anywhere.** What has been measured is behaviour against a
page redrawn to imitate drift — a hashed class renamed, a form id changed, a banner
inserted — on one machine, on one day. Week-scale drift, real redesigns and any site corpus
are unmeasured. PLAN's "replays a week later and survives cosmetic page changes" is a test
to run, not a claim to make.

## Consequences

- `packages/watch` is the only place Playwright's private API is touched, and the only
  package that pins Playwright exactly.
- A Codex bot cannot replay: it has no working MCP tools at all (ADR 0003), so it has no
  browser. Refused with the reason rather than failing at step one.
- Recording holds the bot's browser profile, so it takes that bot's turn slot — one thing
  at a time per bot, which is already how turns work.
- `<select>` became its own gated verb (`browser_select`) rather than being logged as a
  click. An audit log that says "click" when a select happened is the wrong kind of
  convenient.
