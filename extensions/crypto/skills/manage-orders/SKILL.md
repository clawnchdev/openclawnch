---
name: manage-orders
description: Create and manage conditional orders — limit buy/sell, stop-loss, take-profit, DCA, trailing stop, TWAP. Includes order chaining, risk management, and circuit breaker protection.
metadata: { "openclaw": { "emoji": "📋" } }
---

# Manage Orders — Conditional Order Engine

## When to Use

- User wants to set a limit buy or sell
- User wants stop-loss or take-profit protection
- User wants to DCA into a token over time
- User wants a trailing stop that follows the price up
- User wants to split a large order into TWAP chunks
- User wants to chain orders (e.g., buy then auto-set stop-loss)
- User asks to check if any orders have triggered

## When NOT to Use

- Immediate market swaps (use defi-trading skill)
- Hummingbot exchange orders (use hummingbot skill)
- Portfolio balance checks (use defi-trading skill)

## Tool: `manage_orders`

### Order Types

| Type | Trigger | Description |
|------|---------|-------------|
| `limit_buy` | Price drops to target | Buy when price falls below trigger |
| `limit_sell` | Price rises to target | Sell when price rises above trigger |
| `stop_loss` | Price drops below target | Sell to limit downside loss |
| `take_profit` | Price rises above target | Sell to lock in gains |
| `dca` | On interval schedule | Recurring buys at fixed intervals |
| `trailing_stop` | % drop from peak | Sell when price drops N% from its highest point |
| `twap` | Time-weighted chunks | Split large orders across a time window |

### Actions

| Action | Params | Description |
|--------|--------|-------------|
| `create` | type, token, trigger_price, side, amount_pct/amount_raw | Create a new conditional order |
| `list` | — | Show all orders with risk summary |
| `cancel` | order_id | Cancel a specific order |
| `cancel_tag` | tag | Cancel all orders with a tag |
| `check` | current_price or token | Check triggers against a price (auto-fetches from DexScreener) |
| `executed` | order_id, execution_result | Mark an order as executed after swap |
| `failed` | order_id | Mark an order as failed (reverts to pending with cooldown) |
| `pause` | order_id | Pause an order |
| `resume` | order_id | Resume a paused order |
| `risk` | — | Show risk management status and config |
| `reset_circuit_breaker` | — | Reset the circuit breaker after cooldown |
| `cleanup` | — | Remove completed/cancelled orders |

### Order Chaining

Chain a follow-up order that activates after the first one executes:

```
action: create
type: limit_buy
token: 0xABC...
trigger_price: "0.001"
amount_pct: 50
chain_type: stop_loss
chain_trigger_price: "0.0008"
chain_side: sell
chain_amount_pct: 100
```

This buys at 0.001 ETH, then auto-creates a stop-loss at 0.0008 ETH.

### DCA Configuration

| Param | Description |
|-------|-------------|
| `dca_interval_hours` | Hours between buys (e.g., 24 for daily) |
| `dca_max_buys` | Maximum number of iterations (null = unlimited) |

### Trailing Stop Configuration

| Param | Description |
|-------|-------------|
| `trailing_pct` | % drop from peak to trigger (e.g., 10 = sell after 10% decline from high) |
| `floor_price` | Absolute floor — sell immediately if price drops below this |

### TWAP Configuration

| Param | Description |
|-------|-------------|
| `twap_chunks` | Number of chunks to split the order into |
| `twap_window_hours` | Time window for all chunks |
| `twap_max_price` | Don't execute chunks above this price |
| `twap_min_price` | Don't execute chunks below this price |

### Risk Management

The engine includes:
- **Position sizing:** `amount_pct` caps exposure per order
- **Circuit breaker:** Auto-pauses after consecutive failures (cooldown period)
- **Slippage protection:** Default 200 bps (2%), configurable per order
- **Tag-based grouping:** Cancel all related orders at once

### Execution Flow

1. Create orders with `create`
2. Periodically call `check` (auto-fetches live prices)
3. Triggered orders return execution instructions for `defi_swap`
4. After swap, call `executed` to mark done and activate chained orders
5. If swap fails, call `failed` to revert to pending with cooldown

### Important Notes

- Orders are in-memory for the session (persistent storage planned)
- The `check` action auto-fetches prices from DexScreener when no `current_price` is provided
- Always confirm with the user before creating orders with real value
- Side is auto-inferred from order type if omitted (buy types = buy, sell types = sell)
