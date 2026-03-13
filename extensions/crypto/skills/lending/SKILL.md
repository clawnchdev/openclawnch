---
name: lending
description: Supply, borrow, repay, and check health factors on Aave V3 lending protocol on Base
---

# Lending & Borrowing

Use the `defi_lend` tool for lending protocol operations on Aave V3 (Base).

## When to Use

- User wants to earn yield on idle assets → `supply`
- User wants to borrow against collateral → `borrow`
- User asks about liquidation risk → `health_factor`
- User wants to see what they've supplied/borrowed → `positions`
- User wants to repay debt → `repay`
- User wants to withdraw collateral → `withdraw`

## Key Concepts

**Health Factor**: Ratio of collateral value to debt. Below 1.0 = liquidation. Keep above 1.5 for safety.
- > 2.0: Healthy
- 1.5-2.0: Moderate, consider adding collateral
- 1.1-1.5: Warning zone
- < 1.1: Danger, immediate action needed

**LTV (Loan-to-Value)**: Maximum percentage of collateral value you can borrow. Varies by asset.

**Liquidation Threshold**: Collateral value at which liquidation can be triggered. Always higher than LTV.

## Supported Assets (Base)

| Asset | Supply | Borrow |
|-------|--------|--------|
| ETH (WETH) | Yes | Yes |
| USDC | Yes | Yes |
| cbETH | Yes | Yes |
| USDbC | Yes | Yes |

## Common Flows

### Earn yield on USDC
```
defi_lend action=supply asset=USDC amount=1000
```

### Borrow against ETH collateral
```
defi_lend action=supply asset=ETH amount=1.0    # First supply collateral
defi_lend action=borrow asset=USDC amount=500   # Then borrow
```

### Repay and withdraw
```
defi_lend action=repay asset=USDC amount=max     # Repay all debt
defi_lend action=withdraw asset=ETH amount=max   # Withdraw all collateral
```

## Safety Rules

1. **Always check health factor before borrowing** — use `health_factor` action first
2. **Never let health factor drop below 1.5** — warn the user if a borrow would push it below
3. **Use "max" for full repay/withdraw** — avoids dust amount issues
4. **Supply before borrow** — you need collateral first
5. **Monitor positions after volatile moves** — suggest periodic health checks
