/**
 * Plan Executor — walks a Plan IR tree and executes actions via tool dispatch.
 *
 * The executor is the bridge between the scheduler (which determines WHEN) and
 * the actual tool calls (which do the WORK). It:
 *
 * 1. Walks the node tree respecting sequence, parallel, if, wait, and loop semantics.
 * 2. Resolves ValueRefs (step outputs, runtime values, literals) at execution time.
 * 3. Dispatches action nodes to tool functions (provided via ToolDispatcher interface).
 * 4. Tracks per-step execution state for observability.
 * 5. Handles failure policies (abort, skip, retry).
 * 6. Supports cancellation mid-execution.
 *
 * The executor does NOT call tools directly — it receives a ToolDispatcher that the
 * plugin wires up to the real tool registry. This keeps the executor testable.
 *
 * ─── Rollback Awareness ─────────────────────────────────────────────────
 *
 * DeFi operations are NOT atomically rollbackable. A completed swap cannot be "undone"
 * — you'd have to do a reverse swap at whatever the current price is. The executor does
 * NOT attempt automatic rollback. Instead, it:
 *
 * - Stops on failure (abort policy) and reports exactly which step failed
 * - Records all completed steps so the user knows what already happened
 * - For skip policy, continues but logs the failure
 * - For retry policy, retries with delay before giving up
 *
 * The LLM reads the execution report and can suggest corrective actions.
 */

import type {
  Plan,
  PlanNode,
  ActionNode,
  SequenceNode,
  ParallelNode,
  IfNode,
  WaitNode,
  LoopNode,
  PlanExecution,
  StepExecution,
  StepStatus,
  ValueRef,
  Condition,
  CompareOp,
  FailurePolicy,
} from './plan-types.js';
import type { PlanScheduler } from './plan-scheduler.js';

// ─── Tool Dispatcher Interface ──────────────────────────────────────────
// The executor doesn't know about specific tools. It dispatches via this interface.

export interface ToolDispatcher {
  /**
   * Call a tool by name with the given params.
   * Returns the tool result (the `details` field from jsonResult/errorResult).
   * Throws on tool-level errors.
   * @param userId — passed through so tools can enforce per-user gates (readonly, evolution).
   */
  call(toolName: string, params: Record<string, unknown>, userId?: string): Promise<unknown>;

  /**
   * Check if a tool exists.
   */
  exists(toolName: string): boolean;
}

// ─── Confirmation Callback ──────────────────────────────────────────────
// For steps that require user confirmation before execution.

export type ConfirmationCallback = (
  step: ActionNode,
  resolvedParams: Record<string, unknown>,
  userId: string,
) => Promise<boolean>;

// ─── Execution Context ──────────────────────────────────────────────────

interface ExecutionContext {
  planId: string;
  executionId: string;
  /** The user who owns this plan — passed to tools for per-user gates. */
  userId: string;
  /** Results from completed steps, keyed by node ID. */
  stepResults: Map<string, unknown>;
  /** Execution records for each step. */
  steps: StepExecution[];
  /** Set to true to abort execution. */
  cancelled: boolean;
  /** Start time. */
  startedAt: number;
}

// ─── Executor ───────────────────────────────────────────────────────────

export class PlanExecutor {
  private dispatcher: ToolDispatcher;
  private scheduler: PlanScheduler;
  private confirmCallback?: ConfirmationCallback;
  private activeContexts = new Map<string, ExecutionContext>();

  constructor(opts: {
    dispatcher: ToolDispatcher;
    scheduler: PlanScheduler;
    onConfirmRequired?: ConfirmationCallback;
  }) {
    this.dispatcher = opts.dispatcher;
    this.scheduler = opts.scheduler;
    this.confirmCallback = opts.onConfirmRequired;
  }

