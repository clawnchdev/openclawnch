---
name: defi-trading
description: Execute DeFi trades, check token prices, manage portfolio balances, and analyze market conditions on Base and other EVM chains.
metadata: { "openclaw": { "emoji": "📊" } }
---

# DeFi Trading

## When to Use

- User asks about token prices or market data
- User wants to check their wallet balance or portfolio
- User wants to swap tokens
- User asks about market trends or trading opportunities

## When NOT to Use

- Non-financial/non-crypto queries
- Token deployment (use clawnch-launchpad skill)
- Fee claiming (use clawnch-launchpad skill)

## Available Tools

### `defi_price` — Token Prices
- **lookup**: Get price, 24h change, volume, liquidity for any token
- **search**: Find tokens by name or symbol
- **trending**: See what's hot on DexScreener

Supports any token on Base, Ethereum, Arbitrum, Optimism, Polygon.

### `defi_balance` — Wallet Balances
- **overview**: Full portfolio summary (ETH + tokens + USD values)
- **tokens**: ERC-20 token holdings
- **eth**: Just the ETH balance

Defaults to the connected wallet. Can check any address.

### `defi_swap` — Token Swaps
- **quote**: Get a swap quote with price impact and gas estimate
- **execute**: Execute the swap via DEX aggregator

**Always get a quote first** before executing. Present the quote to the user and let them decide. Mention:
- Price impact percentage
- Gas cost estimate
- Slippage tolerance
- Whether it will need phone approval (check against spending policies)

### Well-Known Tokens on Base

| Symbol | Address |
|--------|---------|
| ETH | Native (0xEeee...EEeE) |
| WETH | 0x4200000000000000000000000000000000000006 |
| USDC | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 |
| CLAWNCH | 0xa1F72459dfA10BAD200Ac160eCd78C6b77a747be |

### Risk Guidelines

- Never execute swaps without the user's explicit request
- Always show the quote before executing
- Warn about high price impact (>2%)
- Warn about low liquidity pools
- Suggest setting spending policies before frequent trading
