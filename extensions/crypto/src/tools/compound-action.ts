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
import { PlanCompiler, type Intent, type IntentStep, type IntentStepType, type IntentTrigger } from '../services/plan-compiler.js';
import type { CompareOp, Plan, PlanNode, PlanTemplate, Trigger } from '../services/plan-types.js';
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
  /** Step type: 'action' (default), 'parallel', 'wait', 'loop'. */
  type?: string;
  action?: string;
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
  // Step-output data flow
  output_ref?: string;
  outputRef?: string;
  input_refs?: Record<string, string>;
  inputRefs?: Record<string, string>;
  // Parallel/loop nested steps
  steps?: RawStep[];
  allow_partial_failure?: boolean;
  allowPartialFailure?: boolean;
  // Wait params
  duration?: string;
  until_time?: string;
  untilTime?: string;
  until?: RawCondition;
  max_wait?: string;
  maxWait?: string;
  poll_interval?: string;
  pollInterval?: string;
  // Loop params
  exit_when?: RawCondition;
  exitWhen?: RawCondition;
  max_iterations?: number;
  maxIterations?: number;
  delay_between?: string;
  delayBetween?: string;
}

const ACTIONS = [
  'create', 'execute', 'schedule', 'list', 'status',
  'cancel', 'pause', 'resume', 'history',
  'update', 'save_template', 'from_template', 'list_templates',
  'dead_letter',
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
      'history: execution records. ' +
      'update: modify a draft/paused plan. ' +
      'save_template: save plan as reusable template. ' +
      'from_template: create plan from template. ' +
      'list_templates: list saved templates. ' +
      'dead_letter: view/clear terminal failures (pass plan_id to filter, clear=true to purge).',
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
      type: Type.Optional(stringEnum(['action', 'parallel', 'wait', 'loop'], {
        description: 'Step type. Defaults to "action". Use "parallel" for concurrent steps, "wait" to pause, "loop" to repeat.',
      })),
      action: Type.Optional(stringEnum([
        'swap', 'transfer', 'bridge', 'check_price', 'check_balance',
        'set_order', 'approve', 'launch', 'claim', 'custom',
      ], { description: 'Action to perform (required when type is "action" or omitted).' })),
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
      // Step-output data flow
      output_ref: Type.Optional(Type.String({ description: 'Assign a ref name so downstream steps can use this step\'s output.' })),
      input_refs: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Map param names to "refName.path" (e.g., {"amount": "swap1.amountOut"}).' })),
      // Nested steps for parallel/loop
      steps: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), { description: 'Nested steps for parallel or loop types.' })),
      allow_partial_failure: Type.Optional(Type.Boolean({ description: 'For parallel: continue if some steps fail.' })),
      // Wait params
      duration: Type.Optional(Type.String({ description: 'Wait duration (e.g., "30s", "5m").' })),
      until_time: Type.Optional(Type.String({ description: 'Wait until ISO 8601 time.' })),
      until: Type.Optional(Type.Object({
        token: Type.Optional(Type.String()),
        field: Type.Optional(stringEnum(['price', 'balance', 'gas_price'])),
        op: stringEnum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
        value: Type.Number(),
      }, { description: 'Wait until condition is met.' })),
      max_wait: Type.Optional(Type.String({ description: 'Max wait time (e.g., "24h").' })),
      poll_interval: Type.Optional(Type.String({ description: 'Poll interval for condition waits (e.g., "1m").' })),
      // Loop params
      exit_when: Type.Optional(Type.Object({
        token: Type.Optional(Type.String()),
        field: Type.Optional(stringEnum(['price', 'balance', 'gas_price'])),
        op: stringEnum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
        value: Type.Number(),
      }, { description: 'Exit condition for loop.' })),
      max_iterations: Type.Optional(Type.Number({ description: 'Max loop iterations (default 10).' })),
      delay_between: Type.Optional(Type.String({ description: 'Delay between iterations (e.g., "5s").' })),
    })),
    tags: Type.Optional(Type.Array(Type.String())),
  })),

  // ── plan_id for status/cancel/pause/resume/execute/schedule/history/update/save_template
  plan_id: Type.Optional(Type.String({ description: 'Plan ID for status/cancel/execute/etc.' })),

  // ── template fields
  template_id: Type.Optional(Type.String({ description: 'Template ID for from_template.' })),
  template_name: Type.Optional(Type.String({ description: 'Name for saved template.' })),
  template_description: Type.Optional(Type.String({ description: 'Description for saved template.' })),
  template_params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'Parameters to substitute when instantiating from_template.',
  })),

  // ── update fields
  update_steps: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), {
    description: 'Replacement steps for update action.',
  })),
  update_trigger: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: 'Replacement trigger for update action.',
  })),
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
      'Actions: create, execute, schedule, list, status, cancel, pause, resume, history, ' +
      'update (modify draft/paused plan), save_template (save as reusable template), ' +
      'from_template (instantiate template), list_templates, dead_letter (view/clear terminal failures).',
    parameters: CompoundActionSchema,

    async execute(_toolCallId: string, rawArgs: unknown, ctx?: Record<string, unknown>) {
      const args = rawArgs as Record<string, unknown>;
      const action = readStringParam(args, 'action', { required: true })!;

      // Extract userId from execution context.
      // When called via PlanExecutor, ctx = { senderId: userId }.
      // When called directly by LLM (no ctx), fall back to 'owner'.
      const userId = (ctx?.senderId as string) ?? 'owner';

      try {
        switch (action) {
          case 'create':   return handleCreate(args, userId);
          case 'execute':  return handleExecute(args, userId);
          case 'schedule': return handleSchedule(args, userId);
          case 'list':     return handleList(args, userId);
          case 'status':   return handleStatus(args);
          case 'cancel':   return handleCancel(args, userId);
          case 'pause':    return handlePause(args, userId);
          case 'resume':   return handleResume(args, userId);
          case 'history':  return handleHistory(args);
          case 'update':   return handleUpdate(args, userId);
          case 'save_template':   return handleSaveTemplate(args, userId);
          case 'from_template':   return handleFromTemplate(args, userId);
          case 'list_templates':  return handleListTemplates(args, userId);
          case 'dead_letter':     return handleDeadLetter(args, userId);
          default:
            return errorResult(`Unknown action: "${action}". Use: ${ACTIONS.join(', ')}`);
        }
      } catch (err: any) {
        return errorResult(err.message ?? String(err));
      }
    },
  };
}

