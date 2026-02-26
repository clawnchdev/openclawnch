# OpenClawnch Telegram — DeFi agent on Fly.io
# Image: ghcr.io/openclawnch/telegram
#
# This is the production Docker image for running OpenClawnch as a personal
# Telegram bot on Fly.io. Each user deploys their own instance — no shared
# infrastructure, no middleman.
#
# Required env vars (set via Fly secrets, NOT baked into image):
#   TELEGRAM_BOT_TOKEN   — from @BotFather
#   ANTHROPIC_API_KEY    — or OPENAI_API_KEY
#
# Optional:
#   WALLETCONNECT_PROJECT_ID — defaults to OpenClawnch's project ID
#
# Blocked:
#   CLAWNCHER_PRIVATE_KEY — entrypoint refuses to start if set

FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git curl build-essential python3 procps \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw + OpenClawnch (extension auto-registers via config)
RUN npm install -g openclaw@latest openclawnch@latest

RUN mkdir -p /workspace /root/.openclaw

# Pre-run doctor at build time to cache setup (saves ~2-3s on cold boot)
# This won't have secrets but it pre-downloads schemas, creates dirs, etc.
RUN openclaw doctor --fix 2>/dev/null || true

# Bake in config — Telegram channel + crypto extension enabled
COPY openclaw.json /root/.openclaw/openclaw.json
COPY openclaw.json /tmp/openclaw-clean.json

# Security: private key blocker + state persistence
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_OPTIONS="--max-old-space-size=1536"
ENV NODE_ENV="production"

# OpenClaw gateway health endpoint
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
    CMD curl -f http://localhost:18789/healthz || exit 1

EXPOSE 18789
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
