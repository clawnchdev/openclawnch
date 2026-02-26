---
name: bridge
description: Cross-chain token bridging via LI.FI aggregator. Compare quotes from Across, Stargate, LayerZero, Hop, and more. Execute bridge transfers with wallet approval.
metadata: { "openclaw": { "emoji": "🌉" } }
---

# Bridge — Cross-Chain Transfers

## When to Use

- User wants to move tokens between chains (e.g. Base → Ethereum)
- User asks "what's the cheapest way to bridge USDC to Arbitrum?"
- User wants to compare bridge protocols and fees
- User wants to check the status of a pending bridge transfer
- User asks what chains or tokens are supported for bridging

## When NOT to Use

- Same-chain swaps (use defi-trading skill)
- Cross-chain swaps via Wayfinder (use wayfinder skill — it handles the swap+bridge combo)
- Simple token transfers on same chain (use transfer skill)

## Tool: `bridge`

### Actions

| Action | Description |
|--------|-------------|
| `quote` | Get the best bridge quote with fees and estimated time |
| `routes` | Get multiple route options ranked by LI.FI (recommended, cheapest, fastest) |
| `execute` | Execute a bridge transfer (requires wallet) |
| `status` | Check bridge transaction status (source + destination) |
| `chains` | List all supported chains |
| `tokens` | List bridgeable tokens on a specific chain |

### Parameters

| Param | Required For | Description |
|-------|-------------|-------------|
| `from_chain` | quote, routes, execute | Source chain: name or ID. Default: "base" |
| `to_chain` | quote, routes, execute, status | Destination chain: name or ID |
| `from_token` | quote, routes, execute | Source token address or symbol. Default: "ETH" |
| `to_token` | quote, routes, execute | Destination token address or symbol. Default: "ETH" |
| `amount` | quote, routes, execute | Amount in wei (smallest unit) |
| `slippage` | quote, routes, execute | Slippage tolerance (e.g. 0.03 = 3%). Default: 0.03 |
| `bridge` | routes | Preferred bridge protocol (e.g. "across", "stargate") |
| `tx_hash` | status | Transaction hash to check |
| `chain_id` | tokens | Chain ID for token listing |

### Supported Chains

| Chain | ID | Name Aliases |
|-------|----|-------------|
| Ethereum | 1 | ethereum, eth, mainnet |
| Base | 8453 | base |
| Arbitrum | 42161 | arbitrum, arb |
| Optimism | 10 | optimism, op |
| Polygon | 137 | polygon, matic |
| Avalanche | 43114 | avalanche, avax |
| BNB Chain | 56 | bnb, bsc |
| zkSync Era | 324 | zksync |
| Linea | 59144 | linea |
| Scroll | 534352 | scroll |

### Bridge Protocols (via LI.FI)

LI.FI aggregates these bridges and automatically picks the best route:
- **Across** — Fast optimistic bridge (2-10 min)
- **Stargate** — LayerZero-powered, deep liquidity
- **Hop** — Multi-hop routing
- **Synapse** — Cross-chain AMM
- **Connext** — Liquidity network
- **Celer** — Multi-chain messaging
- And many more...

### Workflow

1. **Compare bridge options:**
   ```
   action: routes, from_chain: base, to_chain: arbitrum, from_token: ETH, to_token: ETH, amount: "1000000000000000000"
   ```
   Returns up to 5 routes ranked by value, with fees and estimated time.

2. **Get best single quote:**
   ```
   action: quote, from_chain: base, to_chain: ethereum, from_token: USDC, to_token: USDC, amount: "1000000000"
   ```

3. **Execute the bridge:**
   ```
   action: execute, from_chain: base, to_chain: arbitrum, from_token: ETH, to_token: ETH, amount: "1000000000000000000"
   ```
   Sends the transaction through ClawnchConnect for approval.

4. **Check transfer status:**
   ```
   action: status, tx_hash: 0xabc123..., from_chain: base, to_chain: arbitrum
   ```
   Returns source confirmation + destination delivery status.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LIFI_API_KEY` | No | Higher rate limits. Get one at https://li.fi |

### Fee Structure

Bridge fees come from:
1. **Gas fees** on source chain (paid in native token)
2. **Bridge protocol fee** (varies by protocol, 0.01-0.3%)
3. **Relayer fee** (some bridges charge for destination delivery)

The `quote` and `routes` actions show all fees broken down.

### Security Notes

- Bridge transactions are irreversible once confirmed on the source chain
- Always verify the destination chain and token before executing
- Use `routes` to compare before `execute` — different protocols may have significantly different fees
- Small amounts may not be cost-effective to bridge due to fixed gas costs
