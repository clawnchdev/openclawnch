---
name: yield
description: Find best DeFi yields across protocols and deposit into vaults
---

# Yield Aggregation

Use the `yield` tool to find the best DeFi yields and deposit into vaults.

## When to Use

- User asks "where can I earn yield on USDC?" or "what's the best APY?"
- User wants to deposit into a yield vault
- User wants to check their vault positions
- User asks about DeFi yield opportunities across protocols

## Data Source

All yield data comes from DeFiLlama's yields API (`yields.llama.fi/pools`), which aggregates data from 400+ protocols across all EVM chains. Data refreshes every 5 minutes.

## Actions

| Action | Description | Required Params |
|--------|-------------|-----------------|
| search | Search yield pools with filters | (all optional) |
| top_yields | Best yields for a specific asset | asset |
| deposit | Deposit into Yearn V3 vault on Base | vault/asset, amount |
| withdraw | Withdraw from vault | vault/asset, amount |
| positions | View vault positions | (none) |
| vaults | List available vaults | (none) |

## Available Vaults (Base)

| Vault | Asset | Standard |
|-------|-------|----------|
| yvUSDC | USDC | ERC-4626 |
| yvWETH | WETH | ERC-4626 |
| yvDAI | DAI | ERC-4626 |

## Common Flows

### Find best yields for an asset
```
yield action=search asset=USDC chain=base
yield action=top_yields asset=USDC chain=base
```

### Search with filters
```
yield action=search chain=base stable_only=true min_apy=5 min_tvl=1000000
yield action=search project=aave chain=ethereum
```

### Deposit into a vault
```
yield action=deposit vault=yvUSDC amount=1000
yield action=deposit asset=WETH amount=0.5
```

### Withdraw from a vault
```
yield action=withdraw vault=yvUSDC amount=max
yield action=withdraw asset=WETH amount=0.5
```

### Check positions
```
yield action=positions
```

## Search Parameters

- `chain` — Filter by chain (base, ethereum, arbitrum, optimism, polygon)
- `asset` — Filter by asset symbol in pool name
- `project` — Filter by protocol (aave, yearn, moonwell, morpho, etc.)
- `min_tvl` — Minimum TVL in USD (default: $100K)
- `min_apy` — Minimum APY percentage
- `stable_only` — Only stablecoin pools
- `limit` — Max results (default: 20)

## Important Notes

1. **Search covers all protocols** — DeFiLlama data includes Aave, Yearn, Moonwell, Morpho, Pendle, and 400+ more
2. **Deposits are Yearn V3 only** — Direct deposit execution currently supports Yearn V3 vaults on Base (ERC-4626). For Aave deposits, use `defi_lend` tool instead.
3. **No new dependencies** — Uses DeFiLlama public API and direct contract calls
4. **APY is variable** — Displayed APYs are current rates and fluctuate over time
5. **Wallet required** — deposit, withdraw, and positions require a connected wallet
6. **TVL filter** — Default $100K TVL minimum to exclude dust/dead pools
