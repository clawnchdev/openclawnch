---
name: staking
description: Liquid staking operations on Ethereum including staking ETH, checking APYs, and managing LSTs
---

# Liquid Staking

Use the `defi_stake` tool for liquid staking operations on Ethereum mainnet.

## When to Use

- User wants to stake ETH for yield
- User asks about staking APYs or LST positions
- User wants to convert between stETH and wstETH
- User wants to exit a staking position

## Supported Protocols

| Protocol | Stake | Unstake | Tokens |
|----------|:-----:|:-------:|--------|
| Lido | Yes (ETH -> stETH) | Via swap | stETH, wstETH |
| Rocket Pool | Yes (ETH -> rETH) | Yes (rETH -> ETH) | rETH |
| Coinbase | Via swap | Via swap | cbETH |

## Key Concepts

**Liquid Staking Token (LST)**: A token representing staked ETH. Earns staking rewards while remaining tradeable and usable in DeFi.

**wstETH vs stETH**: wstETH is the "wrapped" version of stETH. It's value-accruing (1 wstETH > 1 stETH over time) rather than rebasing. Preferred for DeFi (Aave collateral, L2 bridges).

**Exchange Rates**: LSTs are not 1:1 with ETH. rETH and wstETH appreciate over time as staking rewards accrue.

## Common Flows

### Stake ETH via Lido
```
defi_stake action=stake protocol=lido amount=1.0
```
Receives stETH. Then optionally wrap:
```
defi_stake action=wrap amount=1.0
```

### Stake via Rocket Pool
```
defi_stake action=stake protocol=rocket_pool amount=1.0
```

### Check positions and APYs
```
defi_stake action=positions
defi_stake action=positions chain=base
```

### Exit staking
```
defi_stake action=unstake protocol=rocket_pool amount=1.0
```
For Lido/cbETH, use `defi_swap` to swap LST back to ETH (instant, market rate).

## APY Data

APYs are fetched from DeFiLlama and cached for 10 minutes. Typical ranges:
- Lido (stETH): ~3-4% APY
- Rocket Pool (rETH): ~3-4% APY
- Coinbase (cbETH): ~3-4% APY

## Important Notes

1. **Staking targets Ethereum mainnet** — all stake/unstake/wrap/unwrap operations execute on Ethereum L1
2. **Positions work on both chains** — `positions` shows balances on Ethereum and Base (bridged LSTs)
3. **Lido unstaking has a queue** — direct withdrawal takes 7+ days; swap stETH for ETH via DEX for instant exit
4. **cbETH can only be swapped** — no direct mint/redeem contract; use `defi_swap` instead
5. **Gas costs** — Ethereum L1 gas is higher than Base; factor this into small staking amounts
