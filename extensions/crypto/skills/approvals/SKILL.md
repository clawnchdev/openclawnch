# Token Approvals Audit

Use the `approvals` tool to scan, audit, and revoke ERC-20 token approvals.

## When to Use

- User asks about token approvals, allowances, or permissions
- User wants to check what contracts can spend their tokens
- User wants to revoke unlimited or stale approvals
- Security audit of wallet exposure
- After interacting with a new DeFi protocol

## Key Concepts

**ERC-20 Approval**: Permission granted to a spender contract to transfer tokens on your behalf. Created when you interact with DEXes, lending protocols, etc.

**Unlimited Approval**: Approval for the maximum uint256 amount. Convenient (no re-approval needed) but risky if the spender contract is compromised.

**Risk Levels**:
- **safe**: Small allowance to a known protocol
- **moderate**: Unlimited allowance to a known protocol (Uniswap, Aave, etc.)
- **high**: Large allowance to an unknown contract
- **critical**: Unlimited allowance to an unknown contract — revoke immediately

## Actions

### Scan all approvals
```
approvals action=scan
approvals action=scan chain=ethereum
```
Uses Etherscan/Basescan event logs for comprehensive scanning. Falls back to known-spender heuristic if no API key is configured.

### Revoke a specific approval
```
approvals action=revoke token=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 spender=0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD
```

### Revoke all approvals
```
approvals action=revoke_all
```
Scans and revokes every non-zero approval found. Each revocation is a separate transaction.

## Supported Chains

| Chain | Scan Method |
|-------|-------------|
| Base (default) | Basescan events + known spenders |
| Ethereum | Etherscan events + known spenders |

## Safety Rules

1. **Always scan before revoking** — use `scan` first to review what will be revoked
2. **Prioritize critical/high risk** — revoke unknown spenders first
3. **Active DeFi positions** — revoking approvals for protocols you're actively using (e.g., Aave collateral) may require re-approval later
4. **Gas costs** — each revocation is a separate transaction; batch revoking many approvals costs gas
