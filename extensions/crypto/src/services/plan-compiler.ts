/**
 * Plan Compiler — transforms structured intent (from LLM) into Plan IR.
 *
 * The compiler does NOT do NLP. The LLM does the NLP (understanding "sell half my ETH
 * at $4000 then bridge to Arbitrum") and produces a structured intent object. The
 * compiler validates and transforms that intent into a fully-formed Plan IR.
 *
 * This exists because:
 * 1. The LLM shouldn't have to produce the full Plan IR with all its boilerplate.
 *    It should express intent, and the compiler fills in IDs, labels, defaults, etc.
 * 2. The compiler can catch common LLM mistakes (missing required fields, wrong tool
 *    names, impossible conditions) before the plan even reaches the validator.
 * 3. It provides a stable API surface — even if the Plan IR evolves, the intent format
 *    can stay backwards-compatible.
 *
 * ─── Intent Format ──────────────────────────────────────────────────────
 *
 * An Intent is a simplified representation of what the user wants. The LLM produces
 * this from natural language. Example:
 *
 *   User: "When ETH hits $4000, sell half my ETH for USDC, then bridge 500 USDC to Arbitrum"
 *
 *   Intent: {
 *     trigger: { type: 'condition', token: 'ETH', op: 'gte', value: 4000 },
 *     steps: [
 *       { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amountPct: 50 },
 *       { action: 'bridge', token: 'USDC', amount: '500', toChain: 42161 },
 *     ]
 *   }
 */

import type {
  Plan,
  PlanNode,
  ActionNode,
  SequenceNode,
  IfNode,
  WaitNode,
  LoopNode,
  Trigger,
  Condition,
  ValueRef,
  CompareOp,
} from './plan-types.js';

// ─── Intent Types ───────────────────────────────────────────────────────

export interface IntentTrigger {
  type: 'immediate' | 'at_time' | 'every' | 'when_condition';
  /** ISO 8601 time for 'at_time'. */
  time?: string;
  /** Interval string for 'every' (e.g., '4h', '30m', '1d'). */
  interval?: string;
  /** Max runs for recurring triggers. */
  maxRuns?: number;
  /** Condition fields for 'when_condition'. */
  token?: string;
  op?: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  value?: number;
  /** Compound condition: AND/OR multiple conditions. */
  logic?: 'and' | 'or';
  conditions?: IntentTrigger[];
  /** Expiry for condition watches (e.g., '24h', '7d'). */
  expires?: string;
}

export interface IntentStep {
  /** The action to perform. */
  action: 'swap' | 'transfer' | 'bridge' | 'check_price' | 'check_balance'
    | 'set_order' | 'approve' | 'launch' | 'claim' | 'custom';

  // ── Swap params
  tokenIn?: string;
  tokenOut?: string;
  amount?: string;
  amountPct?: number;        // "sell half" → 50
  slippageBps?: number;
  chainId?: number;

  // ── Transfer params
  to?: string;
  token?: string;

  // ── Bridge params
  toChain?: number;
  fromChain?: number;

  // ── Order params
  orderType?: string;        // 'limit_buy', 'stop_loss', etc.
  triggerPrice?: number;

  // ── Custom tool call
  tool?: string;
  params?: Record<string, unknown>;

  // ── Flow control
  /** If provided, makes this step conditional. */
  condition?: {
    token?: string;
    field?: 'price' | 'balance' | 'gas_price';
    op: CompareOp;
    value: number;
  };

  /** If true, require user confirmation before this step. */
  confirm?: boolean;

  /** Failure policy for this step. */
  onFailure?: 'abort' | 'skip' | 'retry';
  retryCount?: number;

  /** Label override. */
  label?: string;
}

export interface Intent {
  /** Human-readable name for the plan. */
  name?: string;
  /** The original natural language request. */
  naturalLanguage: string;
  /** When to start execution. */
  trigger?: IntentTrigger;
  /** Steps to execute (in order). */
  steps: IntentStep[];
  /** Tags for organization. */
  tags?: string[];
}

// ─── Compiler ───────────────────────────────────────────────────────────

export class PlanCompiler {
  private idCounter = 0;

