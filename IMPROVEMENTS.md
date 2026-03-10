# OpenClawnch Improvements over Vanilla OpenClaw

OpenClawnch is a crypto-native extension layer for OpenClaw. Everything below is **additive** — no upstream files are modified, so future OpenClaw versions merge cleanly.

---

## Security & Safety (sprints 1 + 3)

### Budget Enforcement Service
Per-operation cost tracking with session-scoped limits. Every swap, bridge, or transfer records its gas + slippage cost against a running budget. Sessions can set a hard cap; operations that would exceed it are blocked before signing.
- `startSession(userId, budgetUsd)` / `recordCost()` / `checkBudget()` / `endSession()`
- Disk-persisted audit trail under `~/.openclawnch/budgets/`
- **Sprint 3**: Wired into `after_tool_call` hook — gas/fee costs from write operations are automatically recorded to the active session
- **Sprint 3**: Fixed `checkBudget()` side-effect — it was mutating session status to `'exceeded'` as a side-effect of a read call, which prevented subsequent `recordCost()` calls. Status transition now happens inside `recordCost()` where it belongs
- Inspired by Lemon's parent-child budget inheritance model

### Endpoint Allowlist
Outbound HTTP is restricted to a curated set of hosts — DEX aggregators, price feeds, RPC endpoints, block explorers, Bankr, WalletConnect, and known oracles. Anything not on the list is blocked (or warned, depending on mode).
- Three modes via `OPENCLAWNCH_ALLOWLIST_MODE`: `enforce` (default), `warn`, `off`
- Extend at runtime via `OPENCLAWNCH_ALLOWED_HOSTS` (comma-separated)
- Drop-in `guardedFetch()` replacement for `fetch()`
- **Sprint 3**: Wired into **12 files** — all services and tools that previously used raw `fetch()` now go through `guardedFetch()`
- **Sprint 3**: Fixed redirect bypass — `redirect: 'manual'` + recursive allowlist check on redirect targets
- **Sprint 3**: Fixed localhost subdomain bypass — `localhost`/`127.0.0.1` in `EXACT_ONLY_HOSTS` set (no subdomain matching)
- **Sprint 3**: Allowlist mode locked at module init to prevent runtime env injection bypass
- **Sprint 3**: Added `api.telegram.org` to the allowlist (needed by `telegram-draft-stream.ts`)
- Inspired by IronClaw's WASM boundary enforcement

