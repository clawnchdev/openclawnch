# OpenClawnch

Your personal crypto agent. AI assistant with direct access to blockchain protocols, market data, and transaction execution.

Works on **Telegram, Discord, Slack, Signal, WhatsApp, iMessage, and LINE**. Deploy on **Fly.io** or **self-host with Docker**.

Built on [OpenClaw](https://github.com/openclaw/openclaw) — not a fork, a plugin.

## Setup

### Option A: Fly.io (Telegram)

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

   # Edit fly.toml:
   #   - Replace YOUR_APP_NAME with a unique name (e.g. "myname-clawnch")
   #   - Replace YOUR_REGION with nearest region (ewr, lax, lhr, nrt, etc.)
   fly apps create <your-app-name>
   fly volumes create workspace --region <your-region> --size 1 -a <your-app-name>

   # Set secrets (paste the values from steps 3-5):
   fly secrets set TELEGRAM_BOT_TOKEN="<your-bot-token>" -a <your-app-name>
   fly secrets set ANTHROPIC_API_KEY="<your-api-key>" -a <your-app-name>
   fly secrets set OPENCLAWNCH_LLM_PROVIDER=anthropic -a <your-app-name>
   # If using OpenRouter instead:
   # fly secrets set OPENROUTER_API_KEY="<your-key>" -a <your-app-name>
   # fly secrets set OPENCLAWNCH_LLM_PROVIDER=openrouter -a <your-app-name>

   # Optional:
   fly secrets set WALLETCONNECT_PROJECT_ID="<your-project-id>" -a <your-app-name>

   # Deploy (builds locally with Docker, pushes image to Fly):
   fly deploy --local-only

7. PAIR YOUR ACCOUNT:
   # Message your bot on Telegram. It will reply with a pairing code.
   # The code looks like: ABC-1234
   # Approve it:
   fly ssh console -a <your-app-name> -C "openclaw pairing approve telegram <CODE>"

   # If the bot doesn't reply:
   #   - Check logs: fly logs -a <your-app-name>
   #   - The gateway takes ~60s to boot. Wait and try again.
   #   - If you see "webhook not set", the bot token may be wrong.
   #   - If you see "listening" but no response, message /start to the bot.

8. DONE — the bot will walk you through onboarding (persona, capabilities, wallet).

Cost: ~$5/month with auto-suspend, ~$12/month always-on. You pay your own LLM and Fly bills.
```

### Option B: Docker (self-hosted, any channel)

```bash
git clone https://github.com/clawnch/openclawnch.git
cd openclawnch
pnpm install && pnpm build
npm run deploy:pack

cd deploy
cp .env.example .env
# Edit .env — fill in your API keys and channel tokens

docker compose up -d
```

Enable channels by setting the corresponding token in `.env`:
- **Telegram**: `TELEGRAM_BOT_TOKEN` + set webhook to `https://your-domain/telegram-webhook`
- **Discord**: `DISCORD_TOKEN` + enable in `openclaw.json` (`channels.discord.enabled: true`)
- **Slack**: `SLACK_BOT_TOKEN` + enable in `openclaw.json` (`channels.slack.enabled: true`)

The crypto extension works identically on all channels. Onboarding, notifications, and plan alerts automatically route to whichever channel the user is on.

### Channel support

| Channel | Status | Notes |
|---------|--------|-------|
| Telegram | Production | Webhooks, deep links, tappable commands |
| Discord | Ready | Enable in config, set `DISCORD_TOKEN` |
| Slack | Ready | Enable in config, set `SLACK_BOT_TOKEN` |
| Signal | Ready | Requires signal-cli bridge |
| WhatsApp | Ready | Requires WhatsApp Web bridge |
| iMessage | Ready | macOS only |
| LINE | Ready | Requires LINE Messaging API |

All 42 tools and 87 commands work on every channel. The channel abstraction layer (`channel-sender.ts`) routes messages to the correct OpenClaw send function automatically.

## What It Does

42 tools across 11 categories. 87 slash commands. 47 services. Guided onboarding on first message. Works on any channel OpenClaw supports.

### Tools

**Wallet & Transactions**
- `clawnch_connect` — Connect/disconnect wallet, send transactions, manage spending policies
- `transfer` — Send ETH or ERC-20 tokens to any address or ENS name
- `permit2` — Check, approve, and revoke token allowances (Uniswap Permit2)
- `approvals` — Audit and revoke ERC-20 approvals across all tokens

**DeFi Trading**
- `defi_swap` — Token swaps via multi-aggregator routing (0x, 1inch, ParaSwap, KyberSwap, Odos, OpenOcean)
- `defi_balance` — Wallet balances across chains (JSON-RPC + Alchemy fallback)
- `liquidity` — Uniswap V3/V4 liquidity position management (mint, add, remove, collect fees)
- `manage_orders` — Limit orders, DCA, stop-loss (in-memory execution engine)
- `bridge` — Cross-chain bridging via LI.FI

**DeFi Protocols**
- `defi_lend` — Lending/borrowing on Aave V3 (supply, borrow, repay, withdraw, health factor monitoring)
- `defi_stake` — Liquid staking on Lido and Rocket Pool (stake, unstake, wrap/unwrap stETH)
- `yield` — Yield vault deposits/withdrawals on Yearn V3 (ERC-4626 vaults)

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

**NFT & Digital Assets**
- `nft` — NFT transfers, purchases, and listings (ERC-721)
- `airdrop` — Check eligibility and generate claim calldata for active airdrops

**Privacy & Security**
- `privacy` — Privacy-preserving transfers via zero-knowledge pools (deposit, withdraw, transfer)
- `safe` — Gnosis Safe multisig operations (propose, confirm transactions)

**Governance**
- `governance` — DAO proposal voting and token delegation (Governor contracts)
- `farcaster` — Social posting, search, and engagement on Farcaster (via Neynar)

**On-chain Intel**
- `block_explorer` — Transaction lookup, contract source, top holders, gas tracker (Basescan)
- `herd_intelligence` — Token investigation, auditing, swap validation
- `watch_activity` — Monitor on-chain swap activity
- `browser` — Browser automation for dApps that require UI interaction (PinchTab)

**Compound Operations**
- `compound_action` — Chain multiple operations with conditions, schedules, and loops

**Agent & Social**
- `molten` — Agent matching and discovery on Molten
- `clawnx` — X/Twitter posting, search, engagement, DMs
- `hummingbot` — Market-making bot control (36 actions including Condor CLMM/PnL)
- `wayfinder` — Cross-chain route discovery and perps routing
- `crypto_workflow` — Multi-step plan orchestration

**Self-Improvement** (requires `/evolve`)
- `agent_memory` — Persistent agent memory (notes, lessons, preferences)
- `skill_evolve` — Generate and refine skill documents from experience
- `session_recall` — Recall context from previous sessions

### Commands (87 total)

**Core**
| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/wallet` | Wallet status, balance, chain |
| `/portfolio` | Token holdings and wallet info |
| `/balance` | ETH balance and wallet address |
| `/chain` | Current chain info |
| `/tx` | Transaction history |
| `/policy` | Spending auto-approval rules |
| `/setup` | Show configured vs unconfigured tools |
| `/doctor` | Run diagnostics (wallet, RPC, API keys, channels, security) |

**Wallet Connection**
| Command | Description |
|---------|-------------|
| `/connect` | Connect mobile wallet via WalletConnect |
| `/connect_metamask` | Connect MetaMask |
| `/connect_rainbow` | Connect Rainbow |
| `/connect_coinbase` | Connect Coinbase Wallet |
| `/connect_trust` | Connect Trust Wallet |
| `/connect_zerion` | Connect Zerion |
| `/connect_uniswap` | Connect Uniswap Wallet |
| `/connect_rabby` | Connect Rabby |
| `/connect_other` | Connect other WalletConnect wallet |
| `/connect_bankr` | Connect Bankr custodial wallet |
| `/disconnect` | Disconnect the current wallet |

**Wallet Management**
| Command | Description |
|---------|-------------|
| `/create_wallet` | Generate a new encrypted wallet |
| `/import_wallet` | Import wallet from seed phrase |
| `/recover` | Restore wallet from seed phrase |
| `/export_wallet` | Display wallet mnemonic (requires password) |
| `/wallet_backup` | Export encrypted backup file |

**Safety & Signing**
| Command | Description |
|---------|-------------|
| `/mode` | Show current safety/signing mode |
| `/safemode` | Agent confirms before acting (default) |
| `/dangermode` | Agent acts immediately |
| `/readonly` | Read-only mode (no on-chain writes) |
| `/walletsign` | Transactions require phone approval (default) |
| `/autosign` | Auto-sign with private key |

**LLM & Provider**
| Command | Description |
|---------|-------------|
| `/llm` | View or switch LLM model (e.g. `/llm sonnet`) |
| `/llm_opus`, `/llm_sonnet`, `/llm_haiku` | Claude model shortcuts |
| `/llm_gpt`, `/llm_codex`, `/llm_gpt_mini`, `/llm_gpt_nano` | GPT model shortcuts |
| `/llm_gemini`, `/llm_gemini_flash` | Gemini model shortcuts |
| `/llm_kimi`, `/llm_qwen` | Kimi K2.5 / Qwen3 Coder |
| `/provider` | View current LLM provider |
| `/provider_anthropic` | Switch to Anthropic API |
| `/provider_bankr` | Switch to Bankr Gateway |
| `/provider_openrouter` | Switch to OpenRouter |
| `/provider_openai` | Switch to OpenAI |
| `/llmcredits` | Bankr LLM credit balance |
| `/llmcost` | Bankr LLM cost tracking |
| `/topup` | Top up LLM credits |
| `/autotopup` | Configure automatic LLM credit top-up |

**Persona & Onboarding**
| Command | Description |
|---------|-------------|
| `/professional` | Communication style: business-like |
| `/degen` | Communication style: CT native |
| `/chill` | Communication style: casual |
| `/technical` | Communication style: data-heavy |
| `/mentor` | Communication style: educational |
| `/skip` | Skip onboarding |
| `/all` | Select all capabilities during onboarding |
| `/cap_wallet`, `/cap_prices`, ... | Select individual capabilities (10 total) |

**Plans & Automations**
| Command | Description |
|---------|-------------|
| `/plans` | List scheduled plans |
| `/plans_active` | Active plans only |
| `/plans_cancel` | Cancel a plan |
| `/plans_clear` | Cancel all active plans |
| `/automations` | Bankr automation status |

**Forum Topics** (Telegram threaded mode)
| Command | Description |
|---------|-------------|
| `/topics` | List forum topics and their bindings |
| `/topics_setup` | Set up suggested topic structure |
| `/topic_bind` | Bind a topic to a persona/mode (e.g. `/topic_bind 42 trading`) |
| `/topic_unbind` | Remove a topic binding |

**Self-Improvement**
| Command | Description |
|---------|-------------|
| `/evolve` | Enable self-improvement mode |
| `/stable` | Disable self-improvement |
| `/evolution` | Show self-improvement mode and stats |

**Infrastructure**
| Command | Description |
|---------|-------------|
| `/molten` | Molten agent profile |
| `/flykeys` | Manage Fly.io secrets |
| `/flystatus` | Machine status |
| `/flyrestart` | Restart bot |
| `/factoryreset` | Wipe all data and start over |

All commands are tappable in Telegram (no typing needed). On other channels, type them as usual.

### Security

- The agent never holds your private keys (unless you opt into `/autosign` with `CLAWNCHER_PRIVATE_KEY`)
- Default mode: every transaction goes to your phone wallet for approval via WalletConnect
- All write-operation tools are `ownerOnly: true` — hidden from non-owner senders
- Credential leak detection: scans for private keys, seed phrases (BIP-39), WC secrets, API keys
- Sequential execution: multi-step operations run one at a time, never queue multiple transactions
- Injection sanitization on all user inputs routed to Bankr API
- Base Builder Code (ERC-8021): all Base chain transactions include `bc_z92vaimh` attribution
- **Event-sourced tx ledger**: every on-chain action is recorded as an immutable event (audit trail, tax, replay)
- **Receipt waits**: every `writeContract`/`sendTransaction` call waits for `waitForTransactionReceipt` — no fire-and-forget
- **Input validation**: all user-supplied amounts validated with regex before `parseEther`/`parseUnits`/`BigInt` conversion
- **Bounded approvals**: token approvals use exact amounts (or +0.5% buffer), never unlimited MaxUint256
- **MEV protection**: swaps, transfers, and bridges route through Flashbots Protect RPC when available
- **Health factor monitoring**: Aave positions emit heartbeat alerts at warning (< 1.5) and critical (< 1.2) thresholds

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
- `@clawnch/openclaw-crypto` — Standalone OpenClaw plugin (42 tools, 87 commands, 47 services)

Each user runs their own instance (Fly.io or Docker) with their own API keys. No shared infrastructure.

**Extension structure:**
```
extensions/crypto/
├── index.ts                    # Plugin entry (register tools, commands, hooks)
├── src/
│   ├── tools/                  # 42 tool files
│   ├── commands/               # 19 command files
│   ├── lib/                    # Shared utilities (ENS resolver, token decimals, helpers)
│   └── services/               # 47 service files
│       ├── tx-ledger.ts                # Event-sourced audit log for all on-chain actions
│       ├── channel-sender.ts           # Channel-agnostic message routing (7 channels)
│       ├── walletconnect-service.ts    # WalletConnect lifecycle + builder code wrapping
│       ├── rpc-provider.ts             # Multi-RPC with failover + MEV protection
│       ├── dex-aggregator.ts           # Multi-aggregator DEX routing (6 aggregators)
│       ├── lending-service.ts          # Aave V3 supply/borrow/repay/withdraw
│       ├── staking-service.ts          # Lido + Rocket Pool liquid staking
│       ├── yield-service.ts            # Yearn V3 ERC-4626 vault operations
│       ├── governance-service.ts       # Governor contract voting + delegation
│       ├── safe-service.ts             # Gnosis Safe multisig via Safe API
│       ├── plan-compiler.ts            # Intent → Plan IR compiler
│       ├── plan-validator.ts           # 6-pass validation (structural, temporal, financial, tool, safety)
│       ├── plan-scheduler.ts           # Persistent scheduler with condition polling
│       ├── heartbeat-monitor.ts        # Health factor + position monitoring
│       ├── forum-topics.ts             # Telegram threaded mode topic management
│       ├── thread-bindings.ts          # Per-topic persona/safety/tool bindings
│       └── ...
├── skills/                     # 16 skill documents for tool categories
deploy/
├── Dockerfile                  # Container image
├── docker-compose.yml          # Self-hosted deploy
├── .env.example                # Environment variable reference
├── entrypoint.sh               # Startup script
├── fly.template.toml           # Fly.io config template
└── openclaw.json               # OpenClaw config (channels, plugins, models)
```

**SDK dependencies:**
- `@clawnch/sdk` v2.2.1 — Wallet signing, swaps, token deployment
- `@clawnch/clawncher-sdk` v0.3.3 — Fee claiming, LP management, Hummingbot/Condor
- `@clawnch/clawnx` v1.0.0 — X/Twitter integration
- `viem` v2.x — Ethereum interaction (ABI encoding, contract calls, transaction receipts)

## Development

```bash
pnpm install
pnpm build
pnpm typecheck   # tsc --noEmit (strict mode)
pnpm test        # 902 tests across 27 files (902 pass, 11 skip)
```

## License

MIT
