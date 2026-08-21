# Watch and learn

Do a task once with a bot watching. It writes down what you did as a script you can read,
and replays it later on a schedule — stopping for you at every step that matters.

## Recording

In the desktop app: pick a bot, **Record**, optionally give it a starting URL, and press
Start. A browser window opens on **that bot's own profile**, so whatever it is logged into,
you will be too. Do the task once. Press **Stop and keep it**, give it a name and a
schedule.

From chat:

```
/record scout https://invoices.example.com
/stop-recording scout pay-invoice
```

Either way you get two things: a routine in the bot's `bot.toml`, switched **off**, and a
file next to it with the steps in it.

## Reading it before it runs

A recording will not replay until somebody has read it. Open **Routines → Read it**. The
file is plain TOML, one table per step:

```toml
reviewed = false

[[steps]]
n = 2
verb = "type"
tool = "mcp__browser__browser_type"
selector = "internal:role=textbox[name=\"Amount\"i]"
role = "textbox"
name = "Amount"
text = "42.00"
sensitive = false
fragile = false
expect = "value:42.00"
```

What to look at:

- **`sensitive = true`** — stops for you every time, even in Auto. The recorder sets it on
  anything whose words suggest money or sending; you can set it on anything else.
- **`verb = "handback"`** — a step it will not do for you. A password field becomes one of
  these automatically, and the value you typed is not in the file.
- **`fragile = true`** — the only handle recorded was a position. It will stop rather than
  act on whatever is in that position later.
- **`expect`** — what must be true afterwards. Without it a routine that typed into the
  wrong box would report success. Change it if the recorder guessed badly.

Then **I have read this — let it run**, and switch the routine on.

## What happens when it replays

Every step goes through the same approval gate a bot's own browsing goes through, under the
same tool names, into the same audit log. So a click is gated exactly as a click always was,
`/pause` stops a routine mid-way, and `/audit` shows every step.

It stops — and hands you the browser where it stopped — when:

- a step you marked sensitive is denied, or any step is denied at all: **the whole routine
  ends**, rather than skipping one step and carrying on into a half-filled form
- the element it recorded now matches two things, because picking one would be a guess
- none of the recorded handles match the page any more
- what it expected afterwards did not happen
- it reaches a `handback` step

## What it cannot do

2FA and one-time codes. CAPTCHAs. Sites that turn away automated browsers. A login that
expired. A checkout that changed its wording. In every one of those the answer is the same:
it says what stopped it and hands you the browser, on the right page, already logged in.

Switching to the on-screen browser surface does **not** get around bot detection —
`navigator.webdriver` is true either way, and measurement says the user-agent is the only
difference ([ADR 0002](adr/0002-browser-surfaces.md)).

**There is no reliability figure here, on purpose.** What has been measured is that a
routine survives a page redrawn to imitate drift — a renamed class, a changed form id, an
inserted banner — on one machine on one day. Whether your recording still works next month
is a thing to find out, not a thing to promise.
