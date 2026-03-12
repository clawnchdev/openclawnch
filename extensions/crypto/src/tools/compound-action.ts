/**
 * Compound Action Tool — the user-facing entry point for multi-step operations.
 *
 * This is the tool the LLM calls to create, validate, schedule, and manage
 * compound operations. It sits on top of the plan engine (compiler, validator,
 * scheduler, executor) and exposes a clean action-based API.
 *
 * ─── Actions ────────────────────────────────────────────────────────────
 *
 *   create    — Compile an intent into a plan, validate it, return for review
 *   execute   — Run a validated plan immediately
 *   schedule  — Schedule a plan for future execution (time/condition/interval)
 *   list      — List all plans for the current user
 *   status    — Get status of a specific plan
 *   cancel    — Cancel a scheduled/running plan
 *   pause     — Pause a scheduled plan
 *   resume    — Resume a paused plan
 *   history   — Get execution history for a plan
 *
 * ─── Usage Flow ─────────────────────────────────────────────────────────
 *
 * 1. User says "when ETH hits $4000, sell half for USDC then bridge to Arbitrum"
 * 2. LLM calls compound_action with action="create" and an intent object
 * 3. Tool compiles → validates → returns the plan with any issues
 * 4. LLM reviews validation, presents plan to user
 * 5. User confirms → LLM calls compound_action with action="schedule" and the plan ID
 * 6. Scheduler watches the condition, fires when ETH >= $4000
 * 7. Executor runs the steps, reports results
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { PlanCompiler, type Intent, type IntentStep, type IntentTrigger } from '../services/plan-compiler.js';
import type { CompareOp, PlanNode, Trigger } from '../services/plan-types.js';
import { PlanValidator } from '../services/plan-validator.js';
import { getScheduler } from '../services/plan-scheduler.js';
import { formatExecutionSummary } from '../services/plan-executor.js';

// ─── Raw Input Types (from LLM tool args, snake_case) ──────────────────
// These type the raw JSON the LLM sends, before normalizeIntent() converts
// to camelCase. Having explicit types avoids 18+ `as any` casts.

interface RawCondition {
  token?: string;
  field?: string;
  op?: string;
  value?: number;
}

interface RawTrigger {
  type?: string;
  time?: string;
  interval?: string;
  max_runs?: number;
  maxRuns?: number;
  token?: string;
  op?: string;
  value?: number;
  logic?: string;
  conditions?: RawCondition[];
  expires?: string;
}

interface RawStep {
  action: string;
  token_in?: string;
  tokenIn?: string;
  token_out?: string;
  tokenOut?: string;
  amount?: string;
  amount_pct?: number;
  amountPct?: number;
  slippage_bps?: number;
  slippageBps?: number;
  chain_id?: number;
  chainId?: number;
  to?: string;
  token?: string;
  to_chain?: number;
  toChain?: number;
  from_chain?: number;
  fromChain?: number;
  order_type?: string;
  orderType?: string;
  trigger_price?: number;
  triggerPrice?: number;
  tool?: string;
  params?: Record<string, unknown>;
  condition?: RawCondition;
  confirm?: boolean;
  on_failure?: string;
  onFailure?: string;
  retry_count?: number;
  retryCount?: number;
  label?: string;
}

const ACTIONS = [
  'create', 'execute', 'schedule', 'list', 'status',
  'cancel', 'pause', 'resume', 'history',
] as const;

const CompoundActionSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'create: compile intent into plan + validate. ' +
      'execute: run a validated plan now. ' +
      'schedule: schedule for future trigger. ' +
      'list: all plans. ' +
      'status: plan details. ' +
      'cancel/pause/resume: manage scheduled plans. ' +
      'history: execution records.',
  }),

  // ── create action: the intent object
  intent: Type.Optional(Type.Object({
    name: Type.Optional(Type.String({ description: 'Human-readable plan name' })),
    natural_language: Type.String({ description: 'The original user request' }),
    trigger: Type.Optional(Type.Object({
      type: stringEnum(['immediate', 'at_time', 'every', 'when_condition']),
      time: Type.Optional(Type.String({ description: 'ISO 8601 time for at_time' })),
      interval: Type.Optional(Type.String({ description: 'e.g., "4h", "30m", "1d"' })),
      max_runs: Type.Optional(Type.Number({ description: 'Max runs for recurring' })),
      token: Type.Optional(Type.String({ description: 'Token for condition (e.g., ETH)' })),
      op: Type.Optional(stringEnum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq'])),
      value: Type.Optional(Type.Number({ description: 'Price/value threshold' })),
      logic: Type.Optional(stringEnum(['and', 'or'])),
      conditions: Type.Optional(Type.Array(Type.Object({
        token: Type.String(),
        op: stringEnum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
        value: Type.Number(),
      }))),
      expires: Type.Optional(Type.String({ description: 'Expiry for condition watch, e.g., "24h"' })),
    })),
    steps: Type.Array(Type.Object({
      action: stringEnum([
        'swap', 'transfer', 'bridge', 'check_price', 'check_balance',
        'set_order', 'approve', 'launch', 'claim', 'custom',
      ]),
      token_in: Type.Optional(Type.String()),
      token_out: Type.Optional(Type.String()),
      amount: Type.Optional(Type.String()),
      amount_pct: Type.Optional(Type.Number()),
      slippage_bps: Type.Optional(Type.Number()),
      chain_id: Type.Optional(Type.Number()),
      to: Type.Optional(Type.String()),
      token: Type.Optional(Type.String()),
      to_chain: Type.Optional(Type.Number()),
      from_chain: Type.Optional(Type.Number()),
      order_type: Type.Optional(Type.String()),
      trigger_price: Type.Optional(Type.Number()),
      tool: Type.Optional(Type.String()),
      params: Type.Optional(Type.Object({})),
      condition: Type.Optional(Type.Object({
        token: Type.Optional(Type.String()),
        field: Type.Optional(stringEnum(['price', 'balance', 'gas_price'])),
        op: stringEnum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
        value: Type.Number(),
      })),
      confirm: Type.Optional(Type.Boolean()),
      on_failure: Type.Optional(stringEnum(['abort', 'skip', 'retry'])),
      retry_count: Type.Optional(Type.Number()),
      label: Type.Optional(Type.String()),
    })),
    tags: Type.Optional(Type.Array(Type.String())),
  })),

  // ── plan_id for status/cancel/pause/resume/execute/schedule/history
  plan_id: Type.Optional(Type.String({ description: 'Plan ID for status/cancel/execute/etc.' })),
});

export function createCompoundActionTool() {
  return {
    name: 'compound_action',
    label: 'Compound Action',
    ownerOnly: true,
    description:
      'Create and manage multi-step DeFi operations with scheduling, conditions, and sequencing. ' +
      'Use this tool when the user wants to chain multiple operations together, schedule future actions, ' +
      'or set up conditional triggers (e.g., "when ETH hits $4000, sell half and bridge to Arbitrum"). ' +
      'Actions: create (compile intent), execute (run now), schedule (future trigger), list, status, ' +
      'cancel, pause, resume, history.',
    parameters: CompoundActionSchema,

    async execute(_toolCallId: string, rawArgs: unknown) {
      const args = rawArgs as Record<string, unknown>;
      const action = readStringParam(args, 'action', { required: true })!;

      try {
        switch (action) {
          case 'create':   return handleCreate(args);
          case 'execute':  return handleExecute(args);
          case 'schedule': return handleSchedule(args);
          case 'list':     return handleList(args);
          case 'status':   return handleStatus(args);
          case 'cancel':   return handleCancel(args);
          case 'pause':    return handlePause(args);
          case 'resume':   return handleResume(args);
          case 'history':  return handleHistory(args);
          default:
            return errorResult(`Unknown action: "${action}". Use: ${ACTIONS.join(', ')}`);
        }
      } catch (err: any) {
        return errorResult(err.message ?? String(err));
      }
    },
  };
}

// ─── Action Handlers ────────────────────────────────────────────────────

function handleCreate(args: Record<string, unknown>) {
  const intentRaw = args.intent as Record<string, unknown> | undefined;
  if (!intentRaw) return errorResult('Missing "intent" for create action.');

  const intent = normalizeIntent(intentRaw);
  const compiler = new PlanCompiler();

  // Security: never accept userId from tool args (LLM-controlled).
  // Use 'owner' as the default — in single-agent mode there is only one owner.
  // TODO: When multi-user support is added, inject userId from execution context (ctx.senderId).
  const userId = 'owner';
  const plan = compiler.compile(intent, userId);

  // Validate
  const validator = new PlanValidator();
  const validation = validator.validate(plan);
  plan.validation = validation;
  plan.status = validation.valid ? 'validated' : 'draft';

  // Persist the plan (even if invalid — user might fix and retry)
  const scheduler = getScheduler();
  scheduler.addPlan(plan);

  return jsonResult({
    plan_id: plan.id,
    name: plan.name,
    status: plan.status,
    validation: {
      valid: validation.valid,
      errors: validation.issues.filter(i => i.severity === 'error').map(i => i.message),
      warnings: validation.issues.filter(i => i.severity === 'warning').map(i => i.message),
      info: validation.issues.filter(i => i.severity === 'info').map(i => i.message),
      estimated_gas_eth: validation.estimatedGasEth,
      estimated_duration_s: validation.estimatedDurationMs ? Math.round(validation.estimatedDurationMs / 1000) : undefined,
      tools_used: validation.toolsUsed,
      chains_used: validation.chainsUsed,
    },
    trigger: plan.trigger ? describeTrigger(plan.trigger) : 'immediate',
    steps: describeSteps(plan.root),
    natural_language: plan.naturalLanguage,
  });
}

function handleExecute(args: Record<string, unknown>) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for execute action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  if (plan.status === 'cancelled') return errorResult('This plan was cancelled.');
  if (plan.status === 'running') return errorResult('This plan is already running.');
  if (plan.status === 'completed') return errorResult('This plan already completed.');

  // For immediate execution, we update the trigger and add to scheduler
  plan.trigger = { type: 'immediate' };
  plan.status = 'scheduled';
  scheduler.addPlan(plan);

  return jsonResult({
    plan_id: plan.id,
    status: 'scheduled',
    message: 'Plan queued for immediate execution. The scheduler will fire it on the next tick.',
    note: 'You will receive updates as each step completes.',
  });
}

function handleSchedule(args: Record<string, unknown>) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for schedule action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  if (plan.status === 'cancelled') return errorResult('This plan was cancelled.');
  if (!plan.trigger || plan.trigger.type === 'immediate') {
    return errorResult('This plan has no scheduled trigger. Use action="execute" to run immediately, or create a new plan with a trigger.');
  }

  if (plan.validation && !plan.validation.valid) {
    return errorResult(
      'This plan has validation errors that must be fixed first:\n' +
      plan.validation.issues.filter(i => i.severity === 'error').map(i => `- ${i.message}`).join('\n'),
    );
  }

  plan.status = 'scheduled';
  scheduler.addPlan(plan);

  return jsonResult({
    plan_id: plan.id,
    status: 'scheduled',
    trigger: describeTrigger(plan.trigger),
    message: 'Plan is now scheduled. The scheduler is watching for the trigger condition.',
  });
}

function handleList(_args: Record<string, unknown>) {
  const scheduler = getScheduler();
  const plans = scheduler.listPlans();

  if (plans.length === 0) {
    return jsonResult({ plans: [], message: 'No plans found. Use action="create" to create one.' });
  }

  return jsonResult({
    total: plans.length,
    plans: plans.map(p => ({
      plan_id: p.id,
      name: p.name,
      status: p.status,
      trigger: p.trigger ? describeTrigger(p.trigger) : 'immediate',
      created: new Date(p.createdAt).toISOString(),
      tags: p.tags,
    })),
  });
}

function handleStatus(args: Record<string, unknown>) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for status action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  const executions = scheduler.getExecutions(planId);

  return jsonResult({
    plan_id: plan.id,
    name: plan.name,
    status: plan.status,
    trigger: plan.trigger ? describeTrigger(plan.trigger) : 'immediate',
    validation: plan.validation ? {
      valid: plan.validation.valid,
      error_count: plan.validation.issues.filter(i => i.severity === 'error').length,
      warning_count: plan.validation.issues.filter(i => i.severity === 'warning').length,
    } : undefined,
    steps: describeSteps(plan.root),
    executions: executions.map(e => ({
      execution_id: e.executionId,
      status: e.status,
      started: new Date(e.startedAt).toISOString(),
      completed: e.completedAt ? new Date(e.completedAt).toISOString() : undefined,
      step_count: e.steps.length,
      failed_steps: e.steps.filter(s => s.status === 'failed').map(s => s.nodeId),
    })),
    natural_language: plan.naturalLanguage,
    created: new Date(plan.createdAt).toISOString(),
  });
}

function handleCancel(args: Record<string, unknown>) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for cancel action.');

  const scheduler = getScheduler();
  const success = scheduler.cancelPlan(planId);
  if (!success) return errorResult(`Plan "${planId}" not found or already completed.`);

  return jsonResult({ plan_id: planId, status: 'cancelled', message: 'Plan cancelled.' });
}

function handlePause(args: Record<string, unknown>) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for pause action.');

  const scheduler = getScheduler();
  const success = scheduler.pausePlan(planId);
  if (!success) return errorResult(`Plan "${planId}" not found or not in scheduled state.`);

  return jsonResult({ plan_id: planId, status: 'paused', message: 'Plan paused. Use resume to continue.' });
}

function handleResume(args: Record<string, unknown>) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for resume action.');

  const scheduler = getScheduler();
  const success = scheduler.resumePlan(planId);
  if (!success) return errorResult(`Plan "${planId}" not found or not paused.`);

  return jsonResult({ plan_id: planId, status: 'scheduled', message: 'Plan resumed.' });
}

function handleHistory(args: Record<string, unknown>) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for history action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  const executions = scheduler.getExecutions(planId);
  if (executions.length === 0) {
    return jsonResult({ plan_id: planId, executions: [], message: 'No executions yet.' });
  }

  return jsonResult({
    plan_id: planId,
    name: plan.name,
    executions: executions.map(e => ({
      execution_id: e.executionId,
      status: e.status,
      started: new Date(e.startedAt).toISOString(),
      completed: e.completedAt ? new Date(e.completedAt).toISOString() : undefined,
      duration_s: e.completedAt ? Math.round((e.completedAt - e.startedAt) / 1000) : undefined,
      steps: e.steps.map(s => ({
        node_id: s.nodeId,
        status: s.status,
        error: s.error,
        retries: s.retryCount,
      })),
    })),
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Normalize the intent from snake_case params to camelCase for the compiler.
 */
