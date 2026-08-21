# More than one person

Agentda starts as one person's bots. When a second person needs to use them, the question
that matters is not who can chat — it is whose tap counts as an approval.

## Roles

| Role | Can talk to the bots | Can answer approval cards | Can invite people |
|---|---|---|---|
| `owner` | yes | yes | yes |
| `approver` | yes | yes | no |
| `member` | yes | **no** | no |

The first person to pair is an owner, so nothing changes for one person. Everyone paired
before roles existed stays an owner too.

A member's tap is refused with a message saying so, and typing "yes" at a card is refused
the same way — otherwise the button would be guarded and the keyboard would not.

## Inviting someone

```
/invite approver
/invite member
/members
```

The role travels with the invite code, so what someone gets is decided before they ever use
it. They send that code to the bot once, exactly as the first pairing works.

Pairing is per platform. Being an approver on Telegram does not make you one on Slack —
they are different account systems and the daemon has no way to know they are the same
person.

## The audit log answers "who"

Every decision a human makes is recorded with their platform and account id in the same row
as the decision, not a join away from it. Decisions no human made — an auto-approved read,
a timeout, an ungranted tool — have no name against them, because attributing those to
somebody would be a lie.

`/audit` shows it in chat, and the desktop app's audit view has a **who** column.

## What this does not do yet

- **Routing.** Every approver sees every card. Sending a particular bot's approvals to a
  particular person is not built.
- **Per-bot roles.** A role is for the whole daemon, not per bot.
- **Editing rights.** `canAdmin` exists and gates invites; it does not yet gate editing
  personas or routines from chat, because those are desktop-only anyway and the desktop is
  reached with the daemon's own token.

None of this has been run against a real second account on a real platform — there is no
Telegram token here. The rules are tested directly, in the one place all three bridges
share; the SDK wiring around them is not. See [USER_REQUEST.md](../USER_REQUEST.md).
