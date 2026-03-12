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
  PlanTemplate,
  DeadLetterEntry,
  ExecutionCheckpoint,
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
  | { type: 'condition_check_error'; planId: string; error: string }
  | { type: 'plan_added'; plan: Plan }
  | { type: 'plan_cancelled'; planId: string };

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

/** Shape of the scheduler runtime state that survives restarts. */
interface SchedulerState {
  intervalRunCounts: Record<string, number>;
  lastConditionCheck: Record<string, number>;
  /** Cron: number of times each cron plan has fired. */
  cronRunCounts?: Record<string, number>;
  /** Cron: timestamp (floored to minute) of the last fire for each plan. */
  lastCronFire?: Record<string, number>;
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
      const files = readdirSync(this.dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
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

  /** Persist scheduler runtime state (interval counts, last check times). */
  saveState(state: SchedulerState): void {
    this.ensureDir(this.dir);
    const path = join(this.dir, '_scheduler-state.json');
    writeFileSync(path, JSON.stringify(state), 'utf8');
  }

  /** Restore scheduler runtime state. Returns null if no state file. */
  loadState(): SchedulerState | null {
    const path = join(this.dir, '_scheduler-state.json');
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8')) as SchedulerState;
    } catch {
      return null;
    }
  }

  // ── Template Storage ──────────────────────────────────────────────────

  private get templatesDir(): string {
    return join(this.dir, 'templates');
  }

  saveTemplate(template: PlanTemplate): void {
    this.ensureDir(this.templatesDir);
    const path = join(this.templatesDir, `${sanitizeId(template.id)}.json`);
    writeFileSync(path, JSON.stringify(template, null, 2), 'utf8');
  }

