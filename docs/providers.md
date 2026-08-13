# Provider matrix

What each provider can actually do, verified by running it rather than by reading docs. Last
verified 2026-08-13 against `claude` 2.1.206, `codex-cli` 0.146.1, and a local Ollama
(llama3.1:8b).

| | Claude Code | Codex | API keys | Ollama (local) |
|---|---|---|---|---|
| Auth | your Claude Pro/Max login | your ChatGPT login | your API key | none |
| Marginal cost | none beyond your plan | none beyond your plan | metered per token | electricity |
| Conversation | yes | yes | yes | yes |
| Memory (read) | yes | yes, injected into the prompt | yes | yes |
| Memory (write) | yes, gated | **no** | yes, gated | yes, gated |
| Files, email, browser | yes, gated | **no** | yes, gated | yes, gated |
| Mid-turn approval | yes, hook blocks the call | **no — see below** | yes, in-process | yes, in-process |
| Session resume | yes | yes | no (context rebuilt each turn) | no |
| Streaming text | yes | whole message per turn | whole message per turn | whole message per turn |
| Status | shipped | shipped, read-only | shipped, unverified against real keys | shipped, live-verified |

## Why Codex bots are read-only

Codex has a hooks system that fires for every tool, MCP calls included, and a hook can deny
a call. It looks like parity with Claude. It isn't, for two reasons we established by
running the binary — the evidence tables live in
[ADR 0003](adr/0003-codex-gate-and-embedding.md):

1. **MCP tool calls cannot execute in `codex exec` at all.** With hooks, without hooks, with
   `approval_policy="never"` — the call is cancelled either way. That's
   openai/codex#24135, upstream of anything we control.
2. **A denial races the tool it should block.** With an instant deny hook, a denied
   `apply_patch` never writes. With a real gate — which takes time, because a human is
   deciding — the same denial is recorded in the audit log *and the file exists anyway*.

A gate that only wins when it answers in microseconds is not a human-in-the-loop gate. So
Codex bots run `--sandbox read-only`: containment enforced by the OS rather than by a hook
that might lose. Verified to refuse a write even when the human approves it.

That still leaves Codex genuinely useful — conversation, reasoning, reading its memory and
workspace, thread resume — and it is a real second provider for the policy hedge. It just
doesn't get hands.

If upstream fixes both issues, Codex gains write tools by changing a default and deleting a
restriction. The hook plumbing, the queue, and the audit path are already shared with Claude.

## Choosing providers for a bot

`bot.toml` takes either one provider or an ordered chain:

```toml
providers = ["claude", "codex"]
allow_metered_failover = false   # set true to let it fall onto API billing
model = "claude-sonnet-5"        # for API providers only
```

Failover moves to the next provider only for failures another provider could fix — a plan
limit or a login problem. A crash or a bad prompt fails the same way everywhere, so
retrying it just spends twice. Sessions aren't portable between providers, so a switch
starts fresh, seeded from the bot's memory files, and the thread says "context rebuilt", not
"resumed".

Falling from a subscription onto metered billing changes what you pay, so it needs the
explicit opt-in above.

## API-key providers

`anthropic-api`, `openai-api`, `xai-api`, `gemini-api`, and `ollama` run through Agentda's
own agent loop rather than a vendor CLI. That has one real advantage: the approval gate is a
plain function call before a tool executes, so it is genuinely mid-turn with no hook, no
shim, and no race.

They register only when their key is present in the daemon's environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`), so a bot naming a
provider you haven't configured fails with a clear "no adapter" rather than a confusing auth
error. Ollama is always available if you're running a server.

Honest status: the loop and the gate are verified end to end against a local Ollama model
calling real MCP tools — approved calls execute and land in the audit log, denied ones never
touch disk. The hosted API clients are written against each vendor's documented shape but
have not been run against real keys, because there are none on this machine. Their wire
formats are unit-tested; their live behavior is not yet proven.
