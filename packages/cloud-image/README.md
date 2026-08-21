# Agentda on a box that isn't your laptop

Your bots stop when your laptop sleeps. This runs the daemon somewhere that doesn't.

```bash
docker build -f packages/cloud-image/Dockerfile -t agentda/daemon .
docker run -d --name agentda \
  -v /srv/agentda:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -p 127.0.0.1:4599:4599 \
  agentda/daemon
```

Your bots live in `/data/bots` on the volume. The container is disposable; the volume is
the thing to back up.

## Read this part before you use a subscription

**API keys are the credential this image is built for, and the vendor CLIs are deliberately
not in it.**

Anthropic and OpenAI both sell consumer subscriptions for a person at a computer. Neither
sanctions a hosted, always-on daemon running on a subscription login, and heavy automation
on consumer accounts has drawn rate-limiting, risk flags and bans. Putting `claude` or
`codex` in a server image would be an invitation to do exactly that, so they are not here.

If you do it anyway — by building your own image on top of this one — then at minimum: one
login per machine, never copy credentials between machines, and understand that the account
at risk is yours. This is the most policy-fragile thing in the whole project and no amount
of it working today makes it sanctioned.

An API key has none of that problem. It is metered, it is meant for programs, and the
provider chain in `bot.toml` takes one as easily as anything else.

## Reaching it

The control API binds to `0.0.0.0` **inside the container**, which is not the same as
binding it on a host — a container has its own network namespace, and what reaches it is
whatever you published. Publish it to loopback and come in over SSH, or publish it to a
tailnet address:

```bash
-p 127.0.0.1:4599:4599                 # then: ssh -L 4599:127.0.0.1:4599 box
-p 100.x.y.z:4599:4599                 # a tailnet address
```

The daemon answers only to hostnames it was told about — loopback by default. Reaching it as
anything else needs `AGENTDA_API_HOSTS=box.your-tailnet.ts.net`, and that is a deliberate
act, because a wildcard there is how a private daemon becomes a public one by accident.
Every data route still needs the per-run token the daemon prints on startup.

**Do not put this on a public interface.** The token is the only thing between the internet
and a machine that answers approval cards.

## What is in the image, and what isn't

Node, the workspace, and its dependencies. About 120 MB.

Not included: Playwright's browser (so browser hands need `playwright install chromium` in a
derived image), the vendor CLIs (see above), and any container runtime — so a bot's
[virtual desktop](../desktop-image/README.md) does not work from inside this one without
giving it a Docker socket, which is a much bigger decision than it looks.

## Verified

Built and run on 2026-08-21: the daemon starts, serves its API through a published loopback
port, refuses a request with no token (401), refuses one arriving under a hostname it was
not told about (403), and shuts down gracefully on `docker stop`. Not run for a week, and
not run against a real API key — see [USER_REQUEST.md](../../USER_REQUEST.md).
