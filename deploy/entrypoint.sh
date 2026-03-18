#!/bin/bash
set -e

# ── OpenClawnch Telegram Entrypoint ──────────────────────────────────────
# Security-hardened startup for crypto operations on Fly.io.
#
# Runs as root initially to fix volume permissions from earlier deploys,
# then drops to openclawnch via gosu before starting the gateway.

# ── Fix volume ownership ────────────────────────────────────────────────
# The /workspace Fly volume may have dirs created as root by earlier deploys.
# Fix them before dropping privileges.
if [ "$(id -u)" = "0" ]; then
  chown -R openclawnch:openclawnch /workspace 2>/dev/null || true
fi

# ── Persist .openclawnch data across deploys ────────────────────────────
# Symlink ~/.openclawnch to /workspace/.openclawnch (persistent volume).
# Create symlinks for ALL possible HOME dirs since the process may run
# as root (HOME=/root) or as openclawnch (HOME=/home/openclawnch).
PERSIST_DIR="/workspace/.openclawnch"
mkdir -p "$PERSIST_DIR"

for LINK_DIR in /home/openclawnch/.openclawnch /root/.openclawnch; do
  if [ -d "$LINK_DIR" ] && [ ! -L "$LINK_DIR" ]; then
    cp -a "$LINK_DIR/." "$PERSIST_DIR/" 2>/dev/null || true
    rm -rf "$LINK_DIR"
  fi
  if [ ! -L "$LINK_DIR" ]; then
    ln -sf "$PERSIST_DIR" "$LINK_DIR"
  fi
done

chown -R openclawnch:openclawnch "$PERSIST_DIR" 2>/dev/null || true

# ── Private key warning (autosign mode) ─────────────────────────────
# If a private key is present, the user has opted into autosign mode.
# Warn loudly but don't block — they can toggle /walletsign at runtime.
if [ -n "$CLAWNCHER_PRIVATE_KEY" ]; then
  echo ""
  echo "================================================================"
  echo "  WARNING: CLAWNCHER_PRIVATE_KEY is set (autosign available)."
  echo ""
  echo "  The agent can sign transactions without wallet approval."
  echo "  Use /autosign to enable, /walletsign to disable."
  echo "  Default is wallet signing (WalletConnect)."
  echo ""
  echo "  Only use a dedicated hot wallet with limited funds."
  echo "================================================================"
  echo ""
fi

if [ -n "$PRIVATE_KEY" ]; then
  echo ""
  echo "================================================================"
  echo "  WARNING: PRIVATE_KEY is set. Mapping to CLAWNCHER_PRIVATE_KEY."
  echo "================================================================"
  echo ""
  export CLAWNCHER_PRIVATE_KEY="$PRIVATE_KEY"
fi

# ── Restore clean config on each start ──────────────────────────────────
# Prevents drift from doctor/configure writes during the previous session.
# The baked config has absolute paths for plugin resolution.
cp /tmp/openclaw-clean.json "$HOME/.openclaw/openclaw.json"

# ── Inject webhook secret into config ───────────────────────────────────
# OPENCLAW_TG_WEBHOOK_SECRET is set as a machine env var by the deploy CLI.
# OpenClaw's Telegram channel needs it in the config file.
if [ -n "$OPENCLAW_TG_WEBHOOK_SECRET" ]; then
  # Use node to safely merge JSON (no jq in slim image)
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/openclaw.json', 'utf8'));
    cfg.channels = cfg.channels || {};
    cfg.channels.telegram = cfg.channels.telegram || {};
    cfg.channels.telegram.webhookSecret = process.env.OPENCLAW_TG_WEBHOOK_SECRET;
    fs.writeFileSync(process.env.HOME + '/.openclaw/openclaw.json', JSON.stringify(cfg, null, 2));
  "
fi

# ── Create required directories ─────────────────────────────────────────
# Doctor flags these as CRITICAL if missing; create them before gateway start.
mkdir -p "$HOME/.openclaw/agents/main/sessions" \
         "$HOME/.openclaw/credentials"
chmod 700 "$HOME/.openclaw"
chmod 600 "$HOME/.openclaw/openclaw.json"

