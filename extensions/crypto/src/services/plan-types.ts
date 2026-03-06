/**
 * Plan IR (Intermediate Representation) — the structured format for compound operations.
 *
 * The LLM compiles natural language into this IR. The validator checks it. The scheduler
 * persists it. The executor runs it. Every compound operation — from "swap ETH to USDC"
 * to "if ETH > $4000 at 5pm, sell half then bridge to Arbitrum" — compiles to a Plan.
 *
 * ─── Design Principles ─────────────────────────────────────────────────
 *
 * 1. Plans are data, not code. A Plan is JSON-serializable, inspectable, diffable.
 *    The LLM produces them. Humans can read them. The validator can reason about them.
 *
 * 2. Small set of orthogonal primitives. Six node types compose into any compound
 *    operation: Action, Sequence, Conditional, Loop, Wait, and Gate. No special-casing.
 *
 * 3. Separation of trigger from execution. A Plan says WHAT to do. A Trigger says
 *    WHEN to start. The scheduler owns triggers; the executor owns plans.
 *
 * 4. Explicit failure modes. Every node can declare `onFailure`: abort the plan,
 *    skip and continue, or retry N times. No implicit behavior.
 *
 * 5. Observable state. Every plan execution produces a PlanExecution record with
 *    per-step status, timestamps, results, and errors. Fully auditable.
 */

// ─── Primitive Value Types ──────────────────────────────────────────────

/** A reference to a value that may come from a previous step's output. */
export type ValueRef =
  | { type: 'literal'; value: string | number | boolean }
  | { type: 'step_output'; stepId: string; path: string }   // e.g., step "swap1" output field "amountOut"
  | { type: 'env'; key: string }                              // e.g., "ETH_PRICE", "WALLET_BALANCE"
  | { type: 'runtime'; fn: RuntimeFn; args: ValueRef[] };     // e.g., runtime.price("ETH"), runtime.balance("USDC")

/** Runtime functions the executor can evaluate. */
export type RuntimeFn =
  | 'price'           // price("ETH") → current USD price
  | 'balance'         // balance("USDC", chainId?) → wallet balance
  | 'gas_price'       // gas_price(chainId?) → current gas in gwei
  | 'timestamp'       // timestamp() → current unix seconds
  | 'block_number';   // block_number(chainId?) → current block

/** Comparison operators for conditions. */
export type CompareOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

/** Logical operators for combining conditions. */
export type LogicOp = 'and' | 'or' | 'not';

// ─── Conditions ─────────────────────────────────────────────────────────

/** A single comparison: left <op> right. */
export interface CompareCondition {
  type: 'compare';
  left: ValueRef;
  op: CompareOp;
  right: ValueRef;
  /** Human-readable description for display. */
  label?: string;
}

/** Logical combination of conditions. */
export interface LogicCondition {
  type: 'logic';
  op: LogicOp;
  conditions: Condition[];
}

export type Condition = CompareCondition | LogicCondition;

// ─── Plan Nodes ─────────────────────────────────────────────────────────
//
// Six node types that compose into any compound operation:
//
//   Action    — call a tool (defi_swap, transfer, manage_orders, etc.)
//   Sequence  — run nodes in order, passing outputs forward
//   Parallel  — run nodes concurrently (for independent read operations)
//   If        — conditional branching
//   Wait      — pause until a condition or duration
//   Loop      — repeat with a condition or count

/** What to do when a node fails. */
export type FailurePolicy =
  | { strategy: 'abort' }                                    // stop the entire plan
  | { strategy: 'skip'; reason?: string }                    // skip this step, continue
  | { strategy: 'retry'; maxAttempts: number; delayMs: number }; // retry with backoff

/** Base fields shared by all plan nodes. */
interface PlanNodeBase {
  /** Unique identifier within this plan. Used by ValueRef to reference outputs. */
  id: string;
  /** Human-readable label shown to user. */
  label: string;
  /** What to do if this node fails. Default: abort. */
  onFailure?: FailurePolicy;
  /** Optional timeout for this node in ms. */
  timeoutMs?: number;
}

/** Call a tool with parameters. The atomic unit of work. */
export interface ActionNode extends PlanNodeBase {
  type: 'action';
  /** Tool name (e.g., 'defi_swap', 'transfer', 'manage_orders'). */
  tool: string;
  /** Tool parameters. Values can be literals or references to prior step outputs. */
  params: Record<string, ValueRef | string | number | boolean>;
  /**
   * If true, executor must confirm with user before executing (regardless of autosign).
   * Use for high-value or irreversible operations.
   */
  requireConfirmation?: boolean;
}

/** Run child nodes in order. The output of each node is available to the next. */
export interface SequenceNode extends PlanNodeBase {
  type: 'sequence';
  steps: PlanNode[];
}

/** Run child nodes concurrently. Only for independent operations (reads, price checks). */
export interface ParallelNode extends PlanNodeBase {
  type: 'parallel';
  steps: PlanNode[];
  /** If true, continue even if some parallel steps fail. Default: false. */
  allowPartialFailure?: boolean;
}

/** Conditional branching. */
export interface IfNode extends PlanNodeBase {
  type: 'if';
  condition: Condition;
  then: PlanNode;
  else?: PlanNode;
}

/**
 * Pause execution until a condition is met or a duration passes.
 * The scheduler polls the condition at `pollIntervalMs`.
 */
