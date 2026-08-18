# Tool packs

A pack is a curated pointer at an MCP server somebody else maintains, plus the two things a
config file cannot infer: what credentials it needs, and which of its verbs reach the
outside world.

```toml
# packs/mailer/pack.toml
id = "mailer"
name = "Mailer"
description = "Read and send mail."
docs = "https://github.com/…"
verified = "2026-08-18: launched with npx, tools/list matched the classification below"

[[servers]]
name = "mailer"
command = "npx"
args = ["-y", "some-mailer-mcp", "{scope}"]
env_required = ["MAILER_TOKEN"]
read_only = ["list_messages", "read_message"]
outbound = ["send_message"]
```

`{scope}` expands to the bot's own allowed directories, so one pack definition serves every
bot without anyone editing paths into it.

## Why verbs are classified

`read_only` becomes the pack's auto-approve list. Everything else is gated — including
tools the pack forgot to mention, because unlisted means unclassified means gated. A pack
cannot make an action quieter by omission, only louder.

`outbound` is narrower: verbs that send, post, buy, or write to someone else. Those are
never auto-approved *and* they join the bot's always-ask list, so they keep stopping for a
human even in Auto mode — a pack is a server we do not control, and Auto is not a
free-for-all. They are also what makes a pack refuse to attach to a provider whose gate does
not work.

## Installing one

Packs ship in [`packs/`](../packs) and can be added per user in `~/.agentda/packs`. A user
copy of the same id wins. A bot opts in by id:

```toml
packs = ["files", "thinking"]
```

or by ticking it in the desktop app's persona editor, which also shows what a pack still
needs before it can be turned on. Credentials come from the daemon's environment, not from
the bot directory — a bot folder is meant to be copied and shared.

Headless runs cannot complete interactive MCP OAuth, so a pack needing OAuth is set up
before a bot is pointed at it. `claude.ai` connectors do not work outside a claude.ai login
and so are not usable here at all.

## Codex

Packs are refused on Codex-backed bots. Not filtered — refused, with the reason. `codex
exec` cancels every MCP call whatever the configuration says ([ADR
0003](adr/0003-codex-gate-and-embedding.md)), so an attached pack would look available and
silently do nothing, and an outbound verb in that state is exactly the failure PRD M4 calls
a release blocker.

This is also why the "approval proxy for outbound-verb servers on Codex" that Phase 3
planned is not built. The proxy would itself be an MCP server, so it would be cancelled
like everything else. Refusing the attachment is what the proxy was there to guarantee, and
it is guaranteed by not lying about what is attached. If upstream fixes the cancellation,
the proxy becomes worth building and the gate plumbing is already shared.

## Vetting

A pack lands only after it has been run. `apps/daemon/test/packs-live.test.ts` launches
every shipped pack for real and asks it for its tool list, then checks that nothing in the
classification is invented — a tool listed as read-only that the server does not have means
the classification was written from a README rather than from the server. Tools the server
has and the pack does not mention are reported and left gated.

```bash
AGENTDA_LIVE=1 pnpm vitest run apps/daemon/test/packs-live.test.ts
```

## What ships today

| Pack | What it is | Status |
|---|---|---|
| `files` | The reference filesystem server, scoped to the bot's own directories | vetted 2026-08-18 by running it |
| `memory-graph` | Entities-and-relations memory, for bots tracking people and projects | vetted 2026-08-18 by running it |
| `thinking` | A step-by-step scratchpad; touches nothing | vetted 2026-08-18 by running it |

Gmail, Google Sheets, and Google Calendar are the packs Phase 3 named, and they are **not
here**. Each needs OAuth credentials nobody on this machine has, and the rule is that a
pack lands after it has been run — writing three unvetted files would be the opposite of
what the rule is for. They are the first thing to land once credentials exist; see
[USER_REQUEST.md](../USER_REQUEST.md).
