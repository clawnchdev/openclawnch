/**
 * Plan Scheduler — persistent job store with timer loop and condition polling.
 *
 * Responsibilities:
 * 1. Persist plans to disk (Fly volume) so they survive restarts.
 * 2. Run a tick loop that checks time-based and condition-based triggers.
 * 3. When a trigger fires, emit an event — the executor (LLM) handles execution.
 * 4. Track execution state per plan.
 *
 * The scheduler NEVER executes tools directly. It checks conditions and fires events.
 * This keeps money-touching logic in the executor where the LLM can reason about it.
 *
 * ─── Persistence Format ─────────────────────────────────────────────────
 *
 * Plans are stored as individual JSON files in the state directory:
 *   /workspace/.openclaw-state/plans/{planId}.json
 *   /workspace/.openclaw-state/plans/executions/{planId}/{executionId}.json
 *
 * On startup, the scheduler reads all plan files and rebuilds its in-memory state.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Plan,
  PlanStore,
  PlanExecution,
  Trigger,
  Condition,
  CompareCondition,
  ValueRef,
  RuntimeFn,
  PlanStatus,
} from './plan-types.js';

// ─── Event Types ────────────────────────────────────────────────────────

export type SchedulerEvent =
  | { type: 'trigger_fired'; plan: Plan; executionId: string }
  | { type: 'plan_expired'; plan: Plan; reason: string }
  | { type: 'condition_check_error'; planId: string; error: string };

export type SchedulerEventHandler = (event: SchedulerEvent) => void | Promise<void>;

// ─── Runtime Value Resolver ─────────────────────────────────────────────
// Pluggable: the scheduler doesn't know how to fetch prices or balances.
// The plugin wires this up with real service calls.

export interface RuntimeResolver {
  price(token: string): Promise<number>;
  balance(token: string, chainId?: number): Promise<number>;
  gasPrice(chainId?: number): Promise<number>;
  timestamp(): number;
  blockNumber(chainId?: number): Promise<number>;
}

/** Default no-op resolver for testing. */
export const NULL_RESOLVER: RuntimeResolver = {
  price: async () => 0,
  balance: async () => 0,
  gasPrice: async () => 0,
  timestamp: () => Math.floor(Date.now() / 1000),
  blockNumber: async () => 0,
};

// ─── File-based Plan Store ──────────────────────────────────────────────

function getPlansDir(): string {
  const base = process.env.OPENCLAWNCH_TX_DIR
    ? join(process.env.OPENCLAWNCH_TX_DIR, '..', 'plans')
    : join(process.env.HOME ?? '/tmp', '.openclawnch', 'plans');
  return base;
}

function getExecutionsDir(planId: string): string {
  return join(getPlansDir(), 'executions', sanitizeId(planId));
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
}

