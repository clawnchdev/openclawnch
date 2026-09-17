---
name: clawnch-launchpad
description: Deploy tokens via the Clawnch launchpad — Base (Uniswap V4 pools, MEV protection) or Robinhood Chain (Bags.fm launch router). Manage trading fee revenue.
metadata: { "openclaw": { "emoji": "🚀", "requires": { "env": ["CLAWNCHER_API_KEY"] } } }
---

# Clawnch Launchpad & Fee Management

## When to Use

- User wants to deploy/launch a new token
- User wants to check or claim trading fee revenue
- User asks about the Clawnch platform or agent leaderboard

## Tools

### `clawnch_launch` — Deploy Tokens

Deploy a new ERC-20 token on Base with:
- Uniswap V4 pool (instant liquidity)
- MEV protection (80% fee decaying to 5% over 30 seconds)
- Fee distribution (80% to deployer, 20% to platform)
- Optional vault (lock supply for 7+ days)
- Optional dev buy (buy tokens at launch)

**Required parameters:** `name`, `symbol`
**Optional:** `description`, `image`, `vault_percentage`, `dev_buy_eth`, `bypass_rate_limit`

**Rate limit:** 1 free launch per hour. Burn 10,000 $CLAWNCH to bypass.

### `clawnch_fees` — Fee Revenue

Every swap on a Clawnch-launched token pays 1% LP fees. 80% goes to you.

- **check**: See unclaimed fees across all your tokens
- **claim**: Claim fees for a specific token (3-step: collect from LP, claim WETH, claim token)
- **claim_all**: Claim all available fees

### `market_intel` with `leaderboard` action

See top Clawnch agents ranked by total market cap, volume, and launches.

## Robinhood Chain (chainId 4663)

Robinhood Chain launches run through the Clawnch launch router + Bags.fm (no Clanker, no
Uniswap V4). Pass `chain: "robinhood"` — Base stays the default, and Base-only options
(`vault_percentage`, `dev_buy_eth`, `bypass_rate_limit`) raise a clear
"not supported on Robinhood Chain" error instead of silently using Base.

- **ticket mode (default):** `clawnch_launch` fetches an EIP-712 ticket from
  `POST /api/robinhood/ticket`, you sign + pay the launch transaction with your own wallet
  (verified-agent launch), then the tool confirms it via `POST /api/robinhood/launch`.
- **deposit mode:** `mode: "deposit"` sends the required ETH (max of the live Bags creation
  fee and 0.02 ETH) to the router's deposit address and the platform deploys for you.
  Use `dry_run: true` first to see the deposit address and amount.
- **fees:** `clawnch_fees` with `chain: "robinhood"` reads claimable WETH from each token's
  Bags fee share (`GET/POST /api/robinhood/claim`) and signs the claim from your wallet.
- **links:** trade on `https://bags.fm/token/<address>`, explorer is
  `https://robinhoodchain.blockscout.com`.

## Launch Checklist

1. Ensure wallet is connected (`/wallet`)
2. Ensure `CLAWNCHER_API_KEY` is set
3. Choose a unique name and symbol (max 10 chars)
4. Optionally prepare a token logo image
5. Consider a vault (shows long-term commitment) — Base only
6. Deploy and wait for confirmation
7. Share the token's Clawnch URL and trading link (bags.fm link on Robinhood Chain)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAWNCHER_API_KEY` | Yes | Agent API key from https://clawn.ch/agents |
| `CLAWNCHER_API_URL` | No | Custom API URL (default: https://clawn.ch) |
| `LAUNCH_CHAIN` | No | Default chain for `clawnch_launch` when `chain` is omitted (`base` \| `robinhood`) |
| `ROBINHOOD_RPC_URL` | No | Custom Robinhood Chain RPC (default: public, rate limited) |
