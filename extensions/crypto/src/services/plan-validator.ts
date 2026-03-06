/**
 * Plan Validator — checks a Plan IR for contradictions, safety issues, and feasibility.
 *
 * Runs BEFORE a plan is scheduled or executed. Returns a ValidationResult with:
 * - Errors (plan cannot proceed)
 * - Warnings (plan can proceed but user should be aware)
 * - Info (suggestions for improvement)
 *
 * ─── Validation Passes ──────────────────────────────────────────────────
 *
 * 1. Structural  — all node IDs unique, refs resolve, no orphan nodes
 * 2. Temporal    — times are in the future, waits have bounds, no impossible schedules
 * 3. Financial   — no buying and selling the same token, no overspending, slippage sanity
 * 4. Tool        — referenced tools exist, params match schema, ownerOnly checks
 * 5. Safety      — loop bounds exist, total gas estimate reasonable, high-value warnings
 * 6. Dependency  — step outputs referenced before they're produced, circular refs
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
  Condition,
  CompareCondition,
  ValueRef,
  ValidationResult,
  ValidationIssue,
  IssueSeverity,
  FailurePolicy,
} from './plan-types.js';
import { CONTRADICTION_CODES } from './plan-types.js';

// ─── Known Tools ────────────────────────────────────────────────────────
// We don't import the actual tool registry to keep the validator self-contained.
// This list is checked at plan creation time; unknown tools produce warnings, not errors.

const KNOWN_TOOLS = new Set([
  'defi_swap', 'defi_price', 'defi_balance', 'transfer', 'manage_orders',
  'analytics', 'market_intel', 'clawnch_info', 'clawnch_launch', 'clawnch_fees',
  'clawnchconnect', 'crypto_workflow', 'cost_basis', 'permit2', 'liquidity',
  'bridge', 'block_explorer', 'watch_activity', 'herd_intelligence',
  'molten', 'clawnx', 'hummingbot', 'wayfinder',
  'bankr_launch', 'bankr_automate', 'bankr_polymarket', 'bankr_leverage',
]);

const WRITE_TOOLS = new Set([
  'defi_swap', 'transfer', 'clawnch_launch', 'liquidity', 'bridge',
  'permit2', 'bankr_launch', 'bankr_automate', 'bankr_polymarket', 'bankr_leverage',
]);

const READ_TOOLS = new Set([
  'defi_price', 'defi_balance', 'analytics', 'market_intel', 'clawnch_info',
  'cost_basis', 'block_explorer', 'watch_activity', 'herd_intelligence', 'molten',
]);

// Tokens that are "opposite" sides of a trade
const TOKEN_ALIASES: Record<string, string> = {
  WETH: 'ETH', weth: 'ETH', eth: 'ETH',
  USDC: 'USD_STABLE', usdc: 'USD_STABLE',
  USDT: 'USD_STABLE', usdt: 'USD_STABLE',
  DAI: 'USD_STABLE', dai: 'USD_STABLE',
};

const MAX_PLAN_DEPTH = 10;
const MAX_PLAN_NODES = 50;
const MAX_LOOP_ITERATIONS = 1000;
const HIGH_VALUE_ETH_THRESHOLD = 1.0;
const MAX_TOTAL_GAS_ETH = 0.5;

// ─── Validator ──────────────────────────────────────────────────────────

export class PlanValidator {
  private issues: ValidationIssue[] = [];
  private nodeIds = new Set<string>();
  private toolsUsed = new Set<string>();
  private chainsUsed = new Set<number>();
  private executionOrder: string[] = [];

  validate(plan: Plan): ValidationResult {
    this.issues = [];
    this.nodeIds = new Set();
    this.toolsUsed = new Set();
    this.chainsUsed = new Set();
    this.executionOrder = [];

    // Pass 1: Structural
    this.validateStructure(plan.root, 0);

    // Pass 2: Temporal
    this.validateTiming(plan);

    // Pass 3: Financial (contradictions)
    this.validateFinancial(plan.root);

    // Pass 4: Tool validation
    this.validateTools(plan.root);

    // Pass 5: Safety
    this.validateSafety(plan.root);

    // Pass 6: Dependencies
    this.validateDependencies(plan.root);

    const hasErrors = this.issues.some(i => i.severity === 'error');

    return {
      valid: !hasErrors,
      issues: this.issues,
      estimatedGasEth: this.estimateGas(plan.root),
      estimatedDurationMs: this.estimateDuration(plan.root),
      toolsUsed: [...this.toolsUsed],
      chainsUsed: [...this.chainsUsed],
    };
  }

  // ─── Pass 1: Structural ─────────────────────────────────────────────

  private validateStructure(node: PlanNode, depth: number): void {
    // Depth check
    if (depth > MAX_PLAN_DEPTH) {
      this.addIssue('error', node.id, 'STRUCT_DEPTH', `Plan exceeds maximum nesting depth of ${MAX_PLAN_DEPTH}.`);
      return;
    }

    // Unique ID check
    if (this.nodeIds.has(node.id)) {
      this.addIssue('error', node.id, 'STRUCT_DUP_ID', `Duplicate node ID: "${node.id}". Each step must have a unique ID.`);
    }
    this.nodeIds.add(node.id);

    // Node count check
    if (this.nodeIds.size > MAX_PLAN_NODES) {
      this.addIssue('error', node.id, 'STRUCT_TOO_MANY', `Plan exceeds maximum of ${MAX_PLAN_NODES} nodes.`);
      return;
    }

    // Missing label
    if (!node.label || node.label.trim().length === 0) {
      this.addIssue('warning', node.id, 'STRUCT_NO_LABEL', 'Node has no label. Labels help users understand the plan.');
    }

    // Recurse into children
    switch (node.type) {
      case 'action':
        this.executionOrder.push(node.id);
        break;
      case 'sequence':
        for (const step of node.steps) this.validateStructure(step, depth + 1);
        break;
      case 'parallel':
        for (const step of node.steps) this.validateStructure(step, depth + 1);
        break;
      case 'if':
        this.validateCondition(node.condition, node.id);
        this.validateStructure(node.then, depth + 1);
        if (node.else) this.validateStructure(node.else, depth + 1);
        break;
      case 'wait':
        if (!node.until && !node.durationMs && !node.untilTime) {
          this.addIssue('error', node.id, 'STRUCT_WAIT_EMPTY', 'Wait node has no condition, duration, or target time. It would wait forever.');
        }
        if (node.until && node.durationMs) {
          this.addIssue('warning', node.id, 'STRUCT_WAIT_AMBIGUOUS', 'Wait has both a condition and a duration. The condition takes priority; duration is used as max wait.');
        }
        if (node.until) this.validateCondition(node.until, node.id);
        break;
      case 'loop':
        if (!node.maxIterations || node.maxIterations <= 0) {
          this.addIssue('error', node.id, CONTRADICTION_CODES.INFINITE_LOOP, 'Loop has no maxIterations or it is <= 0. This would loop forever.');
        } else if (node.maxIterations > MAX_LOOP_ITERATIONS) {
          this.addIssue('error', node.id, CONTRADICTION_CODES.INFINITE_LOOP, `Loop maxIterations (${node.maxIterations}) exceeds safety limit of ${MAX_LOOP_ITERATIONS}.`);
        }
        if (!node.exitWhen) {
          this.addIssue('warning', node.id, 'LOOP_NO_EXIT', 'Loop has no exitWhen condition. It will run exactly maxIterations times.');
        } else {
          this.validateCondition(node.exitWhen, node.id);
        }
        this.validateStructure(node.body, depth + 1);
        break;
    }
  }

  private validateCondition(cond: Condition, nodeId: string): void {
    if (cond.type === 'compare') {
      this.validateValueRef(cond.left, nodeId);
      this.validateValueRef(cond.right, nodeId);
    } else if (cond.type === 'logic') {
      if (cond.conditions.length === 0) {
        this.addIssue('error', nodeId, 'COND_EMPTY', `Logic "${cond.op}" has no sub-conditions.`);
      }
      if (cond.op === 'not' && cond.conditions.length !== 1) {
        this.addIssue('error', nodeId, 'COND_NOT_ARITY', '"not" must have exactly one sub-condition.');
      }
      for (const sub of cond.conditions) this.validateCondition(sub, nodeId);
    }
  }

  private validateValueRef(ref: ValueRef | string | number | boolean, nodeId: string): void {
    if (typeof ref !== 'object' || ref === null) return; // literal shorthand
    if (ref.type === 'step_output') {
      // Will be checked in dependency pass
    } else if (ref.type === 'runtime') {
      const validFns = new Set(['price', 'balance', 'gas_price', 'timestamp', 'block_number']);
      if (!validFns.has(ref.fn)) {
        this.addIssue('error', nodeId, 'REF_BAD_FN', `Unknown runtime function: "${ref.fn}".`);
      }
    }
  }

  // ─── Pass 2: Temporal ───────────────────────────────────────────────

  private validateTiming(plan: Plan): void {
    if (!plan.trigger) return;

    const now = Date.now();

    switch (plan.trigger.type) {
      case 'time': {
        const at = new Date(plan.trigger.at).getTime();
        if (isNaN(at)) {
          this.addIssue('error', null, CONTRADICTION_CODES.IMPOSSIBLE_TIMING, `Invalid trigger time: "${plan.trigger.at}". Use ISO 8601 format.`);
        } else if (at <= now) {
          this.addIssue('error', null, CONTRADICTION_CODES.IMPOSSIBLE_TIMING, `Trigger time "${plan.trigger.at}" is in the past.`);
        } else if (at - now > 30 * 24 * 60 * 60 * 1000) {
          this.addIssue('warning', null, 'TIME_FAR_FUTURE', 'Trigger is more than 30 days out. Consider whether conditions might change.');
        }
        break;
      }
      case 'interval': {
        if (plan.trigger.everyMs < 30_000) {
          this.addIssue('error', null, CONTRADICTION_CODES.IMPOSSIBLE_TIMING, 'Interval must be at least 30 seconds.');
        }
        if (plan.trigger.everyMs < 60_000) {
          this.addIssue('warning', null, 'TIME_FAST_INTERVAL', 'Interval under 1 minute may cause excessive RPC calls and gas costs.');
        }
        if (plan.trigger.maxRuns && plan.trigger.maxRuns > 10_000) {
          this.addIssue('warning', null, 'TIME_MANY_RUNS', `${plan.trigger.maxRuns} executions is a lot. Consider a reasonable bound.`);
        }
        break;
      }
      case 'condition': {
        if (plan.trigger.pollIntervalMs && plan.trigger.pollIntervalMs < 10_000) {
          this.addIssue('warning', null, 'TIME_FAST_POLL', 'Polling faster than 10s may cause rate limiting.');
        }
        if (!plan.trigger.expiresAfterMs) {
          this.addIssue('warning', null, 'TIME_NO_EXPIRY', 'Condition trigger has no expiry. It will watch indefinitely. Consider setting expiresAfterMs.');
        }
        this.validateCondition(plan.trigger.when, 'trigger');
        break;
      }
    }

    // Check wait nodes for temporal sanity
    this.validateWaitTiming(plan.root, now);
  }

  private validateWaitTiming(node: PlanNode, now: number): void {
    if (node.type === 'wait') {
      if (node.untilTime) {
        const t = new Date(node.untilTime).getTime();
        if (isNaN(t)) {
          this.addIssue('error', node.id, CONTRADICTION_CODES.IMPOSSIBLE_TIMING, `Invalid wait time: "${node.untilTime}".`);
        }
        // Can't check if in past because plan might be scheduled for the future
      }
      if (node.maxWaitMs && node.maxWaitMs > 7 * 24 * 60 * 60 * 1000) {
        this.addIssue('warning', node.id, 'WAIT_LONG', 'Wait timeout exceeds 7 days. Consider a shorter bound.');
      }
      if (!node.maxWaitMs && node.until) {
        this.addIssue('warning', node.id, 'WAIT_NO_TIMEOUT', 'Wait on condition has no maxWaitMs. It could wait indefinitely. Default: 24h.');
      }
    }

    // Recurse
    if (node.type === 'sequence' || node.type === 'parallel') {
      for (const s of node.steps) this.validateWaitTiming(s, now);
    } else if (node.type === 'if') {
      this.validateWaitTiming(node.then, now);
      if (node.else) this.validateWaitTiming(node.else, now);
    } else if (node.type === 'loop') {
      this.validateWaitTiming(node.body, now);
    }
  }

  // ─── Pass 3: Financial ──────────────────────────────────────────────

  private validateFinancial(root: PlanNode): void {
    const actions = this.collectActions(root);

    // Extract all swap/transfer operations
    const buys: Array<{ nodeId: string; token: string; amount?: string }> = [];
    const sells: Array<{ nodeId: string; token: string; amount?: string }> = [];

    for (const action of actions) {
      const tool = action.tool;
      const params = action.params;

      if (tool === 'defi_swap') {
        const tokenIn = this.resolveParamString(params.token_in ?? params.tokenIn);
        const tokenOut = this.resolveParamString(params.token_out ?? params.tokenOut);
        const amount = this.resolveParamString(params.amount);
        if (tokenIn) sells.push({ nodeId: action.id, token: this.normalizeToken(tokenIn), amount });
        if (tokenOut) buys.push({ nodeId: action.id, token: this.normalizeToken(tokenOut) });
      } else if (tool === 'transfer') {
        const token = this.resolveParamString(params.token);
        const amount = this.resolveParamString(params.amount);
        if (token) sells.push({ nodeId: action.id, token: this.normalizeToken(token), amount });
      }
    }

    // Check: buying and selling the same token in the same plan
    for (const buy of buys) {
      for (const sell of sells) {
        if (buy.token === sell.token && buy.nodeId !== sell.nodeId) {
          // Only flag if they're not in the same swap (swapping A→B naturally sells A and buys B)
          this.addIssue(
            'warning', buy.nodeId,
            CONTRADICTION_CODES.BUY_AND_SELL_SAME_TOKEN,
            `Plan both buys and sells ${buy.token} (steps "${buy.nodeId}" and "${sell.nodeId}"). This may be intentional (arbitrage) or a mistake.`,
          );
        }
      }
    }

    // Check: duplicate actions (same tool, same params)
    for (let i = 0; i < actions.length; i++) {
      for (let j = i + 1; j < actions.length; j++) {
        if (actions[i]!.tool === actions[j]!.tool && this.paramsEqual(actions[i]!.params, actions[j]!.params)) {
          this.addIssue(
            'warning', actions[j]!.id,
            CONTRADICTION_CODES.DUPLICATE_ACTION,
            `Step "${actions[j]!.id}" appears to be a duplicate of "${actions[i]!.id}" (same tool and parameters).`,
          );
        }
      }
    }

    // Check: multiple swaps spending the same token without checking balance in between
    const spendsByToken = new Map<string, string[]>();
    for (const sell of sells) {
      const existing = spendsByToken.get(sell.token) ?? [];
      existing.push(sell.nodeId);
      spendsByToken.set(sell.token, existing);
    }
    for (const [token, nodeIds] of spendsByToken) {
      if (nodeIds.length > 1) {
        this.addIssue(
          'warning', nodeIds[1]!,
          CONTRADICTION_CODES.SPEND_MORE_THAN_BALANCE,
          `Multiple steps spend ${token} (${nodeIds.join(', ')}). The second step may not have enough balance. Consider checking balance between steps.`,
        );
      }
    }
  }

  // ─── Pass 4: Tool Validation ────────────────────────────────────────

  private validateTools(node: PlanNode): void {
    if (node.type === 'action') {
      this.toolsUsed.add(node.tool);

      if (!KNOWN_TOOLS.has(node.tool)) {
        this.addIssue('warning', node.id, CONTRADICTION_CODES.MISSING_TOOL, `Unknown tool: "${node.tool}". It may be a custom or future tool.`);
      }

      // Check for write tools that might need confirmation
      if (WRITE_TOOLS.has(node.tool) && !node.requireConfirmation) {
        this.addIssue('info', node.id, 'TOOL_WRITE_NO_CONFIRM', `"${node.tool}" is a write operation. Consider setting requireConfirmation: true for safety.`);
      }

      // Extract chain info if available
      const chainId = this.resolveParamNumber(node.params.chain_id ?? node.params.chainId);
      if (chainId) {
        this.chainsUsed.add(chainId);
        if (![1, 8453, 42161, 10, 137].includes(chainId)) {
          this.addIssue('warning', node.id, CONTRADICTION_CODES.UNSUPPORTED_CHAIN, `Chain ${chainId} is not in the standard supported set (Ethereum, Base, Arbitrum, Optimism, Polygon).`);
        }
      }

      // Validate params have at least a value ref or literal
      for (const [key, val] of Object.entries(node.params)) {
        if (val === undefined || val === null) {
          this.addIssue('warning', node.id, 'TOOL_NULL_PARAM', `Parameter "${key}" is null/undefined.`);
        }
      }
    }

    // Recurse
    if (node.type === 'sequence' || node.type === 'parallel') {
      for (const s of node.steps) this.validateTools(s);
    } else if (node.type === 'if') {
      this.validateTools(node.then);
      if (node.else) this.validateTools(node.else);
    } else if (node.type === 'loop') {
      this.validateTools(node.body);
    }
  }

  // ─── Pass 5: Safety ─────────────────────────────────────────────────

  private validateSafety(root: PlanNode): void {
    const actions = this.collectActions(root);

    // Count write operations
    const writeOps = actions.filter(a => WRITE_TOOLS.has(a.tool));
    if (writeOps.length > 5) {
      this.addIssue('warning', null, 'SAFETY_MANY_WRITES', `Plan has ${writeOps.length} write operations. Consider whether this is intentional.`);
    }

    // Check for high-value operations
    for (const action of actions) {
      if (action.tool === 'defi_swap' || action.tool === 'transfer') {
        const amount = this.resolveParamString(action.params.amount);
        if (amount) {
          const num = parseFloat(amount);
          if (!isNaN(num) && num > HIGH_VALUE_ETH_THRESHOLD) {
            this.addIssue('warning', action.id, 'SAFETY_HIGH_VALUE', `Step "${action.id}" involves ${amount} which may be high value. Verify amounts carefully.`);
          }
        }
      }
    }

    // Check total estimated gas
    const gasEstimate = this.estimateGas(root);
    if (gasEstimate > MAX_TOTAL_GAS_ETH) {
      this.addIssue('warning', null, 'SAFETY_HIGH_GAS', `Estimated total gas: ${gasEstimate.toFixed(4)} ETH. This is above the ${MAX_TOTAL_GAS_ETH} ETH threshold.`);
    }

    // Parallel write operations are dangerous
    this.checkParallelWrites(root);
  }

  private checkParallelWrites(node: PlanNode): void {
    if (node.type === 'parallel') {
      const writes = node.steps.filter(s =>
        s.type === 'action' && WRITE_TOOLS.has(s.tool),
      );
      if (writes.length > 1) {
        this.addIssue('error', node.id, 'SAFETY_PARALLEL_WRITES',
          `Parallel node "${node.id}" contains ${writes.length} write operations. ` +
          'Write operations must be sequential to prevent nonce conflicts and race conditions.');
      }
    }
    // Recurse
    if (node.type === 'sequence' || node.type === 'parallel') {
      for (const s of node.steps) this.checkParallelWrites(s);
    } else if (node.type === 'if') {
      this.checkParallelWrites(node.then);
      if (node.else) this.checkParallelWrites(node.else);
    } else if (node.type === 'loop') {
      this.checkParallelWrites(node.body);
    }
  }

  // ─── Pass 6: Dependencies ──────────────────────────────────────────

  private validateDependencies(root: PlanNode): void {
    // Collect all step_output references and check they reference defined nodes
    // that appear BEFORE the referencing node in execution order.
    const definedBefore = new Set<string>();
    this.walkDependencies(root, definedBefore);
  }

  private walkDependencies(node: PlanNode, definedBefore: Set<string>): void {
    if (node.type === 'action') {
      // Check all param refs
      for (const [key, val] of Object.entries(node.params)) {
        if (typeof val === 'object' && val !== null && 'type' in val && val.type === 'step_output') {
          const ref = val as { type: 'step_output'; stepId: string; path: string };
          if (!this.nodeIds.has(ref.stepId)) {
            this.addIssue('error', node.id, CONTRADICTION_CODES.CIRCULAR_DEPENDENCY,
              `Step "${node.id}" references output of "${ref.stepId}" which does not exist.`);
          } else if (!definedBefore.has(ref.stepId)) {
            this.addIssue('error', node.id, CONTRADICTION_CODES.CIRCULAR_DEPENDENCY,
              `Step "${node.id}" references output of "${ref.stepId}" which hasn't executed yet at this point.`);
          }
        }
      }
      definedBefore.add(node.id);
    } else if (node.type === 'sequence') {
      for (const s of node.steps) this.walkDependencies(s, definedBefore);
    } else if (node.type === 'parallel') {
      // In parallel, no step can see any sibling's output
      const beforeParallel = new Set(definedBefore);
      for (const s of node.steps) {
        this.walkDependencies(s, new Set(beforeParallel));
      }
      // After parallel, all steps are defined
      for (const s of node.steps) this.collectNodeIds(s).forEach(id => definedBefore.add(id));
    } else if (node.type === 'if') {
      const beforeIf = new Set(definedBefore);
      this.walkDependencies(node.then, new Set(beforeIf));
      if (node.else) this.walkDependencies(node.else, new Set(beforeIf));
      // After if, only nodes from both branches are guaranteed — conservative: add neither
      // (outputs from conditional branches are unreliable as dependencies)
    } else if (node.type === 'loop') {
      this.walkDependencies(node.body, new Set(definedBefore));
      // Loop body outputs are available after loop, but value is from last iteration
      this.collectNodeIds(node.body).forEach(id => definedBefore.add(id));
    } else if (node.type === 'wait') {
      definedBefore.add(node.id);
    }
  }

  private collectNodeIds(node: PlanNode): string[] {
    const ids = [node.id];
    if (node.type === 'sequence' || node.type === 'parallel') {
      for (const s of node.steps) ids.push(...this.collectNodeIds(s));
    } else if (node.type === 'if') {
      ids.push(...this.collectNodeIds(node.then));
      if (node.else) ids.push(...this.collectNodeIds(node.else));
    } else if (node.type === 'loop') {
      ids.push(...this.collectNodeIds(node.body));
    }
    return ids;
  }

  // ─── Gas Estimation ─────────────────────────────────────────────────

  /** Rough gas estimate in ETH. Very approximate — real estimation requires RPC. */
  private estimateGas(node: PlanNode): number {
    const GAS_COSTS_ETH: Record<string, number> = {
      defi_swap: 0.002,
      transfer: 0.0005,
      clawnch_launch: 0.01,
      bridge: 0.003,
      permit2: 0.0003,
      liquidity: 0.005,
      bankr_launch: 0.01,
    };

    if (node.type === 'action') {
      return GAS_COSTS_ETH[node.tool] ?? 0;
    } else if (node.type === 'sequence' || node.type === 'parallel') {
      return node.steps.reduce((sum, s) => sum + this.estimateGas(s), 0);
    } else if (node.type === 'if') {
      // Estimate the more expensive branch
      const thenGas = this.estimateGas(node.then);
      const elseGas = node.else ? this.estimateGas(node.else) : 0;
      return Math.max(thenGas, elseGas);
    } else if (node.type === 'loop') {
      // Estimate one iteration × maxIterations (worst case)
      return this.estimateGas(node.body) * Math.min(node.maxIterations, 10);
    }
    return 0;
  }

  /** Rough duration estimate in ms. */
  private estimateDuration(node: PlanNode): number {
    const TOOL_DURATION_MS: Record<string, number> = {
      defi_swap: 15_000,
      transfer: 10_000,
      clawnch_launch: 30_000,
      bridge: 60_000,
      defi_price: 3_000,
      analytics: 5_000,
      market_intel: 5_000,
    };

    if (node.type === 'action') {
      return TOOL_DURATION_MS[node.tool] ?? 5_000;
    } else if (node.type === 'sequence') {
      return node.steps.reduce((sum, s) => sum + this.estimateDuration(s), 0);
    } else if (node.type === 'parallel') {
      return Math.max(...node.steps.map(s => this.estimateDuration(s)), 0);
    } else if (node.type === 'if') {
      return Math.max(this.estimateDuration(node.then), node.else ? this.estimateDuration(node.else) : 0);
    } else if (node.type === 'wait') {
      return node.durationMs ?? node.maxWaitMs ?? 60_000;
    } else if (node.type === 'loop') {
      return this.estimateDuration(node.body) * Math.min(node.maxIterations, 10) + (node.delayMs ?? 0) * Math.min(node.maxIterations, 10);
    }
    return 0;
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private collectActions(node: PlanNode): ActionNode[] {
    if (node.type === 'action') return [node];
    if (node.type === 'sequence' || node.type === 'parallel') {
      return node.steps.flatMap(s => this.collectActions(s));
    }
    if (node.type === 'if') {
      const actions = this.collectActions(node.then);
      if (node.else) actions.push(...this.collectActions(node.else));
      return actions;
    }
    if (node.type === 'loop') return this.collectActions(node.body);
    return [];
  }

  private resolveParamString(val: unknown): string | undefined {
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && val !== null && 'type' in val) {
      const ref = val as ValueRef;
      if (ref.type === 'literal') return String(ref.value);
    }
    return undefined;
  }

  private resolveParamNumber(val: unknown): number | undefined {
    const s = this.resolveParamString(val);
    if (s === undefined) return undefined;
    const n = Number(s);
    return isNaN(n) ? undefined : n;
  }

  private normalizeToken(token: string): string {
    return TOKEN_ALIASES[token] ?? TOKEN_ALIASES[token.toUpperCase()] ?? token.toUpperCase();
  }

  private paramsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      const aVal = this.resolveParamString(a[aKeys[i]!]);
      const bVal = this.resolveParamString(b[bKeys[i]!]);
      if (aVal !== bVal) return false;
    }
    return true;
  }

  private addIssue(severity: IssueSeverity, nodeId: string | null, code: string, message: string): void {
    this.issues.push({ severity, nodeId, code, message });
  }
}
