---
name: airdrop
description: Check eligibility for and claim token airdrops
---

# Airdrop Tracker

Use the `airdrop` tool to check eligibility and claim token airdrops.

## When to Use

- User asks "am I eligible for any airdrops?"
- User asks about a specific airdrop (EigenLayer, LayerZero, Scroll, etc.)
- User wants to claim an airdrop they're eligible for
- User asks what active airdrops are available

## Actions

| Action | Description | Required Params |
|--------|-------------|-----------------|
| list | List known airdrops | (none, optional: status, chain) |
| check | Check eligibility for one airdrop | airdrop_id |
| check_all | Check all active airdrops | (none, uses connected wallet) |
| claim | Generate claim transaction | airdrop_id, claim_index, amount, proof |

## Common Flows

### Browse active airdrops
```
airdrop action=list
airdrop action=list status=active chain=base
airdrop action=list status=all
```

### Check eligibility for a specific airdrop
```
airdrop action=check airdrop_id=eigen-s2
airdrop action=check airdrop_id=morpho address=vitalik.eth
```

### Scan all active airdrops
```
airdrop action=check_all
airdrop action=check_all address=0x...
```

### Claim an eligible airdrop
```
airdrop action=claim airdrop_id=morpho claim_index=1234 amount=1000000000000000000 proof=["0xabc...","0xdef..."]
```
The claim_index, amount, and proof come from the check result.

## Known Airdrops

| ID | Name | Chain | Status |
|----|------|-------|--------|
| eigen-s2 | EigenLayer Season 2 | Ethereum | Active |
| zk-nation | ZKsync (ZK Nation) | Ethereum | Active |
| layerzero | LayerZero (ZRO) | Ethereum | Active |
| scroll | Scroll (SCR) | Ethereum | Active |
| degen-s2 | Degen Chain Season 2 | Base | Active |
| morpho | Morpho (MORPHO) | Ethereum | Active |

## Important Notes

1. **Browser fallback** -- some airdrops require browser-based eligibility checks (no public API). The tool will indicate when the `browser` tool is needed.
2. **Merkle proofs** -- claim transactions use standard Merkle distributor contracts. The proof data comes from the eligibility check.
3. **No API key required** -- eligibility checks use public endpoints and on-chain data.
4. **Wallet required** -- check_all and claim use the connected wallet address by default.
5. **Registry is maintained manually** -- new airdrops are added as they launch. Use `list` to see the current registry.
6. **ENS supported** -- address parameter accepts ENS names.
