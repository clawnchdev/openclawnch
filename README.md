# OpenClawnch

OpenClaw for crypto. The biggest open-source AI assistant, now it handles real money.

OpenClawnch is a thin wrapper around [OpenClaw](https://github.com/openclaw/openclaw) (229k stars) that adds crypto/DeFi capabilities via a standalone extension. Not a fork — a clean plugin that registers tools, commands, and skills through OpenClaw's plugin API.

## Architecture

Two npm packages, one repo:

| Package | Purpose |
|---------|---------|
| `openclawnch` | CLI wrapper — injects the crypto extension into OpenClaw's config, then delegates |
| `@clawnch/openclaw-crypto` | Standalone extension — also works with vanilla OpenClaw via `openclaw extensions add` |

The extension registers:
- **7 agent tools** — wallet connect, prices, balances, swaps, token launches, fee claims, market intel
- **3 slash commands** — `/wallet`, `/policy`, `/tx`
- **4 skills** — ClawnchConnect, DeFi Trading, Clawnch Launchpad, Market Intel
- **1 gateway hook** — auto-initializes WalletConnect at startup

## Security Model: ClawnchConnect

The agent never holds private keys. Every write transaction goes through one of two paths:

1. **WalletConnect** (production) — TX approval on your phone via MetaMask/Rainbow/etc.
2. **Private key** (testing) — set `CLAWNCHER_PRIVATE_KEY` for headless CI/testing

Spending policies let you auto-approve small transactions ("approve under 0.01 ETH, max 5/hour") while requiring manual approval for larger ones.

## Quick Start

```bash
# Install globally
npm install -g openclawnch

# Run (uses OpenClaw under the hood)
openclawnch

# Or install the extension into existing OpenClaw
openclaw extensions add @clawnch/openclaw-crypto
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WALLETCONNECT_PROJECT_ID` | For WC mode | Get one at [cloud.reown.com](https://cloud.reown.com) |
| `CLAWNCHER_PRIVATE_KEY` | For testing | Hex private key (0x...) for headless mode |
| `CLAWNCHER_API_KEY` | For launches | API key for Clawnch deploy API. Get at [clawn.ch/agents](https://clawn.ch/agents) |
| `CLAWNCHER_API_URL` | No | API base URL (default: https://clawn.ch) |
| `CLAWNCHER_NETWORK` | No | `mainnet` or `sepolia` (default: mainnet) |

## Tools

### `clawnchconnect` — Wallet Connection
Connect your wallet, send transactions, manage spending policies, sign messages.
- `connect` — Start WalletConnect pairing (shows QR code)
- `status` — Check connection state
- `disconnect` — End session
- `send_tx` — Submit a transaction for approval
- `set_policy` — Set spending auto-approval rules
- `sign_message` — Sign an arbitrary message

### `defi_price` — Token Prices
Real-time prices from DexScreener with CoinGecko fallback.
- `lookup` — Price by address
- `search` — Search by name/symbol
- `trending` — Trending tokens on Base

### `defi_balance` — Wallet Balances
Check ETH and ERC-20 balances.
- `overview` — Full portfolio summary
- `tokens` — All token balances
- `eth` — ETH balance only

### `defi_swap` — Token Swaps
Swap any tokens on Base via 0x aggregator, routed through ClawnchConnect.
- `quote` — Get price, impact, gas estimate
- `execute` — Execute the swap

### `clawnch_launch` — Token Deployment
Deploy ERC-20 tokens via the Clawnch launchpad with Uniswap V4 pools, MEV protection, and fee distribution.

### `clawnch_fees` — Fee Claims
Check and claim LP trading fees from Clawnch-launched tokens (80/20 split).
- `check` — See unclaimed fees
- `claim` — Claim for specific token
- `claim_all` — Claim all available fees

### `market_intel` — Market Intelligence
Trending tokens, new pairs, whale activity, token analysis, and leaderboards.

## Commands

| Command | Description |
|---------|-------------|
| `/wallet` | Quick wallet status check |
| `/policy` | View/manage spending policies |
| `/tx` | View recent transaction history |

## Development

```bash
# Install dependencies
pnpm install

# Type check
npx tsc --noEmit

# Build both packages
pnpm build

# Run tests
pnpm test

# Clean build artifacts
pnpm clean
```

## Project Structure

```
openclawnch/
├── bin/openclawnch.mjs          # CLI entry point
├── src/wrapper.ts               # Programmatic API
├── extensions/crypto/
│   ├── index.ts                 # Plugin registration
│   ├── src/
│   │   ├── tools/               # 7 agent tools
│   │   ├── commands/            # 3 slash commands
│   │   ├── services/            # WalletConnect service
│   │   └── lib/                 # Shared types & helpers
│   └── skills/                  # 4 SKILL.md files
├── SOUL.md                      # Agent persona
└── PLAN.md                      # Build spec
```

## Dependencies

- **[@clawnch/sdk](https://www.npmjs.com/package/@clawnch/sdk)** — WalletConnectSigner, spending policies, session persistence
- **[@clawnch/clawncher-sdk](https://www.npmjs.com/package/@clawnch/clawncher-sdk)** — Token deployment, swaps, fee claims, price feeds
- **[viem](https://viem.sh)** — Ethereum client library
- **[@sinclair/typebox](https://github.com/sinclairzx81/typebox)** — JSON schema for tool parameters (matches OpenClaw convention)

## License

MIT