# ── Persist identity/devices across restarts ────────────────────────────
# OpenClaw generates an identity (device ID, auth tokens) on first run.
# We symlink these to the persistent Fly volume so they survive restarts.
# Fix ownership: earlier deploys created these dirs as root; the app runs
# as openclawnch and needs write access.
mkdir -p /workspace/.openclaw-state/identity \
         /workspace/.openclaw-state/devices \
         /workspace/.openclaw-state/plans

rm -rf "$HOME/.openclaw/identity" "$HOME/.openclaw/devices"
ln -sf /workspace/.openclaw-state/identity "$HOME/.openclaw/identity"
ln -sf /workspace/.openclaw-state/devices "$HOME/.openclaw/devices"

# ── Persist sender approvals (pairing) across restarts ──────────────────
# OpenClaw stores approved Telegram senders in /root/.openclaw/credentials/.
# Without this symlink, every reboot wipes pairing and the user must re-pair.
mkdir -p /workspace/.openclaw-state/credentials
rm -rf "$HOME/.openclaw/credentials"
ln -sf /workspace/.openclaw-state/credentials "$HOME/.openclaw/credentials"

# ── Persist agent sessions across restarts ──────────────────────────────
# Conversation history lives in sessions/. Symlink to volume for continuity.
mkdir -p /workspace/.openclaw-state/sessions
rm -rf "$HOME/.openclaw/agents/main/sessions"
ln -sf /workspace/.openclaw-state/sessions "$HOME/.openclaw/agents/main/sessions"

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
  const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/openclaw.json', 'utf8'));

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
    anthropic: 'anthropic/claude-sonnet-4-6',
    openrouter: 'openrouter/anthropic/claude-sonnet-4-6',
    openai: 'openai/gpt-4o',
    bankr: 'bankr/claude-sonnet-4.6',
  };
  cfg.agents.defaults.model.primary = models[provider] || models.anthropic;

  // When using Bankr, strip the provider config if no BANKR_LLM_KEY is set
  // (avoids OpenClaw trying to init a broken provider)
  if (provider !== 'bankr' && !process.env.BANKR_LLM_KEY) {
    if (cfg.models && cfg.models.providers && cfg.models.providers.bankr) {
      delete cfg.models.providers.bankr;
      // Clean up empty providers/models objects
      if (Object.keys(cfg.models.providers).length === 0) {
        delete cfg.models.providers;
        delete cfg.models;
      }
    }
  }

  fs.writeFileSync(process.env.HOME + '/.openclaw/openclaw.json', JSON.stringify(cfg, null, 2));
  console.log('LLM provider: ' + provider + ' → model: ' + cfg.agents.defaults.model.primary);
"

# ── Start Botcoin miner (background) ────────────────────────────────────
# Runs alongside the gateway. Logs to stdout (visible in fly logs).
# Uses BANKR_API_KEY from Fly secrets.
if [ -n "$BANKR_API_KEY" ]; then
  echo "Starting Botcoin miner (background, delay=70s, infinite loops)..."
  python3 -u /opt/botcoin/mine.py --loops 0 --delay 70 --save-dir /workspace/botcoin-runs &
  MINER_PID=$!
  echo "Miner PID: $MINER_PID"
else
  echo "BANKR_API_KEY not set — miner disabled."
fi

# ── Start OpenClaw gateway ──────────────────────────────────────────────
# --bind lan: bind to 0.0.0.0 so Fly's proxy can reach the gateway.
# --allow-unconfigured: skip interactive setup prompts in container.
echo "Starting OpenClawnch (Telegram mode)..."

# Debug: log what we're about to run
echo "Gateway config:"
node -e "const c=JSON.parse(require('fs').readFileSync(process.env.HOME + '/.openclaw/openclaw.json','utf8')); console.log(JSON.stringify({gateway:c.gateway,channels:c.channels,plugins:c.plugins?{entries:Object.keys(c.plugins.entries||{})}:null},null,2))"

# Ensure all dirs created above are owned by openclawnch (we're still root here)
if [ "$(id -u)" = "0" ]; then
  chown -R openclawnch:openclawnch "$HOME/.openclaw" "$HOME/.openclawnch" /workspace/botcoin-runs 2>/dev/null || true
  # Drop to non-root user for the actual gateway process
  exec gosu openclawnch openclaw gateway --port 18789 --bind lan --allow-unconfigured 2>&1
else
  exec openclaw gateway --port 18789 --bind lan --allow-unconfigured 2>&1
fi
