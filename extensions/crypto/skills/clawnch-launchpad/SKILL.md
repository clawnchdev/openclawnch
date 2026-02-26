---
name: clawnch-launchpad
description: Deploy tokens via the Clawnch launchpad on Base with Uniswap V4 pools, MEV protection, and fee distribution. Manage trading fee revenue.
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

## Launch Checklist

1. Ensure wallet is connected (`/wallet`)
2. Ensure `CLAWNCHER_API_KEY` is set
3. Choose a unique name and symbol (max 10 chars)
4. Optionally prepare a token logo image
5. Consider a vault (shows long-term commitment)
6. Deploy and wait for confirmation
7. Share the token's Clawnch URL and trading link

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAWNCHER_API_KEY` | Yes | Agent API key from https://clawn.ch/agents |
| `CLAWNCHER_API_URL` | No | Custom API URL (default: https://clawn.ch) |
