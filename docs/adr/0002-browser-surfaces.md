# ADR 0002: a thin in-house browser MCP server, with shadow and on-screen surfaces

Status: accepted, 2026-08-12

## Context

PRD FR-42/FR-45 need browser hands with two execution surfaces: **shadow** (invisible,
the user keeps working) and **on-screen** (visible, watchable). The plan called for judging
Microsoft's `playwright-mcp` against a thin in-house server.

## Decision

**In-house, thin.** `playwright-mcp` is a good general tool, but three of our requirements
are not its concerns:

1. **Per-bot persistent profiles.** Each bot needs its own browser profile directory so
   logins survive between runs and bots never share a session. We control the profile path
   per bot; a general server exposes one browser.
2. **The surface switch.** Shadow vs on-screen has to be per bot and per task, decided by
   the daemon, not by whoever launched a server.
3. **Focus discipline.** The on-screen surface has to pause automation and discard page
   input while the window holds focus at launch — behavior no general server implements
   because no general server promises "we won't take your screen".

The server exposes: `browser_navigate`, `browser_read` (accessibility-oriented text
snapshot), `browser_click`, `browser_type`, `browser_screenshot`, `browser_close`. Verb
names carry their risk class so the gate's patterns are readable in `bot.toml`:
`browser_navigate`/`read`/`screenshot` are auto-approvable; `click`/`type` are gated,
since a click can submit a purchase.

**Shadow** uses Chromium's new headless mode via `channel: "chromium"` (the full browser
binary without a window), not Playwright's default `chromium-headless-shell`. Launched with
`--use-mock-keychain --no-first-run --no-default-browser-check` to suppress the first-run
OS dialogs that are the real focus-steal vector.

**On-screen** launches the same persistent profile headed. Playwright drives the page over
CDP, so the bot never injects OS-level input and cannot read other windows — but a visible
window can receive the user's keystrokes while it holds focus, so the server waits out a
settle delay after launch before acting, and never calls `bringToFront`.

## Consequences

- We own the code, so the gate, per-bot profiles, and the surface switch are all first
  class. The cost is maintaining ~200 lines against Playwright's API.
- Playwright's browser download (~150MB) is a real install cost, so the browser server is
  opt-in per bot (`browser = true` in `bot.toml`), not on by default.
- Anti-bot detection will block shadow mode on some sites: new headless still advertises
  `HeadlessChrome`, runs software WebGL, and lacks proprietary codecs. The on-screen
  override exists for exactly that. We claim no specific site works until we run it.
- Full OS-level desktop control stays out of scope (Phase 4), where the answer is an
  isolated virtual desktop rather than the user's own.