  loadTemplate(templateId: string): PlanTemplate | null {
    const path = join(this.templatesDir, `${sanitizeId(templateId)}.json`);
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8')) as PlanTemplate;
    } catch {
      return null;
    }
  }

  listTemplates(userId?: string): PlanTemplate[] {
    try {
      if (!existsSync(this.templatesDir)) return [];
      return readdirSync(this.templatesDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            return JSON.parse(readFileSync(join(this.templatesDir, f), 'utf8')) as PlanTemplate;
          } catch { return null; }
        })
        .filter((t): t is PlanTemplate => t !== null)
        .filter(t => !userId || t.createdBy === userId);
    } catch {
      return [];
    }
  }

  deleteTemplate(templateId: string): boolean {
    const path = join(this.templatesDir, `${sanitizeId(templateId)}.json`);
    try {
      if (existsSync(path)) {
        rmSync(path);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  // ── Dead-Letter Storage ────────────────────────────────────────────────

  private get deadLetterDir(): string {
    return join(this.dir, 'dead-letter');
  }

  saveDeadLetter(entry: DeadLetterEntry): void {
    this.ensureDir(this.deadLetterDir);
    const filename = `${sanitizeId(entry.planId)}_${sanitizeId(entry.nodeId)}_${entry.timestamp}.json`;
    const path = join(this.deadLetterDir, filename);
    writeFileSync(path, JSON.stringify(entry, null, 2), 'utf8');
  }

  loadDeadLetters(planId?: string): DeadLetterEntry[] {
    try {
      if (!existsSync(this.deadLetterDir)) return [];
      return readdirSync(this.deadLetterDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            return JSON.parse(readFileSync(join(this.deadLetterDir, f), 'utf8')) as DeadLetterEntry;
          } catch { return null; }
        })
        .filter((e): e is DeadLetterEntry => e !== null)
        .filter(e => !planId || e.planId === planId)
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  clearDeadLetters(planId?: string): number {
    try {
      if (!existsSync(this.deadLetterDir)) return 0;
      const files = readdirSync(this.deadLetterDir).filter(f => f.endsWith('.json'));
      let removed = 0;
      for (const f of files) {
        if (planId) {
          try {
            const entry = JSON.parse(readFileSync(join(this.deadLetterDir, f), 'utf8')) as DeadLetterEntry;
            if (entry.planId !== planId) continue;
          } catch { continue; }
        }
        try { rmSync(join(this.deadLetterDir, f)); removed++; } catch { /* ignore */ }
      }
      return removed;
    } catch {
      return 0;
    }
  }

  // ── Execution Checkpoint Storage ──────────────────────────────────────

  private get checkpointsDir(): string {
    return join(this.dir, 'checkpoints');
  }

  saveCheckpoint(cp: ExecutionCheckpoint): void {
    this.ensureDir(this.checkpointsDir);
    const path = join(this.checkpointsDir, `${sanitizeId(cp.executionId)}.json`);
    writeFileSync(path, JSON.stringify(cp, null, 2), 'utf8');
  }

  loadCheckpoint(executionId: string): ExecutionCheckpoint | null {
    const path = join(this.checkpointsDir, `${sanitizeId(executionId)}.json`);
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8')) as ExecutionCheckpoint;
    } catch {
      return null;
    }
  }

  loadAllCheckpoints(): ExecutionCheckpoint[] {
    try {
      if (!existsSync(this.checkpointsDir)) return [];
      return readdirSync(this.checkpointsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            return JSON.parse(readFileSync(join(this.checkpointsDir, f), 'utf8')) as ExecutionCheckpoint;
          } catch { return null; }
        })
        .filter((cp): cp is ExecutionCheckpoint => cp !== null);
    } catch {
      return [];
    }
  }

  deleteCheckpoint(executionId: string): boolean {
    const path = join(this.checkpointsDir, `${sanitizeId(executionId)}.json`);
    try {
      if (existsSync(path)) {
        rmSync(path);
        return true;
      }
    } catch { /* ignore */ }
    return false;
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
  private cronRunCounts = new Map<string, number>();       // planId → cron executions so far
  private lastCronFire = new Map<string, number>();        // planId → last fire timestamp (minute-floored)
  private tickMs: number;
  private running = false;
  private stateDirty = false;                             // debounce state persistence
  private stateFlushTimer: ReturnType<typeof setTimeout> | null = null;

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

    // Restore scheduler runtime state (interval counts, last check times)
    this.restoreState();

    // Start tick loop
    this.tickInterval = setInterval(() => this.tick(), this.tickMs);
    // Run an immediate first tick
    this.tick();
  }

  /** Stop the tick loop. Flush pending state. Plans remain persisted. */
  stop(): void {
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    // Flush any pending state writes
    this.flushState();
    if (this.stateFlushTimer) {
      clearTimeout(this.stateFlushTimer);
      this.stateFlushTimer = null;
    }
  }

  /** Add or update a plan. Persists immediately. */
  addPlan(plan: Plan): void {
    this.store.save(plan);
    if (plan.status === 'scheduled' || plan.status === 'running') {
      this.plans.set(plan.id, plan);
    }
    this.emit({ type: 'plan_added', plan }).catch(() => {});
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
    this.cronRunCounts.delete(planId);
    this.lastCronFire.delete(planId);
    this.persistState();
    this.emit({ type: 'plan_cancelled', planId }).catch(() => {});
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

  // ── Template Proxy Methods ────────────────────────────────────────────

  saveTemplate(template: PlanTemplate): void {
    if (typeof (this.store as FilePlanStore).saveTemplate === 'function') {
      (this.store as FilePlanStore).saveTemplate(template);
    }
  }

  loadTemplate(templateId: string): PlanTemplate | null {
    if (typeof (this.store as FilePlanStore).loadTemplate === 'function') {
      return (this.store as FilePlanStore).loadTemplate(templateId);
    }
    return null;
  }

  listTemplates(userId?: string): PlanTemplate[] {
    if (typeof (this.store as FilePlanStore).listTemplates === 'function') {
      return (this.store as FilePlanStore).listTemplates(userId);
    }
    return [];
  }

  deleteTemplate(templateId: string): boolean {
    if (typeof (this.store as FilePlanStore).deleteTemplate === 'function') {
      return (this.store as FilePlanStore).deleteTemplate(templateId);
    }
    return false;
  }

  // ── Dead-Letter Proxy Methods ────────────────────────────────────────

  saveDeadLetter(entry: DeadLetterEntry): void {
    if (typeof (this.store as FilePlanStore).saveDeadLetter === 'function') {
      (this.store as FilePlanStore).saveDeadLetter(entry);
    }
  }

  loadDeadLetters(planId?: string): DeadLetterEntry[] {
    if (typeof (this.store as FilePlanStore).loadDeadLetters === 'function') {
      return (this.store as FilePlanStore).loadDeadLetters(planId);
    }
    return [];
  }

  clearDeadLetters(planId?: string): number {
    if (typeof (this.store as FilePlanStore).clearDeadLetters === 'function') {
      return (this.store as FilePlanStore).clearDeadLetters(planId);
    }
    return 0;
  }

  // ── Checkpoint Proxy Methods ─────────────────────────────────────────

  saveCheckpoint(cp: ExecutionCheckpoint): void {
    if (typeof (this.store as FilePlanStore).saveCheckpoint === 'function') {
      (this.store as FilePlanStore).saveCheckpoint(cp);
    }
  }

  loadCheckpoint(executionId: string): ExecutionCheckpoint | null {
    if (typeof (this.store as FilePlanStore).loadCheckpoint === 'function') {
      return (this.store as FilePlanStore).loadCheckpoint(executionId);
    }
    return null;
  }

  loadAllCheckpoints(): ExecutionCheckpoint[] {
    if (typeof (this.store as FilePlanStore).loadAllCheckpoints === 'function') {
      return (this.store as FilePlanStore).loadAllCheckpoints();
    }
    return [];
  }

  deleteCheckpoint(executionId: string): boolean {
    if (typeof (this.store as FilePlanStore).deleteCheckpoint === 'function') {
      return (this.store as FilePlanStore).deleteCheckpoint(executionId);
    }
    return false;
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
    } else if (trigger.type === 'price' && !trigger.recurring) {
      plan.status = 'completed';
      this.store.save(plan);
      this.plans.delete(planId);
    }
    // Interval, cron, recurring conditions, and recurring price triggers stay scheduled
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
    } else if (trigger.type === 'price' && !trigger.recurring) {
      plan.status = 'failed';
      this.store.save(plan);
      this.plans.delete(planId);
    }
    // Recurring plans stay scheduled (they'll retry on next trigger)
  }

  // ─── State Persistence ─────────────────────────────────────────────────

  /** Restore intervalRunCounts and lastConditionCheck from disk. */
  private restoreState(): void {
    if (typeof (this.store as FilePlanStore).loadState !== 'function') return;
    const state = (this.store as FilePlanStore).loadState();
    if (!state) return;

    if (state.intervalRunCounts) {
      for (const [k, v] of Object.entries(state.intervalRunCounts)) {
        // Only restore for plans that are still active
        if (this.plans.has(k)) {
          this.intervalRunCounts.set(k, v);
        }
      }
    }
    if (state.lastConditionCheck) {
      for (const [k, v] of Object.entries(state.lastConditionCheck)) {
        if (this.plans.has(k)) {
          this.lastConditionCheck.set(k, v);
        }
      }
    }
    if (state.cronRunCounts) {
      for (const [k, v] of Object.entries(state.cronRunCounts)) {
        if (this.plans.has(k)) {
          this.cronRunCounts.set(k, v);
        }
      }
    }
    if (state.lastCronFire) {
      for (const [k, v] of Object.entries(state.lastCronFire)) {
        if (this.plans.has(k)) {
          this.lastCronFire.set(k, v);
        }
      }
    }
  }

  /** Mark state as dirty; it will be flushed within 5s or at next tick boundary. */
  private persistState(): void {
    this.stateDirty = true;
    // Debounce: flush after 5s of inactivity to batch rapid updates
    if (!this.stateFlushTimer) {
      this.stateFlushTimer = setTimeout(() => {
        this.stateFlushTimer = null;
        this.flushState();
      }, 5_000);
    }
  }

  /** Write state to disk immediately if dirty. */
  private flushState(): void {
    if (!this.stateDirty) return;
    if (typeof (this.store as FilePlanStore).saveState !== 'function') return;
    this.stateDirty = false;

    const state: SchedulerState = {
      intervalRunCounts: Object.fromEntries(this.intervalRunCounts),
      lastConditionCheck: Object.fromEntries(this.lastConditionCheck),
      cronRunCounts: Object.fromEntries(this.cronRunCounts),
      lastCronFire: Object.fromEntries(this.lastCronFire),
    };
    (this.store as FilePlanStore).saveState(state);
  }

  /** How many plans are actively being watched. */
  get activeCount(): number {
    return this.plans.size;
  }

  /** Get all active in-memory plans. */
  getActivePlans(): Plan[] {
    return Array.from(this.plans.values());
  }

  /** Is the scheduler running. */
  get isRunning(): boolean {
    return this.running;
  }

  // ─── Tick Loop ────────────────────────────────────────────────────────

  private ticking = false;

  private async tick(): Promise<void> {
    if (this.ticking) return; // Reentrancy guard — skip if previous tick still running
    this.ticking = true;
    try {
      const now = Date.now();

      for (const [planId, plan] of this.plans) {
        if (plan.status === 'paused' || plan.status === 'running') continue;

        try {
          const shouldFire = await this.shouldTriggerFire(plan, now);
          if (shouldFire) {
            await this.fireTrigger(plan);
          }
        } catch (err: any) {
          await this.emit({ type: 'condition_check_error', planId, error: err.message ?? String(err) });
        }
      }
    } finally {
      this.ticking = false;
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
          await this.emit({ type: 'plan_expired', plan, reason: 'Past end time' });
          plan.status = 'completed';
          this.store.save(plan);
          this.plans.delete(plan.id);
          return false;
        }

        const runCount = this.intervalRunCounts.get(plan.id) ?? 0;
        if (trigger.maxRuns && runCount >= trigger.maxRuns) {
          await this.emit({ type: 'plan_expired', plan, reason: `Reached ${trigger.maxRuns} executions` });
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
        this.persistState();

        // Check expiry
        if (trigger.expiresAfterMs && now - plan.createdAt > trigger.expiresAfterMs) {
          await this.emit({ type: 'plan_expired', plan, reason: 'Condition watch expired' });
          plan.status = 'completed';
          this.store.save(plan);
          this.plans.delete(plan.id);
          return false;
        }

        return await this.evaluateCondition(trigger.when);
      }

      case 'cron':
        // Cron evaluation handled in its own tick path (see evaluateCronTrigger)
        return this.evaluateCronTrigger(plan, trigger, now);

      case 'price':
        // Price triggers are handled by the PriceWatcher service via events.
        // The scheduler does not poll prices directly — the watcher emits
        // 'price_crossed' events which fire the plan through firePriceTrigger().
        return false;

      case 'onchain_event':
        // On-chain event triggers are handled by the OnChainEventListener service.
        // The listener polls getLogs and emits 'onchain_event' events on the bus.
        return false;

      case 'balance':
        // Balance triggers are handled by the BalanceWatcher service.
        // The watcher polls balances and emits 'balance_changed' events on the bus.
        return false;
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
      this.persistState();
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

    await this.emit({ type: 'trigger_fired', plan, executionId });
  }

  // ─── Cron Trigger Evaluation ─────────────────────────────────────────

  private evaluateCronTrigger(
    plan: Plan,
    trigger: { type: 'cron'; expression: string; timezone?: string; maxRuns?: number },
    now: number,
  ): boolean {
    // Check max runs
    const runCount = this.cronRunCounts.get(plan.id) ?? 0;
    if (trigger.maxRuns && runCount >= trigger.maxRuns) {
      plan.status = 'completed';
      this.store.save(plan);
      this.plans.delete(plan.id);
      return false;
    }

    // Floor current time to minute boundary
    const minuteFloor = Math.floor(now / 60_000) * 60_000;

    // Don't fire twice in the same minute
    const lastFire = this.lastCronFire.get(plan.id) ?? 0;
    if (minuteFloor <= lastFire) return false;

    // Parse and evaluate the cron expression against current time
    const date = trigger.timezone
      ? dateInTimezone(now, trigger.timezone)
      : new Date(now);

    if (!matchesCron(trigger.expression, date)) return false;

    // Record the fire
    this.cronRunCounts.set(plan.id, runCount + 1);
    this.lastCronFire.set(plan.id, minuteFloor);
    this.persistState();
    return true;
  }

  // ─── Price Trigger (Event-Driven) ──────────────────────────────────────
  // Called by the event bus listener when PriceWatcher detects a threshold cross.

  async firePriceTrigger(planId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) return;
    if (plan.status === 'paused' || plan.status === 'running') return;

    const trigger = plan.trigger;
    if (!trigger || trigger.type !== 'price') return;

    // One-shot: mark as running
    if (!trigger.recurring) {
      plan.status = 'running';
      this.store.save(plan);
    }

    const executionId = `exec_${plan.id}_${Date.now()}`;
    await this.emit({ type: 'trigger_fired', plan, executionId });
  }

  // ─── On-Chain Event Trigger (Event-Driven) ─────────────────────────────
  // Called by the event bus listener when OnChainEventListener detects a matching log.

  async fireOnChainTrigger(planId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) return;
    if (plan.status === 'paused' || plan.status === 'running') return;

    const trigger = plan.trigger;
    if (!trigger || trigger.type !== 'onchain_event') return;

    if (!trigger.recurring) {
      plan.status = 'running';
      this.store.save(plan);
    }

    const executionId = `exec_${plan.id}_${Date.now()}`;
    await this.emit({ type: 'trigger_fired', plan, executionId });
  }

  // ─── Balance Trigger (Event-Driven) ────────────────────────────────────
  // Called by the event bus listener when BalanceWatcher detects a threshold cross.

  async fireBalanceTrigger(planId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) return;
    if (plan.status === 'paused' || plan.status === 'running') return;

    const trigger = plan.trigger;
    if (!trigger || trigger.type !== 'balance') return;

    if (!trigger.recurring) {
      plan.status = 'running';
      this.store.save(plan);
    }

    const executionId = `exec_${plan.id}_${Date.now()}`;
    await this.emit({ type: 'trigger_fired', plan, executionId });
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

  private async emit(event: SchedulerEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (err) {
        // Log but don't let handler errors break the scheduler.
        // Before this fix, async handler rejections were silently dropped
        // (unhandled promise rejection → potential Node.js crash).
        console.error(`[plan-scheduler] handler error on ${event.type}:`, err);
      }
    }
  }
}

