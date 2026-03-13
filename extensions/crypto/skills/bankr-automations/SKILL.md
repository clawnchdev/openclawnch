---
name: bankr-automations
description: Set up automated server-side trading strategies (limit buys/sells) that execute on Base via Bankr
---

# Trading Automations via Bankr

## Overview
Set up automated trading strategies that execute server-side via Bankr. Automations run on Base and don't require your app to stay online.

## Tool: `bankr_automate`

### Actions
- **limit_buy** — buy a token when its price drops to a target
- **limit_sell** — sell a token when its price rises to a target
- **stop_loss** — sell all of a token if it drops below a threshold
- **dca** — dollar-cost average into a token on a schedule
- **twap** — time-weighted average price sell (spread a sell over time)
- **cancel** — cancel an active automation
- **list** — show all active automations

### Limit Orders
Set a trigger condition like "drops 10%", "rises 20%", or "reaches $50000".
```
limit_buy: token=ETH, amount=$100, trigger="drops 10%"
limit_sell: token=CLAWNCH, trigger="rises 50%"
stop_loss: token=PEPE, trigger="drops 30%"
```

### DCA (Dollar-Cost Averaging)
Automatically buy a fixed amount on a schedule.
```
dca: token=ETH, amount=$50, interval="every day", time="at 9am", duration="for 30 days"
dca: token=BTC, amount=$100, interval="every week"
```

### TWAP (Time-Weighted Average Price)
Spread a large sell over time to minimize price impact.
```
twap: token=ETH, amount=10, duration="over 4 hours"
```

### Managing Automations
- `/automations` command lists all active automations
- Use the `cancel` action with an automation_id to stop one
- Use `cancel` without an ID to cancel all

### Chain Support
Automations are primarily Base. The `chain` parameter defaults to "base".

## Command
- `/automations` — quick list of active automations
