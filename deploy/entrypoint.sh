#!/bin/bash
set -e

# ── OpenClawnch Telegram Entrypoint ──────────────────────────────────────
# Security-hardened startup for crypto operations on Fly.io.

# ── SECURITY: Refuse to start with private keys ─────────────────────────
# OpenClawnch Telegram mode uses WalletConnect exclusively for transaction
# signing. If a private key is present, someone misconfigured the deploy —
# refuse to start rather than risk key exposure.

if [ -n "$CLAWNCHER_PRIVATE_KEY" ]; then
  echo ""
  echo "================================================================"
  echo "  SECURITY ERROR: CLAWNCHER_PRIVATE_KEY is set."
  echo ""
  echo "  OpenClawnch Telegram mode requires WalletConnect for"
  echo "  transaction signing. Private keys must NEVER be stored"
  echo "  on the machine."
  echo ""
  echo "  Fix: Remove the secret and use /connect in Telegram"
  echo "  to pair your phone wallet."
  echo ""
  echo "    fly secrets unset CLAWNCHER_PRIVATE_KEY -a <your-app>"
  echo "================================================================"
  echo ""
  exit 1
fi

if [ -n "$PRIVATE_KEY" ]; then
  echo ""
  echo "================================================================"
  echo "  SECURITY ERROR: PRIVATE_KEY is set."
  echo ""
  echo "  OpenClawnch Telegram mode does not accept raw private keys."
  echo "  Use WalletConnect via /connect in Telegram instead."
  echo ""
  echo "    fly secrets unset PRIVATE_KEY -a <your-app>"
  echo "================================================================"
  echo ""
  exit 1
fi

# ── Restore clean config on each start ──────────────────────────────────
# Prevents drift from doctor/configure writes during the previous session.
# The baked config has absolute paths for plugin resolution.
cp /tmp/openclaw-clean.json /root/.openclaw/openclaw.json

# ── Inject webhook secret into config ───────────────────────────────────
# OPENCLAW_TG_WEBHOOK_SECRET is set as a machine env var by the deploy CLI.
# OpenClaw's Telegram channel needs it in the config file.
if [ -n "$OPENCLAW_TG_WEBHOOK_SECRET" ]; then
  # Use node to safely merge JSON (no jq in slim image)
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
    cfg.channels = cfg.channels || {};
    cfg.channels.telegram = cfg.channels.telegram || {};
    cfg.channels.telegram.webhookSecret = process.env.OPENCLAW_TG_WEBHOOK_SECRET;
    fs.writeFileSync('/root/.openclaw/openclaw.json', JSON.stringify(cfg, null, 2));
  "
fi

# ── Create required directories ─────────────────────────────────────────
# Doctor flags these as CRITICAL if missing; create them before gateway start.
mkdir -p /root/.openclaw/agents/main/sessions \
         /root/.openclaw/credentials
chmod 700 /root/.openclaw
chmod 600 /root/.openclaw/openclaw.json

# ── Persist identity/devices across restarts ────────────────────────────
# OpenClaw generates an identity (device ID, auth tokens) on first run.
# We symlink these to the persistent Fly volume so they survive restarts.
mkdir -p /workspace/.openclaw-state/identity \
         /workspace/.openclaw-state/devices

rm -rf /root/.openclaw/identity /root/.openclaw/devices
ln -sf /workspace/.openclaw-state/identity /root/.openclaw/identity
ln -sf /workspace/.openclaw-state/devices /root/.openclaw/devices

# ── Persist sender approvals (pairing) across restarts ──────────────────
# OpenClaw stores approved Telegram senders in /root/.openclaw/credentials/.
# Without this symlink, every reboot wipes pairing and the user must re-pair.
mkdir -p /workspace/.openclaw-state/credentials
rm -rf /root/.openclaw/credentials
ln -sf /workspace/.openclaw-state/credentials /root/.openclaw/credentials

# ── Persist agent sessions across restarts ──────────────────────────────
# Conversation history lives in sessions/. Symlink to volume for continuity.
mkdir -p /workspace/.openclaw-state/sessions
rm -rf /root/.openclaw/agents/main/sessions
ln -sf /workspace/.openclaw-state/sessions /root/.openclaw/agents/main/sessions

# ── Persist WalletConnect session ───────────────────────────────────────
# The WC pairing is precious — losing it means the user has to re-approve
# in their wallet. Store on the persistent volume.
mkdir -p /workspace/.openclaw-state/wc
export WALLETCONNECT_SESSION="/workspace/.openclaw-state/wc/session.json"

# ── Persist transaction history ─────────────────────────────────────────
mkdir -p /workspace/.openclaw-state/tx
export OPENCLAWNCH_TX_DIR="/workspace/.openclaw-state/tx"

# ── No doctor on boot ───────────────────────────────────────────────────
# Doctor was pre-run at build time (Dockerfile step 7). Running it again
# on boot is counterproductive — it rewrites the config, migrating keys
# and potentially stripping gateway.mode. We create all needed dirs above
# instead of relying on doctor --fix.

# ── Generate gateway auth token ─────────────────────────────────────────
# Non-loopback binds require auth. Generate a random token on each boot.
# This token is internal only (Fly proxy → gateway); not exposed externally.
GATEWAY_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
export OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN"

# Inject token and provider-specific model into config
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));

  // Gateway auth token
  cfg.gateway = cfg.gateway || {};
  cfg.gateway.auth = cfg.gateway.auth || {};
  cfg.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;

  // Set model based on LLM provider
  const provider = process.env.OPENCLAWNCH_LLM_PROVIDER || 'anthropic';
  cfg.agents = cfg.agents || {};
  cfg.agents.defaults = cfg.agents.defaults || {};
  cfg.agents.defaults.model = cfg.agents.defaults.model || {};

  const models = {
    anthropic: 'anthropic/claude-sonnet-4-20250514',
    openrouter: 'openrouter/anthropic/claude-sonnet-4-20250514',
    openai: 'openai/gpt-4o',
  };
  cfg.agents.defaults.model.primary = models[provider] || models.anthropic;

  fs.writeFileSync('/root/.openclaw/openclaw.json', JSON.stringify(cfg, null, 2));
  console.log('LLM provider: ' + provider + ' → model: ' + cfg.agents.defaults.model.primary);
"

# ── Start OpenClaw gateway ──────────────────────────────────────────────
# --bind lan: bind to 0.0.0.0 so Fly's proxy can reach the gateway.
# --allow-unconfigured: skip interactive setup prompts in container.
echo "Starting OpenClawnch (Telegram mode)..."

# Debug: log what we're about to run
echo "Gateway config:"
node -e "const c=JSON.parse(require('fs').readFileSync('/root/.openclaw/openclaw.json','utf8')); console.log(JSON.stringify({gateway:c.gateway,channels:c.channels,plugins:c.plugins?{entries:Object.keys(c.plugins.entries||{})}:null},null,2))"

exec openclaw gateway --port 18789 --bind lan --allow-unconfigured 2>&1