  /**
   * Compile an intent into a Plan IR.
   * Throws CompilationError on invalid intents.
   */
  compile(intent: Intent, userId: string): Plan {
    this.idCounter = 0;

    if (!intent.steps || intent.steps.length === 0) {
      throw new CompilationError('Intent has no steps.');
    }

    const trigger = intent.trigger ? this.compileTrigger(intent.trigger) : undefined;
    const rootSteps = intent.steps.map(step => this.compileStep(step));

    // Wrap conditional steps in if-nodes
    const processedSteps = this.processConditionalSteps(rootSteps, intent.steps);

    const root: PlanNode = processedSteps.length === 1
      ? processedSteps[0]!
      : {
        id: this.nextId('seq'),
        label: 'Main sequence',
        type: 'sequence',
        steps: processedSteps,
      } as SequenceNode;

    const plan: Plan = {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: intent.name ?? this.inferName(intent),
      userId,
      createdAt: Date.now(),
      status: trigger ? 'draft' : 'draft',
      trigger,
      root,
      tags: intent.tags,
      naturalLanguage: intent.naturalLanguage,
    };

    return plan;
  }

  // ─── Trigger Compilation ────────────────────────────────────────────

  private compileTrigger(t: IntentTrigger): Trigger {
    switch (t.type) {
      case 'immediate':
        return { type: 'immediate' };

      case 'at_time': {
        if (!t.time) throw new CompilationError('at_time trigger requires a "time" field (ISO 8601).');
        const parsed = new Date(t.time);
        if (isNaN(parsed.getTime())) throw new CompilationError(`Invalid time: "${t.time}". Use ISO 8601 format.`);
        return { type: 'time', at: parsed.toISOString() };
      }

      case 'every': {
        if (!t.interval) throw new CompilationError('every trigger requires an "interval" field (e.g., "4h", "30m").');
        const ms = parseIntervalToMs(t.interval);
        if (ms < 30_000) throw new CompilationError('Interval must be at least 30 seconds.');
        return {
          type: 'interval',
          everyMs: ms,
          maxRuns: t.maxRuns,
        };
      }

      case 'when_condition': {
        // Simple condition
        if (t.token && t.op && t.value !== undefined) {
          return {
            type: 'condition',
            when: this.buildPriceCondition(t.token, t.op, t.value),
            pollIntervalMs: 60_000,
            expiresAfterMs: t.expires ? parseIntervalToMs(t.expires) : 7 * 24 * 60 * 60 * 1000, // 7d default
          };
        }

        // Compound condition
        if (t.logic && t.conditions && t.conditions.length > 0) {
          const subConditions = t.conditions.map(sub => {
            if (!sub.token || !sub.op || sub.value === undefined) {
              throw new CompilationError('Each sub-condition needs token, op, and value.');
            }
            return this.buildPriceCondition(sub.token, sub.op, sub.value);
          });
          return {
            type: 'condition',
            when: { type: 'logic', op: t.logic, conditions: subConditions },
            pollIntervalMs: 60_000,
            expiresAfterMs: t.expires ? parseIntervalToMs(t.expires) : 7 * 24 * 60 * 60 * 1000,
          };
        }

        throw new CompilationError('when_condition trigger needs (token + op + value) or (logic + conditions[]).');
      }
    }
  }

  private buildPriceCondition(token: string, op: CompareOp, value: number): Condition {
    return {
      type: 'compare',
      left: { type: 'runtime', fn: 'price', args: [{ type: 'literal', value: token }] },
      op,
      right: { type: 'literal', value },
      label: `${token} price ${opSymbol(op)} $${value}`,
    };
  }

  // ─── Step Compilation ───────────────────────────────────────────────

