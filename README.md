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
- **12 agent tools** — wallet, prices, balances, swaps, launches, fees, market intel, hummingbot, orders, watcher, X/Twitter, herd intelligence
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
| `HUMMINGBOT_API_URL` | For hummingbot | Hummingbot API URL (default: http://localhost:8000) |
| `HUMMINGBOT_USERNAME` | For hummingbot | Hummingbot API username (default: admin) |
| `HUMMINGBOT_PASSWORD` | For hummingbot | Hummingbot API password (default: admin) |
| `X_API_KEY` | For clawnx | X/Twitter API key |
| `X_API_SECRET` | For clawnx | X/Twitter API secret |
| `X_ACCESS_TOKEN` | For clawnx | X/Twitter access token |
| `X_ACCESS_TOKEN_SECRET` | For clawnx | X/Twitter access token secret |
| `X_BEARER_TOKEN` | For clawnx | X/Twitter bearer token (optional) |
| `HERD_ACCESS_TOKEN` | For herd | Herd Intelligence access token |

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

### `hummingbot` — Market Making Bot Control
Control Hummingbot instances: place orders, manage executors, deploy bots with strategies, get market data, run backtests.
- `status` — Health check
- `portfolio` — Balances and positions
- `order` / `cancel_order` / `active_orders` — Trading
- `executor` / `stop_executor` / `executors` — Executor management
- `market_data` / `candles` / `orderbook` — Market data
- `bot_deploy` / `bot_status` / `bot_stop` — Bot orchestration
- `templates` / `backtest` — Strategy templates and backtesting
- `gateway_status` / `gateway_start` / `gateway_stop` — DEX gateway

### `manage_orders` — Conditional Orders
Create and manage conditional orders with risk management.
- 7 order types: `limit_buy`, `limit_sell`, `stop_loss`, `take_profit`, `dca`, `trailing_stop`, `twap`
- Order chaining (e.g., buy then auto-set stop-loss)
- Risk management: position sizing, drawdown circuit breaker, rate limiting
- Actions: `create`, `list`, `cancel`, `check`, `executed`, `failed`, `pause`, `resume`, `risk`, `cleanup`

### `watch_activity` — On-Chain Monitoring
Monitor on-chain activity on Base. Read-only, no wallet needed.
- `token_activity` — Full activity report (swaps + transfers + stats)
- `recent_swaps` — Recent swaps for a pool
- `recent_transfers` — Token transfers
- `deployments` — Recent Clawnch token deployments

### `clawnx` — X/Twitter Integration
45+ actions for X/Twitter: post, engage, manage followers, DMs, lists, streaming.
- Content: `post_tweet`, `post_thread`, `post_with_media`, `search`
- Engagement: `like`, `retweet`, `bookmark`, and more
- Social: `follow`, `block`, `mute`, `get_user`
- Timelines: `get_timeline`, `home_timeline`, `get_mentions`
- DMs: `send_dm`, `list_dms`
- Lists: `create_list`, `list_tweets`, `list_members`
- Streaming: `stream_start`, `stream_rules_set`
- Orchestration: `action_chain` (chain multiple actions with PREV_TWEET_ID substitution)

### `herd_intelligence` — On-Chain Intelligence
Investigate contracts, transactions, wallets. Audit tokens. Validate swaps and fee claims. All read-only.
- `investigate` — Auto-detect and analyze address or tx hash
- `audit_token` — Token safety audit (rug pull, honeypot detection)
- `validate_swap` — Check swap route viability
- `validate_claim` — Verify fee claim profitability
- `profile_counterparty` — Assess wallet trustworthiness
- `search_code` — Search contract source code
- `track_token` — Trace token flow for a holder
- `bookmark` — Manage investigation bookmarks
- `simulate` — Build HAL simulation expressions

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
│   │   ├── tools/               # 12 agent tools
│   │   ├── commands/            # 3 slash commands
│   │   ├── services/            # WalletConnect service
│   │   └── lib/                 # Shared types & helpers
│   └── skills/                  # 4 SKILL.md files
├── SOUL.md                      # Agent persona
└── PLAN.md                      # Build spec
```

## Dependencies

- **[@clawnch/sdk](https://www.npmjs.com/package/@clawnch/sdk)** — WalletConnectSigner, spending policies, session persistence
- **[@clawnch/clawncher-sdk](https://www.npmjs.com/package/@clawnch/clawncher-sdk)** — Token deployment, swaps, fee claims, price feeds, orders, watcher, herd intelligence, hummingbot
- **[@clawnch/clawnx](https://www.npmjs.com/package/@clawnch/clawnx)** — X/Twitter API client
- **[viem](https://viem.sh)** — Ethereum client library
- **[@sinclair/typebox](https://github.com/sinclairzx81/typebox)** — JSON schema for tool parameters (matches OpenClaw convention)

## License

MIT
