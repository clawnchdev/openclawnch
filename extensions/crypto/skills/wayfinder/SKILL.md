---
name: wayfinder
description: Cross-chain DeFi via Wayfinder Paths — multi-chain balances, DeFi yield discovery, cross-chain swap quotes, token resolution, and strategy execution.
metadata: { "openclaw": { "emoji": "🧭", "requires": { "env": ["WAYFINDER_API_KEY"] } } }
---

# Wayfinder — Cross-Chain DeFi

## When to Use

- User wants to check balances across multiple chains
- User asks about DeFi yields, lending rates, or farming opportunities
- User wants to swap tokens across different chains
- User wants to resolve a token across chains (find address, price, metadata)
- User wants to run a multi-chain DeFi strategy (basis trading, yield farming)

## When NOT to Use

- Single-chain swaps on Base (use defi-trading skill — faster)
- On-chain monitoring (use watch-activity skill)
- Token safety audits (use herd-intelligence skill)

## Tool: `wayfinder`

### Two Tiers

**REST tier (always available):** pools, balances, quote, resolve_token, gas_token
**CLI tier (requires Python + wayfinder-paths):** execute_swap, strategy

### REST Actions

| Action | Params | Description |
|--------|--------|-------------|
| `pools` | chain_id?, protocol?, min_apy?, token_symbol? | Search DeFi yield opportunities. Returns APY, TVL, protocol. |
| `balances` | address? | Multi-chain portfolio. Shows all tokens with USD values across all chains. |
| `quote` | from_token, to_token, amount, from_chain?, to_chain?, slippage? | Cross-chain swap quote with route comparison. |
| `resolve_token` | query, chain_id? | Look up a token by name, symbol, address, or CoinGecko ID. Returns metadata. |
| `gas_token` | chain_id? | Get the gas token for a chain. |

### CLI Actions

| Action | Params | Description |
|--------|--------|-------------|
| `execute_swap` | from_token, to_token, amount, chain_id?, wallet_label?, slippage? | Execute a cross-chain swap via the wayfinder CLI. |
| `strategy` | strategy_name?, strategy_action?, main_token_amount?, wallet_label? | Run or manage a DeFi strategy. |

### Supported Chains

| Chain | ID | Gas Token |
|-------|----|-----------|
| Ethereum | 1 | ETH |
| Base | 8453 | ETH |
| Arbitrum | 42161 | ETH |
| Optimism | 10 | ETH |
| Polygon | 137 | MATIC |
| Avalanche | 43114 | AVAX |
| BNB Chain | 56 | BNB |
| zkSync Era | 324 | ETH |
| Linea | 59144 | ETH |
| Scroll | 534352 | ETH |
| Mantle | 5000 | MNT |
| Blast | 81457 | ETH |

### Pool Discovery

Find the best yields:
```
action: pools, chain_id: 8453, min_apy: 5, token_symbol: WETH
```

Returns pools sorted by APY descending, with protocol name, TVL, and token info.

### Cross-Chain Quotes

Get the best route for a cross-chain swap:
```
action: quote
from_token: 0xTokenOnBase
to_token: 0xTokenOnArbitrum
amount: "1000000000000000000"  (wei)
from_chain: 8453
to_chain: 42161
```

Returns: best quote (provider, input/output amounts, fees), plus alternative routes for comparison.

### Strategy Management

List available strategies:
```
action: strategy
```

Run a strategy action:
```
action: strategy
strategy_name: basis_trading_strategy
strategy_action: status
wallet_label: main
```

Strategy actions: `status`, `deposit`, `update`, `exit`, `withdraw`, `analyze`, `quote`

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WAYFINDER_API_KEY` | Yes | API key from https://wayfinder.dev |

For CLI actions, also need:
- Python 3.12+
- `pip3 install wayfinder-paths`
- Wayfinder wallet config with labeled wallets

### Important Notes

- REST actions (pools, balances, quote, resolve_token) don't require Python
- Swap amounts for `quote` are in wei (raw units), but `execute_swap` uses human-readable amounts
- Cross-chain swaps may take 1-20 minutes depending on the bridge used
- Strategy actions involve real funds — review strategy docs before depositing
- The `balances` action scans all supported chains, which may take a few seconds
