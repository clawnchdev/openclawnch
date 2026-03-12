# Setup Guide

## First 5 Minutes

No matter which path you choose, here's the fastest route to a working agent:

1. **Get two keys** — an LLM API key and a channel token
2. **Run `openclawnch init`** — the wizard validates both keys and writes your `.env`
3. **Start the agent** — `node bin/openclawnch.mjs`
4. **Message your bot** — it walks you through onboarding (persona, capabilities, wallet)
5. **Run `/setup` in chat** — confirms which tools are ready

You're done when the startup banner shows green checks for LLM and Channel, and `/setup` reports tools ready.

---

## Choose Your Path

| Path | Best for | Time to first message |
|------|----------|-----------------------|
| [Quick start](#quick-start) | Local dev, Mac mini, home server | ~3 minutes |
| [Add to existing OpenClaw](#add-to-existing-openclaw) | Already running OpenClaw | ~1 minute |
| [Docker](#docker) | Self-hosted VPS or NAS | ~5 minutes |
| [Fly.io](#flyio) | Managed cloud, zero-maintenance | ~10 minutes |

All paths give you the same 42 tools, 87 commands, and 47 services.

---

## Quick Start

The default path. Run directly on your machine.

### 1. Clone and install

```bash
git clone https://github.com/clawnch/openclawnch.git
cd openclawnch
pnpm install && pnpm build
```

### 2. Run the setup wizard

```bash
node bin/openclawnch.mjs init
```

The wizard walks you through four steps:

1. **LLM provider** — pick Anthropic, OpenRouter, OpenAI, or Bankr. Paste your key; it validates against the live API.
2. **Channel** — pick Telegram, Discord, or Slack. Paste your token; it confirms the bot exists.
3. **Wallet mode** — WalletConnect (recommended), private key, Bankr, or skip.
4. **Optional APIs** — Alchemy, 0x, Basescan, Herd. Press Enter to skip any.

It writes a `.env` file in the current directory. You can also run `openclawnch init --print` to get export commands instead.

### 3. Start the agent

```bash
node bin/openclawnch.mjs
```

You should see:

```
  OpenClawnch v0.1.0  (OpenClaw v2026.3.8)

  ✓ LLM      Anthropic
  ✓ Channel  Telegram
  ! Wallet   Not configured — use /connect in chat
```

If LLM or Channel show `✗`, the agent won't start. Re-run `openclawnch init` or check your `.env`.

### 4. Message your bot

Open your channel (e.g. Telegram) and send any message. The bot replies with a welcome screen and walks you through:

- **Persona** — Professional, Degen, Chill, Technical, or Mentor
- **Capabilities** — select which feature categories you want active
- **Wallet** — connect via `/connect` (WalletConnect QR code to your phone wallet)

### 5. Verify

Run these commands in chat:

| Command | What it shows |
|---------|---------------|
| `/setup` | X/42 tools ready, which keys are missing, where to get them |
| `/doctor` | Full diagnostic: wallet, RPC, secrets, channels, services |
| `/wallet` | Wallet address and balance (after connecting) |

---

## Add to Existing OpenClaw

If you already have OpenClaw running on any channel, install the crypto extension:

```bash
openclaw plugins install @clawnch/openclaw-crypto
```

Set environment variables for your wallet and APIs (see [Environment Variables](#environment-variables) below), then restart OpenClaw. The extension registers its tools, commands, and hooks automatically.

This is the lightest path — no new binary, no container, no migration. Your existing channels, config, and history stay intact.

After restart, run `/setup` in chat to confirm tools are registered.

---

## Docker

Self-hosted with Docker Compose.

### 1. Build

```bash
git clone https://github.com/clawnch/openclawnch.git
cd openclawnch
pnpm install && pnpm build
npm run deploy:pack
```

### 2. Configure

```bash
cd deploy
cp .env.example .env
```

Edit `.env` — fill in your LLM key and at least one channel token. See [`deploy/.env.example`](../deploy/.env.example) for the full annotated list.

### 3. Start

```bash
docker compose up -d
```

| Action | Command |
|--------|---------|
| View logs | `docker compose logs -f` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` |

State persists in a Docker volume. Your `.env` stays on disk — don't commit it.

### 4. Verify

Message your bot and run `/setup` to confirm tool registration.

---

## Fly.io

Managed cloud deploy. Auto-suspends when idle (~$5/month), wakes on incoming messages.

### Prerequisites

- [flyctl](https://fly.io/docs/flyctl/install/) — `curl -L https://fly.io/install.sh | sh`
- Docker Desktop (must be running for local image builds)
- Fly account — `fly auth signup` or `fly auth login`

### Option A: One-command deploy

```bash
git clone https://github.com/clawnch/openclawnch.git
cd openclawnch
pnpm install && pnpm build

node bin/openclawnch.mjs deploy \
  --telegram-token "YOUR_BOT_TOKEN" \
  --fly-token "YOUR_FLY_TOKEN" \
  --llm-key "YOUR_LLM_KEY"
```

The deploy command validates all tokens, provisions a Fly Machine with a persistent volume, waits for health check, and verifies the Telegram webhook. It prints the bot link when done.

### Option B: Manual Fly deploy

```bash
pnpm install && pnpm build
npm run deploy:pack
cd deploy
cp fly.template.toml fly.toml
```

Edit `fly.toml`:
- Replace `YOUR_APP_NAME` with a unique name (e.g. `myname-clawnch`)
- Replace `YOUR_REGION` with nearest region (`ewr`, `lax`, `lhr`, `nrt`)

```bash
fly apps create <your-app-name>
fly volumes create workspace --region <your-region> --size 1 -a <your-app-name>

# Set secrets:
fly secrets set TELEGRAM_BOT_TOKEN="<your-bot-token>" -a <your-app-name>
fly secrets set ANTHROPIC_API_KEY="<your-api-key>" -a <your-app-name>
fly secrets set OPENCLAWNCH_LLM_PROVIDER=anthropic -a <your-app-name>

# Optional:
fly secrets set WALLETCONNECT_PROJECT_ID="<your-project-id>" -a <your-app-name>

# Deploy:
fly deploy --local-only
```

### Pairing

Message your bot on Telegram. It replies with a pairing code (e.g. `ABC-1234`). Approve it:

```bash
fly ssh console -a <your-app-name> -C "openclaw pairing approve telegram <CODE>"
```

### Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot doesn't reply | Gateway takes ~60s to boot. Wait and try again. |
| "webhook not set" in logs | Bot token is wrong. |
| "listening" but no response | Send `/start` to the bot. |
| Check logs | `fly logs -a <your-app-name>` |

### Cost

- ~$5/month with auto-suspend (pauses when idle)
- ~$12/month always-on
- You pay your own LLM and Fly bills

---

## Running as a Background Service

### macOS (launchd)

```bash
cat > ~/Library/LaunchAgents/ch.openclawn.agent.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ch.openclawn.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/openclawnch/bin/openclawnch.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANTHROPIC_API_KEY</key>
    <string>sk-ant-...</string>
    <key>TELEGRAM_BOT_TOKEN</key>
    <string>...</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/openclawnch.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/openclawnch.err</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/ch.openclawn.agent.plist
```

### Linux (systemd)

```bash
sudo cat > /etc/systemd/system/openclawnch.service << 'EOF'
[Unit]
Description=OpenClawnch
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/openclawnch
ExecStart=/usr/bin/node bin/openclawnch.mjs
Restart=always
EnvironmentFile=/path/to/openclawnch/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now openclawnch
```

---

## Channels

The crypto extension is channel-agnostic. All 42 tools and 87 commands work identically on every channel.

| Channel | How to enable | Notes |
|---------|--------------|-------|
| **Telegram** | Set `TELEGRAM_BOT_TOKEN` | Production-tested. Tappable commands, deep links, webhooks. |
| **Discord** | Set `DISCORD_TOKEN` + `channels.discord.enabled: true` in `openclaw.json` | Slash commands auto-register. |
| **Slack** | Set `SLACK_BOT_TOKEN` + `channels.slack.enabled: true` in `openclaw.json` | Works in channels and DMs. |
| **Signal** | Set up [signal-cli](https://github.com/AsamK/signal-cli) bridge | Requires a dedicated Signal number. |
| **WhatsApp** | Set up [WhatsApp Web](https://github.com/nicehash/whatsapp-web.js) bridge | Requires WhatsApp Business account. |
| **iMessage** | macOS only — native bridge via Messages.app | Only works on bare metal Mac. |
| **LINE** | Set up [LINE Messaging API](https://developers.line.biz/) | Requires LINE Official Account. |

### Multi-channel

You can run multiple channels at once. Each user gets isolated sessions regardless of which channel they message from. The `channel-sender.ts` abstraction routes replies to the correct channel automatically.

---

## Wallet Modes

Three ways to connect a wallet. Pick one or switch at any time via commands.

| Mode | Command | Key custody | Best for |
|------|---------|------------|----------|
| **WalletConnect** | `/connect` | Your phone wallet | Production — agent never holds keys |
| **Private key** | Set `CLAWNCHER_PRIVATE_KEY` env var | Local/Keychain | Headless servers, testing, auto-sign |
| **Bankr** | `/connect_bankr` or set `BANKR_API_KEY` | Custodial (Bankr) | Zero-friction, multi-chain |

### WalletConnect (recommended)

Every transaction goes to your phone wallet (MetaMask, Rainbow, Coinbase, etc.) for approval. The agent never holds your private keys.

Requires `WALLETCONNECT_PROJECT_ID` — get one free at [cloud.reown.com](https://cloud.reown.com).

Shortcut commands: `/connect_metamask`, `/connect_rainbow`, `/connect_coinbase`, `/connect_trust`, `/connect_zerion`, `/connect_uniswap`, `/connect_rabby`, `/connect_other`.

### Private key

For headless or automated setups:

```bash
CLAWNCHER_PRIVATE_KEY=0x...
ALLOW_PRIVATE_KEY_MODE=true
```

The agent signs transactions directly. Use `/autosign` to skip confirmation prompts, or `/walletsign` to require per-tx approval.

### Bankr

Custodial wallet via Bankr Agent API. No private key management, no phone approval. Supports multi-chain operations out of the box.

Set `BANKR_API_KEY` and use `/connect_bankr`.

---

## Environment Variables

See [`deploy/.env.example`](../deploy/.env.example) for the full annotated list.

| Group | Variables | Required? |
|-------|-----------|-----------|
| LLM | `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `BANKR_LLM_KEY` | At least one |
| Channel | `TELEGRAM_BOT_TOKEN`, `DISCORD_TOKEN`, `SLACK_BOT_TOKEN` | At least one |
| Wallet | `WALLETCONNECT_PROJECT_ID`, `CLAWNCHER_PRIVATE_KEY`, `BANKR_API_KEY` | Optional |
| RPC | `CLAWNCHER_RPC_URL`, `ALCHEMY_API_KEY` | Optional (defaults to public RPCs) |
| APIs | `ZEROX_API_KEY`, `BASESCAN_API_KEY`, `HERD_ACCESS_TOKEN`, etc. | Optional (per-tool) |

The `openclawnch init` wizard configures all required variables and validates them. For optional keys, use `/setup` in chat to see which tools need what.

---

## Diagnostic Commands

Once your bot is running, these commands help you verify and troubleshoot:

| Command | What it does |
|---------|-------------|
| `/setup` | Shows tool readiness (X/42 ready), lists missing keys with links to get them |
| `/doctor` | Runs 13 checks: wallet, RPC, secrets, APIs, channels, scheduler, heartbeat |
| `/wallet` | Shows connected wallet address and balances |
| `/flykeys` | Set API keys on Fly.io without redeploying |
| `/flyrestart` | Restart the bot to pick up new keys |

---

## Prerequisites

- **Node.js 22+** — `node --version`
- **pnpm** — `npm install -g pnpm` (or `npx pnpm`)
- **An LLM API key** — at least one of:
  - [Anthropic](https://console.anthropic.com/settings/keys) (recommended, `sk-ant-`)
  - [OpenRouter](https://openrouter.ai/keys) (multi-model, `sk-or-`)
  - [OpenAI](https://platform.openai.com/api-keys) (`sk-`)
  - [Bankr Gateway](https://bankr.bot/api) (pay with crypto)

### Optional keys

| Key | What it unlocks |
|-----|-----------------|
| `WALLETCONNECT_PROJECT_ID` | WalletConnect wallet pairing ([cloud.reown.com](https://cloud.reown.com)) |
| `ALCHEMY_API_KEY` | Higher-tier RPC access |
| `ZEROX_API_KEY` | 0x DEX aggregator |
| `BASESCAN_API_KEY` | Block explorer queries |
| `HERD_ACCESS_TOKEN` | Token investigation/auditing |
| `BANKR_API_KEY` | Bankr custodial wallet + automations |
