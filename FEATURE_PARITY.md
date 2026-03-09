# Feature Parity Tracking — OpenClawnch vs OpenClaw Upstream

This document tracks which OpenClaw features OpenClawnch depends on, tests against,
and extends. It is the single source of truth for merge compatibility when pulling
future OpenClaw releases into this fork.

**Minimum OpenClaw version:** `>=2026.2.0` (peer dependency)

## Plugin API Surface We Use

These are the `api.*` methods our crypto extension calls in `extensions/crypto/index.ts`.
If upstream changes any of these signatures, our extension breaks.

| API Method | Our Usage | Status |
|---|---|---|
| `api.registerTool(tool)` | 28 tools registered | Stable |
| `api.registerCommand(cmd)` | 67+ commands registered | Stable |
| `api.on('gateway_start', cb)` | Wallet init, plan scheduler start | Stable |
| `api.on('message_received', cb)` | Onboarding flow interception | Stable |
| `api.on('message_sending', cb)` | Cancel LLM response during onboarding | Stable |
| `api.on('before_prompt_build', cb)` | System prompt injection (identity, mode, wallet state) | Stable |
| `api.on('after_tool_call', cb)` | Onboarding progression, config hints, cost basis auto-record | Stable |
| `api.logger.info/warn` | Logging throughout | Stable |
| `api.runtime.tools.getAll()` | Plan executor dispatches tools by name | Needs verification each release |

## Tool Registration Shape

Our tools conform to this interface (must match OpenClaw's `AnyAgentTool`):

```ts
{
  name: string;
  label: string;
  description: string;
  ownerOnly: boolean;
  parameters: TSchema;           // TypeBox schema
  execute: (toolCallId: string, args: unknown) => Promise<ToolResult>;
}
```

## Command Registration Shape

Our commands conform to:

```ts
{
  name: string;
  description: string;
  acceptsArgs: boolean;
  requireAuth: boolean;
  handler: (ctx: any) => Promise<{ text: string }>;
}
```

## Hook Event Shapes We Depend On

| Hook | Event fields we read | Context fields we read |
|---|---|---|
| `gateway_start` | (none) | (none) |
| `message_received` | `event.content`, `event.from` | `ctx.channelId`, `ctx.conversationId`, `ctx.senderId`, `ctx.metadata.senderId` |
| `message_sending` | `event.to` | `ctx.conversationId` |
| `before_prompt_build` | (none) | `ctx.sessionKey` |
| `after_tool_call` | `event.toolName`/`event.tool`, `event.result`/`event.details`, `event.error` | `ctx.sessionKey`, `ctx.conversationId` |

## Return Value Contracts

| Hook | Return shape | Effect |
|---|---|---|
| `message_sending` | `{ cancel: true }` | Suppresses LLM response |
| `before_prompt_build` | `{ prependContext: string }` | Prepends text to system prompt |

## OpenClaw Features We Do NOT Modify

These are upstream features we rely on working correctly but do not patch:

- Gateway HTTP server and webhook handling
- Channel adapters (Telegram, Discord, Slack, Signal, WhatsApp, iMessage, LINE)
- Agent runtime and LLM provider routing
- Plugin loader and discovery (`openclaw.json` → `plugins.load.paths`)
- Skills loader (`skills.load.extraDirs`)
- Session management and conversation persistence
- Pairing code authentication
- Model switching (`/model` command — we add shortcuts but don't modify core)

## OpenClawnch-Only Additions (Not in Upstream)

These are new services, tools, and commands that only exist in our extension:

### Services (26)
- `walletconnect-service.ts` — WalletConnect/private key/Bankr wallet management
- `dex-aggregator.ts` — Multi-DEX swap quoting (7 aggregators)
- `price-oracle.ts` — Multi-source price feeds (5 sources)
- `rpc-provider.ts` — Multi-RPC failover with circuit breaker
- `safety-service.ts` — Pre-flight balance/audit checks
- `mode-service.ts` — Safe/danger/readonly + wallet/autosign modes
- `budget-service.ts` — Per-operation gas+slippage budget tracking
- `credential-vault.ts` — Centralized secret access with leak scanning
- `endpoint-allowlist.ts` — HTTP endpoint allowlisting for tools
- `onboarding-flow.ts` — Interactive onboarding state machine
- `channel-sender.ts` — Channel-agnostic message routing
- `plan-compiler.ts` — Natural language → Plan IR compiler
- `plan-validator.ts` — 6-pass plan validation
- `plan-scheduler.ts` — File-based plan persistence and execution scheduling
- `plan-executor.ts` — Plan IR tree-walking executor
- `gas-estimator.ts` — Gas price estimation
- `builder-code.ts` — ERC-8021 builder code attribution
- `allowance-manager.ts` — ERC-20 approval auditing
- `bankr-api.ts` — Bankr Agent API client
- `dexscreener-service.ts` — DexScreener API client
- `price-service.ts` — Price lookup facade
- `chainlink-oracle.ts` — On-chain Chainlink feeds
- `spending-policy-service.ts` — Natural language spending rules
- `tool-config-service.ts` — Tool requirement registry
- `hummingbot-service.ts` — Hummingbot bot control
- `molten-service.ts` — Molten agent matching

### Tools (28)
See `extensions/crypto/index.ts` for the complete list.

### Commands (67+)
See `extensions/crypto/index.ts` for the complete list.

## Version Compatibility Testing

When pulling a new OpenClaw release:

1. Run `npm test` (667 tests across 22 files)
2. Verify plugin loads: `node bin/openclawnch.mjs --help`
3. Check hook signatures haven't changed (search OpenClaw changelog for "plugin", "hook", "registerTool")
4. Verify `api.runtime.tools.getAll()` still returns the expected shape
5. Test one write operation end-to-end (connect wallet → swap)

## Changelog of Upstream Breaking Changes

| OpenClaw Version | Breaking Change | Our Fix | Date |
|---|---|---|---|
| (none yet) | — | — | — |
