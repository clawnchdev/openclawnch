---
name: governance
description: Manage DAO proposals, voting, delegation, and voting power across Snapshot and on-chain governance
---

# DAO Governance

Use the `governance` tool for DAO proposals, voting, delegation, and voting power checks.

## When to Use

- User asks about active governance proposals for a protocol
- User wants to vote on a proposal (Snapshot or on-chain)
- User wants to delegate voting power
- User asks about their voting power or governance participation

## Platforms

| Platform | Type | Coverage |
|----------|------|----------|
| Snapshot | Off-chain (gasless) | 20K+ spaces (Aave, Uniswap, ENS, Safe, etc.) |
| On-chain Governor | On-chain (gas required) | Uniswap, Aave, ENS, Aerodrome |

## Actions

| Action | Description | Required Params |
|--------|-------------|-----------------|
| proposals | List proposals from a space | space |
| vote | Cast a vote | space, proposal_id, choice |
| delegate | Delegate voting power | space, delegatee |
| voting_power | Check VP for an address | space |
| spaces | Browse well-known spaces | (none) |
| governors | List on-chain Governors | (none) |

## Common Flows

### Browse active proposals
```
governance action=proposals space=aave.eth
governance action=proposals space=uniswap state=closed limit=5
```

### Vote on a Snapshot proposal
```
governance action=vote space=aave.eth proposal_id=0x... choice=for
```
Snapshot votes are gasless but require signing via the Snapshot UI.

### Vote on-chain (Governor)
```
governance action=vote space=uniswap proposal_id=12345 choice=for reason="Support this improvement"
```
On-chain votes submit a transaction directly. Supports `castVoteWithReason`.

### Delegate voting power
```
governance action=delegate space=ens delegatee=vitalik.eth
```
Supports ENS names for the delegatee.

### Check voting power
```
governance action=voting_power space=aave.eth
governance action=voting_power space=uniswap address=0x...
```

## Vote Choices

| Input | Value | Meaning |
|-------|-------|---------|
| `for`, `yes`, `1` | 1 | Vote in favor |
| `against`, `no`, `0` | 0 | Vote against |
| `abstain`, `2` | 2 | Abstain |

## Important Notes

1. **Snapshot is gasless** — off-chain voting requires no gas, but cannot be submitted programmatically (user signs in Snapshot UI)
2. **On-chain voting costs gas** — submitted as an Ethereum L1 transaction
3. **Delegation is required** — many governance tokens require self-delegation before voting power activates. If VP is 0 but balance > 0, delegate to yourself.
4. **Wallet required** — vote and delegate actions require a connected wallet
5. **Known Governors** — Uniswap, Aave, ENS, Aerodrome are pre-configured. Custom Governor addresses can be added.
