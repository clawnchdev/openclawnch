# Architecture

OpenClawnch is a crypto-native fork of [OpenClaw](https://github.com/openclaw/openclaw). The crypto functionality lives in a standalone extension that registers tools, commands, and hooks through OpenClaw's extension system.

---

## Packages

Two npm packages, one repo:

| Package | Purpose |
|---------|---------|
| `openclawnch` | CLI wrapper + deploy tooling. Runs `openclaw` with the crypto extension pre-configured. |
| `@clawnch/openclaw-crypto` | Standalone crypto extension. Can be installed into any OpenClaw instance independently. |

Each user runs their own instance with their own API keys. No shared infrastructure.

## Extension structure

```
extensions/crypto/
├── index.ts                    # Entry point (register 48 tools, 117 commands, hooks)
├── src/
│   ├── tools/                  # 42 tool files
│   ├── commands/               # 18 command files
│   ├── hooks/                  # System prompt injection, post-tool-call hooks
│   ├── lib/                    # Shared utilities (ENS resolver, token decimals, helpers)
│   └── services/               # 47 service files
│       ├── channel-sender.ts           # Channel-agnostic message routing (7 channels)
│       ├── walletconnect-service.ts    # WalletConnect lifecycle + builder code wrapping
│       ├── rpc-provider.ts             # Multi-RPC with failover + circuit breaker
│       ├── dex-aggregator.ts           # Multi-aggregator DEX routing (6 aggregators)
│       ├── plan-compiler.ts            # Intent → Plan IR compiler
│       ├── plan-validator.ts           # 6-pass validation
│       ├── plan-scheduler.ts           # Persistent scheduler with condition polling
│       ├── plan-executor.ts            # Tree-walking executor
│       ├── credential-vault.ts         # Secret management + leak detection
│       ├── endpoint-allowlist.ts       # Outbound HTTP restriction
│       ├── tool-config-service.ts      # Per-tool API key requirements
│       └── ...
├── skills/                     # 42 skill documents for LLM guidance
deploy/
├── Dockerfile                  # Container image (Node 22 Alpine)
├── docker-compose.yml          # Self-hosted deploy
├── .env.example                # Full environment variable reference
├── entrypoint.sh               # Startup script
├── fly.template.toml           # Fly.io config template
└── openclaw.json               # OpenClaw config (channels, models, extension paths)
```

## SDK dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@clawnch/sdk` | ^2.2.1 | Wallet signing, swaps, token deployment |
| `@clawnch/clawncher-sdk` | ^0.3.3 | Fee claiming, LP management, Hummingbot/Condor |
| `@clawnch/clawnx` | ^1.0.0 | X/Twitter integration |
| `viem` | ^2.0.0 | Ethereum interaction (ABI encoding, contract calls, receipts) |
| `@sinclair/typebox` | ^0.34.0 | Runtime parameter schemas |

## Registration pattern

Each tool is a factory function (`createXTool()`) that returns `{ name, label, ownerOnly, description, parameters, execute }`. Tools register through `registerToolWithReadonlyGate()` which enforces readonly mode. Write tools are listed in the `WRITE_TOOL_NAMES` set.

Commands register via `api.registerCommand()`. Hooks use `api.on('message_received', ...)` and `api.on('after_tool_call', ...)`.

## Multi-channel routing

The `channel-sender.ts` service abstracts away channel differences. It parses session keys to identify the channel and user, then routes messages through the correct OpenClaw send function. All tools and commands are channel-agnostic — they return structured data, and the routing layer handles delivery.

Supported channels: Telegram, Discord, Slack, Signal, WhatsApp, iMessage, LINE.

---

## Compound Operations Engine

Natural language scheduling and conditional execution for multi-step on-chain operations.

### How it works

1. **Compiler** — parses natural language intent into a Plan IR (intermediate representation)
2. **Validator** — 6-pass validation: structural, temporal, financial, tool availability, safety, dependency
3. **Scheduler** — persistent file-based store with a 15-second tick loop for condition evaluation
4. **Executor** — tree-walking executor with failure policies (abort, skip, retry) and cancellation

### Plan IR

6 node types compose into any operation:

| Node | Purpose |
|------|---------|
| Action | Single tool invocation |
| Sequence | Run steps in order |
| Parallel | Run steps concurrently |
| If | Conditional branching |
| Wait | Pause for duration or condition |
| Loop | Repeat with interval or condition |

4 trigger types: Immediate, Time (specific datetime), Interval (recurring), Condition (price/balance threshold).

### Examples

- **Time triggers**: "Swap 0.1 ETH for USDC at 5pm"
- **Conditions**: "If ETH drops below $3500, buy 0.5 ETH"
- **Loops**: "Every 4 hours, check ETH price and buy if dip > 5%"
- **Chains**: "Sell half my PEPE, bridge the ETH to Arbitrum, then buy ARB"
- **Parallel**: "Check prices on ETH, BTC, and SOL simultaneously"

Plans persist to disk and survive restarts. The validator catches contradictions (buy+sell same token, overspend, infinite loops, circular dependencies) before execution.

### Commands

| Command | Description |
|---------|-------------|
| `/plans` | List all scheduled plans |
| `/plans_active` | Active plans only |
| `/plans_cancel` | Cancel a specific plan |
| `/plans_clear` | Cancel all active plans |

---

## Development

```bash
pnpm install
pnpm build        # Build extension + wrapper
pnpm typecheck    # tsc --noEmit (strict mode)
pnpm test         # 1547 tests across 44 files (1547 pass, 31 skip)
```

Test files cover: tool registration, command handlers, service logic, security hardening, compound operations, channel routing, integration scenarios, and E2E scaffolds.
