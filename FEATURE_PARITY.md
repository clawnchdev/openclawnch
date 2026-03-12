# Feature Parity Tracking — OpenClawnch vs OpenClaw Upstream

This document tracks which OpenClaw features OpenClawnch depends on, tests against,
and extends. It is the single source of truth for merge compatibility when pulling
future OpenClaw releases into this fork.

**Minimum OpenClaw version:** `>=2026.3.0` (peer dependency)
**Bundled OpenClaw version:** `2026.3.8`
**Upstream latest:** `2026.3.9`

## Plugin API Surface We Use

These are the `api.*` methods our crypto extension calls in `extensions/crypto/index.ts`.
If upstream changes any of these signatures, our extension breaks.

| API Method | Our Usage | Status |
|---|---|---|
| `api.registerTool(tool)` | 42 tools registered | Stable |
| `api.registerCommand(cmd)` | 78+ commands registered | Stable |
| `api.on('gateway_start', cb)` | Wallet init, plan scheduler start, heartbeat start | Stable |
| `api.on('message_received', cb)` | Onboarding flow interception, session recall indexing | Stable |
| `api.on('message_sending', cb)` | Cancel LLM response during onboarding, credential leak scanning | Stable |
| `api.on('before_prompt_build', cb)` | System prompt injection (identity, mode, wallet state, memory, skills) | Stable |
| `api.on('after_tool_call', cb)` | Onboarding progression, config hints, cost basis auto-record, tx ledger, budget, session recall, evolution nudge | Stable |
| `api.logger.info/warn` | Logging throughout | Stable |
| `api.runtime.tools.getAll()` | Plan executor dispatches tools by name | **Needs verification each release** |
| `api.runtime.channel.<ch>` | Dynamic channel message sending (22+ channels) | **Needs verification each release** |

### Upstream APIs Not Yet Used (potential adoption)

| API Method | Potential Use | Priority |
|---|---|---|
| `api.registerService()` | Formalize plan scheduler, heartbeat as managed services | Medium |
| `api.registerHttpRoute()` | Webhook endpoints for DEX callbacks | Low |
| `api.registerHook()` | Typed hook registration with priority options | Medium |
| `api.runtime.modelAuth` | Provider key resolution instead of raw process.env | Low |
| `api.runtime.state.resolvePath()` | State directory resolution | Low |
| `before_tool_call` hook | Pre-flight budget checks | Medium |

## Tool Registration Shape

Our tools conform to this interface (must match OpenClaw's `AnyAgentTool`):

```ts
{
  name: string;
  label: string;
  description: string;
  ownerOnly: boolean;
  parameters: TSchema;           // TypeBox schema
  execute: (toolCallId: string, args: unknown, ctx?: any) => Promise<ToolResult>;
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
| `message_received` | `event.content`, `event.from`, `event.metadata.senderId` | `ctx.channelId`, `ctx.conversationId`, `ctx.senderId`, `ctx.sessionKey`, `ctx.messageChannel` |
| `message_sending` | `event.to`, `event.content`, `event.text` | `ctx.conversationId` |
| `before_prompt_build` | (none) | `ctx.sessionKey`, `ctx.senderId`, `ctx.requesterSenderId` |
| `after_tool_call` | `event.toolName`/`event.tool`, `event.result`/`event.details`, `event.error` | `ctx.sessionKey`, `ctx.conversationId`, `ctx.senderId`, `ctx.requesterSenderId` |

## Return Value Contracts

| Hook | Return shape | Effect |
|---|---|---|
| `message_sending` | `{ cancel: true }` | Suppresses LLM response |
| `message_sending` | `{ content: string }` | Replaces outbound text (used for redaction) |
| `before_prompt_build` | `{ prependContext: string }` | Prepends text to system prompt |

**Note:** Upstream v2026.3.7 added `prependSystemContext` and `appendSystemContext` for
cacheable system prompt injection. Migration to these is recommended for static context.

## Channel Sender Compatibility

The channel sender (`channel-sender.ts`) dynamically discovers channels from
`api.runtime.channel` at runtime. It uses the naming convention:

```
runtime.channel.<name>.sendMessage<PascalCase>
```

Known overrides for non-standard naming are maintained in `SEND_FN_OVERRIDES`.
When OpenClaw adds a new channel, it should work automatically if it follows the
naming convention. If not, add an override entry.

## OpenClaw Features We Do NOT Modify

These are upstream features we rely on working correctly but do not patch:

- Gateway HTTP server and webhook handling
- Channel adapters (Telegram, Discord, Slack, Signal, WhatsApp, iMessage, LINE, Matrix, Teams, etc.)
- Agent runtime and LLM provider routing
- Plugin loader and discovery (`openclaw.json` -> `plugins.load.paths`)
- Skills loader (`skills.load.extraDirs`)
- Session management and conversation persistence
- Pairing code authentication
- Model switching (`/model` command -- we add shortcuts but don't modify core)

## OpenClawnch-Only Additions (Not in Upstream)

### Tools (31)
See `extensions/crypto/index.ts` for the complete list.

### Commands (76)
See `extensions/crypto/index.ts` for the complete list.

### Services (26+)
See `extensions/crypto/src/services/` for the complete list.

## Version Compatibility Testing

When pulling a new OpenClaw release:

1. Run `pnpm test` (835+ tests across 26 files)
2. Run `pnpm typecheck` (must pass with zero errors)
3. Verify plugin loads: `node bin/openclawnch.mjs --help`
4. Check hook signatures haven't changed (search OpenClaw changelog for "plugin", "hook", "registerTool")
5. Verify `api.runtime.tools.getAll()` still returns the expected shape
6. Verify `api.runtime.channel` still follows `sendMessage<PascalCase>` convention
7. Test one write operation end-to-end (connect wallet -> swap)

## Changelog of Upstream Breaking Changes

| OpenClaw Version | Breaking Change | Our Fix | Date |
|---|---|---|---|
| v2026.3.7 | `prependSystemContext` / `appendSystemContext` added to `before_prompt_build` | No fix needed — `prependContext` still works. Migration planned. | 2026-03-07 |
| v2026.3.7 | `gateway.auth.mode` required when both token and password are set | N/A — we don't use dual auth. | 2026-03-07 |
| (none yet) | — | — | — |
