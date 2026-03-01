# OpenClawnch

Your personal crypto agent on Telegram. AI assistant with direct access to blockchain protocols, market data, and transaction execution.

Built on [OpenClaw](https://github.com/openclaw/openclaw) — not a fork, a plugin.

## Setup

Paste the following into your AI coding agent (OpenCode, Claude Code, Cursor, etc.):

```
Set up OpenClawnch — a personal crypto Telegram bot deployed on Fly.io.

Here's what I need you to do:

1. PREREQUISITES — make sure these are installed:
   - Node.js 22+ (check: node --version)
   - flyctl (install: curl -L https://fly.io/install.sh | sh)
   - Docker Desktop (needs to be running for local builds)

2. FLY.IO ACCOUNT — if I don't have one:
   - Run: fly auth signup
   - Or if I have one: fly auth login

3. TELEGRAM BOT — create one:
   - Open Telegram, message @BotFather
   - Send /newbot
   - Pick a name and username
   - Copy the bot token (looks like: 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz)

4. LLM API KEY — I need one of:
   - Anthropic: https://console.anthropic.com/settings/keys (starts with sk-ant-)
   - OpenRouter: https://openrouter.ai/keys (starts with sk-or-)
   - OpenAI: https://platform.openai.com/api-keys (starts with sk-)

5. WALLETCONNECT PROJECT ID (optional, needed for wallet features):
   - Go to https://cloud.reown.com
   - Create a project, copy the Project ID

6. CLONE AND DEPLOY:
   git clone https://github.com/clawnch/openclawnch.git
   cd openclawnch
   pnpm install && pnpm build
   npm run deploy:pack

   cd deploy
   cp fly.template.toml fly.toml

   # Edit fly.toml: pick a unique app name (replace "openclawnch-tg")
   # Then:
   fly apps create <your-app-name>
   fly volumes create workspace --region ewr --size 1 -a <your-app-name>

   # Set secrets (paste the values from steps 3-5):
   fly secrets set TELEGRAM_BOT_TOKEN="<your-bot-token>" -a <your-app-name>
   fly secrets set ANTHROPIC_API_KEY="<your-api-key>" -a <your-app-name>
   fly secrets set OPENCLAWNCH_LLM_PROVIDER=anthropic -a <your-app-name>
   # If using OpenRouter instead:
   # fly secrets set OPENROUTER_API_KEY="<your-key>" -a <your-app-name>
   # fly secrets set OPENCLAWNCH_LLM_PROVIDER=openrouter -a <your-app-name>

   # Optional:
   fly secrets set WALLETCONNECT_PROJECT_ID="<your-project-id>" -a <your-app-name>

   # Deploy:
   fly deploy --local-only

   # Wait ~60s for the gateway to boot, then message your bot on Telegram.
   # You'll get a pairing code. Approve it:
   fly ssh console -a <your-app-name> -C "openclaw pairing approve telegram <PAIRING_CODE>"

7. DONE — message your bot. It will walk you through the rest.

Cost: ~$12/month on Fly.io for a 24/7 instance. You pay your own LLM and Fly bills.
```

## What It Does

22 tools across wallet management, DeFi trading, market intelligence, portfolio tracking, token launches, cross-chain bridging, and more. Full list shows up when you first message the bot.

### Commands

| Command | Description |
|---------|-------------|
| `/wallet` | Wallet status and balance |
| `/connect` | Connect mobile wallet via WalletConnect |
| `/tx` | Transaction history |
| `/policy` | Spending auto-approval rules |
| `/llm` | View or switch LLM model (e.g. `/llm sonnet`) |
| `/mode` | Show current safety/signing mode |
| `/safemode` | Agent confirms before acting (default) |
| `/dangermode` | Agent acts immediately |
| `/walletsign` | Transactions require phone approval (default) |
| `/autosign` | Auto-sign with private key (if configured) |
| `/professional` | Set communication style: business-like |
| `/degen` | Set communication style: CT native |
| `/chill` | Set communication style: casual |
| `/technical` | Set communication style: data-heavy |
| `/mentor` | Set communication style: educational |
| `/skip` | Skip onboarding |
| `/factoryreset` | Wipe all data and start over |

### Security

The agent never holds your private keys (unless you opt into `/autosign` mode with `CLAWNCHER_PRIVATE_KEY`). Default mode: every transaction goes to your phone wallet for approval via WalletConnect.

### Architecture

Two npm packages, one repo:

- `openclawnch` — CLI wrapper + deploy tooling
- `@clawnch/openclaw-crypto` — Standalone OpenClaw plugin (22 tools, 16+ commands, 20 skill docs, 8 services)

Each user runs their own Fly.io instance with their own API keys. No shared infrastructure.

## Development

```bash
pnpm install
pnpm build
pnpm test        # 273 tests
```

## License

MIT
