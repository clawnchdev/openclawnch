# @clawnch/openclaw-crypto

Crypto/DeFi extension for [OpenClaw](https://github.com/openclaw/openclaw). Adds wallet management, token swaps, market intelligence, cross-chain bridging, compound operations, and more.

## Install

```bash
openclaw plugins install @clawnch/openclaw-crypto
```

Or use it as part of the full [OpenClawnch](https://github.com/clawnch/openclawnch) distribution:

```bash
npx @clawnch/openclawnch
```

## What's Included

**42 tools** — `clawnch_connect`, `defi_swap`, `defi_price`, `defi_balance`, `transfer`, `bridge`, `permit2`, `analytics`, `market_intel`, `herd_intelligence`, `compound_action`, and more.

**87 slash commands** — `/wallet`, `/connect`, `/swap`, `/send`, `/bridge`, `/plans`, `/setup`, and more. All tappable on Telegram.

**47 services** — WalletConnect lifecycle, multi-RPC failover, DEX aggregation (6 aggregators), price oracle with divergence detection, compound operation engine, credential vault with leak scanning.

**42 skill docs** — LLM guidance for tool usage, security patterns, and DeFi concepts.

## Wallet Modes

| Mode | Setup | Key Custody | Best For |
|------|-------|-------------|----------|
| **WalletConnect** | Scan QR from MetaMask/Rainbow/etc. | User's phone | Production |
| **Private Key** | Set `CLAWNCHER_PRIVATE_KEY` env var | Local/Keychain | Headless/testing |
| **Bankr** | Set `BANKR_API_KEY` | Custodial (Bankr) | Zero-friction |

## Environment Variables

Required (at least one wallet mode):

```bash
# WalletConnect mode
WALLETCONNECT_PROJECT_ID=your_project_id

# OR Private key mode
CLAWNCHER_PRIVATE_KEY=0x...

# OR Bankr custodial mode
BANKR_API_KEY=your_bankr_key
```

Optional:

```bash
ALCHEMY_API_KEY=...          # Better RPC (free tier works)
ZEROX_API_KEY=...            # 0x DEX aggregator
BASESCAN_API_KEY=...         # Block explorer queries
HERD_ACCESS_TOKEN=...        # Token investigation/auditing
```

## Supported Chains

Primary: **Base** (Coinbase L2)
Also: Ethereum, Arbitrum, Optimism, Polygon — via multi-RPC failover with circuit breaker.

## Security

- Agent never holds private keys in WalletConnect mode
- Credential vault with leak scanning on all LLM-bound output
- Endpoint allowlist restricts outbound HTTP to curated hosts
- Spending policies with natural-language configuration
- `ownerOnly: true` on all write-operation tools

## License

MIT
