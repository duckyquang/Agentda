# ADR 0008: a container desktop per task, started on demand

Status: accepted, 2026-08-21

## Context

PLAN Phase 4 wants OS-level work to default to a desktop that is not the user's, watched
live rather than taken over. It left one question open deliberately: **spin a desktop up per
task, or keep one warm per bot** — to be decided by an ADR *after measuring startup cost*.

The plan also worried, in writing, that a container desktop would be "a heavy dependency to
ship and support", with "multi-GB installs with real RAM cost while warm; unmeasured,
figures published when we have them".

## Measured

macOS 25.3.0, Apple M4 Pro, Docker Desktop 29.3.1 (linux/aarch64), 2026-08-21.

| | |
|---|---|
| Image build, cold | 89 s |
| Image size | 403 MB |
| `docker run` → noVNC answering | **0.8 s** |
| Container RSS, desktop idle | 60–62 MB |
| Container CPU, idle | 0.2 % |
| Docker Desktop itself, host RSS | **807 MB** across 11 processes |

## Decision

**Per task, started on first use.** At 0.8 seconds there is nothing to buy by keeping a
desktop warm, and a bot that never touches its desktop should not be holding a container
open. The MCP server starts the container the first time a desktop verb is called and
removes it when the server exits — which is when the turn ends.

Two things follow from the numbers rather than from taste:

- **The container is not the cost; the runtime is.** 60 MB for a whole desktop against
  807 MB for Docker Desktop sitting behind it. So the honest thing to tell a macOS user is
  not "this needs multi-GB" but "this needs a container runtime running, and that is the
  expensive part". On Linux, where the runtime is a daemon rather than a VM, most of that
  disappears.
- **Keeping one warm per bot would be the wrong default even if it were free**, because a
  warm desktop is a logged-in desktop nobody is watching.

**Everything that decides anything stays outside the container.** The container runs an X
server, a window manager and a websocket bridge; input arrives through `docker exec`. It has
no idea what a gate is, cannot reach the daemon, and cannot approve anything. noVNC is
published to `127.0.0.1` only — this is for the person at this machine to watch.

**The verbs needed no new gate machinery.** `desktop_screenshot` and `desktop_where` read;
`desktop_launch`, `desktop_click`, `desktop_type` and `desktop_key` act, and are gated by
default exactly as an unlisted tool always is. A native app's "send" is a `desktop_click` on
a button, which is the same shape as a browser submit — which is what PLAN asked for, and it
falls out of naming the verbs honestly rather than out of a classifier.

## What this does not do

- **No macOS or Windows guest.** A Linux container runs Linux and web apps. Mail and Excel
  are not reachable this way, and that is not a gap to be closed later by trying harder —
  it is licensing and tooling. Reaching a native macOS app means driving the user's own
  desktop, which stays a separate, explicit, per-session opt-in and is not built yet.
- **No text.** The bot sees pixels and window geometry. There is no OCR and no accessibility
  tree, so it clicks at coordinates and must look before it clicks. This is genuinely worse
  than the browser surface, where it reads a real accessibility tree, and a bot should
  prefer the browser whenever the task is reachable in one.
- **The image is not published anywhere.** It is built from
  `packages/desktop-image/Dockerfile` by the user. Shipping a prebuilt desktop image is a
  supply-chain commitment we have not made.

## Verification

`apps/daemon/test/desktop-live.test.ts` drives the real server against a real container:
a screenshot comes back as a real PNG, a launched app appears in the window list, a click
and keystrokes reach the app (checked from outside the container, by reading the file the
typing created), the port is bound to loopback only, and the container is gone once the
server that started it exits. It skips — rather than passing — when there is no runtime or
no image, because a green tick for a desktop that never started would be worse than a red
one.
