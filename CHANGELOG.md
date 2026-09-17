# Changelog

All notable changes to OpenClawnch will be documented in this file.

## [0.2.0] — 2026-09-17

Robinhood Chain (4663) support across the crypto extension.

### Features

- **Robinhood Chain launch, fees and info surfaces** — new `lib/robinhood-api.ts` typed client for `/api/robinhood/{ticket,launch,launches,claim}` with router/Bags/FeeShare ABIs and a chain-guarded sender that refuses any transaction whose chainId isn't 4663
- `clawnch_launch` — ticket mode (EIP-712 ticket → agent signs & sends → confirm) and deposit mode (send ≥ 0.02 ETH → confirm)
- `clawnch_fees` — RHC claimable / claim / claim-all via the claim API
- `clawnch_info` — chain-aware token/list/portfolio/stats with Blockscout and bags.fm links; `vault_claim` raises not-supported on RHC instead of pretending
- Contract registry ROBINHOOD block + RHC token addresses; endpoint allowlist, rpc command, skills and env template updated
- Base-only surfaces now fail loudly (`ClawnchDeployError` / not-supported) — no silent wrong-chain fallbacks

### Tests

- +58 tests (51 unit + 7 opt-in live)
- Fixed flaky state-dir collisions (`/tmp` dirs keyed only by `Date.now()`): all suites now use unique per-instance dirs

## [0.1.0] — 2026-04-02

Initial beta release.

### Features

- 48 tools across trading, DeFi, wallet, portfolio, market data, automation, governance, and token launches
- 118 slash commands
- 76 services
- Compound action engine: conditional chains, time/price/on-chain triggers, cron scheduling, parallel execution
- Spending policies via natural language ("approve under 0.05 ETH, max 10/hour")
- Multi-channel: Telegram (production), Discord, Slack, Signal, WhatsApp, iMessage, LINE
- Three wallet modes: WalletConnect (non-custodial), local encrypted (BIP-39), Bankr (custodial)
- Interactive setup wizard (`openclawnch init`) with live key validation
- One-command Fly.io deploy (`openclawnch deploy`)
- Docker and docker-compose support for self-hosting
- Proactive issue reporting (`/report`) with one-time opt-in
- Agent memory, skill evolution, and session recall
- 6 onboarding personas (Professional, Degen, Chill, Technical, Mentor, Custom)

### Security

- Agent never holds unencrypted private keys (WalletConnect mode)
- All write tools are `ownerOnly`
- Credential leak detection on LLM-bound output
- Endpoint allowlist for outbound HTTP
- Prompt injection resistance guardrails
- Bounded approvals (exact amounts, never unlimited)

### Based On

- OpenClaw `2026.3.28`
- Node.js `>= 22.14.0`