// ─── Cron Helpers ───────────────────────────────────────────────────────
// Minimal 5-field cron parser: minute hour day-of-month month day-of-week.
// Supports: *, ranges (1-5), lists (1,3,5), steps (*/5, 1-10/2).
// No named days/months to keep it small.

/** Convert a Date to the equivalent time in a different timezone. */
function dateInTimezone(epochMs: number, tz: string): Date {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(epochMs));
    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
    return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  } catch {
    // Invalid timezone — fall back to UTC
    return new Date(epochMs);
  }
}

/** Check if a date matches a 5-field cron expression. */
export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // 1-12
  const dayOfWeek = date.getDay();    // 0=Sun, 6=Sat

  return (
    matchesField(fields[0]!, minute, 0, 59) &&
    matchesField(fields[1]!, hour, 0, 23) &&
    matchesField(fields[2]!, dayOfMonth, 1, 31) &&
    matchesField(fields[3]!, month, 1, 12) &&
    matchesField(fields[4]!, dayOfWeek, 0, 7) // 0 and 7 both = Sunday
  );
}

/** Check if a single cron field matches a value. */
function matchesField(field: string, value: number, min: number, max: number): boolean {
  // Handle Sunday normalization: 7 → 0
  if (max === 7 && value === 7) value = 0;

  for (const part of field.split(',')) {
    if (matchesPart(part.trim(), value, min, max)) return true;
  }
  return false;
}

