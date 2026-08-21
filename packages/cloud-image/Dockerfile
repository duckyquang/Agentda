# Agentda on a box that isn't your laptop (PLAN Phase 5).
#
# API keys are the credential this is built for, and the only one either vendor
# sanctions for hosted automation. The vendor CLIs are deliberately NOT in this
# image: shipping them would invite people to put a consumer subscription login
# on a server, which is the most policy-fragile thing this project could do.
# See packages/cloud-image/README.md.
FROM node:22-bookworm-slim AS build

# better-sqlite3 builds from source on the architectures we care about.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# The lockfile first, so a code change does not re-resolve the world.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/
COPY apps/daemon/package.json apps/daemon/
COPY apps/desktop/package.json apps/desktop/
COPY packages/core/package.json packages/core/
COPY packages/mcp-agentda/package.json packages/mcp-agentda/
COPY packages/mcp-browser/package.json packages/mcp-browser/
COPY packages/mcp-desktop/package.json packages/mcp-desktop/
COPY packages/mcp-email/package.json packages/mcp-email/
COPY packages/provider-api/package.json packages/provider-api/
COPY packages/provider-claude/package.json packages/provider-claude/
COPY packages/provider-codex/package.json packages/provider-codex/
COPY packages/watch/package.json packages/watch/
RUN pnpm install --frozen-lockfile

COPY . .

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -d /home/agentda agentda

WORKDIR /app
COPY --from=build --chown=agentda /app /app

# Bots and state live outside the image, so the container is disposable and the
# thing you actually care about is a volume you can back up.
ENV AGENTDA_HOME=/data \
    AGENTDA_BOTS=/data/bots \
    AGENTDA_API_PORT=4599 \
    # Inside a container this is not the same as binding 0.0.0.0 on a host: a
    # container has its own network namespace, and what reaches it is whatever
    # the operator published. Publish it to loopback or a tailnet address.
    AGENTDA_API_BIND=0.0.0.0
VOLUME ["/data"]

USER agentda
EXPOSE 4599

# The control API binds to loopback inside the container. Reaching it from
# outside is a deliberate act — a tailnet, or an SSH tunnel — and never a
# published port on a public interface. The README says why at length.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/daemon/src/index.ts"]
