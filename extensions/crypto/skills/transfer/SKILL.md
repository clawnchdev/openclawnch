---
name: transfer
description: Send ETH or ERC-20 tokens to a recipient address. Estimate gas, check balances, and execute transfers through ClawnchConnect for approval.
metadata: { "openclaw": { "emoji": "💸" } }
---

# Transfer — Send Tokens

## When to Use

- User wants to send ETH to another address
- User wants to send ERC-20 tokens (USDC, USDT, WETH, etc.)
- User wants to estimate gas costs before sending
- User wants to check if they have sufficient balance for a transfer

## When NOT to Use

- Token swaps (use defi-trading skill)
- Adding/removing liquidity (use liquidity skill)
- Cross-chain transfers (use wayfinder skill)

## Tool: `transfer`

### Actions

| Action | Description |
|--------|-------------|
| `estimate` | Check balance and estimate gas without sending. Always do this first. |
| `send` | Execute the transfer. Goes through ClawnchConnect for approval. |

### Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `to` | Yes | Recipient address (0x...) |
| `amount` | Yes | Amount in human-readable units (e.g., "0.1" for 0.1 ETH, "100" for 100 USDC) |
| `token` | No | ERC-20 contract address. Omit for native ETH transfer. |

### Well-Known Tokens on Base

| Symbol | Address | Decimals |
|--------|---------|----------|
| USDC | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | 6 |
| USDT | 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2 | 6 |
| DAI | 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb | 18 |
| WETH | 0x4200000000000000000000000000000000000006 | 18 |
| CLAWNCH | 0xa1F72459dfA10BAD200Ac160eCd78C6b77a747be | 18 |

### Estimate Response

The `estimate` action returns:
- Current ETH balance
- Token balance (for ERC-20 transfers)
- Whether balance is sufficient
- Gas estimate
- Shortfall amount (if insufficient)

### Execution Flow

1. **Always estimate first:** `action: estimate, to: 0x..., amount: "0.1"`
2. Show the user: balance, gas estimate, sufficiency
3. If user confirms: `action: send, to: 0x..., amount: "0.1"`
4. Transaction goes to ClawnchConnect for approval (phone notification or auto-approve via policy)
5. Wait for receipt — report success or revert

### Safety Checks

- Pre-flight balance check for both ETH gas and token amount
- ERC-20 transfers check token balance before submitting
- ETH transfers check via safety-service `checkBalance()`
- Reverted transactions are detected and reported

### Important Notes

- Always show the recipient address, amount, and estimated gas before executing
- For ERC-20 tokens not in the well-known list, decimals are read from the chain (falls back to 18)
- Double-check recipient addresses — blockchain transfers are irreversible
- Large transfers will likely require phone approval via ClawnchConnect