  /**
   * Execute a plan. Returns the execution record.
   * For scheduled plans, this is called when the scheduler fires a trigger.
   */
  async execute(plan: Plan, executionId: string): Promise<PlanExecution> {
    const ctx: ExecutionContext = {
      planId: plan.id,
      executionId,
      userId: plan.userId,
      stepResults: new Map(),
      steps: [],
      cancelled: false,
      startedAt: Date.now(),
    };

    this.activeContexts.set(executionId, ctx);

    try {
      await this.executeNode(plan.root, ctx);

      const execution: PlanExecution = {
        planId: plan.id,
        executionId,
        status: ctx.cancelled ? 'cancelled' : 'completed',
        startedAt: ctx.startedAt,
        completedAt: Date.now(),
        steps: ctx.steps,
      };

      this.scheduler.markCompleted(plan.id, execution);
      return execution;

    } catch (err: any) {
      const isCancelled = ctx.cancelled || err instanceof ExecutionCancelledError;
      const execution: PlanExecution = {
        planId: plan.id,
        executionId,
        status: isCancelled ? 'cancelled' : 'failed',
        startedAt: ctx.startedAt,
        completedAt: Date.now(),
        steps: ctx.steps,
      };

      if (isCancelled) {
        this.scheduler.markCompleted(plan.id, execution);
      } else {
        this.scheduler.markFailed(plan.id, execution);
      }
      return execution;

    } finally {
      this.activeContexts.delete(executionId);
    }
  }

  /**
   * Cancel a running execution.
   */
  cancel(executionId: string): boolean {
    const ctx = this.activeContexts.get(executionId);
    if (!ctx) return false;
    ctx.cancelled = true;
    return true;
  }

  /**
   * Get the number of currently running executions.
   */
  get activeCount(): number {
    return this.activeContexts.size;
  }

  // ─── Node Execution ─────────────────────────────────────────────────

  private async executeNode(node: PlanNode, ctx: ExecutionContext): Promise<void> {
    if (ctx.cancelled) throw new ExecutionCancelledError();

    switch (node.type) {
      case 'action':    return this.executeAction(node, ctx);
      case 'sequence':  return this.executeSequence(node, ctx);
      case 'parallel':  return this.executeParallel(node, ctx);
      case 'if':        return this.executeIf(node, ctx);
      case 'wait':      return this.executeWait(node, ctx);
      case 'loop':      return this.executeLoop(node, ctx);
    }
  }

  // ─── Action ─────────────────────────────────────────────────────────

