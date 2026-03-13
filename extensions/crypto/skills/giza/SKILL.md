---
name: giza
description: Autonomous DeFi yield optimization on Base via self-custodial agent vaults
---

# Giza Tech — Autonomous DeFi Yield

Giza provides autonomous DeFi yield optimization on Base via self-custodial agent vaults.

## What It Is

Giza's "Arma" product deploys intelligent savings agents on Base that:
- Monitor lending protocol rates across Aave, Morpho, Moonwell, and others
- Detect rate shifts and rebalance capital automatically
- Self-custodial: user retains control of their vault
- Target the same DeFi-native user profile as openclawnch

## Integration Paths

### Read-only (recommended first)
Surface Giza vault APYs via the `yield` tool or `wayfinder`:
```
yield action=search project=giza chain=base
```
If Giza pools appear in DeFiLlama data, they'll show up in yield searches automatically.

### Direct vault deposits (future)
When Giza publishes a public API:
- Allow deposits into Giza agent vaults
- Surface Giza-optimized strategies alongside our own yield tools
- Monitor Giza vault performance in the `yield positions` view

## When to Use

- User asks about automated yield optimization on Base
- User wants to compare Giza vault APYs with direct lending/staking
- User mentions "Arma" or "Giza" by name
- User wants passive yield management without manual rebalancing

## Key Concepts

**Agent Vaults**: Self-custodial smart contract vaults managed by Giza's AI agents. User deposits assets; agent autonomously allocates across protocols for optimal yield.

**Rate Monitoring**: Giza agents continuously monitor lending rates and rebalance when rate differentials exceed thresholds.

**Self-custodial**: Unlike centralized yield products, Giza vaults are on-chain smart contracts where the user retains ownership.

## Important Notes

1. **No direct API yet** — integration depends on Giza publishing a public API. Currently informational only.
2. **Base-focused** — Giza operates primarily on Base, aligning with our default chain
3. **Complements our tools** — Giza automates rebalancing; our `yield` tool handles manual deposits. Different use cases.
4. **DeFiLlama integration** — if Giza pools are indexed by DeFiLlama, they appear in `yield action=search` automatically
