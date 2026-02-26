---
name: block-explorer
description: Query Etherscan/Basescan for on-chain data. Transaction lookup, contract source, gas prices, token holders, and internal transactions.
metadata: { "openclaw": { "emoji": "🔍" } }
---

# Block Explorer — Etherscan/Basescan

## When to Use

- User asks "what happened in this transaction?"
- User wants to see contract source code or ABI
- User asks about current gas prices
- User wants to know who holds a token (top holders)
- User wants to trace internal transactions
- User asks about a contract's verification status

## When NOT to Use

- Checking token prices (use defi-trading skill)
- Monitoring real-time on-chain activity (use watch-activity skill)
- Technical analysis (use analytics skill)

## Tool: `block_explorer`

### Actions

| Action | Description |
|--------|-------------|
| `tx_lookup` | Transaction details: status, gas, value, from/to |
| `contract_source` | Verified source code, ABI, compiler info, proxy status |
| `gas_tracker` | Current gas prices: fast/standard/slow + cost estimates |
| `token_holders` | Top token holders with balance and percentage |
| `internal_txs` | Internal (trace) transactions for an address or tx |

### Parameters

| Param | Required For | Description |
|-------|-------------|-------------|
| `chain` | All (optional) | "base" (default) or "ethereum" |
| `tx_hash` | tx_lookup, internal_txs | Transaction hash (0x...) |
| `address` | contract_source, internal_txs | Contract or wallet address (0x...) |
| `token` | token_holders | Token contract address |
| `page` | token_holders, internal_txs | Page number (default: 1) |
| `limit` | token_holders, internal_txs | Results per page (default: 25, max: 100) |

### Environment Variables

| Variable | Required For |
|----------|-------------|
| `BASESCAN_API_KEY` | Base chain queries |
| `ETHERSCAN_API_KEY` | Ethereum chain queries |

Get free API keys at:
- https://basescan.org/apis
- https://etherscan.io/apis

### Workflow

1. **Look up a transaction:**
   ```
   action: tx_lookup, tx_hash: 0xabc123..., chain: base
   ```
   Returns: status, block, from/to, value, gas used, gas cost in ETH.

2. **Check contract source:**
   ```
   action: contract_source, address: 0x833589..., chain: base
   ```
   Returns: verified status, contract name, source code, ABI, proxy info.

3. **Check gas prices:**
   ```
   action: gas_tracker, chain: base
   ```
   Returns: fast/standard/slow in gwei + estimated costs for ETH transfer, ERC-20 transfer, and swap.

4. **Find top token holders:**
   ```
   action: token_holders, token: 0xa1F7..., chain: base, limit: 10
   ```
   Returns: holder addresses, balances, percentage of supply.

5. **Trace internal transactions:**
   ```
   action: internal_txs, tx_hash: 0xabc123..., chain: base
   ```
   Returns: internal calls with from/to/value/type.

### Gas Cost Estimates

The `gas_tracker` action includes pre-computed cost estimates for common operations:

| Operation | Typical Gas |
|-----------|-------------|
| ETH transfer | 21,000 |
| ERC-20 transfer | 65,000 |
| Swap | 200,000 |

### Security Notes

- API keys are used for rate limiting, not authentication — Etherscan data is public
- Contract source may not match deployed bytecode if not verified
- Always verify contract addresses through multiple sources before interacting