// ─── Ownership ──────────────────────────────────────────────────────────

/** Returns an error result if the user doesn't own the plan, or undefined if OK. */
function checkOwnership(plan: Plan, userId: string) {
  // In single-agent mode ('owner'), skip the check — backward compatible.
  if (userId === 'owner' || plan.userId === 'owner') return undefined;
  if (plan.userId !== userId) {
    return errorResult(`Access denied: plan "${plan.id}" belongs to a different user.`);
  }
  return undefined;
}

// ─── Action Handlers ────────────────────────────────────────────────────

function handleCreate(args: Record<string, unknown>, userId: string) {
  const intentRaw = args.intent as Record<string, unknown> | undefined;
  if (!intentRaw) return errorResult('Missing "intent" for create action.');

  const intent = normalizeIntent(intentRaw);
  const compiler = new PlanCompiler();

  // Security: userId comes from execution context (ctx.senderId), never from tool args.
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

function handleExecute(args: Record<string, unknown>, userId: string) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for execute action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  const ownerErr = checkOwnership(plan, userId);
  if (ownerErr) return ownerErr;

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

function handleSchedule(args: Record<string, unknown>, userId: string) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for schedule action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  const ownerErr = checkOwnership(plan, userId);
  if (ownerErr) return ownerErr;

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

function handleList(_args: Record<string, unknown>, userId: string) {
  const scheduler = getScheduler();
  // Filter plans to those owned by the requesting user (or show all for 'owner' in single-agent mode).
  const allPlans = scheduler.listPlans();
  const plans = userId === 'owner' ? allPlans : allPlans.filter(p => p.userId === userId || p.userId === 'owner');

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

function handleCancel(args: Record<string, unknown>, userId: string) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for cancel action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  const ownerErr = checkOwnership(plan, userId);
  if (ownerErr) return ownerErr;

  const success = scheduler.cancelPlan(planId);
  if (!success) return errorResult(`Plan "${planId}" not found or already completed.`);

  return jsonResult({ plan_id: planId, status: 'cancelled', message: 'Plan cancelled.' });
}

function handlePause(args: Record<string, unknown>, userId: string) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for pause action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  const ownerErr = checkOwnership(plan, userId);
  if (ownerErr) return ownerErr;

  const success = scheduler.pausePlan(planId);
  if (!success) return errorResult(`Plan "${planId}" not found or not in scheduled state.`);

  return jsonResult({ plan_id: planId, status: 'paused', message: 'Plan paused. Use resume to continue.' });
}

