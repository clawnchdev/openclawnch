---
name: herd-intelligence
description: On-chain investigation — investigate contracts, transactions, and wallets. Audit token safety (rug pull, honeypot). Validate swap routes and fee claims. Profile counterparties. All read-only.
metadata: { "openclaw": { "emoji": "🔬", "requires": { "env": ["HERD_ACCESS_TOKEN"] } } }
---

# Herd Intelligence — On-Chain Investigation

## When to Use

- User asks "Is this token safe?" or "Is this a rug pull?"
- User wants to investigate an unknown contract or wallet
- User wants to verify a swap route before executing
- User wants to validate a fee claim is real
- User wants to assess whether a counterparty wallet is trustworthy
- User wants to search contract source code for specific patterns
- User wants to trace token flow for a holder

## When NOT to Use

- Simple price lookups (use defi-trading skill)
- Monitoring live activity (use watch-activity skill)
- Executing trades (use defi-trading skill)

## Tool: `herd_intelligence`

All actions are read-only. Requires `HERD_ACCESS_TOKEN` for most operations.

### Actions

| Action | Params | Description |
|--------|--------|-------------|
| `investigate` | target | Auto-detect address/tx and analyze. 66-char = tx, 42-char = contract or wallet. |
| `audit_token` | target, chain | Token safety audit: rug pull indicators, honeypot detection, ownership analysis |
| `validate_swap` | token_in, token_out, amount, chain | Check a swap route for manipulation, MEV risk, and contract safety |
| `validate_claim` | target, chain | Verify that a fee claim for a token is legitimate and has available fees |
| `profile_counterparty` | target, chain | Assess a wallet: activity history, token holdings, risk indicators |
| `search_code` | target (comma-separated addresses), pattern | Search verified contract source code with regex |
| `track_token` | target (holder address), token_in (token address), chain | Trace token flow for a specific holder |
| `bookmark` | target, bookmark_action, bookmark_type, label | Manage bookmarks (list, add, remove) for contracts/wallets/txs |
| `simulate` | target, simulate_type, token_in?, token_out?, recipient? | Build HAL simulation expressions |

### Token Safety Audit

The `audit_token` action checks:
- **Ownership:** Is the contract renounced? Proxy upgradeable?
- **Honeypot indicators:** Can you sell? Hidden fees? Max transfer limits?
- **Liquidity:** Is liquidity locked? What percentage?
- **Tax analysis:** Buy/sell tax percentages
- **Holder concentration:** Top holder percentages, insider wallets
- **Code analysis:** Known rug patterns, suspicious functions

### Swap Route Validation

Before executing a swap, validate with:
```
action: validate_swap
token_in: 0xTokenA
token_out: 0xTokenB
amount: "1.0"
chain: base
```

This checks:
- Both tokens for honeypot/rug indicators
- Route liquidity depth
- MEV exposure risk
- Historical manipulation patterns

### Counterparty Profiling

When interacting with an unknown wallet:
```
action: profile_counterparty
target: 0xWalletAddress
chain: base
```

Returns:
- Account age and activity level
- Token holdings and recent trades
- Risk indicators (fresh wallet, token concentration, etc.)
- Known label (exchange, protocol, whale, etc.)

### HAL Simulation

Build simulation expressions for testing operations without executing:

| simulate_type | Description |
|---------------|-------------|
| `transfer` | ERC-20 transfer adapter |
| `swap` | Swap action (with approval) |
| `balance` | Balance reader |
| `allowance` | Allowance reader |
| `approve` | Approval adapter |

### Bookmarks

Track interesting contracts, wallets, and transactions:
- `bookmark_action: list` — view all bookmarks
- `bookmark_action: add, target: 0x..., bookmark_type: contract, label: "suspicious"` — add
- `bookmark_action: remove, target: 0x..., bookmark_type: contract` — remove

### Chains

Set `chain` parameter: `"base"` (default) or `"ethereum"`.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HERD_ACCESS_TOKEN` | Yes | Herd Intelligence API token |

### Important Notes

- All operations are read-only — no gas costs
- The `investigate` action auto-detects whether the target is a transaction, contract, or wallet
- Always run `audit_token` before recommending a new token to the user
- Safety audits are heuristic — they reduce risk but cannot guarantee safety
- Combine with `watch_activity` for a complete due diligence picture
