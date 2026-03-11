# Security Model

OpenClawnch handles real money. The security model is designed around the principle that the agent should never be able to steal funds, even if compromised.

---

## Key custody

The agent never holds your private keys by default. In WalletConnect mode, every transaction is routed to your phone wallet for approval. You see the full transaction details and tap approve/reject.

| Mode | Agent has keys? | Approval flow |
|------|----------------|---------------|
| WalletConnect | No | Phone wallet approval |
| Private key + `/walletsign` | Yes (local) | Agent asks, you confirm in chat |
| Private key + `/autosign` | Yes (local) | Automatic — no confirmation |
| Bankr | No (custodial) | Bankr API handles signing |

## Access control

- All write-operation tools are **`ownerOnly: true`** — only the paired account owner can invoke them. Non-owner senders in group chats cannot trigger on-chain actions.
- **Spending policies** — configure per-token or per-amount auto-approval rules via `/policy`. Transactions exceeding the policy go to wallet for manual approval.
- **Safety modes** — `/safemode` (default) requires confirmation before acting. `/dangermode` skips confirmation. `/readonly` blocks all on-chain writes entirely.

## Credential leak detection

The credential vault scans all LLM-bound output for:

- Private keys (`0x` + 64 hex chars)
- BIP-39 seed phrases (12/24 word sequences from the English wordlist)
- WalletConnect session secrets
- API keys (Anthropic, OpenRouter, OpenAI, Alchemy, etc.)

If a credential is detected in agent output, it is redacted before being sent to the user or stored in conversation history.

## Input validation

- All user-supplied amounts are validated with regex before `parseEther`/`parseUnits`/`BigInt` conversion — prevents NaN/Infinity injection.
- Bankr API inputs are sanitized for prompt injection patterns.
- RPC error messages are scrubbed to remove sensitive tokens before surfacing to the user.

## Transaction safety

- **Sequential execution** — multi-step operations run one at a time. The agent checks on-chain balances between steps. Never queues multiple transactions.
- **Receipt waits** — every `writeContract` and `sendTransaction` call waits for `waitForTransactionReceipt`. No fire-and-forget.
- **Bounded approvals** — token approvals use exact amounts (or +0.5% buffer), never unlimited `MaxUint256`.
- **MEV protection** — swaps, transfers, and bridges route through Flashbots Protect RPC when available on the target chain.
- **Event-sourced tx ledger** — every on-chain action is recorded as an immutable event for audit trail, tax reporting, and replay.

## Network security

- **Endpoint allowlist** — outbound HTTP is restricted to a curated set of hosts (`endpoint-allowlist.ts`). Tools cannot make arbitrary network requests.
- **Multi-RPC failover** — if one RPC endpoint fails or returns bad data, the provider cycles to the next with a circuit breaker. No single point of failure.

## Monitoring

- **Health factor monitoring** — Aave lending positions emit heartbeat alerts at warning (< 1.5) and critical (< 1.2) thresholds.
- **`/doctor` command** — run diagnostics on wallet connection, RPC health, API key configuration, channel status, and security settings.

## Builder Code

All Base chain transactions include the Base Builder Code `bc_z92vaimh` (ERC-8021) for on-chain attribution. This is applied at the wallet client level — every `sendTransaction` and `writeContract` call on Base includes the data suffix automatically.

## Test coverage

958 tests cover security-critical paths including:

- `ownerOnly` enforcement on all write tools
- Credential leak detection patterns
- Injection sanitization on Bankr API inputs
- RPC error message scrubbing
- Bounded approval enforcement
- Transaction receipt waiting
- Input validation (amount parsing, address formats)
