---
name: liquidity
description: Manage Uniswap V4 and V3 liquidity positions on Base — list positions, read pool state, mint/add/remove liquidity, and collect fees.
metadata: { "openclaw": { "emoji": "🌊" } }
---

# Liquidity — Uniswap Position Management

## When to Use

- User wants to provide liquidity on Uniswap V3 or V4
- User wants to view their existing LP positions
- User wants to add liquidity to an existing position
- User wants to remove liquidity or withdraw
- User wants to collect accumulated trading fees from positions
- User wants to check a V4 pool's current state (price, tick, liquidity)

## When NOT to Use

- Simple token swaps (use defi-trading skill)
- Checking token prices (use defi-trading skill)
- Launching new tokens (use clawnch-launchpad skill)

## Tool: `liquidity`

All write operations go through ClawnchConnect for approval.

### Read Actions

| Action | Params | Description |
|--------|--------|-------------|
| `positions` | — | List all V3 LP positions for the connected wallet |
| `v4_position` | token_id | Read a specific V4 position by NFT token ID |
| `v4_pool` | token0, token1, fee?, tick_spacing?, hook_address? | Read V4 pool state: price, tick, liquidity |

### Write Actions

| Action | Params | Description |
|--------|--------|-------------|
| `v3_mint` | token0, token1, fee, tick_lower, tick_upper, amount0, amount1 | Open a new V3 position |
| `v4_mint` | token0, token1, fee, tick_spacing, tick_lower, tick_upper, amount0, amount1, hook_address?, slippage_bps? | Open a new V4 position |
| `v3_add` | token_id, amount0, amount1 | Add liquidity to an existing V3 position |
| `v3_remove` | token_id, percentage? | Remove liquidity (default: 100% = full withdrawal) |
| `v3_collect` | token_id | Collect accumulated fees |

### Pool Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `token0` | — | Lower address token (addresses must be sorted) |
| `token1` | — | Higher address token |
| `fee` | 3000 | Fee tier in hundredths of bps (500 = 0.05%, 3000 = 0.3%, 10000 = 1%) |
| `tick_spacing` | 60 | V4 tick spacing |
| `hook_address` | 0x0000...0000 | V4 hook contract (zero = no hook) |
| `slippage_bps` | 50 | Slippage tolerance (50 = 0.5%) |

### Tick Range Selection

The tick range determines the price range where your position earns fees:

- **Narrow range** (e.g., current tick +/- 100): Higher capital efficiency, more fees when price is in range, but goes out of range more often
- **Wide range** (e.g., current tick +/- 10000): Lower capital efficiency, earns less per trade but stays in range longer
- **Full range** (min tick to max tick): Similar to V2-style liquidity, always earning but very low efficiency

Use `v4_pool` to check the current tick, then set `tick_lower` and `tick_upper` around it.

### Fee Tiers

| Fee | Use Case |
|-----|----------|
| 500 (0.05%) | Stablecoin pairs (USDC/USDT) |
| 3000 (0.3%) | Standard pairs (ETH/USDC) |
| 10000 (1%) | Exotic or volatile pairs |

### Typical Workflow

1. Check current pool state: `action: v4_pool, token0: ..., token1: ...`
2. View existing positions: `action: positions`
3. Mint new position: `action: v3_mint, token0: ..., token1: ..., tick_lower: ..., tick_upper: ..., amount0: "1.0", amount1: "1000"`
4. Monitor fees: `action: positions` (check unclaimed fees)
5. Collect fees: `action: v3_collect, token_id: ...`
6. Remove liquidity: `action: v3_remove, token_id: ..., percentage: 50`

### Important Notes

- Token addresses must be sorted: `token0` < `token1` (lower address first)
- Amounts are in human-readable units (e.g., "1.0" = 1 token, not wei)
- All writes require gas — pre-flight balance check is automatic
- Removing 100% of liquidity also burns the position NFT
- V4 positions with hooks interact with the hook contract on every swap — verify the hook is safe
- Impermanent loss is real — explain the risks to users before they add liquidity