export class FilePlanStore implements PlanStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? getPlansDir();
    this.ensureDir(this.dir);
  }

  save(plan: Plan): void {
    this.ensureDir(this.dir);
    const path = join(this.dir, `${sanitizeId(plan.id)}.json`);
    writeFileSync(path, JSON.stringify(plan, null, 2), 'utf8');
  }

  load(planId: string): Plan | null {
    const path = join(this.dir, `${sanitizeId(planId)}.json`);
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8')) as Plan;
    } catch {
      return null;
    }
  }

  loadAll(userId?: string): Plan[] {
    try {
      if (!existsSync(this.dir)) return [];
      const files = readdirSync(this.dir).filter(f => f.endsWith('.json'));
      const plans: Plan[] = [];
      for (const f of files) {
        try {
          const plan = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Plan;
          if (!userId || plan.userId === userId) {
            plans.push(plan);
          }
        } catch { /* skip corrupt files */ }
      }
      return plans;
    } catch {
      return [];
    }
  }

  delete(planId: string): boolean {
    const path = join(this.dir, `${sanitizeId(planId)}.json`);
    try {
      if (existsSync(path)) {
        rmSync(path);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  saveExecution(exec: PlanExecution): void {
    const dir = getExecutionsDir(exec.planId);
    this.ensureDir(dir);
    const path = join(dir, `${sanitizeId(exec.executionId)}.json`);
    writeFileSync(path, JSON.stringify(exec, null, 2), 'utf8');
  }

  loadExecutions(planId: string): PlanExecution[] {
    const dir = getExecutionsDir(planId);
    try {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            return JSON.parse(readFileSync(join(dir, f), 'utf8')) as PlanExecution;
          } catch { return null; }
        })
        .filter((e): e is PlanExecution => e !== null);
    } catch {
      return [];
    }
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// ─── Scheduler ──────────────────────────────────────────────────────────

export class PlanScheduler {
  private store: PlanStore;
  private resolver: RuntimeResolver;
  private handlers: SchedulerEventHandler[] = [];
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private plans = new Map<string, Plan>();
  private lastConditionCheck = new Map<string, number>(); // planId → last check time
  private intervalRunCounts = new Map<string, number>();   // planId → executions so far
  private tickMs: number;
  private running = false;

  constructor(opts?: {
    store?: PlanStore;
    resolver?: RuntimeResolver;
    tickMs?: number;
  }) {
    this.store = opts?.store ?? new FilePlanStore();
    this.resolver = opts?.resolver ?? NULL_RESOLVER;
    this.tickMs = opts?.tickMs ?? 15_000; // Check every 15s
  }

  /** Register an event handler. Returns unsubscribe function. */
  on(handler: SchedulerEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  /** Load persisted plans and start the tick loop. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Restore from disk
    const persisted = this.store.loadAll();
    for (const plan of persisted) {
      if (plan.status === 'scheduled' || plan.status === 'running' || plan.status === 'paused') {
        this.plans.set(plan.id, plan);
      }
    }

    // Start tick loop
    this.tickInterval = setInterval(() => this.tick(), this.tickMs);
    // Run an immediate first tick
    this.tick();
  }

  /** Stop the tick loop. Plans remain persisted. */
  stop(): void {
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /** Add or update a plan. Persists immediately. */
  addPlan(plan: Plan): void {
    this.store.save(plan);
    if (plan.status === 'scheduled' || plan.status === 'running') {
      this.plans.set(plan.id, plan);
    }
  }

  /** Cancel a plan. */
  cancelPlan(planId: string): boolean {
    const plan = this.plans.get(planId) ?? this.store.load(planId);
    if (!plan) return false;
    plan.status = 'cancelled';
    this.store.save(plan);
    this.plans.delete(planId);
    this.lastConditionCheck.delete(planId);
    this.intervalRunCounts.delete(planId);
    return true;
  }

  /** Pause a plan (stops trigger checking, can be resumed). */
  pausePlan(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'scheduled') return false;
    plan.status = 'paused';
    this.store.save(plan);
    return true;
  }

  /** Resume a paused plan. */
  resumePlan(planId: string): boolean {
    const plan = this.plans.get(planId) ?? this.store.load(planId);
    if (!plan || plan.status !== 'paused') return false;
    plan.status = 'scheduled';
    this.store.save(plan);
    this.plans.set(plan.id, plan);
    return true;
  }

  /** Get a plan by ID. */
  getPlan(planId: string): Plan | null {
    return this.plans.get(planId) ?? this.store.load(planId);
  }

  /** List all plans for a user. */
  listPlans(userId?: string): Plan[] {
    return this.store.loadAll(userId);
  }

  /** Get execution history for a plan. */
  getExecutions(planId: string): PlanExecution[] {
    return this.store.loadExecutions(planId);
  }

  /** Mark a plan execution as complete (called by executor). */
  markCompleted(planId: string, execution: PlanExecution): void {
    const plan = this.plans.get(planId);
    if (!plan) return;

    this.store.saveExecution(execution);

    // For non-recurring triggers, mark plan as completed
    const trigger = plan.trigger;
    if (!trigger || trigger.type === 'immediate' || trigger.type === 'time') {
      plan.status = 'completed';
      this.store.save(plan);
      this.plans.delete(planId);
    } else if (trigger.type === 'condition' && !trigger.recurring) {
      plan.status = 'completed';
      this.store.save(plan);
      this.plans.delete(planId);
    }
    // Interval triggers and recurring conditions stay scheduled
  }

  /** Mark a plan execution as failed (called by executor). */
  markFailed(planId: string, execution: PlanExecution): void {
    const plan = this.plans.get(planId);
    if (!plan) return;

    this.store.saveExecution(execution);

    // Non-recurring plans go to failed status
    const trigger = plan.trigger;
    if (!trigger || trigger.type === 'immediate' || trigger.type === 'time') {
      plan.status = 'failed';
      this.store.save(plan);
      this.plans.delete(planId);
    }
    // Recurring plans stay scheduled (they'll retry on next trigger)
  }

  /** How many plans are actively being watched. */
  get activeCount(): number {
    return this.plans.size;
  }

  /** Is the scheduler running. */
  get isRunning(): boolean {
    return this.running;
  }

  // ─── Tick Loop ────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const now = Date.now();

    for (const [planId, plan] of this.plans) {
      if (plan.status === 'paused' || plan.status === 'running') continue;

      try {
        const shouldFire = await this.shouldTriggerFire(plan, now);
        if (shouldFire) {
          await this.fireTrigger(plan);
        }
      } catch (err: any) {
        this.emit({ type: 'condition_check_error', planId, error: err.message ?? String(err) });
      }
    }
  }

  private async shouldTriggerFire(plan: Plan, now: number): Promise<boolean> {
    const trigger = plan.trigger;
    if (!trigger || trigger.type === 'immediate') return true;

    switch (trigger.type) {
      case 'time': {
        const at = new Date(trigger.at).getTime();
        return !isNaN(at) && now >= at;
      }

      case 'interval': {
        const startAt = trigger.startAt ? new Date(trigger.startAt).getTime() : plan.createdAt;
        if (now < startAt) return false;

        const endAt = trigger.endAt ? new Date(trigger.endAt).getTime() : Infinity;
        if (now > endAt) {
          this.emit({ type: 'plan_expired', plan, reason: 'Past end time' });
          plan.status = 'completed';
          this.store.save(plan);
          this.plans.delete(plan.id);
          return false;
        }

        const runCount = this.intervalRunCounts.get(plan.id) ?? 0;
        if (trigger.maxRuns && runCount >= trigger.maxRuns) {
          this.emit({ type: 'plan_expired', plan, reason: `Reached ${trigger.maxRuns} executions` });
          plan.status = 'completed';
          this.store.save(plan);
          this.plans.delete(plan.id);
          return false;
        }

        // Check if enough time has passed since creation/last run
        const elapsed = now - startAt;
        const expectedRuns = Math.floor(elapsed / trigger.everyMs);
        return expectedRuns > runCount;
      }

      case 'condition': {
        // Respect poll interval
        const lastCheck = this.lastConditionCheck.get(plan.id) ?? 0;
        const pollMs = trigger.pollIntervalMs ?? 60_000;
        if (now - lastCheck < pollMs) return false;

        this.lastConditionCheck.set(plan.id, now);

        // Check expiry
        if (trigger.expiresAfterMs && now - plan.createdAt > trigger.expiresAfterMs) {
          this.emit({ type: 'plan_expired', plan, reason: 'Condition watch expired' });
          plan.status = 'completed';
          this.store.save(plan);
          this.plans.delete(plan.id);
          return false;
        }

        return await this.evaluateCondition(trigger.when);
      }
    }

    return false;
  }

  private async fireTrigger(plan: Plan): Promise<void> {
    const executionId = `exec_${plan.id}_${Date.now()}`;

    // Track interval runs
    const trigger = plan.trigger;
    if (trigger?.type === 'interval') {
      const count = (this.intervalRunCounts.get(plan.id) ?? 0) + 1;
      this.intervalRunCounts.set(plan.id, count);
    }

    // For one-shot triggers, mark as running so we don't fire again
    if (!trigger || trigger.type === 'immediate' || trigger.type === 'time') {
      plan.status = 'running';
      this.store.save(plan);
    }
    if (trigger?.type === 'condition' && !trigger.recurring) {
      plan.status = 'running';
      this.store.save(plan);
    }

    this.emit({ type: 'trigger_fired', plan, executionId });
  }

  // ─── Condition Evaluation ─────────────────────────────────────────────
  // Evaluates conditions using the runtime resolver. Used by both the scheduler
  // (for condition triggers) and the executor (for if/wait nodes).

  async evaluateCondition(cond: Condition): Promise<boolean> {
    if (cond.type === 'compare') {
      const left = await this.resolveValue(cond.left);
      const right = await this.resolveValue(cond.right);
      return this.compare(left, cond.op, right);
    } else if (cond.type === 'logic') {
      switch (cond.op) {
        case 'and': {
          for (const sub of cond.conditions) {
            if (!await this.evaluateCondition(sub)) return false;
          }
          return true;
        }
        case 'or': {
          for (const sub of cond.conditions) {
            if (await this.evaluateCondition(sub)) return true;
          }
          return false;
        }
        case 'not': {
          return !await this.evaluateCondition(cond.conditions[0]!);
        }
      }
    }
    return false;
  }

  async resolveValue(ref: ValueRef): Promise<number> {
    switch (ref.type) {
      case 'literal':
        return typeof ref.value === 'number' ? ref.value : parseFloat(String(ref.value)) || 0;
      case 'runtime':
        return this.resolveRuntimeFn(ref.fn, ref.args);
      case 'env': {
        const v = process.env[ref.key];
        return v ? parseFloat(v) || 0 : 0;
      }
      case 'step_output':
        // Step outputs are resolved by the executor, not the scheduler.
        // During trigger evaluation, step_output refs return 0.
        return 0;
    }
  }

  private async resolveRuntimeFn(fn: RuntimeFn, args: ValueRef[]): Promise<number> {
    const resolvedArgs = await Promise.all(args.map(a => this.resolveValue(a)));
    switch (fn) {
      case 'price':
        // First arg is a literal token symbol
        const token = args[0]?.type === 'literal' ? String(args[0].value) : 'ETH';
        return this.resolver.price(token);
      case 'balance':
        const balToken = args[0]?.type === 'literal' ? String(args[0].value) : 'ETH';
        const balChain = resolvedArgs[1] ?? undefined;
        return this.resolver.balance(balToken, balChain);
      case 'gas_price':
        return this.resolver.gasPrice(resolvedArgs[0] ?? undefined);
      case 'timestamp':
        return this.resolver.timestamp();
      case 'block_number':
        return this.resolver.blockNumber(resolvedArgs[0] ?? undefined);
    }
  }

  private compare(left: number, op: string, right: number): boolean {
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

  private emit(event: SchedulerEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch { /* don't let handler errors break the scheduler */ }
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _scheduler: PlanScheduler | null = null;

export function getScheduler(opts?: ConstructorParameters<typeof PlanScheduler>[0]): PlanScheduler {
  if (!_scheduler) {
    _scheduler = new PlanScheduler(opts);
  }
  return _scheduler;
}

export function resetScheduler(): void {
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
}