function normalizeIntent(raw: Record<string, unknown>): Intent {
  const rawSteps = (raw.steps ?? []) as RawStep[];
  const steps: IntentStep[] = rawSteps.map((s) => ({
    action: s.action as IntentStep['action'],
    tokenIn: s.token_in ?? s.tokenIn,
    tokenOut: s.token_out ?? s.tokenOut,
    amount: s.amount,
    amountPct: s.amount_pct ?? s.amountPct,
    slippageBps: s.slippage_bps ?? s.slippageBps,
    chainId: s.chain_id ?? s.chainId,
    to: s.to,
    token: s.token,
    toChain: s.to_chain ?? s.toChain,
    fromChain: s.from_chain ?? s.fromChain,
    orderType: s.order_type ?? s.orderType,
    triggerPrice: s.trigger_price ?? s.triggerPrice,
    tool: s.tool,
    params: s.params,
    condition: s.condition ? {
      token: s.condition.token,
      field: s.condition.field as IntentStep['condition'] extends { field?: infer F } ? F : never,
      op: s.condition.op as CompareOp,
      value: s.condition.value as number,
    } : undefined,
    confirm: s.confirm,
    onFailure: (s.on_failure ?? s.onFailure) as IntentStep['onFailure'],
    retryCount: s.retry_count ?? s.retryCount,
    label: s.label,
  }));

  const rawTrigger = raw.trigger as RawTrigger | undefined;
  const trigger: IntentTrigger | undefined = rawTrigger ? {
    type: rawTrigger.type as IntentTrigger['type'],
    time: rawTrigger.time,
    interval: rawTrigger.interval,
    maxRuns: rawTrigger.max_runs ?? rawTrigger.maxRuns,
    token: rawTrigger.token,
    op: rawTrigger.op as IntentTrigger['op'],
    value: rawTrigger.value,
    logic: rawTrigger.logic as IntentTrigger['logic'],
    conditions: rawTrigger.conditions as IntentTrigger['conditions'],
    expires: rawTrigger.expires,
  } : undefined;

  return {
    name: raw.name as string | undefined,
    naturalLanguage: ((raw.natural_language ?? raw.naturalLanguage ?? '') as string),
    trigger,
    steps,
    tags: raw.tags as string[] | undefined,
  };
}

