---
name: clawnch-info
description: On-chain token information, portfolio discovery, vault claims, agent registration, and Clawnch platform data. Most actions are read-only.
metadata: { "openclaw": { "emoji": "🦞" } }
---

# Clawnch Info — Platform Data & Token Details

## When to Use

- User asks about a specific Clawnch token's on-chain details
- User wants to discover what tokens a wallet holds
- User wants to check or claim vested vault allocations
- User wants to register as a verified Clawnch agent
- User asks about Clawnch platform stats (total tokens, agents, volume)
- User wants to browse tokens deployed on Clawnch

## When NOT to Use

- Price lookups (use defi-trading skill)
- Token safety audits (use herd-intelligence skill)
- Launching new tokens (use clawnch-launchpad skill)
- Fee claiming (use clawnch-launchpad skill — clawnch_fees tool)

## Tool: `clawnch_info`

### Read-Only Actions

| Action | Params | Description |
|--------|--------|-------------|
| `token_info` | token | On-chain token details via ClawnchReader: name, symbol, decimals, supply, creator, taxes, vault info |
| `portfolio` | address? | Token discovery for a wallet via ClawnchPortfolio. Finds all tokens held, with values. |
| `agent_status` | address? | Check if a wallet is a registered Clawnch agent. Shows agent ID, name, verification. |
| `platform_stats` | — | Clawnch platform stats: total tokens, agents, volume, liquidity, active tokens. |
| `list_tokens` | page?, page_size? | Paginated list of all Clawnch-deployed tokens with price, market cap, volume. |

### Write Actions

| Action | Params | Description |
|--------|--------|-------------|
| `vault_claim` | token | Check and claim vested vault allocation. Shows lockup status and claims if available. |
| `agent_register` | agent_name, agent_description? | Register as a verified Clawnch agent. Requires `CLAWNCH_API_KEY`. |

### Token Info Fields

For Clawnch-deployed tokens, `token_info` returns extra fields:

| Field | Description |
|-------|-------------|
| `isClawnchToken` | Whether this token was deployed via Clawnch |
| `creator` | Deployer address |
| `launchDate` | When the token was deployed |
| `liquidityLocked` | Whether LP is locked |
| `taxBuy` / `taxSell` | Buy/sell tax percentages |
| `maxWallet` | Max wallet holding limit |
| `vault` | Vault info: lockup end time, vesting duration, total allocation |

### Vault Claim Flow

1. Check vault status: `action: vault_claim, token: 0xTokenAddress`
2. If locked: shows lockup end time
3. If unlocked but nothing available: shows vesting progress
4. If tokens available: auto-executes the claim (goes through ClawnchConnect)

### Portfolio Discovery

The `portfolio` action discovers tokens held by a wallet:
```
action: portfolio, address: 0xWalletAddress
```

If full portfolio data is available (via ClawnchPortfolio), returns:
- ETH balance + USD value
- Each token: address, symbol, balance, price, value, isClawnchToken
- Total portfolio value

If only addresses are available, returns token addresses for further lookup via `token_info`.

### Platform Stats

The `platform_stats` action returns:
- Total tokens deployed
- Total registered agents
- Total trading volume (USD)
- Total liquidity (USD)
- Active tokens in last 24h
- Top 5 tokens by volume

### Token Listing

Browse all Clawnch tokens with pagination:
```
action: list_tokens, page: 1, page_size: 20
```

Each token includes: address, name, symbol, creator, launch date, price, market cap, volume, holder count.

### Environment Variables

| Variable | Required For | Description |
|----------|-------------|-------------|
| `CLAWNCH_API_KEY` | agent_register, agent_status | Agent API key |
| `CLAWNCHER_API_URL` | platform_stats, list_tokens, agent_status | Custom API URL (default: https://clawn.ch) |

### Important Notes

- `token_info` and `portfolio` require a public RPC client (wallet service must be started)
- `vault_claim` is the only action that costs gas — pre-flight balance check is automatic
- `agent_register` uses `ClawnchApiDeployer.register()` which is a static method
- `agent_status` is read-only — it queries the API directly without needing a wallet client
- For fee revenue data, use `clawnch_fees` tool instead