function handleResume(args: Record<string, unknown>, userId: string) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for resume action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  const ownerErr = checkOwnership(plan, userId);
  if (ownerErr) return ownerErr;

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

// ─── Update ─────────────────────────────────────────────────────────────

function handleUpdate(args: Record<string, unknown>, userId: string) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for update action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  const ownerErr = checkOwnership(plan, userId);
  if (ownerErr) return ownerErr;

  if (plan.status !== 'draft' && plan.status !== 'paused' && plan.status !== 'validated') {
    return errorResult(`Can only update plans in draft, validated, or paused state. Current: "${plan.status}".`);
  }

  const updateSteps = args.update_steps as Record<string, unknown>[] | undefined;
  const updateTrigger = args.update_trigger as Record<string, unknown> | undefined;
  const intentRaw = args.intent as Record<string, unknown> | undefined;

  if (!updateSteps && !updateTrigger && !intentRaw) {
    return errorResult('Provide "update_steps", "update_trigger", or a new "intent" to update.');
  }

  // If a full new intent is provided, recompile the entire plan
  if (intentRaw) {
    const intent = normalizeIntent(intentRaw);
    const compiler = new PlanCompiler();
    const newPlan = compiler.compile(intent, plan.userId);

    // Preserve plan identity
    plan.root = newPlan.root;
    plan.trigger = newPlan.trigger;
    plan.naturalLanguage = newPlan.naturalLanguage;
    plan.tags = newPlan.tags ?? plan.tags;
    plan.name = newPlan.name;
  } else {
    // Partial update: replace steps and/or trigger
    if (updateSteps) {
      const rawIntent = {
        naturalLanguage: plan.naturalLanguage ?? 'updated plan',
        steps: updateSteps as unknown as RawStep[],
        tags: plan.tags,
      };
      const intent = normalizeIntent(rawIntent as Record<string, unknown>);
      const compiler = new PlanCompiler();
      const tempPlan = compiler.compile(intent, plan.userId);
      plan.root = tempPlan.root;
    }
    if (updateTrigger) {
      const rawIntent = {
        naturalLanguage: plan.naturalLanguage ?? 'updated plan',
        steps: [{ action: 'check_price', token: 'ETH' }], // dummy step for trigger compilation
        trigger: updateTrigger,
      };
      const intent = normalizeIntent(rawIntent as Record<string, unknown>);
      const compiler = new PlanCompiler();
      const tempPlan = compiler.compile(intent, plan.userId);
      plan.trigger = tempPlan.trigger;
    }
  }

  // Re-validate
  const validator = new PlanValidator();
  const validation = validator.validate(plan);
  plan.validation = validation;
  plan.status = validation.valid ? 'validated' : 'draft';

  scheduler.addPlan(plan);

  return jsonResult({
    plan_id: plan.id,
    name: plan.name,
    status: plan.status,
    validation: {
      valid: validation.valid,
      errors: validation.issues.filter(i => i.severity === 'error').map(i => i.message),
      warnings: validation.issues.filter(i => i.severity === 'warning').map(i => i.message),
    },
    message: 'Plan updated and re-validated.',
  });
}

// ─── Templates ──────────────────────────────────────────────────────────

