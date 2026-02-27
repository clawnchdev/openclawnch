---
name: clawnchconnect
description: Connect a mobile wallet for human-approved blockchain transactions via ClawnchConnect. Manage spending policies, sign messages, and submit transactions that go to the user's phone for approval.
metadata: { "openclaw": { "emoji": "🦞", "requires": { "env": ["WALLETCONNECT_PROJECT_ID"] } } }
---

# ClawnchConnect — Wallet Connection & Transaction Signing

## When to Use

- User wants to connect a crypto wallet
- User wants to send a blockchain transaction
- User wants to set spending policies for auto-approval
- User wants to check their wallet connection status
- User wants to sign a message with their wallet
- Any DeFi tool requires a connected wallet

## When NOT to Use

- Read-only operations (price checks, balance views for other addresses)
- Non-crypto tasks

## Tool: `clawnchconnect`

### Actions

| Action | Description |
|--------|-------------|
| `connect` | Initialize WalletConnect pairing. Provides a deep link for the user to tap and open their mobile wallet (MetaMask, Rainbow, Coinbase Wallet, etc.) |
| `status` | Check connection state, address, chain, ETH balance, and active spending policies |
| `disconnect` | End the WalletConnect session |
| `send_tx` | Submit a transaction. Auto-approved if within policy, otherwise goes to user's phone |
| `set_policy` | Set spending policies using natural language |
| `sign_message` | Request a message signature from the connected wallet |

### Spending Policy Examples

```
"approve under 0.05 ETH"
"auto-approve below 0.01 ETH, max 10 per hour"
"only allow 0x4200000000000000000000000000000000000006"
"approve everything" (dangerous — use with caution)
"no auto-approve" (clear all policies)
```

### Transaction Approval Flow

1. Agent calls `send_tx` with transaction details
2. If transaction matches a spending policy → auto-approved, user gets notification
3. If transaction exceeds policies → sent to user's phone wallet for manual approval
4. User approves/rejects on their phone
5. Agent receives the result

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WALLETCONNECT_PROJECT_ID` | Yes (for WC mode) | Get one at cloud.walletconnect.com |
| `CLAWNCHER_PRIVATE_KEY` | Alternative | For headless/testing mode only |
| `CLAWNCHER_NETWORK` | No | `mainnet` (default) or `sepolia` |
| `CLAWNCHER_RPC_URL` | No | Custom RPC endpoint |

### Important Notes

- The agent NEVER holds private keys in production
- Always explain what a transaction does before submitting it
- Always mention estimated gas costs
- Respect the user's spending policies
- If a transaction is rejected, explain what happened and suggest alternatives
