# ADR 0009: fix the layout first; the wrapper is the easy part

Status: accepted, 2026-08-21

## Context

PLAN Phase 5 asks for a mobile spike and an ADR: **Tauri 2 mobile vs React Native**, judged
against the existing UI. The framing assumed the decision was about toolchains.

## What the spike actually found

The desktop UI is a single HTML page served by the daemon over a loopback HTTP API. Put it
on a phone-sized screen, and it is not a toolchain problem. Measured with real Chromium
under device emulation, before any change:

| | iPhone 15 | Pixel 7 |
|---|---|---|
| Chat pane width | **77 px** | 96 px |
| Approval card width | 77 px | 96 px |
| …with a 83 px Approve button inside it | — | — |
| Header height (7 tabs, wrapped) | **392 px** | 362 px |
| Sideways scroll | 186 px | 186 px |
| JavaScript errors | none | none |

So the app *worked* on a phone. The 280 px sidebar simply took the screen, the approval card
came out narrower than its own button, and the header was taller than the content it
labelled.

That reframes the question. **Both candidate wrappers wrap a web page.** Tauri 2 mobile puts
a WKWebView/WebView around it; React Native would mean rewriting the UI in React Native
components — which is only worth arguing about if the web UI cannot be made to work, and it
can: one media query took the approval card from 77 px to 369 px, the header from 392 px to
52 px, and the sideways scroll to zero.

## Decision

**Make the existing page responsive — done — and defer the wrapper choice.**

With a responsive page there are three ways to have Agentda on a phone, in increasing cost:

1. **A browser on the tailnet.** Zero new code. The daemon already serves the page and
   already guards it with a per-run token, and Phase 5's remote access made the bind address
   and allowed hostnames explicit. This works today.
2. **Tauri 2 mobile.** A thin shell around the same URL, sharing the desktop shell's Rust.
   Buys an icon, a splash screen, and later push notifications — which is the one thing a
   browser genuinely cannot do well, and the one reason to build it.
3. **React Native.** A rewrite of a UI that already exists, for a product whose UI is a
   client of an HTTP API. Nothing in the spike argues for paying that.

So: **Tauri 2 mobile when there is a reason, and the reason will be push notifications** —
"your bot is waiting for you" is the one interaction a chat bridge currently does better
than the app. Until then a browser on a tailnet is the honest answer, and Telegram remains
the good mobile client it always was.

## What could not be measured

An actual iOS build was not attempted, because this machine has Command Line Tools and not
Xcode, no iOS Rust targets, no `cargo-tauri`, and no simulators. So this ADR says nothing
about whether Tauri 2's iOS build works for this app, how large the binary is, or what its
WKWebView does with an EventSource stream — all of which would need to be checked before
committing to option 2. What it does establish is that none of that is on the critical path,
because the blocker was never the wrapper.

## Consequences

- The page is responsive below 700 px: the bot list becomes a strip along the top, the tab
  row scrolls sideways instead of stacking, and cards get the full width. Covered by a test
  at an iPhone viewport that also approves a real card, so it checks that it works rather
  than only that it fits.
- Phase 5's mobile deliverable is a decision and a working phone layout, not an app binary.
  The plan's own words were "we decide then, not now"; this is that decision, with the
  measurement that drove it.
