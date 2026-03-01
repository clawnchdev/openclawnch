# Token Launching via Bankr

## Overview
Deploy tokens on Base (Uniswap V4) or Solana (Raydium LaunchLab) via Bankr's token launch API. Gas is sponsored.

## Tool: `bankr_launch`

### Actions
- **deploy** — launch a token on-chain
- **simulate** — dry run without broadcasting (returns predicted address)
- **fees** — check earned trading fees from your launched tokens
- **claim** — claim earned fees

### Base Launch (Uniswap V4)
- 100B fixed supply, non-mintable
- 1.2% swap fee on all trades
- Fee split: 57% creator / 36.1% Bankr / 1.9% ecosystem / 5% Doppler protocol
- Creator claims both their token and WETH
- Optional vault: lock 1-90% of supply for N days
- Optional vesting: cliff + linear schedule

### Solana Launch (Raydium LaunchLab)
- Bonding curve → auto-migration to CPMM pool
- 0.5% bonding curve fee (claimable in SOL)
- Post-migration LP: 50% creator / 40% Bankr / 10% burned
- Must specify chain="solana" explicitly

### Fee Structure
Fees accumulate from trading activity on the token. High-volume tokens can generate $10-100+/day. Use the "fees" action to check and "claim" to withdraw.

### Rate Limits
- Standard: 50 deploys/day
- Bankr Club: 100 deploys/day

### Parameters
| Parameter | Required | Description |
|-----------|----------|-------------|
| name | Yes (deploy/simulate) | Token name (1-100 chars) |
| symbol | No | Ticker (defaults to first 4 of name) |
| description | No | Max 500 chars |
| image | No | Logo URL (uploaded to IPFS) |
| chain | No | "base" (default) or "solana" |
| fee_recipient | No | Address, ENS, X handle, Farcaster handle |

### Self-Sustaining Agent Model
Launch token → trading generates fees → claim 57% → fund LLM credits at bankr.bot/llm → agent keeps running.
