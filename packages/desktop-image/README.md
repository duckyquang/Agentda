# The bot's desktop

A whole Linux desktop in a container, for work a browser cannot reach. It is not your
desktop: your screen, your keyboard and your windows are untouched while a bot uses it.

## Build it

```bash
docker build -t agentda/desktop:dev packages/desktop-image
```

Any container runtime works — Docker Desktop, OrbStack, colima, podman — as long as
`docker` on your PATH talks to it. Nothing is published to a registry: shipping a prebuilt
desktop image is a supply-chain commitment this project has not made.

## Give a bot one

```toml
# bot.toml
desktop = true
auto_approve = ["mcp__desktop__desktop_screenshot", "mcp__desktop__desktop_where"]
```

Looking is free; launching, clicking, typing and key presses are gated like anything else
that acts. The bot's desktop state lives in `desktop/` inside its own directory, so a login
it does survives the container it was done in.

## Watching it

The container publishes noVNC on a random loopback port:

```bash
docker port agentda-desktop-<bot>
```

Open that in a browser for a live view. It is bound to `127.0.0.1` deliberately.

## What it costs, measured

On an M4 Pro Mac with Docker Desktop, 2026-08-21: 403 MB image, **0.8 s** from `docker run`
to a usable desktop, ~60 MB while running. Docker Desktop itself is 807 MB — the runtime is
the expensive part, not the desktop. Full reasoning in
[ADR 0008](../../docs/adr/0008-virtual-desktop.md).

## What it cannot do

Run macOS or Windows applications. A Linux container runs Linux and web apps; Mail and Excel
are not reachable this way. There is also no OCR and no accessibility tree, so a bot clicks
at coordinates and has to look first — genuinely worse than the browser surface, which reads
a real accessibility tree. A bot should prefer the browser whenever the task is reachable in
one.
