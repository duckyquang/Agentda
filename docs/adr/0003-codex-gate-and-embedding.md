# ADR 0003: Codex bots are read-only, because its hook gate races

Status: accepted, 2026-08-13 · Verified against codex-cli 0.146.1 on macOS, ChatGPT-plan auth

## Context

Before writing the Codex adapter, two things needed deciding: whether `codex exec` or the
`codex mcp-server` embedding should host our turns, and whether Codex can do the
human-in-the-loop approval the product rests on. PRD FR-20 assumed it could not and gave
Codex bots no outbound tools, citing openai/codex#24135.

## What the CLI actually does

Everything below was verified by running the binary. The published third-party guidance on
Codex hooks is wrong in both directions, so none of it is taken on faith here.

**Hooks exist and fire for every tool, including MCP tools.** A `PreToolUse` hook receives
`session_id`, `turn_id`, `tool_name`, `tool_input`, `cwd`, `model` on stdin. Returning
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}`
blocks a call. Three conditions, each discovered the hard way:

1. **`--enable hooks` is mandatory** — without it hooks are silently ignored: no error, no
   log line, the tool just runs. That silence cost the most time here.
2. **Inline `-c 'hooks.PreToolUse=[…]'` per invocation.** File discovery also works from
   `$CODEX_HOME/hooks.json` (next to `config.toml`, *not* `hooks/hooks.json`), but writing
   there would mutate the user's own Codex setup, which we refuse to do.
3. **`--dangerously-bypass-hook-trust`** — the alternative is persisting a trust record in
   the user's config for a shim we generated seconds earlier.

**MCP tool calls cannot be approved at all in `codex exec`.** A hook can deny one, but
nothing lets one through — verified by elimination:

| Setup | Result |
|---|---|
| hook returns `permissionDecision:"allow"` | cancelled |
| `PermissionRequest` hook returns allow | cancelled |
| hook exits silently (approval = pass-through) | cancelled |
| `approval_policy="never"`, **no hooks at all** | **cancelled** |
| same, but a shell tool instead of MCP | runs |

That is openai/codex#24135, alive in 0.146.1 and upstream of anything we control.

**And the deny path races.** This is the finding that decides the design. With an
*instant* deny hook, a denied `apply_patch` never writes its file. With our real gate —
which must take time, because a human is deciding — the same denial is recorded in the
audit log **and the file exists anyway**, containing exactly the patch content:

```
ASK apply_patch {"command":"*** Begin Patch\n*** Add File: denied.txt\n+hi ..."}
AUDIT: [{ tool: 'apply_patch', decision: 'deny', source: 'human-tap' }]
file exists: true "hi\n"
```

Codex starts the tool and consults the hook concurrently. A gate that only wins when it
answers in microseconds is not a human-in-the-loop gate. We reproduced this repeatedly; it
is not flakiness in our client (the client was rewritten from curl to Node, fails closed on
every error path, and the same race persists).

## Decision

**Host turns on `codex exec --json`, not `codex mcp-server`.** The embedding was only ever
the fallback for mid-turn control, and the blocker is tool execution, not the host protocol.

**Codex bots are read-only.** `--sandbox read-only` is the default and the guarantee:
verified that a write attempt under it fails outright, enforced by the OS sandbox rather
than by a hook that might lose a race. Concretely, a Codex bot can converse, reason, and
read its workspace. It gets no writes, no email, no browser, and no MCP tools.

Memory still works in the direction that matters: persona and memory files are injected
into the prompt (Codex has no `--append-system-prompt-file`), so a Codex bot reads its
memory. It cannot write memory; that stays a Claude capability.

**The gate still runs on Codex**, and every decision is still audited — but it is defence
in depth, not the guarantee. The guarantee is the sandbox. We say so plainly rather than
implying parity we cannot demonstrate.

## Consequences

- PRD FR-2/FR-20's "no outbound tools on Codex" caveat stands, for a sharper reason than
  originally written: not "no gate exists" but "the gate races and MCP tools cannot
  execute." The docs carry the evidence.
- Users get a real second provider for conversation and research — the policy hedge Phase 2
  exists for — without a safety claim we cannot back.
- The provider canary asserts Codex still refuses writes under the read-only sandbox, so a
  CLI change that quietly loosens this fails loudly.
- If upstream fixes both the race and #24135, Codex gains write tools by changing a default
  and deleting a restriction; the hook plumbing, the queue, and the audit path are already
  shared with Claude and already proven.
