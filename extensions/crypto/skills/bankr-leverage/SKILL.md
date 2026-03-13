---
name: bankr-leverage
description: Open leveraged long/short positions via Avantis on Base with up to 10x leverage
---

# Leveraged Trading via Bankr

## Overview
Open leveraged long/short positions via Avantis protocol on Base. Supports crypto pairs, forex, and commodities with up to 10x leverage.

## Tool: `bankr_leverage`

### Actions
- **long** — open a long position (profit when price goes up)
- **short** — open a short position (profit when price goes down)
- **close** — close an existing position
- **positions** — view all open positions

### Supported Pairs
- **Crypto:** BTC/USD, ETH/USD, SOL/USD, and more
- **Forex:** EUR/USD, GBP/USD, JPY/USD
- **Commodities:** GOLD, SILVER, OIL

### Opening Positions
```
long: pair="BTC/USD", amount="100", leverage=5, stop_loss="5%", take_profit="50%"
short: pair="ETH/USD", amount="200", leverage=3
long: pair="GOLD", amount="500", leverage=2, stop_loss="3%"
```

### Risk Management
- **stop_loss** — automatically close if loss exceeds this percentage
- **take_profit** — automatically close when profit reaches this percentage
- **leverage** — 1x to 10x. Higher leverage = higher risk + reward
- Always set stop-loss on leveraged positions

### Risk Warning
Leveraged trading carries significant risk of loss. With 10x leverage, a 10% adverse move liquidates your position. Start small and use stop-losses.

### Chain
All leveraged trading executes on Base via Avantis protocol.

### Parameters
| Parameter | Required | Description |
|-----------|----------|-------------|
| pair | Yes (long/short/close) | Trading pair (e.g. "BTC/USD") |
| amount | Yes (long/short) | Dollar amount |
| leverage | No | 1-10x (default: 1) |
| stop_loss | No | Stop-loss percentage |
| take_profit | No | Take-profit percentage |
