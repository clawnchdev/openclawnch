# OpenClawnch Telegram — DeFi agent on Fly.io
#
# Layer strategy for fast deploys:
#   1. System deps (rarely changes)         — cached
#   2. OpenClaw + WalletConnect (weekly)    — cached
#   3. OpenClawnch extension (every deploy) — fast, just JS files
#   4. Config + entrypoint (every deploy)   — tiny files
#
# Required env vars (set via Fly secrets, NOT baked into image):
#   TELEGRAM_BOT_TOKEN   — from @BotFather
#   ANTHROPIC_API_KEY    — or OPENROUTER_API_KEY or OPENAI_API_KEY
#
# Optional:
#   WALLETCONNECT_PROJECT_ID — for mobile wallet pairing

FROM node:22-slim

# ── Layer 1: System deps (cached unless base image changes) ──────────
RUN apt-get update && apt-get install -y \
    git curl build-essential python3 procps \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Heavy npm globals (cached until openclaw or WC updates) ─
# These two are ~2min to install. Only bust this cache when upgrading.
# IMPORTANT: Pin openclaw version to match package.json peer dep range.
# Using @latest in CI can break builds if upstream introduces breaking changes.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g openclaw@2026.3.8 @walletconnect/sign-client@2

# ── Layer 3: OpenClawnch extension (changes every deploy) ────────────
# Copy just the tarball and install. With npm cache mount this is ~30s
# instead of ~2min.
COPY openclawnch.tgz /tmp/openclawnch.tgz
RUN --mount=type=cache,target=/root/.npm \
    mkdir -p /usr/local/lib/node_modules/@clawnch/openclawnch && \
    tar xzf /tmp/openclawnch.tgz -C /usr/local/lib/node_modules/@clawnch/openclawnch --strip-components=1 && \
    rm /tmp/openclawnch.tgz
# Most runtime deps are bundled into the output via tsdown noExternal
# (see tsdown.config.ts).  Only @uniswap/v4-sdk and @uniswap/v3-sdk stay
# external because they have a broken `ethers/lib/utils` CJS import that
# rolldown can't resolve.
# Note: We use npm pack + tar instead of npm install because @uniswap/v4-sdk
# ships with broken "workspace:*" deps that npm install can't resolve.
RUN --mount=type=cache,target=/root/.npm \
    DEST=/usr/local/lib/node_modules/@clawnch/openclawnch/node_modules && \
    mkdir -p "$DEST" && cd /tmp && mkdir _deps && cd _deps && \
    for pkg in @uniswap/v4-sdk @uniswap/v3-sdk; do \
      npm pack "$pkg" && \
      dir="$DEST/$pkg" && mkdir -p "$dir" && \
      tarball=$(ls *.tgz | tail -1) && \
      tar xzf "$tarball" --strip-components=1 -C "$dir" && \
      rm "$tarball"; \
    done && \
    rm -rf /tmp/_deps
# MetaMask Smart Accounts Kit — install globally (has transitive deps)
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @metamask/smart-accounts-kit@0.4.0-beta.1

# ── Layer 4: Dirs, config, entrypoint (tiny, always rebuilt) ─────────
# Create non-root user for security
RUN groupadd -r openclawnch && useradd -r -g openclawnch -d /home/openclawnch -s /sbin/nologin openclawnch

RUN mkdir -p /workspace /home/openclawnch/.openclaw \
    /home/openclawnch/.openclaw/agents/main/sessions \
    /home/openclawnch/.openclaw/credentials \
    /home/openclawnch/.openclawnch && \
    chmod 700 /home/openclawnch/.openclaw /home/openclawnch/.openclawnch && \
    chown -R openclawnch:openclawnch /workspace /home/openclawnch

COPY openclaw.json /home/openclawnch/.openclaw/openclaw.json
COPY openclaw.json /tmp/openclaw-clean.json
RUN chown openclawnch:openclawnch /home/openclawnch/.openclaw/openclaw.json

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV NODE_ENV="production"
ENV HOME="/home/openclawnch"

# Note: Fly.io ignores Dockerfile HEALTHCHECK — it uses its own TCP/HTTP
# health checks configured in fly.toml. This HEALTHCHECK is kept for local
# Docker testing and docker-compose deployments.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
    CMD curl -f http://localhost:18789/healthz || exit 1

EXPOSE 18789
WORKDIR /workspace

# Install gosu for dropping privileges in entrypoint after volume fixup
RUN apt-get update && apt-get install -y gosu && rm -rf /var/lib/apt/lists/*

# Entrypoint runs as root to fix volume ownership, then drops to openclawnch
ENTRYPOINT ["/entrypoint.sh"]
