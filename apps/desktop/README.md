# Agentda desktop

A Tauri window around the daemon's loopback API. The shell is deliberately thin: it starts
the daemon, reads the URL the daemon prints (which carries that run's token), and points a
webview at it. Every decision — the gate, the audit log, the approval queue — stays in the
daemon, so there is exactly one implementation of each.

```bash
pnpm --filter @agentda/desktop dev     # builds the Rust shell and opens the window
AGENTDA_URL=http://127.0.0.1:4599/?token=… pnpm --filter @agentda/desktop dev
```

The second form attaches to a daemon you already have running, which is how you work on
both at once. `pnpm daemon` alone prints a URL you can open in any browser — the window is
a convenience, not a requirement.

## What the window does

Bot roster with mode badges and a "waiting on you" marker · chat with a live checklist of
tool calls as they happen · approval cards showing the full payload, with Approve, Deny, or
a typed amendment · an approvals inbox across every bot · the audit log with filters ·
routine definitions and their run history · the persona editor (providers, model, hands,
scope, gate lists, budgets, and adding a per-bot Telegram token) · the bot-screen preview
with Take over / Hand back · a mic for voice notes.

## The daemon's lifetime

The shell starts the daemon as a child process and passes `AGENTDA_EXIT_WITH_PARENT=1`.
Quitting the app kills it; so does killing the window outright, because the daemon watches
the stdin pipe and shuts down when it closes. A daemon nobody can see should not keep
polling Telegram and firing routines.

## What is not done

Packaging. `bundle.active` is false, and the daemon is spawned as `node …` from the repo
rather than shipped as a packaged sidecar binary — that needs Node itself bundled, which
is its own piece of work. Today this builds and runs from a checkout; it is not yet a
`.app` you can hand to someone.

Verified on macOS: the shell builds (`cargo build`), starts the daemon, opens the window on
its URL, and leaves no daemon behind when the window is killed.