function describeTrigger(t: Trigger): string {
  switch (t.type) {
    case 'immediate': return 'Run immediately';
    case 'time': return `At ${t.at}`;
    case 'interval': {
      const interval = formatMs(t.everyMs);
      const runs = t.maxRuns ? ` (max ${t.maxRuns} runs)` : '';
      return `Every ${interval}${runs}`;
    }
    case 'condition': return `When condition met (polling every ${formatMs(t.pollIntervalMs ?? 60_000)})`;
  }
}

function describeSteps(node: PlanNode, depth = 0): Array<{ id: string; type: string; label: string; tool?: string; depth: number }> {
  const indent = depth;
  const result: Array<{ id: string; type: string; label: string; tool?: string; depth: number }> = [];

  result.push({
    id: node.id,
    type: node.type,
    label: node.label,
    tool: node.type === 'action' ? (node as any).tool : undefined,
    depth: indent,
  });

  if (node.type === 'sequence' || node.type === 'parallel') {
    for (const s of (node as any).steps) {
      result.push(...describeSteps(s, depth + 1));
    }
  } else if (node.type === 'if') {
    result.push(...describeSteps((node as any).then, depth + 1));
    if ((node as any).else) {
      result.push({ id: `${node.id}_else`, type: 'else', label: 'Else', depth: indent + 1 });
      result.push(...describeSteps((node as any).else, depth + 2));
    }
  } else if (node.type === 'loop') {
    result.push(...describeSteps((node as any).body, depth + 1));
  }

  return result;
}

function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${(ms / 86_400_000).toFixed(1)}d`;
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(0)}s`;
}
