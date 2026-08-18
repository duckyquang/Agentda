# ADR 0005: WhatsApp is parked, not built

Status: accepted, 2026-08-18

## Context

Phase 3 lists WhatsApp as an explicit decision point rather than a build. It is the most
requested chat app in the world, and it is also the only one of the four where "put your
bot here" is a business onboarding project rather than a token you paste into a file.

## The two routes, and what each costs

**Official — WhatsApp Cloud API.** Meta's supported path. What it needs before a single
message moves:

| | |
|---|---|
| Business verification | A Meta Business account, verified with real company documents |
| Phone number | A dedicated number that is not already on WhatsApp, tied to the WABA |
| Public webhook | Meta POSTs to you; there is no long-polling or socket mode |
| Templates | Anything you send outside the 24-hour service window must be a pre-approved template, reviewed by Meta |
| Money | Service messages inside the window are free; templates are billed per message, by category |

Every one of those is a direct contradiction of how the rest of Agentda works. Telegram,
Slack, and Discord all reach the daemon from behind NAT with no inbound port. WhatsApp
requires a public webhook, which means a tunnel or a host — and the moment there is a host,
"everything runs on your own machine" stops being true for that path.

The template requirement is worse than the cost. A scheduled routine that pings you at 9am
is, by WhatsApp's rules, a business-initiated message: it needs a template approved in
advance by Meta. A bot whose whole point is saying arbitrary things to you at arbitrary
times cannot express itself in pre-approved templates.

**Unofficial — Baileys, whatsapp-web.js and friends.** These drive the WhatsApp Web
protocol with your personal account. No verification, no templates, no cost, and it would
work this afternoon. It is also explicitly against WhatsApp's terms, and the failure mode is
a permanent ban of the phone number — a number people use for their family and their bank.

Shipping that as a supported bridge would mean asking users to risk their real phone number
on our convenience. We are not going to do that, and a footnote saying "at your own risk"
does not change what we would be encouraging.

## Decision

**Skip it. Revisit only against real demand, and only via the official API.**

If it is ever built: the daemon grows an optional public webhook receiver, the bridge
refuses to send outside the service window unless a template is configured, and the docs
open with the verification checklist rather than burying it. None of that is hard; it is
just a different product shape, and nobody has asked for it yet.

## Consequences

- WhatsApp users reach their bots through Telegram, Slack, or Discord, or through the
  desktop app.
- The bridge abstraction is where this would land if it is ever built, and it already has
  the piece that matters — sender authentication and approvals are platform-independent.
- The unofficial route stays out of the repo entirely, including as an example. A working
  example is an endorsement no disclaimer walks back.

## What we did not verify

The pricing structure above is from Meta's published model as we understand it, not from a
run against a live WABA. Meta has changed WhatsApp pricing more than once (per-conversation
to per-message, and free service conversations), and anyone acting on this should check the
current pricing page rather than this file. Nothing in the decision turns on the exact
numbers: the blockers are verification, the public webhook, and templates.
