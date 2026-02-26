---
name: analytics
description: OHLCV candlestick data and technical indicators (RSI, MACD, Bollinger Bands, SMA, EMA) for any token. Use for data-driven trading decisions.
metadata: { "openclaw": { "emoji": "📈" } }
---

# Analytics — Technical Indicators

## When to Use

- User asks "is token X overbought?"
- User wants RSI, MACD, or Bollinger Bands for a token
- User wants moving averages (SMA/EMA)
- User wants a technical analysis summary before trading
- User asks for candlestick / OHLCV data

## When NOT to Use

- Executing trades (use defi-trading skill)
- Looking up current price only (use defi-trading skill)
- On-chain analytics / holder data (use block-explorer skill)

## Tool: `analytics`

### Actions

| Action | Description |
|--------|-------------|
| `candles` | Fetch OHLCV candlestick data |
| `rsi` | Relative Strength Index (default period: 14) |
| `macd` | MACD line, signal line, histogram (12/26/9) |
| `bollinger` | Bollinger Bands: middle, upper, lower (default period: 20, 2 std dev) |
| `sma` | Simple Moving Average |
| `ema` | Exponential Moving Average |
| `summary` | All-in-one technical analysis with composite signal |

### Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `token` | Yes | Token address (0x...) or search term |
| `chain` | No | Chain: base (default), ethereum, arbitrum, optimism, polygon |
| `interval` | No | Candle interval: 1m, 5m, 15m, 1h (default), 4h, 1d |
| `period` | No | Indicator period. Default varies: RSI=14, Bollinger=20, SMA/EMA=20 |
| `limit` | No | Number of candles. Default: 100, max: 500 |

### Summary Action Output

The `summary` action computes all indicators at once and returns:
- RSI (14-period)
- MACD (12/26/9)
- Bollinger Bands (20-period, 2 std dev)
- SMA (20 and 50)
- EMA (12 and 26)
- Composite score: -3 (very bearish) to +3 (very bullish)
- Overall signal: strong_buy, buy, neutral, sell, strong_sell
- Individual signal explanations

### Signal Interpretation

**RSI:**
- >= 70: Overbought (potential reversal down)
- <= 30: Oversold (potential bounce)
- 40-60: Neutral zone

**MACD:**
- Histogram > 0: Bullish momentum
- Histogram < 0: Bearish momentum
- Histogram crossing zero: Trend change signal

**Bollinger Bands:**
- Price near upper band: Potentially overbought
- Price near lower band: Potentially oversold
- Narrow bandwidth: Low volatility (potential breakout)

### Workflow

1. **Quick technical check before a trade:**
   ```
   action: summary, token: 0xa1F7..., interval: 1h
   ```

2. **Check if a token is overbought:**
   ```
   action: rsi, token: 0xa1F7..., interval: 4h
   ```

3. **Get moving average trend:**
   ```
   action: sma, token: 0xa1F7..., period: 50, interval: 1d
   ```

### Data Source Note

Candle data is synthesized from DexScreener's price data (price changes, volume). For precise OHLCV data, verify with a dedicated charting platform like TradingView. The indicators are computed in pure TypeScript — no external TA library dependency.
