# Tools Reference

42 tools across 11 categories. All tools work on every channel. Write-operation tools are `ownerOnly: true` — only the paired account owner can invoke them.

Run `/setup` to see which tools are configured and which need additional API keys.

---

## Wallet & Transactions

| Tool | Actions | Description |
|------|---------|-------------|
| `clawnch_connect` | connect, status, disconnect, send_tx, set_policy, sign_message | Wallet lifecycle, transaction signing, spending policies |
| `transfer` | send | Send ETH or ERC-20 tokens to any address or ENS name |
| `permit2` | check, approve, revoke | Uniswap Permit2 token allowance management |
| `approvals` | check, revoke, set, list | Audit and revoke ERC-20 approvals across all tokens |

## DeFi Trading

| Tool | Actions | Description |
|------|---------|-------------|
| `defi_swap` | quote, execute | Token swaps via multi-aggregator routing (0x, 1inch, ParaSwap, KyberSwap, Odos, OpenOcean) |
| `defi_balance` | eth, erc20, all | Wallet balances across chains (JSON-RPC + Alchemy fallback) |
| `liquidity` | mint, add, remove, collect, positions | Uniswap V3/V4 LP management |
| `manage_orders` | create, list, cancel, status | Limit orders, DCA, stop-loss (in-memory execution engine) |
| `bridge` | quote, execute, status, chains | Cross-chain bridging via LI.FI |

## DeFi Protocols

| Tool | Actions | Description |
|------|---------|-------------|
| `defi_lend` | supply, borrow, repay, withdraw, positions | Aave V3 lending/borrowing with health factor monitoring |
| `defi_stake` | stake, unstake, claim, positions | Liquid staking on Lido and Rocket Pool |
| `yield` | opportunities, deposit, withdraw, positions, compare | Yearn V3 ERC-4626 vault operations |

## Market Intelligence

| Tool | Actions | Description |
|------|---------|-------------|
| `defi_price` | token, pair | Token prices via DexScreener |
| `analytics` | rsi, macd, bollinger, sma, ema, candles, signals | Technical analysis with signal scoring |
| `market_intel` | trending, new_pairs, buys_sells | Trending tokens, new pairs, buy/sell ratios |
| `cost_basis` | record, query, summary, reset | P&L tracking with FIFO cost basis calculation |

## Token Launches & Fees

| Tool | Actions | Description |
|------|---------|-------------|
| `clawnch_launch` | deploy, status | Deploy tokens on Clawnch launchpad |
| `clawnch_fees` | check, claim | Check and claim LP fees |
| `clawnch_info` | platform_stats, top_tokens, agent | Platform stats, top tokens, agent management |

## Bankr Integration

Requires `BANKR_API_KEY`.

| Tool | Actions | Description |
|------|---------|-------------|
| `bankr_launch` | deploy, status | Token deployment via Bankr Agent API |
| `bankr_automate` | dca, limit, twap, stop_loss, rebalance, list, cancel | Automated trading strategies |
| `bankr_polymarket` | positions, buy, sell, markets | Prediction market operations |
| `bankr_leverage` | open, close, manage, positions | Leveraged trading |

## NFT & Digital Assets

| Tool | Actions | Description |
|------|---------|-------------|
| `nft` | balance, transfer, metadata, collection_stats, list, buy | ERC-721 operations |
| `airdrop` | list, check, check_all, claim | Airdrop eligibility checking and claim calldata generation |

## Privacy & Security

| Tool | Actions | Description |
|------|---------|-------------|
| `privacy` | shield, unshield, private_transfer, status | Zero-knowledge pool operations |
| `safe` | info, balances, pending_txs, history, propose, confirm, execute | Gnosis Safe multisig via Safe Transaction Service |

## Governance & Social

| Tool | Actions | Description |
|------|---------|-------------|
| `governance` | proposals, vote, delegate, power, create | DAO governance (Governor contracts) |
| `farcaster` | post, timeline, profile, search, channels | Farcaster social protocol via Neynar |

## On-chain Intel

| Tool | Actions | Description |
|------|---------|-------------|
| `block_explorer` | tx, address, contract, holders, gas | Basescan/Etherscan integration |
| `herd_intelligence` | investigate, audit, validate | Token investigation and swap validation |
| `watch_activity` | monitor, history | On-chain swap activity monitoring |
| `browser` | navigate, interact, screenshot, extract | dApp browser automation (PinchTab) |

## Compound Operations

| Tool | Actions | Description |
|------|---------|-------------|
| `compound_action` | create, execute, schedule, list, status, cancel, pause, resume, history | Chain multiple operations with conditions, schedules, loops |

## Agent & Social

| Tool | Actions | Description |
|------|---------|-------------|
| `molten` | profile, search, capabilities, plugins | Agent matching and discovery |
| `clawnx` | post, search, timeline, engage, dm | X/Twitter integration |
| `hummingbot` | 36 actions (start, stop, status, pnl, clmm_positions, routines, dashboard...) | Market-making bot control including Condor CLMM |
| `wayfinder` | 11 actions (route, quote, execute, perps, bridge...) | Cross-chain route discovery and perps routing |
| `crypto_workflow` | check_orders, check_positions, rebalance | Multi-step plan orchestration |

## Self-Improvement

Requires `/evolve` to enable.

| Tool | Actions | Description |
|------|---------|-------------|
| `agent_memory` | store, recall, search, list, delete | Persistent memory across sessions |
| `skill_evolve` | create, refine, list, apply | Generate and refine skill documents from experience |
| `session_recall` | recent, search, summarize | Recall context from previous sessions |
