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
RUN --mount=type=cache,target=/root/.npm \
    npm install -g openclaw@latest @walletconnect/sign-client@2

# ── Layer 3: OpenClawnch extension (changes every deploy) ────────────
# Copy just the tarball and install. With npm cache mount this is ~30s
# instead of ~2min.
COPY openclawnch.tgz /tmp/openclawnch.tgz
RUN --mount=type=cache,target=/root/.npm \
    npm install -g /tmp/openclawnch.tgz && rm /tmp/openclawnch.tgz

# ── Layer 4: Dirs, config, entrypoint (tiny, always rebuilt) ─────────
RUN mkdir -p /workspace /root/.openclaw \
    /root/.openclaw/agents/main/sessions \
    /root/.openclaw/credentials && \
    chmod 700 /root/.openclaw

COPY openclaw.json /root/.openclaw/openclaw.json
COPY openclaw.json /tmp/openclaw-clean.json

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV NODE_ENV="production"

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
    CMD curl -f http://localhost:18789/healthz || exit 1

EXPOSE 18789
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
