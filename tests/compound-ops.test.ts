/**
 * Compound Operations Engine — comprehensive tests.
 *
 * Tests the full pipeline: compiler, validator, scheduler, executor, builder code,
 * and the compound_action tool.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ══════════════════════════════════════════════════════════════════════════════
// 1. Plan Compiler
// ══════════════════════════════════════════════════════════════════════════════

describe('PlanCompiler', () => {
  it('compiles a simple swap intent', async () => {
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'swap 1 ETH for USDC',
      steps: [{ action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' }],
    }, 'user1');

    expect(plan.id).toMatch(/^plan_/);
    expect(plan.userId).toBe('user1');
    expect(plan.status).toBe('draft');
    expect(plan.root.type).toBe('action');
    expect((plan.root as any).tool).toBe('defi_swap');
    expect((plan.root as any).params.token_in).toBe('ETH');
    expect((plan.root as any).params.token_out).toBe('USDC');
  });

  it('compiles a multi-step sequence', async () => {
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'swap ETH to USDC then bridge to Arbitrum',
      steps: [
        { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
        { action: 'bridge', token: 'USDC', amount: '500', toChain: 42161 },
      ],
    }, 'user1');

    expect(plan.root.type).toBe('sequence');
    expect((plan.root as any).steps.length).toBe(2);
    expect((plan.root as any).steps[0].tool).toBe('defi_swap');
    expect((plan.root as any).steps[1].tool).toBe('bridge');
  });

  it('compiles at_time trigger', async () => {
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    const futureTime = new Date(Date.now() + 3600_000).toISOString();
    const plan = compiler.compile({
      naturalLanguage: 'swap at 5pm',
      trigger: { type: 'at_time', time: futureTime },
      steps: [{ action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' }],
    }, 'user1');

    expect(plan.trigger!.type).toBe('time');
    expect((plan.trigger as any).at).toBe(futureTime);
  });

  it('compiles interval trigger', async () => {
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'check prices every 4 hours',
      trigger: { type: 'every', interval: '4h', maxRuns: 10 },
      steps: [{ action: 'check_price', token: 'ETH' }],
    }, 'user1');

    expect(plan.trigger!.type).toBe('interval');
    expect((plan.trigger as any).everyMs).toBe(4 * 3_600_000);
    expect((plan.trigger as any).maxRuns).toBe(10);
  });

  it('compiles condition trigger', async () => {
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'when ETH hits $4000, sell half',
      trigger: { type: 'when_condition', token: 'ETH', op: 'gte', value: 4000 },
      steps: [{ action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amountPct: 50 }],
    }, 'user1');

    expect(plan.trigger!.type).toBe('condition');
    const cond = (plan.trigger as any).when;
    expect(cond.type).toBe('compare');
    expect(cond.op).toBe('gte');
  });

  it('compiles compound condition trigger (AND)', async () => {
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'when ETH > 4000 AND BTC > 100000',
      trigger: {
        type: 'when_condition',
        logic: 'and',
        conditions: [
          { token: 'ETH', op: 'gt', value: 4000 },
          { token: 'BTC', op: 'gt', value: 100000 },
        ],
      },
      steps: [{ action: 'check_price', token: 'ETH' }],
    }, 'user1');

    const when = (plan.trigger as any).when;
    expect(when.type).toBe('logic');
    expect(when.op).toBe('and');
    expect(when.conditions.length).toBe(2);
  });

  it('wraps conditional steps in if-nodes', async () => {
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'swap ETH, then if USDC balance > 1000 bridge to Arbitrum',
      steps: [
        { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
        {
          action: 'bridge', token: 'USDC', amount: '500', toChain: 42161,
          condition: { token: 'USDC', field: 'balance', op: 'gt', value: 1000 },
        },
      ],
    }, 'user1');

    expect(plan.root.type).toBe('sequence');
    const steps = (plan.root as any).steps;
    expect(steps[0].type).toBe('action'); // swap — no condition
    expect(steps[1].type).toBe('if');     // bridge — wrapped in if
    expect(steps[1].then.tool).toBe('bridge');
  });

  it('rejects empty steps', async () => {
    const { PlanCompiler, CompilationError } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    expect(() => compiler.compile({
      naturalLanguage: 'nothing',
      steps: [],
    }, 'user1')).toThrow(CompilationError);
  });

  it('rejects invalid interval format', async () => {
    const { PlanCompiler, CompilationError } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    expect(() => compiler.compile({
      naturalLanguage: 'every banana',
      trigger: { type: 'every', interval: 'banana' },
      steps: [{ action: 'check_price', token: 'ETH' }],
    }, 'user1')).toThrow(CompilationError);
  });

  it('custom action requires tool field', async () => {
    const { PlanCompiler, CompilationError } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    expect(() => compiler.compile({
      naturalLanguage: 'custom thing',
      steps: [{ action: 'custom' }],
    }, 'user1')).toThrow(CompilationError);
  });

  it('parseIntervalToMs handles all units', async () => {
    const { parseIntervalToMs } = await import('../extensions/crypto/src/services/plan-compiler.js');
    expect(parseIntervalToMs('30s')).toBe(30_000);
    expect(parseIntervalToMs('5m')).toBe(300_000);
    expect(parseIntervalToMs('4h')).toBe(14_400_000);
    expect(parseIntervalToMs('1d')).toBe(86_400_000);
    expect(parseIntervalToMs('2w')).toBe(1_209_600_000);
    expect(parseIntervalToMs('30sec')).toBe(30_000);
    expect(parseIntervalToMs('5min')).toBe(300_000);
  });

  it('sets requireConfirmation true for write actions by default', async () => {
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'swap and transfer',
      steps: [
        { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
        { action: 'transfer', token: 'ETH', amount: '0.5', to: '0xabc' },
      ],
    }, 'user1');

    const steps = (plan.root as any).steps;
    expect(steps[0].requireConfirmation).toBe(true);
    expect(steps[1].requireConfirmation).toBe(true);
  });

  it('sets requireConfirmation false for read actions', async () => {
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');
    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'check prices',
      steps: [{ action: 'check_price', token: 'ETH' }],
    }, 'user1');

    expect((plan.root as any).requireConfirmation).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Plan Validator
// ══════════════════════════════════════════════════════════════════════════════

describe('PlanValidator', () => {
  it('validates a simple valid plan', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');

    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'swap 1 ETH for USDC',
      steps: [{ action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' }],
    }, 'user1');

    const validator = new PlanValidator();
    const result = validator.validate(plan);

    expect(result.valid).toBe(true);
    expect(result.toolsUsed).toContain('defi_swap');
    expect(result.estimatedGasEth).toBeGreaterThan(0);
  });

  it('detects duplicate node IDs', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const validator = new PlanValidator();
    const result = validator.validate({
      id: 'plan1', name: 'test', userId: 'u', createdAt: Date.now(), status: 'draft',
      root: {
        id: 'seq1', type: 'sequence', label: 'seq', steps: [
          { id: 'dup', type: 'action', label: 'a', tool: 'defi_price', params: {} },
          { id: 'dup', type: 'action', label: 'b', tool: 'defi_price', params: {} },
        ],
      },
    });

    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === 'STRUCT_DUP_ID')).toBe(true);
  });

  it('detects buy and sell same token contradiction', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');

    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'buy then sell ETH',
      steps: [
        { action: 'swap', tokenIn: 'USDC', tokenOut: 'ETH', amount: '1000' },
        { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '0.5' },
      ],
    }, 'user1');

    const validator = new PlanValidator();
    const result = validator.validate(plan);

    const contradiction = result.issues.find(i => i.code === 'CONTRA_BUY_SELL');
    expect(contradiction).toBeDefined();
  });

  it('detects multiple spends of same token', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');

    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'swap ETH twice',
      steps: [
        { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
        { action: 'swap', tokenIn: 'ETH', tokenOut: 'DAI', amount: '1' },
      ],
    }, 'user1');

    const validator = new PlanValidator();
    const result = validator.validate(plan);
    expect(result.issues.some(i => i.code === 'CONTRA_OVERSPEND')).toBe(true);
  });

  it('detects past trigger time', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const validator = new PlanValidator();
    const result = validator.validate({
      id: 'plan1', name: 'test', userId: 'u', createdAt: Date.now(), status: 'draft',
      trigger: { type: 'time', at: '2020-01-01T00:00:00Z' },
      root: { id: 'a1', type: 'action', label: 'swap', tool: 'defi_swap', params: {} },
    });

    expect(result.issues.some(i => i.code === 'CONTRA_TIMING')).toBe(true);
  });

  it('detects interval too short', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const validator = new PlanValidator();
    const result = validator.validate({
      id: 'plan1', name: 'test', userId: 'u', createdAt: Date.now(), status: 'draft',
      trigger: { type: 'interval', everyMs: 5_000 },
      root: { id: 'a1', type: 'action', label: 'check', tool: 'defi_price', params: {} },
    });

    expect(result.issues.some(i => i.code === 'CONTRA_TIMING')).toBe(true);
  });

  it('detects parallel write operations', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const validator = new PlanValidator();
    const result = validator.validate({
      id: 'plan1', name: 'test', userId: 'u', createdAt: Date.now(), status: 'draft',
      root: {
        id: 'par1', type: 'parallel', label: 'parallel writes', steps: [
          { id: 'a1', type: 'action', label: 'swap1', tool: 'defi_swap', params: {} },
          { id: 'a2', type: 'action', label: 'swap2', tool: 'defi_swap', params: {} },
        ],
      },
    });

    expect(result.issues.some(i => i.code === 'SAFETY_PARALLEL_WRITES')).toBe(true);
  });

  it('detects infinite loop (no maxIterations)', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const validator = new PlanValidator();
    const result = validator.validate({
      id: 'plan1', name: 'test', userId: 'u', createdAt: Date.now(), status: 'draft',
      root: {
        id: 'loop1', type: 'loop', label: 'forever', maxIterations: 0,
        body: { id: 'a1', type: 'action', label: 'check', tool: 'defi_price', params: {} },
      },
    });

    expect(result.issues.some(i => i.code === 'CONTRA_INFINITE')).toBe(true);
  });

  it('warns about unknown tools', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const validator = new PlanValidator();
    const result = validator.validate({
      id: 'plan1', name: 'test', userId: 'u', createdAt: Date.now(), status: 'draft',
      root: { id: 'a1', type: 'action', label: 'mystery', tool: 'nonexistent_tool', params: {} },
    });

    expect(result.issues.some(i => i.code === 'CONTRA_NO_TOOL')).toBe(true);
  });

  it('warns about wait with no condition or duration', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const validator = new PlanValidator();
    const result = validator.validate({
      id: 'plan1', name: 'test', userId: 'u', createdAt: Date.now(), status: 'draft',
      root: { id: 'w1', type: 'wait', label: 'wait forever' },
    });

    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === 'STRUCT_WAIT_EMPTY')).toBe(true);
  });

  it('estimates gas for multi-step plan', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const { PlanCompiler } = await import('../extensions/crypto/src/services/plan-compiler.js');

    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'swap then bridge',
      steps: [
        { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
        { action: 'bridge', token: 'USDC', amount: '500', toChain: 42161 },
      ],
    }, 'user1');

    const validator = new PlanValidator();
    const result = validator.validate(plan);
    expect(result.estimatedGasEth).toBeGreaterThan(0.004); // swap + bridge
  });

  it('detects dependency on non-existent step', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const validator = new PlanValidator();
    const result = validator.validate({
      id: 'plan1', name: 'test', userId: 'u', createdAt: Date.now(), status: 'draft',
      root: {
        id: 'a1', type: 'action', label: 'swap', tool: 'defi_swap',
        params: {
          amount: { type: 'step_output', stepId: 'nonexistent', path: 'balance' },
        },
      },
    });

    expect(result.issues.some(i => i.code === 'CONTRA_CIRCULAR')).toBe(true);
  });

  it('condition trigger without expiry produces warning', async () => {
    const { PlanValidator } = await import('../extensions/crypto/src/services/plan-validator.js');
    const validator = new PlanValidator();
    const result = validator.validate({
      id: 'plan1', name: 'test', userId: 'u', createdAt: Date.now(), status: 'draft',
      trigger: {
        type: 'condition',
        when: { type: 'compare', left: { type: 'literal', value: 1 }, op: 'gt', right: { type: 'literal', value: 0 } },
      },
      root: { id: 'a1', type: 'action', label: 'check', tool: 'defi_price', params: {} },
    });

    expect(result.issues.some(i => i.code === 'TIME_NO_EXPIRY')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Plan Scheduler
// ══════════════════════════════════════════════════════════════════════════════

describe('PlanScheduler', () => {
  beforeEach(async () => {
    const { resetScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    resetScheduler();
  });

  afterEach(async () => {
    const { resetScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    resetScheduler();
  });

  it('starts and stops', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });
    sched.start();
    expect(sched.isRunning).toBe(true);
    sched.stop();
    expect(sched.isRunning).toBe(false);
  });

  it('adds and retrieves a plan', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });

    const plan = makePlan('p1', 'scheduled');
    sched.addPlan(plan);
    expect(sched.getPlan('p1')).toBeDefined();
    expect(sched.getPlan('p1')!.name).toBe('test');
  });

  it('cancels a plan', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });

    sched.addPlan(makePlan('p1', 'scheduled'));
    expect(sched.cancelPlan('p1')).toBe(true);
    expect(sched.getPlan('p1')!.status).toBe('cancelled');
  });

  it('pauses and resumes a plan', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });

    sched.addPlan(makePlan('p1', 'scheduled'));
    expect(sched.pausePlan('p1')).toBe(true);
    expect(sched.getPlan('p1')!.status).toBe('paused');
    expect(sched.resumePlan('p1')).toBe(true);
    expect(sched.getPlan('p1')!.status).toBe('scheduled');
  });

  it('evaluates simple comparison condition', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const sched = new PlanScheduler({
      tickMs: 100_000,
      store: createMemoryStore(),
      resolver: {
        price: async (t) => t === 'ETH' ? 4500 : 0,
        balance: async () => 0,
        gasPrice: async () => 0,
        timestamp: () => Math.floor(Date.now() / 1000),
        blockNumber: async () => 0,
      },
    });

    const result = await sched.evaluateCondition({
      type: 'compare',
      left: { type: 'runtime', fn: 'price', args: [{ type: 'literal', value: 'ETH' }] },
      op: 'gte',
      right: { type: 'literal', value: 4000 },
    });
    expect(result).toBe(true);

    const result2 = await sched.evaluateCondition({
      type: 'compare',
      left: { type: 'runtime', fn: 'price', args: [{ type: 'literal', value: 'ETH' }] },
      op: 'lt',
      right: { type: 'literal', value: 4000 },
    });
    expect(result2).toBe(false);
  });

  it('evaluates AND condition', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const sched = new PlanScheduler({
      tickMs: 100_000,
      store: createMemoryStore(),
      resolver: {
        price: async (t) => t === 'ETH' ? 4500 : t === 'BTC' ? 50000 : 0,
        balance: async () => 0, gasPrice: async () => 0,
        timestamp: () => Math.floor(Date.now() / 1000), blockNumber: async () => 0,
      },
    });

    const result = await sched.evaluateCondition({
      type: 'logic', op: 'and',
      conditions: [
        { type: 'compare', left: { type: 'runtime', fn: 'price', args: [{ type: 'literal', value: 'ETH' }] }, op: 'gte', right: { type: 'literal', value: 4000 } },
        { type: 'compare', left: { type: 'runtime', fn: 'price', args: [{ type: 'literal', value: 'BTC' }] }, op: 'gte', right: { type: 'literal', value: 100000 } },
      ],
    });
    expect(result).toBe(false); // BTC = 50000 < 100000
  });

  it('evaluates OR condition', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const sched = new PlanScheduler({
      tickMs: 100_000,
      store: createMemoryStore(),
      resolver: {
        price: async (t) => t === 'ETH' ? 4500 : 0,
        balance: async () => 0, gasPrice: async () => 0,
        timestamp: () => Math.floor(Date.now() / 1000), blockNumber: async () => 0,
      },
    });

    const result = await sched.evaluateCondition({
      type: 'logic', op: 'or',
      conditions: [
        { type: 'compare', left: { type: 'runtime', fn: 'price', args: [{ type: 'literal', value: 'ETH' }] }, op: 'gte', right: { type: 'literal', value: 4000 } },
        { type: 'compare', left: { type: 'literal', value: 0 }, op: 'gt', right: { type: 'literal', value: 1 } },
      ],
    });
    expect(result).toBe(true); // ETH >= 4000 is true
  });

  it('evaluates NOT condition', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });

    const result = await sched.evaluateCondition({
      type: 'logic', op: 'not',
      conditions: [
        { type: 'compare', left: { type: 'literal', value: 1 }, op: 'gt', right: { type: 'literal', value: 2 } },
      ],
    });
    expect(result).toBe(true); // NOT (1 > 2) = true
  });

  it('fires immediate trigger event', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const store = createMemoryStore();
    const sched = new PlanScheduler({ tickMs: 50, store });

    const events: any[] = [];
    sched.on((e) => events.push(e));

    const plan = makePlan('p1', 'scheduled');
    plan.trigger = { type: 'immediate' };
    sched.addPlan(plan);
    sched.start();

    await sleep(200);
    sched.stop();

    expect(events.some(e => e.type === 'trigger_fired' && e.plan.id === 'p1')).toBe(true);
  });

  it('fires time trigger when time arrives', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const store = createMemoryStore();
    const sched = new PlanScheduler({ tickMs: 50, store });

    const events: any[] = [];
    sched.on((e) => events.push(e));

    const plan = makePlan('p2', 'scheduled');
    plan.trigger = { type: 'time', at: new Date(Date.now() + 50).toISOString() };
    sched.addPlan(plan);
    sched.start();

    await sleep(300);
    sched.stop();

    expect(events.some(e => e.type === 'trigger_fired' && e.plan.id === 'p2')).toBe(true);
  });

  it('lists all plans', async () => {
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const store = createMemoryStore();
    const sched = new PlanScheduler({ tickMs: 100_000, store });

    sched.addPlan(makePlan('p1', 'scheduled'));
    sched.addPlan(makePlan('p2', 'scheduled'));
    const plans = sched.listPlans();
    expect(plans.length).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Plan Executor
// ══════════════════════════════════════════════════════════════════════════════

describe('PlanExecutor', () => {
  it('executes a single action plan', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });
    const executor = new PlanExecutor({
      dispatcher: createMockDispatcher({ defi_swap: { success: true, txHash: '0xabc' } }),
      scheduler: sched,
    });

    const plan = makePlan('p1', 'validated');
    plan.root = { id: 'swap1', type: 'action', label: 'Swap', tool: 'defi_swap', params: { token_in: 'ETH', token_out: 'USDC' } };
    sched.addPlan(plan);

    const exec = await executor.execute(plan, 'exec1');
    expect(exec.status).toBe('completed');
    expect(exec.steps.length).toBe(1);
    expect(exec.steps[0].status).toBe('completed');
    expect(exec.steps[0].result).toEqual({ success: true, txHash: '0xabc' });
  });

  it('executes a sequence of actions', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });
    const callLog: string[] = [];
    const executor = new PlanExecutor({
      dispatcher: {
        call: async (name: string) => { callLog.push(name); return { ok: true }; },
        exists: () => true,
      },
      scheduler: sched,
    });

    const plan = makePlan('p1', 'validated');
    plan.root = {
      id: 'seq1', type: 'sequence', label: 'steps', steps: [
        { id: 'a1', type: 'action', label: 'price', tool: 'defi_price', params: {} },
        { id: 'a2', type: 'action', label: 'swap', tool: 'defi_swap', params: {} },
        { id: 'a3', type: 'action', label: 'check', tool: 'defi_balance', params: {} },
      ],
    };
    sched.addPlan(plan);

    const exec = await executor.execute(plan, 'exec1');
    expect(exec.status).toBe('completed');
    expect(callLog).toEqual(['defi_price', 'defi_swap', 'defi_balance']);
  });

  it('handles action failure with abort policy', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });
    const executor = new PlanExecutor({
      dispatcher: {
        call: async (name: string) => { if (name === 'defi_swap') throw new Error('Insufficient balance'); return {}; },
        exists: () => true,
      },
      scheduler: sched,
    });

    const plan = makePlan('p1', 'validated');
    plan.root = {
      id: 'seq1', type: 'sequence', label: 'steps', steps: [
        { id: 'a1', type: 'action', label: 'swap', tool: 'defi_swap', params: {} },
        { id: 'a2', type: 'action', label: 'bridge', tool: 'bridge', params: {} },
      ],
    };
    sched.addPlan(plan);

    const exec = await executor.execute(plan, 'exec1');
    expect(exec.status).toBe('failed');
    expect(exec.steps.length).toBe(1); // bridge never started
    expect(exec.steps[0].status).toBe('failed');
    expect(exec.steps[0].error).toContain('Insufficient balance');
  });

  it('handles skip failure policy', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });
    const callLog: string[] = [];
    const executor = new PlanExecutor({
      dispatcher: {
        call: async (name: string) => {
          callLog.push(name);
          if (name === 'defi_swap') throw new Error('fail');
          return {};
        },
        exists: () => true,
      },
      scheduler: sched,
    });

    const plan = makePlan('p1', 'validated');
    plan.root = {
      id: 'seq1', type: 'sequence', label: 'steps', steps: [
        { id: 'a1', type: 'action', label: 'swap', tool: 'defi_swap', params: {}, onFailure: { strategy: 'skip' } },
        { id: 'a2', type: 'action', label: 'check', tool: 'defi_balance', params: {} },
      ],
    };
    sched.addPlan(plan);

    const exec = await executor.execute(plan, 'exec1');
    expect(exec.status).toBe('completed'); // plan continues despite swap failure
    expect(callLog).toEqual(['defi_swap', 'defi_balance']);
    expect(exec.steps[0].status).toBe('skipped');
    expect(exec.steps[1].status).toBe('completed');
  });

  it('handles retry failure policy', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });
    let attempts = 0;
    const executor = new PlanExecutor({
      dispatcher: {
        call: async () => {
          attempts++;
          if (attempts < 3) throw new Error('transient');
          return { ok: true };
        },
        exists: () => true,
      },
      scheduler: sched,
    });

    const plan = makePlan('p1', 'validated');
    plan.root = {
      id: 'a1', type: 'action', label: 'swap', tool: 'defi_swap', params: {},
      onFailure: { strategy: 'retry', maxAttempts: 5, delayMs: 10 },
    };
    sched.addPlan(plan);

    const exec = await executor.execute(plan, 'exec1');
    expect(exec.status).toBe('completed');
    expect(exec.steps[0].retryCount).toBe(2); // failed twice, succeeded on 3rd
  });

  it('cancellation stops execution', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });
    const callLog: string[] = [];
    let executor: any;

    const plan = makePlan('p1', 'validated');
    plan.root = {
      id: 'seq1', type: 'sequence', label: 'steps', steps: [
        { id: 'a1', type: 'action', label: 'slow', tool: 'defi_price', params: {} },
        { id: 'a2', type: 'action', label: 'never', tool: 'defi_swap', params: {} },
      ],
    };
    sched.addPlan(plan);

    executor = new PlanExecutor({
      dispatcher: {
        call: async (name: string) => {
          callLog.push(name);
          if (name === 'defi_price') {
            // Cancel during first step
            executor.cancel('exec1');
          }
          return {};
        },
        exists: () => true,
      },
      scheduler: sched,
    });

    const exec = await executor.execute(plan, 'exec1');
    expect(exec.status).toBe('cancelled');
    expect(callLog).toEqual(['defi_price']); // second step never ran
  });

  it('confirmation callback can block execution', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const sched = new PlanScheduler({ tickMs: 100_000, store: createMemoryStore() });
    const executor = new PlanExecutor({
      dispatcher: createMockDispatcher({ defi_swap: { ok: true } }),
      scheduler: sched,
      onConfirmRequired: async () => false, // always decline
    });

    const plan = makePlan('p1', 'validated');
    plan.root = { id: 'a1', type: 'action', label: 'swap', tool: 'defi_swap', params: {}, requireConfirmation: true };
    sched.addPlan(plan);

    const exec = await executor.execute(plan, 'exec1');
    expect(exec.steps[0].status).toBe('skipped');
    expect(exec.steps[0].error).toContain('declined');
  });

  it('formats execution summary', async () => {
    const { formatExecutionSummary } = await import('../extensions/crypto/src/services/plan-executor.js');
    const summary = formatExecutionSummary({
      planId: 'p1', executionId: 'e1', status: 'completed',
      startedAt: Date.now() - 5000, completedAt: Date.now(),
      steps: [
        { nodeId: 'a1', status: 'completed', startedAt: Date.now() - 4000, completedAt: Date.now() - 2000 },
        { nodeId: 'a2', status: 'failed', startedAt: Date.now() - 2000, completedAt: Date.now(), error: 'boom' },
      ],
    }, makePlan('p1', 'completed'));

    expect(summary).toContain('**Plan: test**');
    expect(summary).toContain('[OK] a1');
    expect(summary).toContain('[FAIL] a2');
    expect(summary).toContain('boom');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Builder Code (ERC-8021)
// ══════════════════════════════════════════════════════════════════════════════

describe('Base Builder Code (ERC-8021)', () => {
  it('BUILDER_CODE is correct', async () => {
    const { BUILDER_CODE } = await import('../extensions/crypto/src/services/builder-code.js');
    expect(BUILDER_CODE).toBe('bc_z92vaimh');
  });

  it('DATA_SUFFIX is correctly encoded', async () => {
    const { DATA_SUFFIX, BUILDER_CODE } = await import('../extensions/crypto/src/services/builder-code.js');
    // Verify format: [len][code_utf8][0x00][8021 x 8]
    const hex = DATA_SUFFIX.slice(2); // remove 0x
    const lenByte = parseInt(hex.slice(0, 2), 16);
    expect(lenByte).toBe(BUILDER_CODE.length); // 11

    const codeHex = hex.slice(2, 2 + lenByte * 2);
    const decoded = Buffer.from(codeHex, 'hex').toString('utf8');
    expect(decoded).toBe(BUILDER_CODE);

    // Separator
    expect(hex.slice(2 + lenByte * 2, 2 + lenByte * 2 + 2)).toBe('00');

    // Magic suffix — all remaining bytes are 8021 repeated
    const magic = hex.slice(2 + lenByte * 2 + 2);
    expect(magic).toBe('80218021802180218021802180218021');
    expect(magic.length / 4).toBe(8); // 8 repetitions of 8021
  });

  it('appendBuilderCode adds suffix to empty data for Base', async () => {
    const { appendBuilderCode, DATA_SUFFIX } = await import('../extensions/crypto/src/services/builder-code.js');
    expect(appendBuilderCode(undefined, 8453)).toBe(DATA_SUFFIX);
    expect(appendBuilderCode('0x', 8453)).toBe(DATA_SUFFIX);
  });

  it('appendBuilderCode appends to existing calldata for Base', async () => {
    const { appendBuilderCode, DATA_SUFFIX } = await import('../extensions/crypto/src/services/builder-code.js');
    const result = appendBuilderCode('0xabcdef', 8453);
    expect(result).toBe('0xabcdef' + DATA_SUFFIX.slice(2));
  });

  it('appendBuilderCode does NOT modify data for non-Base chains', async () => {
    const { appendBuilderCode } = await import('../extensions/crypto/src/services/builder-code.js');
    expect(appendBuilderCode('0xabcdef', 1)).toBe('0xabcdef');
    expect(appendBuilderCode('0xabcdef', 42161)).toBe('0xabcdef');
    expect(appendBuilderCode(undefined, 1)).toBeUndefined();
  });

  it('appendBuilderCode works for Base Sepolia', async () => {
    const { appendBuilderCode, DATA_SUFFIX } = await import('../extensions/crypto/src/services/builder-code.js');
    expect(appendBuilderCode(undefined, 84532)).toBe(DATA_SUFFIX);
  });

  it('hasBuilderCode detects presence of suffix', async () => {
    const { hasBuilderCode, DATA_SUFFIX } = await import('../extensions/crypto/src/services/builder-code.js');
    expect(hasBuilderCode(DATA_SUFFIX)).toBe(true);
    expect(hasBuilderCode('0xabcdef' + DATA_SUFFIX.slice(2))).toBe(true);
    expect(hasBuilderCode('0xabcdef')).toBe(false);
    expect(hasBuilderCode(undefined)).toBe(false);
  });

  it('wrapWithBuilderCode wraps sendTransaction for Base', async () => {
    const { wrapWithBuilderCode } = await import('../extensions/crypto/src/services/builder-code.js');

    const calls: any[] = [];
    const mockClient = {
      chain: { id: 8453 },
      sendTransaction: async (args: any) => { calls.push(args); return '0xhash'; },
    };

    const wrapped = wrapWithBuilderCode(mockClient);
    await wrapped.sendTransaction({ to: '0xabc', value: 100n });

    expect(calls.length).toBe(1);
    expect(calls[0].data).toBeDefined(); // suffix was added
    expect(calls[0].data).toContain('8021');
  });

  it('wrapWithBuilderCode passes through for non-Base chain', async () => {
    const { wrapWithBuilderCode } = await import('../extensions/crypto/src/services/builder-code.js');

    const mockClient = {
      chain: { id: 1 },
      sendTransaction: async (args: any) => '0xhash',
    };

    const wrapped = wrapWithBuilderCode(mockClient);
    expect(wrapped).toBe(mockClient); // not wrapped, returned as-is
  });

  it('wrapWithBuilderCode appends to existing data', async () => {
    const { wrapWithBuilderCode, DATA_SUFFIX } = await import('../extensions/crypto/src/services/builder-code.js');

    const calls: any[] = [];
    const mockClient = {
      chain: { id: 8453 },
      sendTransaction: async (args: any) => { calls.push(args); return '0xhash'; },
    };

    const wrapped = wrapWithBuilderCode(mockClient);
    await wrapped.sendTransaction({ to: '0xabc', data: '0xdeadbeef' });

    expect(calls[0].data).toBe('0xdeadbeef' + DATA_SUFFIX.slice(2));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Compound Action Tool
// ══════════════════════════════════════════════════════════════════════════════

describe('compound_action tool', () => {
  beforeEach(async () => {
    const { resetScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    resetScheduler();
    // Clean up any persisted plan files from previous test runs
    const fs = await import('node:fs');
    const path = await import('node:path');
    const plansDir = path.join(process.env.HOME ?? '/tmp', '.openclawnch', 'plans');
    try {
      if (fs.existsSync(plansDir)) {
        const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.json'));
        for (const f of files) fs.unlinkSync(path.join(plansDir, f));
      }
    } catch { /* ignore */ }
  });

  it('has correct tool shape', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    expect(tool.name).toBe('compound_action');
    expect(tool.ownerOnly).toBe(true);
    expect(typeof tool.execute).toBe('function');
    expect(tool.parameters).toBeDefined();
  });

  it('create action compiles and validates an intent', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    const result = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'swap 1 ETH for USDC',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
      },
    });

    const data = (result as any).details;
    expect(data.plan_id).toMatch(/^plan_/);
    expect(data.status).toBe('validated');
    expect(data.validation.valid).toBe(true);
    expect(data.validation.tools_used).toContain('defi_swap');
  });

  it('create with condition trigger', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    const result = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'when ETH > 4000, sell half',
        trigger: { type: 'when_condition', token: 'ETH', op: 'gte', value: 4000 },
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount_pct: 50 }],
      },
    });

    const data = (result as any).details;
    expect(data.trigger).toContain('condition');
  });

  it('list returns empty when no plans', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    const result = await tool.execute('call1', { action: 'list' });
    const data = (result as any).details;
    expect(data.plans).toEqual([]);
  });

  it('create then list shows the plan', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'test plan',
        steps: [{ action: 'check_price', token: 'ETH' }],
      },
    });

    const result = await tool.execute('call2', { action: 'list' });
    const data = (result as any).details;
    expect(data.total).toBe(1);
  });

  it('cancel removes a plan', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'test',
        steps: [{ action: 'check_price', token: 'ETH' }],
      },
    });
    const planId = (createResult as any).details.plan_id;

    const cancelResult = await tool.execute('call2', { action: 'cancel', plan_id: planId });
    expect((cancelResult as any).details.status).toBe('cancelled');
  });

  it('status returns plan details', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'swap and bridge',
        steps: [
          { action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' },
          { action: 'bridge', token: 'USDC', amount: '500', to_chain: 42161 },
        ],
      },
    });
    const planId = (createResult as any).details.plan_id;

    const statusResult = await tool.execute('call2', { action: 'status', plan_id: planId });
    const data = (statusResult as any).details;
    expect(data.name).toBeDefined();
    expect(data.steps.length).toBeGreaterThan(0);
  });

  it('returns error for missing intent on create', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    const result = await tool.execute('call1', { action: 'create' });
    expect((result as any).isError).toBe(true);
  });

  it('returns error for unknown plan_id on cancel', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    const result = await tool.execute('call1', { action: 'cancel', plan_id: 'nonexistent' });
    expect((result as any).isError).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

function makePlan(id: string, status: string): any {
  return {
    id,
    name: 'test',
    userId: 'user1',
    createdAt: Date.now(),
    status,
    root: { id: 'a1', type: 'action', label: 'test', tool: 'defi_price', params: {} },
  };
}

function createMemoryStore(): any {
  const plans = new Map<string, any>();
  const executions = new Map<string, any[]>();
  return {
    save: (plan: any) => plans.set(plan.id, { ...plan }),
    load: (id: string) => plans.get(id) ?? null,
    loadAll: (userId?: string) => {
      const all = [...plans.values()];
      return userId ? all.filter(p => p.userId === userId) : all;
    },
    delete: (id: string) => plans.delete(id),
    saveExecution: (exec: any) => {
      const list = executions.get(exec.planId) ?? [];
      list.push(exec);
      executions.set(exec.planId, list);
    },
    loadExecutions: (planId: string) => executions.get(planId) ?? [],
  };
}

function createMockDispatcher(results: Record<string, any>): any {
  return {
    call: async (name: string) => results[name] ?? { ok: true },
    exists: (name: string) => name in results || true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
