---
name: lobster-cash
description: Agent payments via Solana USDC wallets and Visa virtual cards for crypto and traditional purchases
---

# Lobster.cash — Agent Payments

Lobster.cash enables the agent to spend money and make purchases.

## What It Is

An OpenClaw plugin by Crossmint that gives AI agents payment capabilities:
- **Solana USDC wallet** for crypto payments
- **Visa virtual cards** for traditional purchases
- Agent can pay for APIs, services, subscriptions — anywhere credit cards or USDC are accepted
- Human approves scoped payment methods

## Installation

```bash
openclaw plugins install @crossmint/lobster.cash
```

Then configure:
```
/flykeys set CROSSMINT_API_KEY your_key
```

## When to Use

- User asks the agent to pay for something (API credits, subscriptions, services)
- Agent needs to autonomously pay for resources (hosting, data feeds)
- User wants to set up payment methods with spending controls
- User wants the agent to manage expenses

## How It Works

1. Lobster.cash provides a custodial Solana USDC wallet for the agent
2. Virtual Visa cards can be created for specific merchants/categories
3. Human sets spending limits and approval policies
4. Agent requests payment → Lobster processes via USDC or Visa

## Spending Controls

- Per-transaction limits ($X max per purchase)
- Daily/weekly/monthly caps
- Merchant category restrictions
- Domain allowlists for online purchases
- Human approval required above threshold

## Integration with OpenClawnch

Lobster.cash complements our existing wallet infrastructure:
- **Agent payments** (Lobster) — for the agent to spend money on the user's behalf
- **User DeFi** (ClawnchConnect/Bankr) — for on-chain financial operations

They serve different purposes and can coexist.

## Important Notes

1. **Solana-based** — Lobster uses Solana USDC, not Base/Ethereum
2. **Custodial** — Lobster holds the payment wallet (different from our non-custodial model)
3. **Plugin, not a tool** — installs as a separate OpenClaw plugin alongside our crypto extension
4. **Evaluate vs PaySponge** — Lobster for Visa cards, PaySponge for multi-chain crypto payments. Pick one or both.
