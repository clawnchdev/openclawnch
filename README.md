# OpenClawnch

[![CI](https://github.com/clawnchbot/openclawnch/actions/workflows/ci.yml/badge.svg)](https://github.com/clawnchbot/openclawnch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@clawnch/openclawnch)](https://www.npmjs.com/package/@clawnch/openclawnch)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A crypto-native AI agent with direct access to blockchain protocols, market data, and transaction execution. Built as an extension to [OpenClaw](https://github.com/openclaw/openclaw).

48 tools. 118 commands. 75 services. Runs on Telegram, Discord, Slack, Signal, WhatsApp, iMessage, and LINE.

## Quick Start

```bash
git clone https://github.com/clawnchbot/openclawnch.git
cd openclawnch
pnpm install && pnpm build

# Interactive setup -- validates keys live, writes .env:
openclawnch init

# Start:
openclawnch
```

Message your bot. It walks you through onboarding (persona, capabilities, wallet). Run `/setup` in chat to see tool status, `/doctor` for diagnostics.

### Other Install Methods

**Already have OpenClaw?**
```bash
openclaw plugins install @clawnch/openclaw-crypto
```

**Docker (self-hosted):**
```bash
cp deploy/.env.example deploy/.env   # fill in your keys
docker compose -f deploy/docker-compose.yml up -d
```

**Fly.io (one command):**
```bash
openclawnch deploy --telegram-token "BOT_TOKEN" --fly-token "FLY_TOKEN" --llm-key "sk-ant-..."
```

Full setup guide with all options: **[docs/SETUP.md](docs/SETUP.md)**

## Tools

| Category | Tools | What it does |
|----------|-------|-------------|
| **Wallet** | `clawnch_connect`, `transfer`, `permit2`, `approvals` | WalletConnect pairing, ENS transfers, token approvals, spending policies |
| **Trading** | `defi_swap`, `defi_balance`, `liquidity`, `manage_orders`, `bridge` | 6 DEX aggregators, limit/stop/trailing orders, DCA, cross-chain bridging |
| **DeFi** | `defi_lend`, `defi_stake`, `yield` | Aave V3 supply/borrow, Lido/Rocket Pool staking, Yearn V3 vaults, live APYs via DeFiLlama |
| **Market Data** | `defi_price`, `analytics`, `market_intel`, `cost_basis` | RSI/MACD/Bollinger bands, trending tokens, whale activity, FIFO P&L tracking |
| **Token Launches** | `clawnch_launch`, `clawnch_fees` | Deploy ERC-20s on Base via Clawnch launchpad with Uniswap V4 pools. Fee management |
| **Bankr** | `bankr_launch`, `bankr_automate`, `bankr_polymarket`, `bankr_leverage` | Custodial wallet, automation rules, Polymarket predictions, leveraged positions |
| **NFT & Airdrop** | `nft`, `airdrop` | ERC-721 mint/transfer/burn, airdrop eligibility checking, claim generation |
| **Security** | `privacy`, `safe` | Privacy-preserving transfers, Gnosis Safe multisig management |
| **Governance** | `governance`, `farcaster` | DAO proposal voting, Farcaster casting/search/notifications |
| **On-chain Intel** | `block_explorer`, `herd_intelligence`, `watch_activity`, `browser` | Contract source, token audits, swap monitoring, web browsing |
| **Automation** | `compound_action` | Multi-step plans with conditionals, time/price/on-chain triggers, cron, parallel execution |
| **Agent** | `molten`, `clawnx`, `hummingbot`, `wayfinder` | X/Twitter posting, agent-to-agent matching, market-making, route optimization |
| **Memory** | `agent_memory`, `skill_evolve`, `session_recall` | Persistent memory, self-improvement, session context recall |

Full tool reference: **[docs/TOOLS.md](docs/TOOLS.md)** | All 118 commands: **[docs/COMMANDS.md](docs/COMMANDS.md)**

## Channels

| Channel | Status | Notes |
|---------|--------|-------|
| Telegram | Production | Tappable slash commands, deep links, webhooks, streaming responses |
| Discord | Ready | Slash commands auto-register, thread bindings |
| Slack | Ready | Works in channels and DMs |
| Signal | Ready | Requires signal-cli bridge |
| WhatsApp | Ready | Requires WhatsApp Web bridge |
| iMessage | Ready | macOS only (bare metal Mac) |
| LINE | Ready | Requires LINE Messaging API |

All tools and commands work identically on every channel.

## Wallet Modes

| Mode | Key custody | How it works |
|------|------------|-------------|
| **WalletConnect** | Your phone wallet | `/connect` generates a pairing link. Every write transaction goes to your phone for approval. Agent never holds keys. |
| **Private key** | Local encrypted | BIP-39 mnemonic generated locally, encrypted with scrypt + AES-256-GCM, stored in macOS Keychain or encrypted file. Enables auto-signing below policy thresholds. |
| **Bankr** | Custodial | `/connect_bankr` or `BANKR_API_KEY`. Multi-chain custodial wallet. Good for automation-heavy setups. |

Spending policies control what the agent can auto-approve: `"approve swaps under 0.05 ETH, max 10 per hour"`.

Details: **[docs/SETUP.md#wallet-modes](docs/SETUP.md#wallet-modes)**

## Automation

The compound operations engine lets users describe multi-step plans in natural language:

- **Time triggers** -- "every day at 9am, check ETH price"
- **Price triggers** -- "when ETH drops below $2000, swap 1 ETH to USDC"
- **On-chain triggers** -- "when gas is under 10 gwei, execute the pending swap"
- **Conditionals** -- "if my portfolio is down more than 5%, alert me"
- **Loops and parallel execution** -- "DCA $100 into ETH every week for 12 weeks"

Plans persist to disk and survive restarts. Managed via `/plans`, `/interrupt_plan`.

## Security

- Agent never holds unencrypted private keys (WalletConnect mode)
- All write tools are `ownerOnly` -- only the paired account owner can invoke them
- Credential leak detection on all LLM-bound output
- Prompt injection resistance guardrails in the system prompt
- Sequential execution -- never queues multiple transactions
- Bounded approvals -- exact amounts, never unlimited
- Endpoint allowlist -- outbound HTTP restricted to curated hosts
- Transaction verification -- always shows what a tx will do before executing

Full security model: **[docs/SECURITY.md](docs/SECURITY.md)**

## Architecture

```
openclawnch (CLI wrapper)
  └── spawns openclaw gateway
        └── loads @clawnch/openclaw-crypto (extension)
              ├── 48 tools (registered via plugin API)
              ├── 118 commands
              ├── hooks: gateway_start, message_received, before_prompt_build, after_tool_call
              └── 75 services (wallet, RPC, price, gas, plans, onboarding, ...)
```

Two packages: `openclawnch` (CLI + deploy tooling) and `@clawnch/openclaw-crypto` (standalone extension). The extension registers tools, commands, and hooks through OpenClaw's plugin system. Each user runs their own instance.

The CLI wrapper handles config patching, `.env` loading, and spawning the OpenClaw gateway. The extension does everything else: wallet management, plan scheduling, onboarding, tool execution.

Details: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

## Configuration

### Required

You need at least one LLM key and one channel token:

```bash
# LLM (pick one)
ANTHROPIC_API_KEY=sk-ant-...      # recommended
OPENROUTER_API_KEY=sk-or-...
OPENAI_API_KEY=sk-...
BANKR_LLM_KEY=...                 # pay with crypto

# Channel (pick one)
TELEGRAM_BOT_TOKEN=123456:ABC...  # from @BotFather
DISCORD_TOKEN=...
SLACK_BOT_TOKEN=xoxb-...
```

### Optional

RPC, DEX APIs, block explorers, price feeds, X/Twitter credentials, and more. See [deploy/.env.example](deploy/.env.example) for the full reference with comments.

The setup wizard (`openclawnch init`) walks through everything interactively with live key validation.

## Development

```bash
pnpm install
pnpm build                # builds CLI wrapper + crypto extension
pnpm typecheck            # TypeScript 6.0 strict mode
pnpm test                 # 1547 pass, 31 skip, 0 fail (vitest 4)
```

### Project Structure

```
bin/openclawnch.mjs           CLI entry point
src/init.ts                   Setup wizard
src/deploy.ts                 Fly.io provisioning
src/wrapper.ts                Library export
extensions/crypto/
  index.ts                    Plugin entry -- registers all tools, commands, hooks
  src/tools/                  48 tool implementations
  src/commands/               Command handlers
  src/services/               75 service modules
  src/hooks/                  Prompt builder, message interceptors
  src/lib/                    Shared utilities
  skills/                     Agent skills (bundled)
deploy/
  Dockerfile                  Production container
  docker-compose.yml          Self-hosted orchestration
  openclaw.json               Channel + gateway + model config
  entrypoint.sh               Container bootstrap
  fly.template.toml           Fly.io template for new deploys
tests/                        1547 tests across 44 files
```

### Adding a Tool

```bash
# 1. Create the tool
touch extensions/crypto/src/tools/my-tool.ts

# 2. Register it in index.ts
import { myTool } from './src/tools/my-tool.js';
api.registerTool(myTool);

# 3. Add tests
touch tests/my-tool.test.ts
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide including tool interface shape, service patterns, and testing conventions.

## Issue Reporting

OpenClawnch includes built-in issue reporting. When opted in, the agent proactively suggests filing GitHub issues when it encounters bugs or unexpected behavior.

```
/report_opt_in              Enable issue reporting
/report <title> | <desc>    File an issue
/report_opt_out             Disable
```

## Tech Stack

| Component | Version |
|-----------|---------|
| OpenClaw | 2026.3.28 |
| Node.js | >= 22.14.0 |
| TypeScript | 6.0 |
| viem | 2.47 |
| MetaMask Delegation SDK | 1.0.0 |
| vitest | 4.1 |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines, testing patterns, and how to add new tools.

## License

MIT -- see [LICENSE](LICENSE).
