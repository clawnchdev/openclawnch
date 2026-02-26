---
name: watch-activity
description: Monitor on-chain activity — token swaps, transfers, whale alerts, and new token deployments on Base. Read-only, no wallet required.
metadata: { "openclaw": { "emoji": "👁" } }
---

# Watch Activity — On-Chain Monitoring

## When to Use

- User wants to see recent swaps for a token
- User wants to track transfers of a specific token
- User wants to monitor new token deployments on Clawnch
- User wants whale activity alerts or volume spikes
- User wants to verify trading activity after a token launch

## When NOT to Use

- Price lookups (use defi-trading skill)
- Deep contract investigation (use herd-intelligence skill)
- Historical trade analysis on CEXs (use hummingbot skill)

## Tool: `watch_activity`

Read-only — requires only a public RPC client. No wallet connection needed.

### Actions

| Action | Params | Description |
|--------|--------|-------------|
| `token_activity` | token, pool_id (optional), blocks | Full activity report: swaps + transfers + stats. If no pool_id, shows transfers only. |
| `recent_swaps` | pool_id, blocks, limit | Recent swaps for a specific liquidity pool |
| `recent_transfers` | token, blocks, limit | ERC-20 transfer events for a token |
| `deployments` | admin (optional), blocks | Recent Clawnch token deployments. Filter by deployer address. |

### Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `token` | — | Token contract address (required for token_activity, recent_transfers) |
| `pool_id` | Auto-derived | Uniswap V4 pool ID (bytes32). Auto-derived from token via ClawnchReader if omitted. |
| `blocks` | 5000 | Lookback window in blocks (~3 hours on Base at 2s/block) |
| `limit` | 50 | Maximum results to return |
| `admin` | — | Filter deployments by this admin/deployer address |

### Activity Report Fields

When using `token_activity` with a pool_id, the report includes:

- **Stats:** transfer count, swap count, unique addresses, largest transfer, total volume
- **Transfers:** from, to, amount, txHash, block number (top 20)
- **Swaps:** sender, amount0, amount1, txHash, block number (top 20)

### Pool ID Resolution

If you don't have the pool_id:
1. The tool tries to derive it via `ClawnchReader.getTokenRewards()`
2. If that fails, it returns transfers only
3. You can find pool IDs in the Clawnch UI or via `clawnch_info` with `token_info`

### Typical Usage

**After launching a token:**
```
action: deployments, admin: 0xYourAddress
```

**Monitor your token's trading:**
```
action: token_activity, token: 0xTokenAddress
```

**Watch for whale activity:**
```
action: recent_swaps, pool_id: 0xPoolId, blocks: 500, limit: 20
```
Look for large `amount0` or `amount1` values relative to pool liquidity.

### Data Sources

- **ClawnchWatcher** from `@clawnch/clawncher-sdk` — reads Base mainnet events
- Block-based lookback, not time-based — 5000 blocks is ~3 hours on Base

### Important Notes

- All operations are read-only
- Large lookback windows (>10000 blocks) may be slow on public RPCs
- The tool surfaces raw event data — interpret volume spikes and large transfers as potential whale activity
- For more detailed analysis, combine with `herd_intelligence` tool
