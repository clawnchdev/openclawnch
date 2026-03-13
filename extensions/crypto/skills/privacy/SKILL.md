---
name: privacy
description: Execute private transactions on Base via Veil.cash ZK privacy pools
---

# Privacy (Veil.cash)

Use the `privacy` tool for private transactions on Base via Veil.cash ZK privacy pools.

## When to Use

- User wants to make a private transfer
- User wants to deposit ETH/USDC into a privacy pool
- User wants to withdraw from a privacy pool to break on-chain linkage
- User asks about shielded balances
- User asks about Veil.cash or privacy-preserving transactions

## How It Works

1. **Deposit**: Send ETH or USDC from your public wallet into the privacy pool (on-chain transaction)
2. **Wait**: Let time pass so the anonymity set grows (more users = more privacy)
3. **Withdraw**: Exit to any address using a ZK proof that proves you deposited without revealing which deposit is yours

The ZK proof breaks the on-chain link between deposit and withdrawal addresses.

## Actions

| Action | Description | Required Params |
|--------|-------------|-----------------|
| deposit | Send to privacy pool | asset, amount |
| withdraw | Exit pool to an address | asset, amount, recipient |
| transfer | Private-to-private transfer | asset, amount, recipient (shielded key) |
| balance | Check shielded balance | (asset optional) |
| info | Pool info and supported assets | (none) |

## Supported Assets

| Asset | Pool Denomination |
|-------|-------------------|
| ETH | Variable |
| USDC | Variable |

## Common Flows

### Deposit into privacy pool
```
privacy action=deposit asset=ETH amount=0.1
```
Returns a note hash — **user must save this** for recovery.

### Withdraw to a fresh address
```
privacy action=withdraw asset=ETH amount=0.1 recipient=0xNewAddress...
```
Supports ENS names for recipient. Uses relayer for privacy (your wallet doesn't submit the withdrawal tx directly).

### Private transfer
```
privacy action=transfer asset=USDC amount=100 recipient=<shielded_public_key>
```
Both sender and recipient stay within the pool.

### Check shielded balance
```
privacy action=balance
privacy action=balance asset=ETH
```

### View pool info
```
privacy action=info
```
Shows supported assets, pool status, and whether @veil-cash/sdk is installed.

## Important Notes

1. **Base only** — Veil.cash privacy pools are deployed on Base
2. **SDK required** — `@veil-cash/sdk` must be installed (`pnpm add @veil-cash/sdk`). The tool gracefully reports if it's missing.
3. **Save your notes** — Encrypted deposit notes are required for recovery. If lost and wallet access is lost, funds cannot be recovered.
4. **Relayer withdrawals** — Withdrawals are submitted via relayer to preserve privacy (small fee applies)
5. **Anonymity takes time** — Larger anonymity sets provide better privacy. Depositing and immediately withdrawing offers less privacy.
6. **Wallet required** — deposit, balance, and transfer actions require a connected wallet