export interface WaitNode extends PlanNodeBase {
  type: 'wait';
  /** Wait until this condition is true. */
  until?: Condition;
  /** Wait for a fixed duration (ms). Mutually exclusive with `until`. */
  durationMs?: number;
  /** Wait until a specific time (ISO 8601). Mutually exclusive with `until` and `durationMs`. */
  untilTime?: string;
  /** How often to check the `until` condition (ms). Default: 60_000 (1 min). */
  pollIntervalMs?: number;
  /** Maximum time to wait before giving up (ms). Default: 86_400_000 (24h). */
  maxWaitMs?: number;
}

/** Repeat a node. */
export interface LoopNode extends PlanNodeBase {
  type: 'loop';
  body: PlanNode;
  /** Stop when this condition is true. Checked after each iteration. */
  exitWhen?: Condition;
  /** Maximum iterations. Required as a safety bound. */
  maxIterations: number;
  /** Delay between iterations (ms). Default: 0. */
  delayMs?: number;
}

export type PlanNode = ActionNode | SequenceNode | ParallelNode | IfNode | WaitNode | LoopNode;

// ─── Triggers ───────────────────────────────────────────────────────────
//
// Triggers determine WHEN a plan starts. A plan without a trigger executes immediately.

/** Execute at a specific time. */
export interface TimeTrigger {
  type: 'time';
  /** ISO 8601 datetime string (e.g., "2026-03-06T17:00:00Z"). */
  at: string;
}

/** Execute on a recurring schedule. */
export interface IntervalTrigger {
  type: 'interval';
  /** Interval in ms between executions. */
  everyMs: number;
  /** First execution time (ISO 8601). If omitted, starts immediately. */
  startAt?: string;
  /** Stop recurring after this time. */
  endAt?: string;
  /** Max total executions. */
  maxRuns?: number;
}

/** Execute when a condition becomes true (polled). */
export interface ConditionTrigger {
  type: 'condition';
  /** The condition to watch. */
  when: Condition;
  /** How often to poll (ms). Default: 60_000. */
  pollIntervalMs?: number;
  /** Stop watching after this time (ms from creation). */
  expiresAfterMs?: number;
  /** If true, trigger fires every time condition is met (not just first). Default: false. */
  recurring?: boolean;
}

/** Execute immediately. */
export interface ImmediateTrigger {
  type: 'immediate';
}

export type Trigger = TimeTrigger | IntervalTrigger | ConditionTrigger | ImmediateTrigger;

// ─── Plan ───────────────────────────────────────────────────────────────

export type PlanStatus = 'draft' | 'validated' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface Plan {
  /** Unique plan ID. Generated on creation. */
  id: string;
  /** Human-readable name (e.g., "Sell ETH at $4000 and bridge to Arbitrum"). */
  name: string;
  /** The user who created this plan. */
  userId: string;
  /** When was this plan created. */
  createdAt: number;
  /** Current status. */
  status: PlanStatus;

  /** When to start execution. If omitted, executes immediately. */
  trigger?: Trigger;
  /** The operation tree. */
  root: PlanNode;

  /** Validation results (populated by PlanValidator). */
  validation?: ValidationResult;

  /** Tags for organization (e.g., ['swap', 'eth', 'scheduled']). */
  tags?: string[];
  /** The original natural language request that produced this plan. */
  naturalLanguage?: string;
}

// ─── Validation ─────────────────────────────────────────────────────────

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: IssueSeverity;
  /** Which node caused this issue (by id). Null for plan-level issues. */
  nodeId: string | null;
  /** Issue code for programmatic handling. */
  code: string;
  /** Human-readable description. */
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Estimated total gas cost in ETH (rough). */
  estimatedGasEth?: number;
  /** Estimated total time to complete (ms). */
  estimatedDurationMs?: number;
  /** Tools this plan will use. */
  toolsUsed: string[];
  /** Chains this plan will touch. */
  chainsUsed: number[];
}

// ─── Execution Tracking ─────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';

export interface StepExecution {
  nodeId: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  /** The result returned by the tool (for action nodes). */
  result?: unknown;
  /** Error message if failed. */
  error?: string;
  /** Number of retry attempts made. */
  retryCount?: number;
}

export interface PlanExecution {
  planId: string;
  /** Unique execution ID (a plan can execute multiple times via interval triggers). */
  executionId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  steps: StepExecution[];
  /** Cumulative gas spent in ETH. */
  gasSpentEth?: number;
}

// ─── Plan Store Interface ───────────────────────────────────────────────

export interface PlanStore {
  save(plan: Plan): void;
  load(planId: string): Plan | null;
  loadAll(userId?: string): Plan[];
  delete(planId: string): boolean;
  saveExecution(exec: PlanExecution): void;
  loadExecutions(planId: string): PlanExecution[];
}

// ─── Contradiction Codes ────────────────────────────────────────────────
// Used by the validator to identify specific contradiction types.

export const CONTRADICTION_CODES = {
  BUY_AND_SELL_SAME_TOKEN: 'CONTRA_BUY_SELL',
  SPEND_MORE_THAN_BALANCE: 'CONTRA_OVERSPEND',
  OPPOSITE_CONDITIONS: 'CONTRA_OPPOSITE_COND',
  IMPOSSIBLE_TIMING: 'CONTRA_TIMING',
  CIRCULAR_DEPENDENCY: 'CONTRA_CIRCULAR',
  DUPLICATE_ACTION: 'CONTRA_DUPLICATE',
  CONFLICTING_SLIPPAGE: 'CONTRA_SLIPPAGE',
  UNSUPPORTED_CHAIN: 'CONTRA_CHAIN',
  MISSING_TOOL: 'CONTRA_NO_TOOL',
  INFINITE_LOOP: 'CONTRA_INFINITE',
} as const;

export type ContradictionCode = typeof CONTRADICTION_CODES[keyof typeof CONTRADICTION_CODES];
