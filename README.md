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

28 tools across 7 categories. 65 slash commands. 25 services. Guided onboarding on first message.

### Tools

**Wallet & Transactions**
- `clawnch_connect` — Connect/disconnect wallet, send transactions, manage spending policies
- `transfer` — Send ETH or ERC-20 tokens to any address
- `permit2` — Check, approve, and revoke token allowances (Uniswap Permit2)

**DeFi Trading**
- `defi_swap` — Token swaps via multi-aggregator routing (0x, 1inch, ParaSwap, KyberSwap, Odos, OpenOcean)
- `defi_balance` — Wallet balances across chains (JSON-RPC + Alchemy fallback)
- `liquidity` — Add/remove liquidity positions
- `manage_orders` — Limit orders, DCA, stop-loss (in-memory execution engine)
- `bridge` — Cross-chain bridging via LI.FI

**Market Intelligence**
- `defi_price` — Token prices via DexScreener
- `analytics` — Technical analysis: RSI, MACD, Bollinger Bands, SMA, EMA, signal scoring
- `market_intel` — Trending tokens, new pairs, buy/sell ratios
- `cost_basis` — P&L tracking with FIFO cost basis calculation

**Token Launches & Fees**
- `clawnch_launch` — Deploy tokens on Clawnch launchpad
- `clawnch_fees` — Check and claim LP fees
- `clawnch_info` — Platform stats, top tokens, agent management

**Bankr Integration** (requires Bankr API key)
- `bankr_launch` — Deploy tokens via Bankr Agent API
- `bankr_automate` — DCA, limit orders, TWAP, stop-loss, rebalance
- `bankr_polymarket` — Prediction market positions
- `bankr_leverage` — Leveraged trading (open/close/manage)

**On-chain Intel**
- `block_explorer` — Transaction lookup, contract source, top holders, gas tracker (Basescan)
- `herd_intelligence` — Token investigation, auditing, swap validation
- `watch_activity` — Monitor on-chain swap activity

**Compound Operations**
- `compound_action` — Chain multiple operations with conditions, schedules, and loops. Handles "do X at 5pm", "if ETH > $4000 then sell half", "every 4 hours check price and buy if dip > 5%"

**Agent & Social**
- `molten` — Agent matching and discovery on Molten
- `clawnx` — X/Twitter posting, search, engagement, DMs
- `hummingbot` — Market-making bot control
- `wayfinder` — Cross-chain route discovery
- `crypto_workflow` — Multi-step plan orchestration

### Commands

| Command | Description |
|---------|-------------|
| `/wallet` | Wallet status and balance |
| `/connect` | Connect mobile wallet (MetaMask, Coinbase, Rainbow, etc.) |
| `/connect_bankr` | Connect Bankr custodial wallet |
| `/tx` | Transaction history |
| `/policy` | Spending auto-approval rules |
| `/setup` | Show configured vs unconfigured tools |
| `/llm` | View or switch LLM model (e.g. `/llm sonnet`) |
| `/llm_opus`, `/llm_sonnet` | Quick model switch shortcuts |
| `/provider_anthropic` | Switch to Anthropic API |
| `/provider_bankr` | Switch to Bankr LLM |
| `/provider_openrouter` | Switch to OpenRouter |
| `/llmcredits` | Bankr LLM credit balance |
| `/llmcost` | Bankr LLM cost tracking |
| `/mode` | Show current safety/signing mode |
| `/safemode` | Agent confirms before acting (default) |
| `/dangermode` | Agent acts immediately |
| `/walletsign` | Transactions require phone approval (default) |
| `/autosign` | Auto-sign with private key (if configured) |
| `/professional` | Communication style: business-like |
| `/degen` | Communication style: CT native |
| `/chill` | Communication style: casual |
| `/technical` | Communication style: data-heavy |
| `/mentor` | Communication style: educational |
| `/skip` | Skip onboarding |
| `/molten` | Molten agent profile |
| `/automations` | Bankr automation status |
| `/plans` | List scheduled plans |
| `/plans_active` | Active plans only |
| `/plans_cancel` | Cancel a plan |
| `/plans_clear` | Cancel all active plans |
| `/flykeys` | Manage Fly.io secrets |
| `/flystatus` | Machine status |
| `/flyrestart` | Restart bot |
| `/factoryreset` | Wipe all data and start over |

All commands are tappable in Telegram (no typing needed).

### Security

- The agent never holds your private keys (unless you opt into `/autosign` with `CLAWNCHER_PRIVATE_KEY`)
- Default mode: every transaction goes to your phone wallet for approval via WalletConnect
- All write-operation tools are `ownerOnly: true` — hidden from non-owner senders
- Credential leak detection: scans for private keys, seed phrases (BIP-39), WC secrets, API keys
- Sequential execution: multi-step operations run one at a time, never queue multiple transactions
- Injection sanitization on all user inputs routed to Bankr API
- Base Builder Code (ERC-8021): all Base chain transactions include `bc_z92vaimh` attribution

### Compound Operations Engine

Natural language scheduling and conditional execution:

- **Time triggers**: "Swap 0.1 ETH for USDC at 5pm"
- **Conditions**: "If ETH drops below $3500, buy 0.5 ETH"
- **Loops**: "Every 4 hours, check ETH price and buy if dip > 5%"
- **Chains**: "Sell half my PEPE, bridge the ETH to Arbitrum, then buy ARB"
- **Parallel**: "Check prices on ETH, BTC, and SOL simultaneously"

Plans persist to disk and survive restarts. Scheduler runs a 15-second tick loop for condition evaluation.

6 node types (Action, Sequence, Parallel, If, Wait, Loop) compose into any operation. 4 trigger types (Immediate, Time, Interval, Condition). Full validation catches contradictions (buy+sell same token, overspend, infinite loops, circular dependencies).

### Architecture

Two npm packages, one repo:

- `openclawnch` — CLI wrapper + deploy tooling
- `@clawnch/openclaw-crypto` — Standalone OpenClaw plugin (28 tools, 65 commands, 25 services)

Each user runs their own Fly.io instance with their own API keys. No shared infrastructure.

**Extension structure:**
```
extensions/crypto/
├── index.ts                    # Plugin entry (register tools, commands, hooks)
├── src/
│   ├── tools/                  # 28 tool files
│   ├── commands/               # 12 command files
│   └── services/               # 25 service files
│       ├── walletconnect-service.ts    # WalletConnect lifecycle + builder code wrapping
│       ├── plan-types.ts               # Compound ops IR (6 node types, 4 triggers)
│       ├── plan-compiler.ts            # Intent → Plan IR compiler
│       ├── plan-validator.ts           # 6-pass validation (structural, temporal, financial, tool, safety, dependency)
│       ├── plan-scheduler.ts           # Persistent scheduler with condition polling
│       ├── plan-executor.ts            # Tree-walking executor with cancellation support
│       ├── builder-code.ts             # ERC-8021 Base Builder Code service
│       ├── dex-aggregator.ts           # Multi-aggregator DEX routing
│       ├── price-oracle.ts             # Multi-source price feeds with divergence detection
│       ├── rpc-provider.ts             # Multi-RPC with failover + circuit breaker
│       └── ...                         # 14 more services
└── package.json
```

**SDK dependencies:**
- `@clawnch/sdk` v2.2.1 — Wallet signing, swaps, token deployment
- `@clawnch/clawncher-sdk` v0.3.3 — Fee claiming, LP management
- `@clawnch/clawnx` v1.0.0 — X/Twitter integration

## Development

```bash
pnpm install
pnpm build
pnpm test        # 632 tests across 21 files (632 pass, 11 skip)
```

## License

MIT