  private compileStep(step: IntentStep): ActionNode {
    const id = this.nextId(step.action);
    const failurePolicy = this.compileFailurePolicy(step);

    switch (step.action) {
      case 'swap':
        return {
          id,
          type: 'action',
          label: step.label ?? `Swap ${step.amountPct ? step.amountPct + '% ' : ''}${step.tokenIn ?? '?'} → ${step.tokenOut ?? '?'}`,
          tool: 'defi_swap',
          params: {
            action: 'execute',
            ...(step.tokenIn && { token_in: step.tokenIn }),
            ...(step.tokenOut && { token_out: step.tokenOut }),
            ...(step.amount && { amount: step.amount }),
            ...(step.amountPct !== undefined && { amount_pct: step.amountPct }),
            ...(step.slippageBps !== undefined && { slippage_bps: step.slippageBps }),
            ...(step.chainId !== undefined && { chain_id: step.chainId }),
          },
          requireConfirmation: step.confirm ?? true,
          onFailure: failurePolicy,
        };

      case 'transfer':
        return {
          id,
          type: 'action',
          label: step.label ?? `Transfer ${step.amount ?? '?'} ${step.token ?? 'ETH'} to ${step.to ? truncateAddr(step.to) : '?'}`,
          tool: 'transfer',
          params: {
            action: 'send',
            ...(step.token && { token: step.token }),
            ...(step.amount && { amount: step.amount }),
            ...(step.to && { to: step.to }),
          },
          requireConfirmation: step.confirm ?? true,
          onFailure: failurePolicy,
        };

      case 'bridge':
        return {
          id,
          type: 'action',
          label: step.label ?? `Bridge ${step.amount ?? '?'} ${step.token ?? '?'} to chain ${step.toChain ?? '?'}`,
          tool: 'bridge',
          params: {
            action: 'execute',
            ...(step.token && { token: step.token }),
            ...(step.amount && { amount: step.amount }),
            ...(step.toChain !== undefined && { to_chain_id: step.toChain }),
            ...(step.fromChain !== undefined && { from_chain_id: step.fromChain }),
          },
          requireConfirmation: step.confirm ?? true,
          onFailure: failurePolicy,
        };

      case 'check_price':
        return {
          id,
          type: 'action',
          label: step.label ?? `Check ${step.token ?? 'ETH'} price`,
          tool: 'defi_price',
          params: {
            action: 'lookup',
            ...(step.token && { token: step.token }),
          },
          requireConfirmation: false,
          onFailure: failurePolicy,
        };

      case 'check_balance':
        return {
          id,
          type: 'action',
          label: step.label ?? `Check ${step.token ?? 'all'} balance`,
          tool: 'defi_balance',
          params: {
            ...(step.token && { token: step.token }),
          },
          requireConfirmation: false,
          onFailure: failurePolicy,
        };

      case 'set_order':
        return {
          id,
          type: 'action',
          label: step.label ?? `Set ${step.orderType ?? 'limit'} order for ${step.token ?? step.tokenOut ?? '?'}`,
          tool: 'manage_orders',
          params: {
            action: 'create',
            ...(step.orderType && { order_type: step.orderType }),
            ...(step.token && { token: step.token }),
            ...(step.tokenIn && { token_in: step.tokenIn }),
            ...(step.tokenOut && { token_out: step.tokenOut }),
            ...(step.amount && { amount: step.amount }),
            ...(step.triggerPrice !== undefined && { trigger_price: step.triggerPrice }),
          },
          requireConfirmation: step.confirm ?? false,
          onFailure: failurePolicy,
        };

      case 'approve':
        return {
          id,
          type: 'action',
          label: step.label ?? `Approve ${step.token ?? '?'}`,
          tool: 'permit2',
          params: {
            action: 'approve',
            ...(step.token && { token: step.token }),
          },
          requireConfirmation: step.confirm ?? true,
          onFailure: failurePolicy,
        };

      case 'launch':
        return {
          id,
          type: 'action',
          label: step.label ?? 'Launch token',
          tool: 'clawnch_launch',
          params: (step.params ?? {}) as Record<string, string | number | boolean | ValueRef>,
          requireConfirmation: step.confirm ?? true,
          onFailure: failurePolicy,
        };

      case 'claim':
        return {
          id,
          type: 'action',
          label: step.label ?? 'Claim fees/rewards',
          tool: 'clawnch_fees',
          params: {
            action: 'claim',
            ...(step.token && { token: step.token }),
          },
          requireConfirmation: step.confirm ?? false,
          onFailure: failurePolicy,
        };

      case 'custom':
        if (!step.tool) throw new CompilationError('custom action requires a "tool" field.');
        return {
          id,
          type: 'action',
          label: step.label ?? `Run ${step.tool}`,
          tool: step.tool,
          params: (step.params ?? {}) as Record<string, string | number | boolean | ValueRef>,
          requireConfirmation: step.confirm ?? false,
          onFailure: failurePolicy,
        };

      default:
        throw new CompilationError(`Unknown action: "${step.action}".`);
    }
  }

