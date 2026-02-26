---
name: hummingbot
description: Control Hummingbot market-making bots — place orders, manage executors and strategies, deploy bots, get market data, run backtests.
metadata: { "openclaw": { "emoji": "🤖", "requires": { "env": ["HUMMINGBOT_API_URL"] } } }
---

# Hummingbot — Market-Making Bot Control

## When to Use

- User wants to run a market-making strategy
- User wants to place orders on centralized or decentralized exchanges
- User wants to deploy, monitor, or stop trading bots
- User asks about order books, candles, funding rates, or market data
- User wants to backtest a strategy
- User wants to manage position leverage on perps exchanges

## When NOT to Use

- Simple token swaps (use defi-trading skill)
- On-chain activity monitoring (use watch-activity skill)
- One-off price checks (use defi-trading skill)

## Tool: `hummingbot`

Requires a running Hummingbot instance. Set `HUMMINGBOT_API_URL`, `HUMMINGBOT_USERNAME`, `HUMMINGBOT_PASSWORD`.

### Action Groups

#### Health & Portfolio

| Action | Description |
|--------|-------------|
| `status` | Health check — verify the Hummingbot instance is reachable |
| `portfolio` | Balances, positions, and active orders across connected exchanges |

#### Order Management

| Action | Params | Description |
|--------|--------|-------------|
| `order` | connector, trading_pair, trade_type, amount, price, order_type | Place a limit or market order |
| `cancel_order` | connector, order_id | Cancel a specific order |
| `active_orders` | connector, trading_pair | List open orders |

#### Executors

Executors are automated trading primitives that run inside Hummingbot.

| Action | Description |
|--------|-------------|
| `executor` | Create a new executor (position, DCA, grid, order, arbitrage) |
| `stop_executor` | Stop a running executor by ID |
| `executors` | Search/list executors |
| `executor_types` | List available executor types and their config schemas |

**Executor types:** `position_executor`, `dca_executor`, `grid_executor`, `order_executor`, `arbitrage_executor`

#### Market Data

| Action | Params | Description |
|--------|--------|-------------|
| `market_data` | connector, trading_pair | Current prices for one or more pairs |
| `candles` | connector, trading_pair, interval, days | OHLCV candle data (1m, 5m, 15m, 30m, 1h, 4h, 1d) |
| `orderbook` | connector, trading_pair | Current order book snapshot |
| `funding_rate` | connector, trading_pair | Perps funding rate |

#### Bot Management

| Action | Params | Description |
|--------|--------|-------------|
| `bot_deploy` | bot_name, controllers_config | Deploy a new bot with controller configs |
| `bot_status` | — | Status of all running bots |
| `bot_stop` | bot_name | Stop a specific bot |
| `bot_logs` | bot_name, log_type, limit | View bot logs (error, general, all) |
| `bot_history` | bot_name, days | Trade history for a bot |

#### Strategy Templates & Backtesting

| Action | Params | Description |
|--------|--------|-------------|
| `templates` | template, template_overrides | List templates, view one, or build a config with overrides |
| `backtest` | backtest_config, start_time, end_time | Run a historical backtest |

#### Infrastructure

| Action | Description |
|--------|-------------|
| `gateway_status` | DEX gateway connection status |
| `gateway_start` | Start the DEX gateway (needs passphrase + image) |
| `gateway_stop` | Stop the DEX gateway |
| `leverage` | Set position mode (HEDGE/ONE-WAY) and leverage multiplier |
| `connectors` | List available exchange connectors |
| `accounts` | List configured accounts |
| `scripts` | List available scripts |
| `history` | Search trade history with filters |

### Typical Workflow

1. Check status: `action: status`
2. View portfolio: `action: portfolio`
3. Get market data: `action: candles, connector: binance, trading_pair: ETH-USDT, interval: 1h`
4. List templates: `action: templates`
5. Deploy a bot: `action: bot_deploy, bot_name: my-mm, controllers_config: [...]`
6. Monitor: `action: bot_status` and `action: bot_logs, bot_name: my-mm`
7. Stop: `action: bot_stop, bot_name: my-mm`

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HUMMINGBOT_API_URL` | Yes | Hummingbot API endpoint (default: http://localhost:8000) |
| `HUMMINGBOT_USERNAME` | Yes | API username (default: admin) |
| `HUMMINGBOT_PASSWORD` | Yes | API password (default: admin) |

### Important Notes

- All order/executor operations hit the Hummingbot instance, not the blockchain directly
- Use `bot_deploy` for persistent strategies, `executor` for one-off automated trades
- Always check `bot_status` before deploying to avoid conflicts
- Backtests use historical data — past performance does not predict future results
