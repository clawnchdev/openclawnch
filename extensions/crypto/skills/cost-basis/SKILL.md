---
name: cost-basis
description: Track trade cost basis and compute P&L using FIFO. Record buys/sells, view unrealized/realized profit per token and portfolio-wide.
metadata: { "openclaw": { "emoji": "📊" } }
---

# Cost Basis & P&L Tracking

## When to Use

- User asks "how much did I make/lose on token X?"
- User wants to track their trading performance
- User wants to see cost basis for their holdings
- User wants to export trade history for tax purposes
- After a swap completes and user wants to record it

## When NOT to Use

- Looking up current prices (use defi-trading skill)
- Checking wallet balances (use defi-trading skill)
- Technical analysis / charting (use analytics skill)

## Tool: `cost_basis`

### Actions

| Action | Description |
|--------|-------------|
| `record_trade` | Manually record a buy or sell trade |
| `portfolio_pnl` | Unrealized + realized P&L for all holdings |
| `token_pnl` | Detailed P&L for a specific token with FIFO lot breakdown |
| `history` | List recent trade records |
| `export` | Full trade history as JSON (for tax/accounting) |

### Parameters

| Param | Required For | Description |
|-------|-------------|-------------|
| `token` | record_trade, token_pnl | Token contract address (0x...) |
| `symbol` | record_trade | Token symbol (e.g., "USDC") |
| `type` | record_trade | "buy" or "sell" |
| `amount` | record_trade | Token amount (number) |
| `price_usd` | record_trade | Price per token in USD at time of trade |
| `current_price` | portfolio_pnl, token_pnl | Current price for P&L calc (optional — defaults to last trade price) |
| `tx_hash` | record_trade | Transaction hash (optional) |
| `limit` | history | Max records to return (default: 50) |

### Workflow

1. **Record a trade after a swap:**
   ```
   action: record_trade, token: 0xa1F7..., symbol: CLAWNCH, type: buy, amount: 1000, price_usd: 0.05
   ```

2. **Check portfolio P&L:**
   ```
   action: portfolio_pnl
   ```
   Optionally pass `current_price` to override the last-known price.

3. **Detailed P&L for one token:**
   ```
   action: token_pnl, token: 0xa1F7..., current_price: 0.08
   ```
   Shows FIFO tax lots, realized gains from sells, unrealized gains on holdings.

4. **View trade history:**
   ```
   action: history, limit: 20
   ```

5. **Export for taxes:**
   ```
   action: export
   ```

### FIFO Cost Basis Method

Trades are matched First-In, First-Out:
- When you sell, the oldest buy lots are consumed first
- Realized P&L = sale proceeds - cost basis of consumed lots
- Unrealized P&L = current value - cost basis of remaining lots

### Auto-Recording

The after_tool_call hook in the extension can auto-record trades when swaps complete via the `recordSwapTrade()` function. Manual recording is also supported for trades made outside the agent.

### Data Persistence

Trade records are stored at `~/.openclawnch/data/trade-history.json` (or `$OPENCLAWNCH_TX_DIR/trade-history.json`). Data survives agent restarts and is volume-mounted in Docker deployments.