### Credential Vault
Centralized secret access with logical names (`bridge.lifi.apiKey`, `wallet.privateKey`, `bankr.apiKey`, etc.) mapped to environment variables. All access is audit-logged with the requesting tool name.
- `getSecret(name, requestingTool)` — returns the value only if configured
- `scanForLeaks(text)` — detects actual secret values, private key patterns (`0x[a-fA-F0-9]{64}`), seed phrase patterns (12/24 BIP-39 words), and API key prefixes in arbitrary text
- Integrated into the `message_sending` hook: every outbound LLM message is scanned, and any leaked secret is redacted before it leaves the process
- `getConfigurationSummary()` — used by `/doctor` to report which secrets are present vs. missing
- **Sprint 3**: Fixed multi-match redaction offset bug — redactions now applied in reverse order to preserve string positions
- **Sprint 3**: Expanded private key false-positive heuristic — calldata, ABI, selector, and topics context no longer triggers false private key detection
- **Sprint 3**: Wired into **19 files** — all tools and services that previously read `process.env.SECRET` directly now go through `getCredentialVault().getSecret()`. Registry expanded from 22 to 29 secrets (added `WAYFINDER_API_KEY`, `CLAWNCH_API_KEY`, `CLAWNCHER_API_KEY`, `HUMMINGBOT_USERNAME`, `HUMMINGBOT_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `HUMMINGBOT_PASSWORD`)
- Inspired by IronClaw's credential injection at host boundary

### Readonly Mode
A third safety mode alongside `safe` and `danger`. In readonly mode, the agent can query balances, prices, and portfolio data but **cannot** execute any write operation (swaps, transfers, approvals, bridge, launch, etc.).
- `/readonly` slash command to toggle
- Enforced via `before_prompt_build` hook — injects a system prompt that blocks all write tools
- **Sprint 3**: Hard enforcement added — `registerToolWithReadonlyGate()` wraps all 28 tools at registration time, blocking write tool `execute()` calls regardless of LLM behavior
- `isReadonly()` helper available to any service that needs to check
- Inspired by ZeroClaw's autonomy levels (readonly/supervised/full)

### `/doctor` Diagnostic Command
One-command health check that validates the entire stack (13 checks):
- Wallet connectivity (WalletConnect session or private key)
- RPC endpoint health (latency + block number)
- Provider circuit breaker status
- Critical and high-priority secrets (via Credential Vault)
- Tool configuration completeness
- Current safety mode
- Endpoint allowlist mode and host count
- Budget tracker session status
- Plan scheduler state
- Transaction ledger stats
- Heartbeat monitor status
- Market cache hit rates
- Channel (Telegram/Discord) connectivity
- Inspired by ZeroClaw's `zeroclaw doctor`

### Outbound Message Leak Scanning
The `message_sending` hook scans every message the LLM is about to send for leaked secrets (private keys, seed phrases, API tokens). Detected values are redacted to `[REDACTED:secret-name]` before the message leaves the process. This is a defense-in-depth layer on top of the Credential Vault.

---

## Observability & Monitoring (new in sprint 2)

### Event-Sourced Transaction Ledger
Append-only log of every on-chain action the agent takes. Each event gets a monotonically increasing sequence number and is persisted as JSONL to disk. Supports:
- 16 event types covering all write tools (swap, transfer, bridge, approve, launch, etc.)
- Query API with filters by user, event type, chain, status, time range, and pagination
- Status updates as new events (preserves append-only invariant, references original via `_refSeq`)
- Aggregate statistics (by type, status, chain)
- Lookup by sequence number or transaction hash
- Automatic recording via the `after_tool_call` hook for all write tools
- Foundation for heartbeat monitoring and cross-session continuity

### Heartbeat Position Monitor
Periodic background checks on all open positions. Configurable via environment variables:
- `OPENCLAWNCH_HEARTBEAT_INTERVAL_MS` — check frequency (default: 5 minutes)
- `OPENCLAWNCH_HEARTBEAT_DROP_PCT` — price drop alert threshold (default: 10%)
- `OPENCLAWNCH_HEARTBEAT_GAIN_PCT` — price gain alert threshold (default: 20%)
- `OPENCLAWNCH_HEARTBEAT_DROP_USD` — portfolio value drop alert (default: $100)
- `OPENCLAWNCH_HEARTBEAT_ENABLED` — enable/disable (default: true)

Detects and alerts on:
- **Price drops** exceeding threshold (warning at 10%, critical at 25%)
- **Price gains** exceeding threshold (informational)
- **Portfolio value drops** exceeding USD threshold
- **New tokens** appearing in the wallet unexpectedly
- **Positions disappearing** (potential rug or unauthorized transfer)
- Alerts routed to all configured channels (Telegram, Discord) via channel sender
- Starts automatically on `gateway_start`
- **Sprint 3**: Added tick overlap guard with proper `try/finally` cleanup — prevents concurrent ticks from piling up when RPC/portfolio calls are slow
- Inspired by ZeroClaw's heartbeat system

### MarketIntel Cache Layer
TTL-based caching for all market data API calls. Wraps DexScreener, CoinGecko, and other price feeds:
- Per-category default TTLs: token prices (15s), trending (1m), new pairs (30s), leaderboard (5m), gas prices (10s)
- Configurable via `CacheConfig` with per-category TTL overrides
- **Stale-on-error** mode: serves expired cached data when upstream API is down (rather than failing)
- LRU-style eviction when cache capacity is reached
- Full statistics: hit rate, cache size, stale serves, evictions, per-category breakdown
- Entry metadata API for diagnostics (age, TTL remaining, hit count)
- Integrated into `/doctor` diagnostic output
- **Sprint 3**: Wired into `dexscreener-service.ts` with automatic category inference

---

## Upstream Compatibility Tracking

### FEATURE_PARITY.md
Documents every OpenClaw plugin API surface OpenClawnch depends on: `registerTool()`, `registerCommand()`, `on()` hooks, event shapes, return contracts. Includes a version compatibility testing checklist so upstream upgrades can be validated systematically.
- Inspired by IronClaw's `FEATURE_PARITY.md` practice

---

## Self-Improvement (sprint 4)

### Recursive Self-Improvement via Procedural Memory
Inspired by [Hermes Agent](https://github.com/NousResearch/hermes-agent), the agent can learn from experience using file-backed procedural memory. No weight updates or code generation — learning is achieved by writing markdown files to disk that are injected into future prompts.

Two modes controlled by `/evolve` and `/stable`:
- **Stable** (default) — predictable behavior. Existing learned knowledge is accessible (read-only) but no new learning occurs.
- **Evolving** — full self-improvement. The agent proactively saves memories, creates skills, and receives periodic nudges.

### Agent Memory Service
File-backed declarative memory with frozen snapshots. Two stores:
- `MEMORY.md` — agent's own notes (environment facts, tool quirks, lessons). 2200 char limit.
- `USER_{id}.md` — per-user profiles (preferences, communication style). 1375 char limit.
- §-delimited entries with injection detection (~9 patterns covering prompt injection, credential references, invisible Unicode)
- **Frozen snapshot pattern**: memory is read once at session start and injected into the system prompt. Mid-session writes update disk but do NOT change the active prompt — preserves the LLM prefix cache. Next session sees updated memory.
- Persisted under `~/.openclawnch/memory/`

### Evolution Mode Service
Per-user stable/evolving toggle with nudge system:
- Persisted to disk under `~/.openclawnch/evolution/`
- Turn counting with configurable intervals: memory nudge every 10 turns, skill nudge every 15
- Env vars: `OPENCLAWNCH_EVOLUTION_MODE`, `OPENCLAWNCH_MEMORY_NUDGE_INTERVAL`, `OPENCLAWNCH_SKILL_NUDGE_INTERVAL`
- Write actions on `agent_memory` and `skill_evolve` tools are gated at registration time — blocked in stable mode regardless of LLM behavior

### Session Recall Service
JSONL-backed full-text search over past conversations:
- In-memory tokenized search with TF-based relevance scoring
- `recordTurn()` appends to `~/.openclawnch/recall/sessions.jsonl`
- `search(query, maxResults)` returns ranked sessions with context windows
- 50K entry cap with FIFO eviction
- Always available (not gated by evolution mode — read-only)
- Wired into `message_received` (user messages) and `after_tool_call` (tool results) hooks

### Skill Security Guard
Static analysis scanner for agent-created skills (~50 regex patterns across 10 categories):
- Prompt injection, exfiltration, destructive commands, privilege escalation, obfuscation, crypto-specific dangers, persistence/backdoors, self-modification, supply chain attacks
- Three trust levels: `builtin` (always passes), `learned` (critical+high blocks), `imported` (any finding blocks)
- `scanSkillContent()`, `formatScanReport()`, `validateSkillFrontmatter()`

### Skill Evolution Tool
Agent-initiated skill creation and improvement:
- Actions: create, patch, list, view, delete
- Skills stored in `~/.openclawnch/learned-skills/` (separate from the 27 static skills, so upgrades don't overwrite agent-learned ones)
- All writes pass through the skill security scanner
- `buildLearnedSkillsIndex()` generates a compact index for system prompt injection
- YAML frontmatter with agentskills.io format

### 3 New Tools, 3 New Commands
- **Tools** (31 total): `agent_memory`, `skill_evolve`, `session_recall`
- **Commands** (78 total): `/evolve`, `/stable`, `/evolution`

---

## Bankr Credit Management (post-sprint 4)

### `/topup` Command
Top up LLM credits directly from Telegram:
- `/topup <amount> [token]` — request a credit top-up via the Bankr Agent API
- Validates amount (1–1000 range), supports token selection (USDC default, also SOL/ETH)
- Uses `bankrPromptAndPoll()` for the mutation since exact REST endpoints aren't documented
- Clear success/error feedback with formatted messages

### `/autotopup` Command
View and configure automatic credit top-ups:
- `/autotopup` — view current auto top-up configuration
- `/autotopup enable [amount] [threshold] [token]` — enable with optional parameters (defaults: 10 USDC, threshold 5)
- `/autotopup disable` — disable auto top-up
- Tries `GET /v1/credits/auto` on the LLM Gateway for structured data, falls back to Agent API prompt
- Validates amount (1–500) and threshold (1–100) ranges

### Enhanced `/llmcredits`
Now shows credit balance (via `GET /v1/credits` on `llm.bankr.bot`), auto top-up status, and links to `/topup` and `/autotopup` commands. Graceful fallback when credit API is unavailable.

### Two Bankr API Integration Points
- **LLM Gateway** (`llm.bankr.bot`, auth: `X-API-Key` with `BANKR_LLM_KEY`) — read-only credit/usage queries
- **Agent API** (`api.bankr.bot`, auth: `X-API-Key` with `BANKR_API_KEY` via credential vault) — wallet operations, prompts, signing, and mutation operations via `bankrPromptAndPoll()`

---

## DeFi Trading Infrastructure (pre-existing)

### 31 Specialized Tools
| Category | Tools |
|----------|-------|
| Trading | `defi-swap`, `defi-price`, `defi-balance`, `manage-orders`, `permit2` |
| Analytics | `analytics`, `cost-basis`, `market-intel`, `herd-intelligence` |
| Cross-chain | `bridge`, `transfer` |
| Exploration | `block-explorer`, `watch-activity` |
| Liquidity | `liquidity`, `compound-action` |
| Token Launch | `clawnch-launch`, `clawnch-fees`, `clawnch-info`, `clawnchconnect`, `clawnx` |
| Bankr | `bankr-launch`, `bankr-leverage`, `bankr-polymarket`, `bankr-automate` |
| Advanced | `molten`, `hummingbot`, `wayfinder`, `crypto-workflow` |
| Self-Improvement | `agent-memory`, `skill-evolve`, `session-recall` |

### 7-Aggregator DEX Routing
Quotes from 1inch, 0x, Paraswap, OpenOcean, KyberSwap, Odos, and Li.Fi are compared in parallel. The best price wins after gas-inclusive comparison.

### 5-Source Price Oracle
Prices from CoinGecko, Birdeye, DexScreener, on-chain TWAP, and Chainlink are cross-referenced. Outliers are discarded; the median is returned with confidence scoring.

### Multi-RPC Failover with Circuit Breakers
Multiple RPC endpoints per chain with automatic failover. Circuit breakers track error rates and temporarily remove unhealthy providers. Latency-based routing sends requests to the fastest healthy endpoint.

### Gas Estimation Service
Estimates gas for any transaction, converts to USD, and compares swap routes on a gas-inclusive basis so the cheapest route isn't the one that costs more in gas.

### FIFO Cost Basis Tracking
Automatic lot-level P&L tracking using FIFO accounting. Every buy creates a lot; every sell matches against the oldest lots. Unrealized and realized gains are available at any time.

### Plan Compiler & Scheduler
Natural-language trading plans are compiled into executable step sequences with validation, then scheduled for execution with dependency tracking between steps.

---

## Wallet & Connectivity

### Three Wallet Modes
1. **WalletConnect** (default) — phone-based approval for every transaction. Supports MetaMask, Rainbow, Coinbase Wallet, Trust, Phantom, Rabby, Zerion, and OKX.
2. **Private Key** (headless) — for automated/server deployments. Gated behind `ALLOW_PRIVATE_KEY_MODE=true`.
3. **Bankr** (custodial) — API-managed wallet via Bankr platform.

### Multi-Channel Output
Telegram and Discord adapters with draft-stream support. The agent can send formatted messages, images, and transaction receipts to channels.

### Fly.io Deployment
Built-in commands for managing Fly.io deployments: `/flystatus`, `/flykeys`, `/flyrestart`, plus provider configuration.

---

## Agent Persona & UX

### 78 Slash Commands
Full command palette covering wallet management, safety modes, trading, analytics, deployment, model selection, LLM provider shortcuts, onboarding, plan management, diagnostics, self-improvement modes, credit management, and help.

### 27 Skills
Each tool has a companion skill file that teaches the LLM how and when to use it, including edge cases, required parameters, and safety considerations.

### Configurable Personas
Multiple persona modes that adjust the agent's communication style and risk tolerance.

### Safety Service with Pre-flight Checks
Every write operation goes through pre-flight validation: balance sufficiency, slippage bounds, gas estimation, approval checks, and rate limiting.

---

## Test Coverage

902 tests (+ 11 skipped) across 27 test files covering plugin registration, tool behavior, service logic, command handlers, bridge operations, safety services, self-improvement modules, credit management, and integration scenarios.

---

## Roadmap — Planned Improvements

The following items were identified during the competitive research phase and are prioritized for future sprints:

### Near-term
- **Deny-by-default channel auth** — require explicit allowlisting of Telegram/Discord channels before the agent responds (inspired by ZeroClaw)
- **`openclawnch migrate` command** — import settings, keys, and history from vanilla OpenClaw (inspired by ZeroClaw)

### Medium-term
- **XMTP adapter** — decentralized messaging channel for wallet-to-wallet agent communication (inspired by Lemon)
- **Per-wallet isolated context** — container-style isolation so multi-user deployments can't cross-contaminate state (inspired by NanoClaw)
- **Vector-enhanced recall** — upgrade session recall from TF-based to embedding-based search for semantic matching

### Long-term
- **Agent swarms** — multi-agent coordination for complex DeFi strategies (inspired by NanoClaw)
- **Natural language cron** — schedule recurring checks and actions using plain English (inspired by Hermes Agent)
- **WASM sandbox for tool execution** — run untrusted tool code in isolated WASM containers (inspired by IronClaw)