function handleSaveTemplate(args: Record<string, unknown>, userId: string) {
  const planId = readStringParam(args, 'plan_id');
  if (!planId) return errorResult('Missing "plan_id" for save_template action.');

  const scheduler = getScheduler();
  const plan = scheduler.getPlan(planId);
  if (!plan) return errorResult(`Plan "${planId}" not found.`);

  const ownerErr = checkOwnership(plan, userId);
  if (ownerErr) return ownerErr;

  const templateName = readStringParam(args, 'template_name') ?? plan.name;
  const templateDesc = readStringParam(args, 'template_description');

  const template: PlanTemplate = {
    id: `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: templateName,
    description: templateDesc ?? undefined,
    createdBy: userId,
    createdAt: Date.now(),
    tags: plan.tags,
    intent: {
      naturalLanguage: plan.naturalLanguage ?? templateName,
      steps: extractStepsFromRoot(plan.root),
      trigger: plan.trigger ? extractTriggerAsRaw(plan.trigger) : undefined,
      tags: plan.tags,
    },
    params: (args.template_params as Record<string, { description?: string; default?: string | number; required?: boolean }>) ?? undefined,
  };

  scheduler.saveTemplate(template);

  return jsonResult({
    template_id: template.id,
    name: template.name,
    description: template.description,
    message: 'Template saved. Use action="from_template" with this template_id to create new plans.',
  });
}

function handleFromTemplate(args: Record<string, unknown>, userId: string) {
  const templateId = readStringParam(args, 'template_id');
  if (!templateId) return errorResult('Missing "template_id" for from_template action.');

  const scheduler = getScheduler();
  const template = scheduler.loadTemplate(templateId);
  if (!template) return errorResult(`Template "${templateId}" not found.`);

  // Merge user-supplied params into the template intent
  const params = args.template_params as Record<string, unknown> | undefined;
  let intentRaw: Record<string, unknown> = { ...template.intent };

  if (params) {
    // Simple parameter substitution: replace $param references in step fields
    const stepsJson = JSON.stringify(template.intent.steps);
    let substituted = stepsJson;
    for (const [key, value] of Object.entries(params)) {
      substituted = substituted.replaceAll(`$${key}`, String(value));
    }
    intentRaw = {
      ...intentRaw,
      steps: JSON.parse(substituted),
      natural_language: template.intent.naturalLanguage,
    };
  }

  // Compile as a new plan
  const intent = normalizeIntent(intentRaw);
  const compiler = new PlanCompiler();
  const plan = compiler.compile(intent, userId);

  // Validate
  const validator = new PlanValidator();
  const validation = validator.validate(plan);
  plan.validation = validation;
  plan.status = validation.valid ? 'validated' : 'draft';
  plan.tags = [...(template.tags ?? []), `from:${template.id}`];

  scheduler.addPlan(plan);

  return jsonResult({
    plan_id: plan.id,
    name: plan.name,
    status: plan.status,
    from_template: template.id,
    validation: {
      valid: validation.valid,
      errors: validation.issues.filter(i => i.severity === 'error').map(i => i.message),
    },
    message: `Plan created from template "${template.name}".`,
  });
}

function handleListTemplates(_args: Record<string, unknown>, userId: string) {
  const scheduler = getScheduler();
  const templates = scheduler.listTemplates();

  if (templates.length === 0) {
    return jsonResult({ templates: [], message: 'No templates found. Use action="save_template" to save a plan as a template.' });
  }

  return jsonResult({
    total: templates.length,
    templates: templates.map(t => ({
      template_id: t.id,
      name: t.name,
      description: t.description,
      created_by: t.createdBy,
      created: new Date(t.createdAt).toISOString(),
      tags: t.tags,
      params: t.params ? Object.keys(t.params) : [],
    })),
  });
}

// ─── Dead-Letter Handler ─────────────────────────────────────────────────

function handleDeadLetter(args: Record<string, unknown>, _userId: string) {
  const scheduler = getScheduler();
  const planId = args.plan_id as string | undefined;
  const clear = args.clear === true || args.clear === 'true';

  if (clear) {
    const removed = scheduler.clearDeadLetters(planId);
    return jsonResult({
      cleared: removed,
      message: planId
        ? `Cleared ${removed} dead-letter entries for plan ${planId}.`
        : `Cleared ${removed} dead-letter entries.`,
    });
  }

  const entries = scheduler.loadDeadLetters(planId);

  if (entries.length === 0) {
    return jsonResult({
      entries: [],
      message: planId
        ? `No dead-letter entries for plan ${planId}.`
        : 'No dead-letter entries. All plans completed successfully or are still running.',
    });
  }

  return jsonResult({
    total: entries.length,
    entries: entries.map(e => ({
      plan_id: e.planId,
      node_id: e.nodeId,
      execution_id: e.executionId,
      user_id: e.userId,
      error: e.error,
      retry_count: e.retryCount,
      tool: e.tool,
      params: e.params,
      timestamp: new Date(e.timestamp).toISOString(),
    })),
  });
}

// ─── Template Extraction Helpers ────────────────────────────────────────

/** Extract raw step descriptions from a compiled plan root node. */
function extractStepsFromRoot(node: PlanNode): Record<string, unknown>[] {
  switch (node.type) {
    case 'action': {
      // Exclude 'action' from params to avoid overriding the step action name
      const { action: _discardAction, ...cleanParams } = node.params as Record<string, unknown>;
      return [{ action: inferAction(node.tool), tool: node.tool, ...cleanParams }];
    }
    case 'sequence':
      return node.steps.flatMap(extractStepsFromRoot);
    case 'parallel':
      return [{ type: 'parallel', steps: node.steps.flatMap(extractStepsFromRoot) }];
    case 'wait':
      return [{ type: 'wait', duration: node.durationMs ? `${Math.round(node.durationMs / 1000)}s` : undefined }];
    case 'loop':
      return [{ type: 'loop', steps: extractStepsFromRoot(node.body), max_iterations: node.maxIterations }];
    case 'if':
      return [...extractStepsFromRoot(node.then), ...(node.else ? extractStepsFromRoot(node.else) : [])];
    default:
      return [];
  }
}

/** Map tool names back to intent action names. */
function inferAction(tool: string): string {
  const map: Record<string, string> = {
    defi_swap: 'swap',
    transfer_token: 'transfer',
    bridge_assets: 'bridge',
    check_price: 'check_price',
    check_balance: 'check_balance',
    manage_orders: 'set_order',
    manage_approvals: 'approve',
    airdrop_tool: 'claim',
  };
  return map[tool] ?? 'custom';
}

/** Convert compiled Trigger back to raw format for template storage. */
function extractTriggerAsRaw(trigger: Trigger): Record<string, unknown> {
  switch (trigger.type) {
    case 'immediate':
      return { type: 'immediate' };
    case 'time':
      return { type: 'at_time', time: trigger.at };
    case 'interval':
      return {
        type: 'every',
        interval: `${Math.round(trigger.everyMs / 1000)}s`,
        max_runs: trigger.maxRuns,
      };
    case 'condition':
      return { type: 'when_condition' }; // Conditions are complex; simplified
    default:
      return { type: 'immediate' };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Normalize the intent from snake_case params to camelCase for the compiler.
 */
function normalizeStep(s: RawStep): IntentStep {
  const condition = s.condition ? {
    token: s.condition.token,
    field: s.condition.field as 'price' | 'balance' | 'gas_price' | undefined,
    op: s.condition.op as CompareOp,
    value: s.condition.value as number,
  } : undefined;

  const until = s.until ? {
    token: s.until.token,
    field: s.until.field as 'price' | 'balance' | 'gas_price' | undefined,
    op: s.until.op as CompareOp,
    value: s.until.value as number,
  } : undefined;

  const exitWhen = (s.exit_when ?? s.exitWhen) ? {
    token: (s.exit_when ?? s.exitWhen)!.token,
    field: (s.exit_when ?? s.exitWhen)!.field as 'price' | 'balance' | 'gas_price' | undefined,
    op: (s.exit_when ?? s.exitWhen)!.op as CompareOp,
    value: (s.exit_when ?? s.exitWhen)!.value as number,
  } : undefined;

  return {
    type: (s.type as IntentStep['type']) ?? undefined,
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
    condition,
    confirm: s.confirm,
    onFailure: (s.on_failure ?? s.onFailure) as IntentStep['onFailure'],
    retryCount: s.retry_count ?? s.retryCount,
    label: s.label,
    // Step-output data flow
    outputRef: s.output_ref ?? s.outputRef,
    inputRefs: s.input_refs ?? s.inputRefs,
    // Nested steps (recurse)
    steps: s.steps ? s.steps.map(normalizeStep) : undefined,
    allowPartialFailure: s.allow_partial_failure ?? s.allowPartialFailure,
    // Wait params
    duration: s.duration,
    untilTime: s.until_time ?? s.untilTime,
    until,
    maxWait: s.max_wait ?? s.maxWait,
    pollInterval: s.poll_interval ?? s.pollInterval,
    // Loop params
    exitWhen,
    maxIterations: s.max_iterations ?? s.maxIterations,
    delayBetween: s.delay_between ?? s.delayBetween,
  };
}

function normalizeIntent(raw: Record<string, unknown>): Intent {
  const rawSteps = (raw.steps ?? []) as RawStep[];
  const steps: IntentStep[] = rawSteps.map(normalizeStep);

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
    case 'cron': {
      const tz = t.timezone ? ` (${t.timezone})` : '';
      const runs = t.maxRuns ? ` (max ${t.maxRuns} runs)` : '';
      return `Cron: ${t.expression}${tz}${runs}`;
    }
    case 'price': {
      const recur = t.recurring ? ' (recurring)' : ' (once)';
      return `When ${t.token} ${t.condition} $${t.threshold}${recur}`;
    }
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
