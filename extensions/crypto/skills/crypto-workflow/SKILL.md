---
name: crypto-workflow
description: Multi-step crypto workflows that chain tools together with safety checks. Orchestrates swap, launch, order check, and portfolio operations into complete pipelines.
metadata: { "openclaw": { "emoji": "🔗" } }
---

# Crypto Workflow — Multi-Tool Pipelines

## When to Use

- User wants a complete swap workflow (audit + balance check + quote + execute + stop-loss)
- User wants to launch a token and prepare a promotional tweet
- User wants to check all conditional order triggers at once
- User wants a full portfolio snapshot

## When NOT to Use

- Simple single-tool operations (use the specific tool directly)
- Non-crypto tasks

## Tool: `crypto_workflow`

### Why Workflows Exist

LLMs can forget steps in a multi-tool sequence. Workflows guarantee all steps happen, in order, with safety checks. Each workflow runs pre-flight checks, prepares the core action, and queues follow-up steps.

### Workflows

#### `safe_swap` — Audited Token Swap

Complete pipeline: wallet check, price lookup, safety validation, swap instruction, optional stop-loss.

| Param | Required | Description |
|-------|----------|-------------|
| `token_in` | Yes | Token to sell (symbol or address) |
| `token_out` | Yes | Token to buy (symbol or address) |
| `amount` | Yes | Amount to sell |
| `slippage` | No | Slippage % (default: 1.0) |
| `stop_loss_pct` | No | Auto stop-loss % below entry price |

**Steps:**
1. Verify wallet connected
2. Look up prices for both tokens
3. Run safety checks (balance, token audit, honeypot detection)
4. Prepare swap instruction for `defi_swap`
5. If `stop_loss_pct` set: prepare `manage_orders` stop-loss instruction

**Output:** Returns `nextActions` array — execute them in order.

#### `launch_and_promote` — Token Launch + Tweet

Complete pipeline: wallet check, balance validation, launch instruction, tweet text generation, monitoring setup.

| Param | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Token name |
| `symbol` | Yes | Token symbol |
| `description` | No | Token description |
| `dev_buy_eth` | No | ETH amount for dev buy at launch |

**Steps:**
1. Verify wallet connected
2. Validate balance for gas + dev buy
3. Prepare `clawnch_launch` instruction
4. Generate promotional tweet text
5. Prepare `watch_activity` monitoring instruction

#### `check_orders` — Order Trigger Check

Returns instructions to call `manage_orders` with action `check`, which auto-fetches live prices from DexScreener and evaluates all active order triggers.

No parameters needed.

#### `portfolio_snapshot` — Full Portfolio View

Aggregates wallet state: ETH balance, recent transactions, spending policies.

No parameters needed. Requires a connected wallet.

**Steps:**
1. Get ETH balance + USD value
2. Fetch recent transaction history
3. Show active spending policies

**Tip:** For full ERC-20 balances, also call `defi_balance` with action `tokens`. For fee revenue, call `clawnch_fees` with action `check`.

### Execution Pattern

Workflows return a structured result with:
- `status`: "ready", "blocked", or "ok"
- `steps`: Array of step results (each with status + data)
- `nextActions`: Array of tool calls to execute in order
- `message`: Human-readable summary

The agent should execute each item in `nextActions` sequentially, reporting results to the user at each step.

### Important Notes

- Workflows don't execute trades directly — they prepare and validate, then return instructions
- If a safety check blocks, the workflow stops and explains why
- The `safe_swap` workflow is strongly recommended over calling `defi_swap` directly
- Always present the workflow's warnings to the user before proceeding
