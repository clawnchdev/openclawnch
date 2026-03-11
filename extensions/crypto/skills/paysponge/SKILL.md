# PaySponge — Agent Financial Infrastructure

PaySponge (YC-backed) provides agent wallets, spending controls, and a gateway for businesses to sell to agents.

## What It Is

Financial infrastructure purpose-built for AI agents:
- **Agent wallets** — fiat + crypto, multi-chain (Base, Solana, Tempo)
- **Spending controls** — per-operation cost limits, daily caps, domain allowlists
- **Business gateway** — standardized interface for merchants to accept agent payments
- **OpenClaw skill** available at `sponge.md`

## Setup

Add the PaySponge skill and configure:
```
/flykeys set PAYSPONGE_API_KEY your_key
```

## When to Use

- Agent needs to pay for crypto-native services (API calls, data feeds, compute)
- User wants granular spending controls ($X/day, $Y/tx, domain restrictions)
- Agent needs a multi-chain wallet for programmatic payments
- User wants to set up autonomous spending for recurring costs

## Spending Controls

PaySponge offers fine-grained spending policies:

| Control | Description |
|---------|-------------|
| Per-tx limit | Maximum amount per single transaction |
| Daily cap | Maximum daily spend across all transactions |
| Domain allowlist | Only allow payments to specific domains/services |
| Category rules | Allow/block specific merchant categories |
| Asset restrictions | Limit which tokens the agent can spend |
| Approval threshold | Human approval required above $X |

## Supported Chains

- Base (primary)
- Solana
- Tempo (Tempo Network)

## Integration with OpenClawnch

PaySponge complements our existing infrastructure:
- **DeFi operations** (ClawnchConnect) — user-directed on-chain transactions
- **Agent payments** (PaySponge) — agent-initiated spending within budgets
- **Budget tracking** (budget-service) — our existing per-operation cost tracking integrates naturally

## Lobster.cash vs PaySponge

| Feature | Lobster.cash | PaySponge |
|---------|-------------|-----------|
| Visa cards | Yes | No |
| Crypto payments | Solana USDC | Base, Solana, Tempo |
| Spending controls | Basic limits | Granular policies |
| Merchant gateway | No | Yes |
| OpenClaw integration | Plugin | Skill |

Both can coexist: Lobster for Visa card payments, PaySponge for crypto-native payments with fine-grained controls.

## Important Notes

1. **YC-backed** — legitimate infrastructure with VC funding and active development
2. **Multi-chain** — works on Base (our primary chain), not limited to one chain
3. **Skill, not a plugin** — integrates as a skill doc guiding the agent, not a standalone tool
4. **Evaluate alongside budget-service** — our existing `budget-service.ts` already tracks per-operation costs; PaySponge adds execution (actual payments) on top
