# Safe Multisig

Use the `safe` tool to manage Safe{Wallet} multisig wallets.

## When to Use

- User asks about their Safe/multisig wallet details
- User wants to check pending transactions needing signatures
- User wants to propose a new multisig transaction
- User wants to confirm (co-sign) a pending transaction
- User asks about Safe balances or transaction history

## Supported Chains

| Chain | Chain ID |
|-------|----------|
| Ethereum | 1 |
| Base | 8453 |
| Arbitrum | 42161 |
| Optimism | 10 |
| Polygon | 137 |

## Actions

| Action | Description | Required Params |
|--------|-------------|-----------------|
| info | Safe details (threshold, owners, nonce) | safe_address |
| balances | Token balances (ETH + ERC-20) | safe_address |
| pending_txs | List pending transactions awaiting signatures | safe_address |
| history | Executed transaction history | safe_address |
| propose | Propose a new transaction | safe_address, to, signature |
| confirm | Co-sign a pending transaction | safe_tx_hash, signature |
| execute | Check if a transaction has enough signatures | safe_tx_hash |

## Common Flows

### Check Safe info
```
safe action=info safe_address=0x... chain=ethereum
safe action=info safe_address=mywallet.eth chain=base
```

### View balances
```
safe action=balances safe_address=0x... chain=base
```

### Check pending transactions
```
safe action=pending_txs safe_address=0x... chain=ethereum
```

### View transaction history
```
safe action=history safe_address=0x... chain=ethereum limit=10
```

### Check execution readiness
```
safe action=execute safe_tx_hash=0x... chain=ethereum
```

## Important Notes

1. **ENS supported** -- safe_address can be an ENS name (resolved on Ethereum mainnet)
2. **Signatures required** -- propose and confirm actions require EIP-712 signatures generated off-chain using the Safe signing scheme
3. **Wallet required** -- propose action verifies the connected wallet is a Safe owner
4. **Execution** -- the execute action checks readiness (threshold met) but does not submit the on-chain execution transaction. Use the Safe app or submit directly.
5. **Multi-chain** -- defaults to Ethereum. Pass `chain=base` etc. to query other networks.
6. **Public API** -- Safe Transaction Service is free, no API key required