  /**
   * Process steps that have inline conditions — wrap them in if-nodes.
   * E.g., step with condition "if USDC balance > 1000" becomes:
   *   IfNode { condition: balance(USDC) > 1000, then: actionNode }
   */
  private processConditionalSteps(actions: ActionNode[], intents: IntentStep[]): PlanNode[] {
    const result: PlanNode[] = [];

    for (let i = 0; i < actions.length; i++) {
      const step = intents[i]!;
      const action = actions[i]!;

      if (step.condition) {
        const cond = this.buildStepCondition(step.condition);
        const ifNode: IfNode = {
          id: this.nextId('if'),
          type: 'if',
          label: `If ${step.condition.field ?? 'price'}(${step.condition.token ?? '?'}) ${opSymbol(step.condition.op)} ${step.condition.value}`,
          condition: cond,
          then: action,
        };
        result.push(ifNode);
      } else {
        result.push(action);
      }
    }

    return result;
  }

  private buildStepCondition(c: NonNullable<IntentStep['condition']>): Condition {
    const field = c.field ?? 'price';
    const token = c.token ?? 'ETH';

    let fn: 'price' | 'balance' | 'gas_price';
    if (field === 'balance') fn = 'balance';
    else if (field === 'gas_price') fn = 'gas_price';
    else fn = 'price';

    return {
      type: 'compare',
      left: { type: 'runtime', fn, args: [{ type: 'literal', value: token }] },
      op: c.op,
      right: { type: 'literal', value: c.value },
      label: `${token} ${field} ${opSymbol(c.op)} ${c.value}`,
    };
  }

  private compileFailurePolicy(step: IntentStep) {
    if (!step.onFailure || step.onFailure === 'abort') return undefined; // default
    if (step.onFailure === 'skip') return { strategy: 'skip' as const };
    if (step.onFailure === 'retry') {
      return { strategy: 'retry' as const, maxAttempts: step.retryCount ?? 3, delayMs: 5_000 };
    }
    return undefined;
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private nextId(prefix: string): string {
    return `${prefix}_${++this.idCounter}`;
  }

  private inferName(intent: Intent): string {
    if (intent.steps.length === 1) {
      const step = intent.steps[0]!;
      return step.label ?? `${step.action} ${step.tokenIn ?? step.token ?? ''}`.trim();
    }
    const actions = intent.steps.map(s => s.action).join(' → ');
    const triggerDesc = intent.trigger?.type === 'at_time' ? ` at ${intent.trigger.time}`
      : intent.trigger?.type === 'when_condition' ? ` when ${intent.trigger.token ?? ''} ${opSymbol(intent.trigger.op ?? 'gte')} $${intent.trigger.value ?? '?'}`
      : '';
    return `${actions}${triggerDesc}`;
  }
}

// ─── Errors ─────────────────────────────────────────────────────────────

export class CompilationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompilationError';
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────

function opSymbol(op: string): string {
  switch (op) {
    case 'gt': return '>';
    case 'gte': return '>=';
    case 'lt': return '<';
    case 'lte': return '<=';
    case 'eq': return '=';
    case 'neq': return '!=';
    default: return op;
  }
}

function truncateAddr(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Parse human-readable intervals to milliseconds.
 * Supports: 30s, 5m, 4h, 1d, 2w
 */
export function parseIntervalToMs(input: string): number {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day|w|wk)s?$/i);
  if (!match) throw new CompilationError(`Invalid interval format: "${input}". Use e.g., "30s", "5m", "4h", "1d", "2w".`);

  const value = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1000, sec: 1000,
    m: 60_000, min: 60_000,
    h: 3_600_000, hr: 3_600_000,
    d: 86_400_000, day: 86_400_000,
    w: 604_800_000, wk: 604_800_000,
  };

  const ms = value * (multipliers[unit] ?? 1000);
  if (ms <= 0 || !isFinite(ms)) throw new CompilationError(`Invalid interval: "${input}".`);
  return Math.round(ms);
}
