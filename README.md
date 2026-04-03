# OpenClawnch

[![CI](https://github.com/clawnchbot/openclawnch/actions/workflows/ci.yml/badge.svg)](https://github.com/clawnchbot/openclawnch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@clawnch/openclawnch)](https://www.npmjs.com/package/@clawnch/openclawnch)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Your personal crypto agent. AI assistant with direct access to blockchain protocols, market data, and transaction execution.

A crypto-native fork of [OpenClaw](https://github.com/openclaw/openclaw). 48 tools. 117 commands. 75 services. Works on Telegram, Discord, Slack, Signal, WhatsApp, iMessage, and LINE.

## Quick Start

```bash
git clone https://github.com/clawnchbot/openclawnch.git
cd openclawnch
pnpm install && pnpm build

# Interactive setup — validates your keys, writes .env:
node bin/openclawnch.mjs init

# Start the agent:
node bin/openclawnch.mjs
```

Message your bot. It walks you through onboarding. Run `/setup` in chat to see tool status, `/doctor` for diagnostics.

**Already have OpenClaw?** Just install the extension: `openclaw plugins install @clawnch/openclaw-crypto`

Also runs on [Docker](docs/SETUP.md#docker) and [Fly.io](docs/SETUP.md#flyio). Full setup guide: **[docs/SETUP.md](docs/SETUP.md)**

## What It Does

| Category | Tools | Highlights |
|----------|-------|------------|
| Wallet & Transactions | `clawnch_connect`, `transfer`, `permit2`, `approvals` | WalletConnect pairing, ENS support, spending policies |
| DeFi Trading | `defi_swap`, `defi_balance`, `liquidity`, `manage_orders`, `bridge` | 6 DEX aggregators, limit orders, DCA, cross-chain bridging |
| DeFi Protocols | `defi_lend`, `defi_stake`, `yield` | Aave V3, Lido, Rocket Pool, Yearn V3 |
| Market Intel | `defi_price`, `analytics`, `market_intel`, `cost_basis` | RSI/MACD/Bollinger, trending tokens, FIFO P&L |
| Bankr | `bankr_launch`, `bankr_automate`, `bankr_polymarket`, `bankr_leverage` | Custodial wallet, automations, prediction markets |
| NFT & Airdrop | `nft`, `airdrop` | ERC-721 ops, eligibility checking, claim generation |
| Security | `privacy`, `safe` | Zero-knowledge transfers, Gnosis Safe multisig |
| Governance | `governance`, `farcaster` | DAO voting, Farcaster social |
| On-chain Intel | `block_explorer`, `herd_intelligence`, `watch_activity`, `browser` | Contract source, token audits, swap monitoring |
| Compound Ops | `compound_action` | Conditional chains, time triggers, loops, parallel execution |
| Agent | `molten`, `clawnx`, `hummingbot`, `wayfinder`, `agent_memory`, `skill_evolve`, `session_recall` | X/Twitter, market-making, persistent memory |

Full reference: **[docs/TOOLS.md](docs/TOOLS.md)** | All commands: **[docs/COMMANDS.md](docs/COMMANDS.md)**

## Channels

| Channel | Status | Notes |
|---------|--------|-------|
| Telegram | Production | Tappable commands, deep links, webhooks |
| Discord | Ready | Slash commands auto-register |
| Slack | Ready | Works in channels and DMs |
| Signal | Ready | Requires signal-cli bridge |
| WhatsApp | Ready | Requires WhatsApp Web bridge |
| iMessage | Ready | macOS only (bare metal Mac) |
| LINE | Ready | Requires LINE Messaging API |

All tools and commands work identically on every channel.

## Wallet Modes

| Mode | Key custody | Setup |
|------|------------|-------|
| **WalletConnect** | Your phone wallet | `/connect` — agent never holds keys |
| **Private key** | Local/Keychain | `CLAWNCHER_PRIVATE_KEY` env var |
| **Bankr** | Custodial | `/connect_bankr` or `BANKR_API_KEY` |

Details: **[docs/SETUP.md#wallet-modes](docs/SETUP.md#wallet-modes)**

## Security

- Agent never holds private keys (WalletConnect mode)
- All write tools are `ownerOnly` — only the paired account owner can invoke them
- Credential leak detection on all LLM-bound output
- Sequential execution — never queues multiple transactions
- Bounded approvals — exact amounts, never unlimited
- Endpoint allowlist — outbound HTTP restricted to curated hosts

Full model: **[docs/SECURITY.md](docs/SECURITY.md)**

## Architecture

Two packages: `openclawnch` (CLI wrapper) and `@clawnch/openclaw-crypto` (standalone extension). The extension registers tools, commands, and hooks through OpenClaw's extension system. Each user runs their own instance.

Includes a compound operations engine for natural language scheduling — time triggers, conditions, loops, parallel execution. Plans persist to disk and survive restarts.

Details: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test         # 1547 pass, 31 skip, 0 fail
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines, testing patterns, and how to add new tools.

## License

MIT — see [LICENSE](LICENSE) for details.
