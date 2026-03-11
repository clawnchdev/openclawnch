# Setup Guide

Four ways to run OpenClawnch, depending on what you already have and where you want to run it.

| Path | Best for | Requires |
|------|----------|----------|
| [Add to existing OpenClaw](#add-to-existing-openclaw) | Already running OpenClaw | OpenClaw installed |
| [Bare metal](#bare-metal) | Mac mini, home server, dev machine | Node.js 22+ |
| [Docker](#docker) | Self-hosted VPS or NAS | Docker |
| [Fly.io](#flyio) | Managed cloud, Telegram-first | Fly account, Docker |

All four paths give you the same 42 tools, 87 commands, and 47 services. The crypto extension works identically regardless of how you run it.

---

## Prerequisites (all paths)

- **Node.js 22+** — `node --version`
- **pnpm** — `npm install -g pnpm` (or use `npx pnpm`)
- **An LLM API key** — at least one of:
  - [Anthropic](https://console.anthropic.com/settings/keys) (recommended, starts with `sk-ant-`)
  - [OpenRouter](https://openrouter.ai/keys) (multi-model, starts with `sk-or-`)
  - [OpenAI](https://platform.openai.com/api-keys) (starts with `sk-`)
  - [Bankr Gateway](https://bankr.bot/api) (pay with crypto)

### Optional keys

| Key | What it unlocks |
|-----|-----------------|
| `WALLETCONNECT_PROJECT_ID` | WalletConnect wallet pairing ([get one](https://cloud.reown.com)) |
| `ALCHEMY_API_KEY` | Higher-tier RPC access |
| `ZEROX_API_KEY` | 0x DEX aggregator |
| `BASESCAN_API_KEY` | Block explorer queries |
| `HERD_ACCESS_TOKEN` | Token investigation/auditing |
| `BANKR_API_KEY` | Bankr custodial wallet + automations |

See [`deploy/.env.example`](../deploy/.env.example) for the full list of environment variables.

---

## Add to existing OpenClaw

If you already have OpenClaw running (any channel, any deploy), install the crypto extension:

```bash
openclaw plugins install @clawnch/openclaw-crypto
```

Set your wallet and API keys as environment variables (see [Wallet Modes](#wallet-modes) and [Environment Variables](#environment-variables) below), then restart OpenClaw. The extension registers its tools, commands, and hooks automatically.

This is the lightest path — no new binary, no container, no migration. Your existing channels, config, and conversation history stay intact.

---

## Bare metal

Run directly on any machine with Node.js. No Docker, no cloud, no containers. Good for a Mac mini, a home server, or local development.

```bash
git clone https://github.com/clawnch/openclawnch.git
cd openclawnch
pnpm install && pnpm build
```

Set your environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export TELEGRAM_BOT_TOKEN="1234567890:ABC..."   # or DISCORD_TOKEN, SLACK_BOT_TOKEN
export WALLETCONNECT_PROJECT_ID="..."            # optional
```

Run it:

```bash
node bin/openclawnch.mjs
```

The wrapper auto-configures OpenClaw with the crypto extension and starts the gateway. State persists to `~/.openclawnch/`.

### Running as a background service (macOS)

Create a launchd plist to keep it running:

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

### Running as a background service (Linux)

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

## Docker

Self-hosted with Docker Compose. Works on any machine with Docker installed.

```bash
git clone https://github.com/clawnch/openclawnch.git
cd openclawnch
pnpm install && pnpm build
npm run deploy:pack

cd deploy
cp .env.example .env
```

Edit `.env` — fill in your LLM key and at least one channel token. Then:

```bash
docker compose up -d
```

Logs: `docker compose logs -f`
Restart: `docker compose restart`
Stop: `docker compose down`

State persists in a Docker volume. Your `.env` file stays on disk — don't commit it.

---

## Fly.io

Managed cloud deploy. Best if you want a hands-off setup with auto-suspend (pauses when idle, wakes on incoming messages). Telegram-first but works with any channel.

### Prerequisites (Fly-specific)

- [flyctl](https://fly.io/docs/flyctl/install/) — `curl -L https://fly.io/install.sh | sh`
- Docker Desktop (needs to be running for local image builds)
- Fly account — `fly auth signup` or `fly auth login`

### Telegram bot

1. Open Telegram, message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, pick a name and username
3. Copy the bot token (looks like `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)

### Deploy

```bash
git clone https://github.com/clawnch/openclawnch.git
cd openclawnch
pnpm install && pnpm build
npm run deploy:pack

cd deploy
cp fly.template.toml fly.toml
```

Edit `fly.toml`:
- Replace `YOUR_APP_NAME` with a unique name (e.g. `myname-clawnch`)
- Replace `YOUR_REGION` with nearest region (`ewr`, `lax`, `lhr`, `nrt`, etc.)

```bash
fly apps create <your-app-name>
fly volumes create workspace --region <your-region> --size 1 -a <your-app-name>

# Set secrets:
fly secrets set TELEGRAM_BOT_TOKEN="<your-bot-token>" -a <your-app-name>
fly secrets set ANTHROPIC_API_KEY="<your-api-key>" -a <your-app-name>
fly secrets set OPENCLAWNCH_LLM_PROVIDER=anthropic -a <your-app-name>

# Optional:
fly secrets set WALLETCONNECT_PROJECT_ID="<your-project-id>" -a <your-app-name>

# Deploy (builds locally, pushes to Fly):
fly deploy --local-only
```

### Pair your account

Message your bot on Telegram. It replies with a pairing code (e.g. `ABC-1234`). Approve it:

```bash
fly ssh console -a <your-app-name> -C "openclaw pairing approve telegram <CODE>"
```

The bot walks you through onboarding from there (persona, capabilities, wallet).

### Troubleshooting

- **Bot doesn't reply**: gateway takes ~60s to boot. Wait and try again.
- **"webhook not set"** in logs: bot token is wrong.
- **"listening" but no response**: send `/start` to the bot.
- **Check logs**: `fly logs -a <your-app-name>`

### Cost

- ~$5/month with auto-suspend (pauses when idle)
- ~$12/month always-on
- You pay your own LLM and Fly bills

---

## Channels

The crypto extension is channel-agnostic. All 42 tools and 87 commands work on every channel. Pick one or run multiple simultaneously.

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

You can run multiple channels at once. Each user gets isolated sessions regardless of which channel they message from. The `channel-sender.ts` abstraction routes replies, notifications, and plan alerts to the correct channel automatically.

---

## Wallet Modes

Three ways to connect a wallet. Pick one (or switch at any time via commands).

| Mode | Command | Key custody | Best for |
|------|---------|------------|----------|
| **WalletConnect** | `/connect` | Your phone wallet | Production use — agent never holds keys |
| **Private key** | Set `CLAWNCHER_PRIVATE_KEY` env var | Local/Keychain | Headless servers, testing, auto-sign |
| **Bankr** | `/connect_bankr` or set `BANKR_API_KEY` | Custodial (Bankr) | Zero-friction, multi-chain |

### WalletConnect (recommended)

Every transaction goes to your phone wallet (MetaMask, Rainbow, Coinbase, etc.) for approval. The agent never holds your private keys.

Shortcut commands: `/connect_metamask`, `/connect_rainbow`, `/connect_coinbase`, `/connect_trust`, `/connect_zerion`, `/connect_uniswap`, `/connect_rabby`, `/connect_other`.

Requires `WALLETCONNECT_PROJECT_ID` — get one free at [cloud.reown.com](https://cloud.reown.com).

### Private key

For headless or automated setups. Set:

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

See [`deploy/.env.example`](../deploy/.env.example) for the full annotated list. Key groups:

| Group | Variables | Required? |
|-------|-----------|-----------|
| LLM | `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `BANKR_LLM_KEY` | At least one |
| Channel | `TELEGRAM_BOT_TOKEN`, `DISCORD_TOKEN`, `SLACK_BOT_TOKEN` | At least one |
| Wallet | `WALLETCONNECT_PROJECT_ID`, `CLAWNCHER_PRIVATE_KEY`, `BANKR_API_KEY` | Optional (wallet features) |
| RPC | `CLAWNCHER_RPC_URL`, `ALCHEMY_API_KEY` | Optional (defaults to public RPCs) |
| APIs | `ZEROX_API_KEY`, `BASESCAN_API_KEY`, `HERD_ACCESS_TOKEN`, etc. | Optional (per-tool) |

Run `/setup` after starting to see which tools are configured and which need additional keys.