// Check if a single cron part (e.g., star-slash-5, 1-10/2, star, 5) matches.
function matchesPart(part: string, value: number, min: number, _max: number): boolean {
  const slashIdx = part.indexOf('/');
  const rangePart = slashIdx >= 0 ? part.slice(0, slashIdx) : part;
  const step = slashIdx >= 0 ? parseInt(part.slice(slashIdx + 1), 10) : 1;
  if (isNaN(step) || step < 1) return false;

  if (rangePart === '*') {
    return (value - min) % step === 0;
  }

  // Handle range: 1-5
  const dashIdx = rangePart.indexOf('-');
  if (dashIdx >= 0) {
    const start = parseInt(rangePart.slice(0, dashIdx), 10);
    const end = parseInt(rangePart.slice(dashIdx + 1), 10);
    if (isNaN(start) || isNaN(end)) return false;
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  }

  // Single value
  const num = parseInt(rangePart, 10);
  if (isNaN(num)) return false;
  return value === num;
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _scheduler: PlanScheduler | null = null;

export function getScheduler(opts?: ConstructorParameters<typeof PlanScheduler>[0]): PlanScheduler {
  if (!_scheduler) {
    _scheduler = new PlanScheduler(opts);
  } else if (opts) {
    console.warn(
      '[plan-scheduler] getScheduler() called with config but scheduler already exists. ' +
      'Config ignored. Call resetScheduler() first to reconfigure.',
    );
  }
  return _scheduler;
}

export function resetScheduler(): void {
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
}
