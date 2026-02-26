---
name: market-intel
description: Real-time market intelligence — trending tokens, new pairs, whale watching, token analysis, and Clawnch agent leaderboard.
metadata: { "openclaw": { "emoji": "🔍" } }
---

# Market Intelligence

## When to Use

- User asks what's trending in crypto
- User wants to analyze a specific token
- User asks about new token launches or pairs
- User wants whale activity or large trade alerts
- User asks about the Clawnch ecosystem or agent rankings

## Tool: `market_intel`

### Actions

| Action | Description |
|--------|-------------|
| `trending` | Top trending tokens by DexScreener boosts. Filter by chain. |
| `new_pairs` | Recently created liquidity pools on a chain. |
| `whale_watch` | Volume spikes and transaction data for a token (proxy for whale activity). |
| `analysis` | Deep-dive on a specific token: price, volume, liquidity, market cap, Clawnch data. |
| `leaderboard` | Top Clawnch agents ranked by market cap/volume/launches. |

### Parameters

- `token` — Token address or symbol (for analysis and whale_watch)
- `chain` — Chain to query: base, ethereum, arbitrum, optimism, polygon (default: base)
- `limit` — Number of results (default: 10)

### Data Sources

- **DexScreener** — Real-time DEX data, trending tokens, new pairs (free, no API key)
- **CoinGecko** — Broader market data, coin metadata (optional API key for higher limits)
- **Clawnch API** — Platform-specific analytics, agent leaderboard, token details

### Analysis Format

When analyzing a token, present:
1. Current price (USD and ETH)
2. Price changes (5m, 1h, 6h, 24h)
3. Volume (1h, 6h, 24h)
4. Liquidity depth
5. Market cap / FDV
6. DEX and pool details
7. Clawnch data (if applicable): deployer, fees, launch date

### Caveats

- DexScreener data is for DEX-listed tokens only (not centralized exchanges)
- Whale detection is approximate (based on volume spikes, not individual trades)
- Always note the data source and that crypto markets are volatile
- Never give financial advice — present data and let the user decide
