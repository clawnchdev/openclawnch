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

# ── Persist identity/devices across restarts ────────────────────────────
# OpenClaw generates an identity (device ID, auth tokens) on first run.
# We symlink these to the persistent Fly volume so they survive restarts.
mkdir -p /workspace/.openclaw-state/identity \
         /workspace/.openclaw-state/devices

rm -rf /root/.openclaw/identity /root/.openclaw/devices
ln -sf /workspace/.openclaw-state/identity /root/.openclaw/identity
ln -sf /workspace/.openclaw-state/devices /root/.openclaw/devices

# ── Persist WalletConnect session ───────────────────────────────────────
# The WC pairing is precious — losing it means the user has to re-scan
# the QR code. Store on the persistent volume.
mkdir -p /workspace/.openclaw-state/wc
export WALLETCONNECT_SESSION="/workspace/.openclaw-state/wc/session.json"

# ── Persist transaction history ─────────────────────────────────────────
mkdir -p /workspace/.openclaw-state/tx
export OPENCLAWNCH_TX_DIR="/workspace/.openclaw-state/tx"

# ── Skip doctor on boot (pre-ran at build time) ────────────────────────
# Only run doctor if this is the first-ever boot (no identity dir yet).
if [ ! -f /workspace/.openclaw-state/identity/.initialized ]; then
  echo "First boot — running openclaw doctor..."
  openclaw doctor --fix 2>/dev/null || true
  touch /workspace/.openclaw-state/identity/.initialized
fi

# ── Start OpenClaw gateway ──────────────────────────────────────────────
# --bind lan: bind to 0.0.0.0 so Fly's proxy can reach the gateway.
# Default is loopback (127.0.0.1) which is unreachable from Fly proxy.
echo "Starting OpenClawnch (Telegram mode)..."
exec openclaw gateway --port 18789 --bind lan --verbose
