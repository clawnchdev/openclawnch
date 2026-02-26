---
name: permit2
description: Manage Uniswap Permit2 token allowances. Check, approve, revoke, or lockdown ERC-20 token approvals for DeFi protocols.
metadata: { "openclaw": { "emoji": "🔐" } }
---

# Permit2 — Token Allowance Management

## When to Use

- User wants to check which tokens are approved for a protocol
- User needs to approve a token for Uniswap or other DeFi protocols
- User wants to revoke a specific token approval for a spender
- Emergency: user wants to lockdown all approvals immediately
- User is preparing for a swap or LP operation and needs Permit2 setup

## When NOT to Use

- Executing swaps (use defi-trading skill)
- Managing LP positions (use liquidity skill)
- General ERC-20 transfers (use transfer skill)

## Tool: `permit2`

### Actions

| Action | Description |
|--------|-------------|
| `check_allowance` | Read current Permit2 allowance for a token/spender pair |
| `approve` | One-time ERC-20 max approval for Permit2 contract |
| `approve_batch` | Approve multiple tokens for Permit2 in sequence |
| `revoke` | Set Permit2 allowance to zero for a specific spender |
| `lockdown` | Emergency: revoke all allowances for multiple token/spender pairs |

### Parameters

| Param | Required For | Description |
|-------|-------------|-------------|
| `token` | check_allowance, approve, revoke | ERC-20 token contract address (0x...) |
| `tokens` | approve_batch | Array of token addresses |
| `spender` | check_allowance, revoke | Spender address or alias |
| `pairs` | lockdown | Array of `{token, spender}` objects |

### Known Spender Aliases

| Alias | Address | Usage |
|-------|---------|-------|
| `universal_router` | 0x198EF79F1F515F02dFE9e3115eD9fC07183f02fC | Uniswap swaps |
| `position_manager` | 0x7C5f5A4bBd8fD63184577525326123B519429bDc | Uniswap V4 LP |

### Workflow

1. **Check existing allowance:**
   ```
   action: check_allowance, token: 0x833589..., spender: universal_router
   ```

2. **Approve token for Permit2 (one-time):**
   ```
   action: approve, token: 0x833589...
   ```

3. **Batch approve multiple tokens:**
   ```
   action: approve_batch, tokens: ["0x833589...", "0x420000..."]
   ```

4. **Revoke a spender:**
   ```
   action: revoke, token: 0x833589..., spender: universal_router
   ```

5. **Emergency lockdown:**
   ```
   action: lockdown, pairs: [{token: "0x833589...", spender: "universal_router"}, ...]
   ```

### How Permit2 Works

Permit2 is a universal token approval system:
1. You approve Permit2 once per token (ERC-20 → Permit2 max approval)
2. For each protocol interaction, Permit2 manages per-spender allowances
3. This is more secure than approving each protocol individually — one lockdown revokes everything

### Security Notes

- `approve` grants max ERC-20 allowance to the Permit2 contract itself
- Individual spender allowances are managed through Permit2's internal accounting
- `lockdown` is the emergency kill switch — use it if you suspect compromise
- Always verify spender addresses before approving
