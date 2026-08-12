# ADR 0001: the approval gate rides on a PreToolUse hook, not `--permission-prompt-tool`

Status: accepted, 2026-08-12 · Verified against claude 2.1.206 on macOS

## Context

PRD FR-20 and PLAN Phase 1 both specified the Claude gate as `--permission-prompt-tool`
pointing at an MCP tool the daemon hosts. That flag does not exist in claude 2.1.206
(`claude --help` has no `--permission-prompt-tool`; the permission surface is
`--permission-mode`, `--allowedTools`/`--disallowedTools`, `--tools`, and hooks). The docs
were written against an older or assumed CLI generation.

We need an interception point that can hold a tool call while a human decides, for up to
the FR-22 approval window, without wedging the session.

## Decision

Use a **PreToolUse hook**. The daemon runs a loopback HTTP server and writes a settings
file (loaded with `--settings`, which composes with `--setting-sources ""` so the user's
own hooks stay excluded) whose hook command is a small curl shim. The shim POSTs the hook
payload to the daemon and prints the verdict the daemon returns.

Verified behavior, by running it:

- The hook fires **before** the tool executes and receives `session_id`, `tool_name`, and
  `tool_input` on stdin.
- Returning `permissionDecision: "deny"` blocks the call — the target file was never
  created and the model was told it was denied.
- Returning `"allow"` lets it proceed.
- The CLI **waits** for the hook: a hook that slept 6s stretched the turn by 6s. That is
  what makes a blocking human gate possible at all.
- `timeout` on the hook entry (seconds) is accepted; we set it above the approval window,
  and set `MCP_TOOL_TIMEOUT` on the spawn for the same reason, so the CLI never cancels a
  pending approval out from under the human.

Live tests (`AGENTDA_LIVE=1`, `packages/provider-claude/test/gate-live.test.ts`) assert
deny / allow / timeout-to-deny end to end against the real binary.

## Consequences

- The gate needs no SDK and no credential handling: a genuine binary plus a hook config,
  which keeps the compliance stance in R1 intact.
- Tool availability and approval stay separate (FR-11): granted tools are passed via
  `--tools` / `--mcp-config`, never `--allowedTools`, so every call still reaches the hook.
- The hook is a subprocess per tool call, so the shim must stay tiny; curl is already
  present on macOS and Linux. If that assumption ever breaks, replace the shim with a
  compiled helper — the daemon side does not change.
- Fail-closed by construction: if the daemon is unreachable or the gate throws, the shim's
  output is not a valid allow, and the daemon's own error path returns an explicit deny.
- Codex has no equivalent blocking hook, which is why FR-20's Codex half stays unresolved
  until its adapter lands in Phase 2 — this ADR does not change that.
