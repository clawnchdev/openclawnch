# Polymarket Predictions via Bankr

## Overview
Access Polymarket prediction markets through Bankr. Search for markets, place bets, view positions, and redeem winnings. Executes on Polygon.

## Tool: `bankr_polymarket`

### Actions
- **search** — find prediction markets by topic
- **bet** — place a bet on a market outcome
- **positions** — view your current open positions
- **redeem** — claim winnings from resolved markets

### Searching Markets
Search for any topic — politics, sports, crypto, science, entertainment.
```
search: query="Will Bitcoin reach $100k by December?"
search: query="Eagles win Super Bowl"
search: query="next fed rate decision"
```

### Placing Bets
Specify the market, outcome (yes/no), and dollar amount.
```
bet: market="Bitcoin reaches $100k", outcome="yes", amount="50"
bet: market="Eagles win Super Bowl", outcome="no", amount="25"
```

### Managing Positions
- Use `positions` to see all your active bets
- Use `redeem` to claim winnings after markets resolve

### How Polymarket Works
- Binary markets: bet on yes/no outcomes
- Prices reflect market consensus probabilities
- Markets resolve when the event occurs or at expiry
- Winnings paid in USDC on Polygon

### Chain
All Polymarket operations execute on Polygon. Gas is sponsored by Bankr.
