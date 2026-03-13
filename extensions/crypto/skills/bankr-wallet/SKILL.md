---
name: bankr-wallet
description: Custodial wallet accessible via API for server-side on-chain operations without phone approval
---

# Bankr Wallet Mode

## What It Is
Bankr provides a custodial wallet accessible via API. When connected, all on-chain operations (swaps, launches, signing) execute server-side through Bankr's infrastructure. No phone approval needed.

## How to Connect
1. User needs a Bankr API key with Agent API enabled (bankr.bot/api)
2. Set `BANKR_API_KEY` env var or Fly secret
3. Run `/connect_bankr` or use clawnchconnect tool with wallet="bankr"

## Wallet Addresses
- Each Bankr account gets one EVM address and optionally one Solana address
- EVM address works across Base, Ethereum, Polygon, Unichain
- Solana address is separate

## Supported Chains
| Chain | Swaps | Launch | Automations | Leverage | Polymarket | Gas Sponsored |
|-------|:-----:|:------:|:-----------:|:--------:|:----------:|:-------------:|
| Base | Yes | Yes | Yes | Yes | No | Yes |
| Ethereum | Yes | No | No | No | No | No |
| Polygon | Yes | No | No | No | Yes | Yes |
| Unichain | Yes | No | No | No | No | Yes |
| Solana | Yes | Yes | No | No | No | Limited |

## Security Model
- Bankr's Sentinel system screens all transactions server-side
- No spending policies needed (Sentinel replaces them)
- Custodial: Bankr holds the private keys
- For self-custody, use WalletConnect with MetaMask/Rainbow/etc.

## Bankr Club
Premium membership that increases rate limits:
- 1,000 prompts/day (vs 100)
- 100 token deploys/day (vs 50)
- 10 Solana gas sponsorships/day (vs 1)

## Commands
- `/connect_bankr` — connect Bankr wallet
- `/connect` — shows all wallet options including Bankr
- `/wallet` — shows current wallet info