  private async executeAction(node: ActionNode, ctx: ExecutionContext): Promise<void> {
    const step: StepExecution = {
      nodeId: node.id,
      status: 'running',
      startedAt: Date.now(),
      retryCount: 0,
    };
    ctx.steps.push(step);

    // Resolve all parameter ValueRefs to concrete values
    const resolvedParams = await this.resolveParams(node.params, ctx);

    // Confirmation check
    if (node.requireConfirmation && this.confirmCallback) {
      const confirmed = await this.confirmCallback(node, resolvedParams, ctx.userId);
      if (!confirmed) {
        step.status = 'skipped';
        step.completedAt = Date.now();
        step.error = 'User declined confirmation';
        return;
      }
    }

    // Check tool exists
    if (!this.dispatcher.exists(node.tool)) {
      step.status = 'failed';
      step.completedAt = Date.now();
      step.error = `Tool "${node.tool}" not found`;
      await this.handleFailure(node, step, ctx);
      return;
    }

    // Execute with retry logic
    const policy = node.onFailure ?? { strategy: 'abort' as const };
    const maxAttempts = policy.strategy === 'retry' ? policy.maxAttempts : 1;
    const retryDelay = policy.strategy === 'retry' ? policy.delayMs : 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (ctx.cancelled) throw new ExecutionCancelledError();

      try {
        // Apply timeout if configured; pass userId for per-user gates (readonly, evolution)
        const result = node.timeoutMs
          ? await withTimeout(this.dispatcher.call(node.tool, resolvedParams, ctx.userId), node.timeoutMs)
          : await this.dispatcher.call(node.tool, resolvedParams, ctx.userId);

        // Success
        step.status = 'completed';
        step.completedAt = Date.now();
        step.result = result;
        step.retryCount = attempt;
        ctx.stepResults.set(node.id, result);
        return;

      } catch (err: any) {
        step.retryCount = attempt + 1;
        step.error = err.message ?? String(err);

        if (attempt < maxAttempts - 1) {
          // Wait before retry
          await sleep(retryDelay);
          continue;
        }

        // Final attempt failed
        step.status = 'failed';
        step.completedAt = Date.now();
        await this.handleFailure(node, step, ctx);
        return;
      }
    }
  }

  // ─── Sequence ───────────────────────────────────────────────────────

  private async executeSequence(node: SequenceNode, ctx: ExecutionContext): Promise<void> {
    for (const child of node.steps) {
      if (ctx.cancelled) throw new ExecutionCancelledError();
      await this.executeNode(child, ctx);
    }
  }

  // ─── Parallel ───────────────────────────────────────────────────────

  private async executeParallel(node: ParallelNode, ctx: ExecutionContext): Promise<void> {
    const results = await Promise.allSettled(
      node.steps.map(child => this.executeNode(child, ctx)),
    );

    if (!node.allowPartialFailure) {
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        const firstError = (failed[0] as PromiseRejectedResult).reason;
        throw firstError;
      }
    }
  }

  // ─── If ─────────────────────────────────────────────────────────────

  private async executeIf(node: IfNode, ctx: ExecutionContext): Promise<void> {
    const conditionMet = await this.evaluateCondition(node.condition, ctx);
    if (conditionMet) {
      await this.executeNode(node.then, ctx);
    } else if (node.else) {
      await this.executeNode(node.else, ctx);
    }
  }

  // ─── Wait ───────────────────────────────────────────────────────────

  private async executeWait(node: WaitNode, ctx: ExecutionContext): Promise<void> {
    const step: StepExecution = {
      nodeId: node.id,
      status: 'waiting',
      startedAt: Date.now(),
    };
    ctx.steps.push(step);

    try {
      // Fixed duration wait
      if (node.durationMs && !node.until && !node.untilTime) {
        await this.waitDuration(node.durationMs, ctx);
        step.status = 'completed';
        step.completedAt = Date.now();
        return;
      }

      // Wait until specific time
      if (node.untilTime && !node.until) {
        const target = new Date(node.untilTime).getTime();
        const remaining = target - Date.now();
        if (remaining > 0) {
          await this.waitDuration(remaining, ctx);
        }
        step.status = 'completed';
        step.completedAt = Date.now();
        return;
      }

      // Wait until condition
      if (node.until) {
        const pollMs = node.pollIntervalMs ?? 60_000;
        const maxWait = node.maxWaitMs ?? 86_400_000; // 24h default
        const deadline = Date.now() + maxWait;

        while (Date.now() < deadline) {
          if (ctx.cancelled) throw new ExecutionCancelledError();

          const met = await this.evaluateCondition(node.until, ctx);
          if (met) {
            step.status = 'completed';
            step.completedAt = Date.now();
            return;
          }

          await this.waitDuration(Math.min(pollMs, deadline - Date.now()), ctx);
        }

        // Timed out waiting
        step.status = 'failed';
        step.completedAt = Date.now();
        step.error = `Wait timed out after ${maxWait}ms`;
        await this.handleFailure(
          { ...node, type: 'wait' as const, id: node.id, label: node.label },
          step,
          ctx,
        );
      }
    } catch (err: any) {
      if (err instanceof ExecutionCancelledError) throw err;
      step.status = 'failed';
      step.completedAt = Date.now();
      step.error = err.message ?? String(err);
    }
  }

  // ─── Loop ───────────────────────────────────────────────────────────

  private async executeLoop(node: LoopNode, ctx: ExecutionContext): Promise<void> {
    for (let i = 0; i < node.maxIterations; i++) {
      if (ctx.cancelled) throw new ExecutionCancelledError();

      // Check exit condition
      if (node.exitWhen) {
        const shouldExit = await this.evaluateCondition(node.exitWhen, ctx);
        if (shouldExit) return;
      }

      await this.executeNode(node.body, ctx);

      // Delay between iterations
      if (node.delayMs && i < node.maxIterations - 1) {
        await this.waitDuration(node.delayMs, ctx);
      }
    }
  }

  // ─── Condition Evaluation ────────────────────────────────────────
  // The executor evaluates conditions using ctx.stepResults for step_output refs,
  // falling back to the scheduler's resolver for runtime refs (price, balance, etc.).
  // This fixes the bug where the scheduler's evaluateCondition returns 0 for step_output.

  private async evaluateCondition(cond: Condition, ctx: ExecutionContext): Promise<boolean> {
    if (cond.type === 'compare') {
      const left = await this.resolveConditionValue(cond.left, ctx);
      const right = await this.resolveConditionValue(cond.right, ctx);
      return this.compare(left, cond.op, right);
    } else if (cond.type === 'logic') {
      switch (cond.op) {
        case 'and': {
          for (const sub of cond.conditions) {
            if (!await this.evaluateCondition(sub, ctx)) return false;
          }
          return true;
        }
        case 'or': {
          for (const sub of cond.conditions) {
            if (await this.evaluateCondition(sub, ctx)) return true;
          }
          return false;
        }
        case 'not': {
          return !await this.evaluateCondition(cond.conditions[0]!, ctx);
        }
      }
    }
    return false;
  }

  private async resolveConditionValue(ref: ValueRef, ctx: ExecutionContext): Promise<number> {
    switch (ref.type) {
      case 'literal':
        return typeof ref.value === 'number' ? ref.value : parseFloat(String(ref.value)) || 0;
      case 'step_output': {
        // Resolve from executor's step results (the fix for the WaitNode bug)
        const result = ctx.stepResults.get(ref.stepId);
        if (result === undefined) return 0;
        const val = getNestedValue(result, ref.path);
        return typeof val === 'number' ? val : parseFloat(String(val)) || 0;
      }
      case 'env': {
        const v = process.env[ref.key];
        return v ? parseFloat(v) || 0 : 0;
      }
      case 'runtime':
        // Runtime refs need the scheduler's RuntimeResolver
        return this.scheduler.resolveValue(ref);
    }
  }

  private compare(left: number, op: CompareOp, right: number): boolean {
    switch (op) {
      case 'gt': return left > right;
      case 'gte': return left >= right;
      case 'lt': return left < right;
      case 'lte': return left <= right;
      case 'eq': return Math.abs(left - right) < Number.EPSILON;
      case 'neq': return Math.abs(left - right) >= Number.EPSILON;
      default: return false;
    }
  }

  // ─── Value Resolution ─────────────────────────────────────────────

  private async resolveParams(
    params: Record<string, ValueRef | string | number | boolean>,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(params)) {
      resolved[key] = await this.resolveValue(val, ctx);
    }

    return resolved;
  }

  private async resolveValue(
    ref: ValueRef | string | number | boolean,
    ctx: ExecutionContext,
  ): Promise<unknown> {
    // Literal shorthand (raw string, number, or boolean passed directly)
    if (typeof ref !== 'object' || ref === null) return ref;

    switch (ref.type) {
      case 'literal':
        return ref.value;

      case 'step_output': {
        const result = ctx.stepResults.get(ref.stepId);
        if (result === undefined) {
          throw new Error(`Step "${ref.stepId}" has no result yet (referenced by path "${ref.path}").`);
        }
        return getNestedValue(result, ref.path);
      }

      case 'env': {
        // Security: only allow reading env vars from an explicit allowlist.
        // Without this, an LLM-generated plan could exfiltrate secrets like
        // CLAWNCHER_PRIVATE_KEY by referencing them as env ValueRefs.
        const ALLOWED_ENV_KEYS = new Set([
          'NODE_ENV',
          'CLAWNCHER_NETWORK',
          'CLAWNCHER_API_URL',
          'CHAIN_ID',
          'DEFAULT_SLIPPAGE_BPS',
          'LOG_LEVEL',
        ]);
        if (!ALLOWED_ENV_KEYS.has(ref.key)) {
          throw new Error(`Plan env ref "${ref.key}" is not in the allowed env var list.`);
        }
        return process.env[ref.key] ?? undefined;
      }

      case 'runtime':
        return this.scheduler.resolveValue(ref);
    }
  }

  // ─── Failure Handling ─────────────────────────────────────────────

  private async handleFailure(node: PlanNode, step: StepExecution, ctx: ExecutionContext): Promise<void> {
    const policy: FailurePolicy = node.onFailure ?? { strategy: 'abort' };

    switch (policy.strategy) {
      case 'abort':
        throw new StepFailedError(node.id, step.error ?? 'Unknown error');

      case 'skip':
        step.status = 'skipped';
        // Continue execution — don't throw
        return;

      case 'retry':
        // Retry is handled in executeAction's loop — if we're here, all retries exhausted
        throw new StepFailedError(node.id, `All ${policy.maxAttempts} retry attempts exhausted: ${step.error}`);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /** Wait for a duration, checking for cancellation periodically. */
  private async waitDuration(ms: number, ctx: ExecutionContext): Promise<void> {
    const checkInterval = 1000; // Check cancellation every 1s
    let remaining = ms;

    while (remaining > 0) {
      if (ctx.cancelled) throw new ExecutionCancelledError();
      const wait = Math.min(remaining, checkInterval);
      await sleep(wait);
      remaining -= wait;
    }
  }
}

// ─── Errors ─────────────────────────────────────────────────────────────

export class ExecutionCancelledError extends Error {
  constructor() {
    super('Plan execution was cancelled');
    this.name = 'ExecutionCancelledError';
  }
}

export class StepFailedError extends Error {
  public readonly stepId: string;

  constructor(stepId: string, message: string) {
    super(`Step "${stepId}" failed: ${message}`);
    this.name = 'StepFailedError';
    this.stepId = stepId;
  }
}

// ─── Utility Functions ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Access a nested value by dot-path. E.g., "result.amountOut" on { result: { amountOut: 100 } }
 * returns 100.
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

// ─── Execution Summary Formatter ────────────────────────────────────────
// Produces a human-readable summary for Telegram output.

export function formatExecutionSummary(exec: PlanExecution, plan: Plan): string {
  const statusIcon: Record<string, string> = {
    completed: 'Done',
    failed: 'FAILED',
    cancelled: 'Cancelled',
    running: 'Running',
  };

  const lines: string[] = [
    `**Plan: ${plan.name}**`,
    `Status: ${statusIcon[exec.status] ?? exec.status}`,
    `Duration: ${((exec.completedAt ?? Date.now()) - exec.startedAt) / 1000}s`,
    '',
  ];

  for (const step of exec.steps) {
    const stepStatusIcon: Record<string, string> = {
      completed: '[OK]',
      failed: '[FAIL]',
      skipped: '[SKIP]',
      waiting: '[WAIT]',
      running: '[...]',
      pending: '[ ]',
    };

    const icon = stepStatusIcon[step.status] ?? '[ ]';
    const duration = step.startedAt && step.completedAt
      ? ` (${((step.completedAt - step.startedAt) / 1000).toFixed(1)}s)`
      : '';
    const error = step.error ? ` — ${step.error}` : '';
    const retries = step.retryCount && step.retryCount > 0 ? ` (${step.retryCount} retries)` : '';

    lines.push(`${icon} ${step.nodeId}${duration}${retries}${error}`);
  }

  return lines.join('\n');
}
