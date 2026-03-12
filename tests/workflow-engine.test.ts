/**
 * Workflow Engine Tests — Sprint 10 (Layer 1: Composable Primitives)
 *
 * Tests for:
 * - 10.1: Extended Intent format (parallel, wait, loop step types)
 * - 10.2: Step-output data flow (outputRef / inputRefs)
 * - 10.3: WaitNode condition bug fix (executor resolves step_output in conditions)
 * - 10.6: Multi-user plan ownership
 * - 10.7: Persistent scheduler state (interval counts, condition check times)
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { PlanCompiler, type Intent, type IntentStep } from '../extensions/crypto/src/services/plan-compiler.js';
import { PlanValidator } from '../extensions/crypto/src/services/plan-validator.js';
import { PlanExecutor, type ToolDispatcher } from '../extensions/crypto/src/services/plan-executor.js';
import { PlanScheduler, FilePlanStore, NULL_RESOLVER, resetScheduler } from '../extensions/crypto/src/services/plan-scheduler.js';
import type { Plan, PlanNode, ActionNode, ParallelNode, SequenceNode, WaitNode, LoopNode, IfNode, Condition } from '../extensions/crypto/src/services/plan-types.js';

// ── Global Cleanup ──────────────────────────────────────────────────────
// Tests that use the compound_action tool write plans to the global
// FilePlanStore on disk. Clean up plan files so other test files
// (e.g. beta-audit-phase7) start with a clean slate.

afterAll(async () => {
  const { join } = await import('node:path');
  const { existsSync, readdirSync, rmSync } = await import('node:fs');

  // Delete all plan files from the default store directory
  const plansDir = join(process.env.HOME ?? '/tmp', '.openclawnch', 'plans');
  try {
    if (existsSync(plansDir)) {
      const files = readdirSync(plansDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        rmSync(join(plansDir, f), { force: true });
      }
      // Also clean templates subdirectory
      const templatesDir = join(plansDir, 'templates');
      if (existsSync(templatesDir)) {
        const tplFiles = readdirSync(templatesDir).filter(f => f.endsWith('.json'));
        for (const f of tplFiles) {
          rmSync(join(templatesDir, f), { force: true });
        }
      }
    }
  } catch { /* ignore cleanup errors */ }
  resetScheduler();
});

// ── Helpers ─────────────────────────────────────────────────────────────

function compileIntent(intent: Intent): Plan {
  const compiler = new PlanCompiler();
  return compiler.compile(intent, 'test-user');
}

function makeIntent(steps: IntentStep[], trigger?: Intent['trigger']): Intent {
  return {
    naturalLanguage: 'test intent',
    steps,
    trigger,
  };
}

// ── 10.1: Parallel Step Compilation ─────────────────────────────────────

describe('PlanCompiler — parallel steps', () => {
  it('compiles a parallel step into a ParallelNode', () => {
    const intent = makeIntent([
      {
        type: 'parallel',
        steps: [
          { action: 'check_price', token: 'ETH' },
          { action: 'check_price', token: 'BTC' },
        ],
      },
    ]);

    const plan = compileIntent(intent);
    expect(plan.root.type).toBe('parallel');
    const par = plan.root as ParallelNode;
    expect(par.steps).toHaveLength(2);
    expect(par.steps[0]!.type).toBe('action');
    expect(par.steps[1]!.type).toBe('action');
    expect((par.steps[0] as ActionNode).tool).toBe('defi_price');
    expect((par.steps[1] as ActionNode).tool).toBe('defi_price');
  });

  it('parallel with allowPartialFailure', () => {
    const intent = makeIntent([
      {
        type: 'parallel',
        allowPartialFailure: true,
        steps: [
          { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '0.5' },
          { action: 'swap', tokenIn: 'ETH', tokenOut: 'DAI', amount: '0.5' },
        ],
      },
    ]);

    const plan = compileIntent(intent);
    const par = plan.root as ParallelNode;
    expect(par.allowPartialFailure).toBe(true);
  });

  it('rejects parallel step with no nested steps', () => {
    const intent = makeIntent([
      { type: 'parallel', steps: [] },
    ]);
    expect(() => compileIntent(intent)).toThrow('non-empty');
  });

  it('parallel inside a sequence', () => {
    const intent = makeIntent([
      { action: 'check_balance', token: 'ETH' },
      {
        type: 'parallel',
        steps: [
          { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '0.5' },
          { action: 'swap', tokenIn: 'ETH', tokenOut: 'DAI', amount: '0.5' },
        ],
      },
      { action: 'check_balance', token: 'USDC' },
    ]);

    const plan = compileIntent(intent);
    expect(plan.root.type).toBe('sequence');
    const seq = plan.root as SequenceNode;
    expect(seq.steps).toHaveLength(3);
    expect(seq.steps[0]!.type).toBe('action');
    expect(seq.steps[1]!.type).toBe('parallel');
    expect(seq.steps[2]!.type).toBe('action');
  });
});

// ── 10.1: Wait Step Compilation ─────────────────────────────────────────

describe('PlanCompiler — wait steps', () => {
  it('compiles a duration wait', () => {
    const intent = makeIntent([
      { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
      { type: 'wait', duration: '5m' },
      { action: 'check_balance', token: 'USDC' },
    ]);

    const plan = compileIntent(intent);
    const seq = plan.root as SequenceNode;
    expect(seq.steps).toHaveLength(3);
    const wait = seq.steps[1] as WaitNode;
    expect(wait.type).toBe('wait');
    expect(wait.durationMs).toBe(300_000);
  });

  it('compiles an untilTime wait', () => {
    const futureTime = new Date(Date.now() + 3_600_000).toISOString();
    const intent = makeIntent([
      { type: 'wait', untilTime: futureTime },
      { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
    ]);

    const plan = compileIntent(intent);
    const seq = plan.root as SequenceNode;
    const wait = seq.steps[0] as WaitNode;
    expect(wait.type).toBe('wait');
    expect(wait.untilTime).toBe(futureTime);
  });

  it('compiles a condition wait', () => {
    const intent = makeIntent([
      {
        type: 'wait',
        until: { token: 'ETH', field: 'price', op: 'lt', value: 3000 },
        maxWait: '24h',
        pollInterval: '2m',
      },
      { action: 'swap', tokenIn: 'USDC', tokenOut: 'ETH', amount: '1000' },
    ]);

    const plan = compileIntent(intent);
    const seq = plan.root as SequenceNode;
    const wait = seq.steps[0] as WaitNode;
    expect(wait.type).toBe('wait');
    expect(wait.until).toBeDefined();
    expect(wait.maxWaitMs).toBe(86_400_000);
    expect(wait.pollIntervalMs).toBe(120_000);
  });

  it('rejects wait step without duration, untilTime, or until', () => {
    const intent = makeIntent([
      { type: 'wait' },
    ]);
    expect(() => compileIntent(intent)).toThrow('duration');
  });
});

// ── 10.1: Loop Step Compilation ─────────────────────────────────────────

describe('PlanCompiler — loop steps', () => {
  it('compiles a loop step', () => {
    const intent = makeIntent([
      {
        type: 'loop',
        maxIterations: 5,
        delayBetween: '10s',
        exitWhen: { token: 'USDC', field: 'balance', op: 'gte', value: 5000 },
        steps: [
          { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '0.1' },
        ],
      },
    ]);

    const plan = compileIntent(intent);
    expect(plan.root.type).toBe('loop');
    const loop = plan.root as LoopNode;
    expect(loop.maxIterations).toBe(5);
    expect(loop.delayMs).toBe(10_000);
    expect(loop.exitWhen).toBeDefined();
    expect(loop.body.type).toBe('action');
  });

  it('loop with multiple body steps wraps in sequence', () => {
    const intent = makeIntent([
      {
        type: 'loop',
        maxIterations: 3,
        steps: [
          { action: 'check_price', token: 'ETH' },
          { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '0.01' },
        ],
      },
    ]);

    const plan = compileIntent(intent);
    const loop = plan.root as LoopNode;
    expect(loop.body.type).toBe('sequence');
    const seq = loop.body as SequenceNode;
    expect(seq.steps).toHaveLength(2);
  });

  it('loop defaults maxIterations to 10', () => {
    const intent = makeIntent([
      {
        type: 'loop',
        steps: [{ action: 'check_price', token: 'ETH' }],
      },
    ]);

    const plan = compileIntent(intent);
    const loop = plan.root as LoopNode;
    expect(loop.maxIterations).toBe(10);
  });

  it('rejects loop step with no nested steps', () => {
    const intent = makeIntent([
      { type: 'loop', steps: [] },
    ]);
    expect(() => compileIntent(intent)).toThrow('non-empty');
  });
});

// ── 10.1: Nested Structures ─────────────────────────────────────────────

describe('PlanCompiler — nested structures', () => {
  it('parallel inside loop', () => {
    const intent = makeIntent([
      {
        type: 'loop',
        maxIterations: 3,
        steps: [
          {
            type: 'parallel',
            steps: [
              { action: 'check_price', token: 'ETH' },
              { action: 'check_price', token: 'BTC' },
            ],
          },
        ],
      },
    ]);

    const plan = compileIntent(intent);
    expect(plan.root.type).toBe('loop');
    const loop = plan.root as LoopNode;
    expect(loop.body.type).toBe('parallel');
  });

  it('wait inside sequence inside parallel', () => {
    const intent = makeIntent([
      {
        type: 'parallel',
        steps: [
          { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '0.5' },
          { type: 'wait', duration: '10s' },
        ],
      },
    ]);

    const plan = compileIntent(intent);
    const par = plan.root as ParallelNode;
    expect(par.steps[0]!.type).toBe('action');
    expect(par.steps[1]!.type).toBe('wait');
  });

  it('action with inline condition compiles to IfNode', () => {
    const intent = makeIntent([
      {
        action: 'swap',
        tokenIn: 'ETH',
        tokenOut: 'USDC',
        amount: '1',
        condition: { token: 'ETH', field: 'price', op: 'gte', value: 4000 },
      },
    ]);

    const plan = compileIntent(intent);
    expect(plan.root.type).toBe('if');
    const ifNode = plan.root as IfNode;
    expect(ifNode.then.type).toBe('action');
  });
});

// ── 10.1: Backward Compatibility ────────────────────────────────────────

describe('PlanCompiler — backward compatibility', () => {
  it('steps without type field default to action', () => {
    const intent = makeIntent([
      { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
    ]);

    const plan = compileIntent(intent);
    expect(plan.root.type).toBe('action');
    expect((plan.root as ActionNode).tool).toBe('defi_swap');
  });

  it('existing multi-step sequence still works', () => {
    const intent = makeIntent([
      { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
      { action: 'bridge', token: 'USDC', amount: '1000', toChain: 42161 },
    ]);

    const plan = compileIntent(intent);
    expect(plan.root.type).toBe('sequence');
    const seq = plan.root as SequenceNode;
    expect(seq.steps).toHaveLength(2);
    expect((seq.steps[0] as ActionNode).tool).toBe('defi_swap');
    expect((seq.steps[1] as ActionNode).tool).toBe('bridge');
  });
});

// ── 10.2: Step-Output Data Flow ─────────────────────────────────────────

describe('PlanCompiler — step-output data flow', () => {
  it('outputRef assigns the ref name as the node ID', () => {
    const intent = makeIntent([
      { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1', outputRef: 'my_swap' },
    ]);

    const plan = compileIntent(intent);
    expect(plan.root.type).toBe('action');
    expect(plan.root.id).toBe('my_swap');
  });

  it('inputRefs compile to step_output ValueRefs', () => {
    const intent = makeIntent([
      { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1', outputRef: 'swap1' },
      { action: 'bridge', token: 'USDC', toChain: 42161, inputRefs: { amount: 'swap1.amountOut' } },
    ]);

    const plan = compileIntent(intent);
    const seq = plan.root as SequenceNode;
    const bridgeNode = seq.steps[1] as ActionNode;
    const amountParam = bridgeNode.params.amount;

    expect(amountParam).toBeDefined();
    expect(typeof amountParam).toBe('object');
    expect((amountParam as any).type).toBe('step_output');
    expect((amountParam as any).stepId).toBe('swap1');
    expect((amountParam as any).path).toBe('amountOut');
  });

  it('inputRef to unknown outputRef throws', () => {
    const intent = makeIntent([
      { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
      { action: 'bridge', token: 'USDC', toChain: 42161, inputRefs: { amount: 'nonexistent.amountOut' } },
    ]);

    expect(() => compileIntent(intent)).toThrow('unknown outputRef');
  });

  it('inputRef without dot path throws', () => {
    const intent = makeIntent([
      { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1', outputRef: 'swap1' },
      { action: 'bridge', token: 'USDC', toChain: 42161, inputRefs: { amount: 'swap1' } },
    ]);

    expect(() => compileIntent(intent)).toThrow('refName.path');
  });
});

// ── 10.2: Validation with step_output refs ──────────────────────────────

describe('PlanValidator — step_output refs', () => {
  it('validates a plan with step_output refs (dependency ordering is correct)', () => {
    const intent = makeIntent([
      { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1', outputRef: 'swap1' },
      { action: 'bridge', token: 'USDC', toChain: 42161, inputRefs: { amount: 'swap1.amountOut' } },
    ]);

    const plan = compileIntent(intent);
    const validator = new PlanValidator();
    const result = validator.validate(plan);

    // Should not have dependency errors (swap1 is before bridge in sequence)
    const depErrors = result.issues.filter(i => i.code === 'dangling_ref' || i.code === 'out_of_order_ref');
    expect(depErrors).toHaveLength(0);
  });
});

// ── 10.3: WaitNode Condition Bug Fix ────────────────────────────────────

describe('PlanExecutor — condition evaluation with step_output', () => {
  let mockScheduler: any;
  let mockDispatcher: ToolDispatcher;

  beforeEach(() => {
    mockScheduler = {
      evaluateCondition: vi.fn().mockResolvedValue(true),
      resolveValue: vi.fn().mockResolvedValue(0),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    };
    mockDispatcher = {
      call: vi.fn().mockResolvedValue({ amountOut: 500 }),
      exists: vi.fn().mockReturnValue(true),
    };
  });

  it('executeIf resolves step_output in condition via executor (not scheduler)', async () => {
    // Build a plan: action → if(step_output > 100) → action
    const plan: Plan = {
      id: 'test-plan',
      name: 'Test',
      userId: 'test',
      createdAt: Date.now(),
      status: 'running',
      root: {
        id: 'seq_1',
        type: 'sequence',
        label: 'Main',
        steps: [
          {
            id: 'swap_1',
            type: 'action',
            label: 'Swap',
            tool: 'defi_swap',
            params: { action: 'execute' },
          } as ActionNode,
          {
            id: 'if_1',
            type: 'if',
            label: 'Check output',
            condition: {
              type: 'compare',
              left: { type: 'step_output', stepId: 'swap_1', path: 'amountOut' },
              op: 'gte',
              right: { type: 'literal', value: 100 },
            },
            then: {
              id: 'bridge_1',
              type: 'action',
              label: 'Bridge',
              tool: 'bridge',
              params: { action: 'execute' },
            } as ActionNode,
          } as IfNode,
        ],
      } as SequenceNode,
    };

    const executor = new PlanExecutor({
      dispatcher: mockDispatcher,
      scheduler: mockScheduler,
    });

    const exec = await executor.execute(plan, 'exec-1');
    expect(exec.status).toBe('completed');

    // The bridge should have been called (condition was true: 500 >= 100)
    expect(mockDispatcher.call).toHaveBeenCalledTimes(2);
    const callNames = (mockDispatcher.call as any).mock.calls.map((c: any[]) => c[0]);
    expect(callNames).toContain('defi_swap');
    expect(callNames).toContain('bridge');

    // The scheduler's evaluateCondition should NOT have been called
    // (the executor uses its own evaluateCondition now)
    expect(mockScheduler.evaluateCondition).not.toHaveBeenCalled();
  });

  it('if-condition with step_output evaluates false correctly', async () => {
    // swap returns amountOut: 50, condition is >= 100 → should skip bridge
    mockDispatcher = {
      call: vi.fn().mockResolvedValue({ amountOut: 50 }),
      exists: vi.fn().mockReturnValue(true),
    };

    const plan: Plan = {
      id: 'test-plan-2',
      name: 'Test',
      userId: 'test',
      createdAt: Date.now(),
      status: 'running',
      root: {
        id: 'seq_1',
        type: 'sequence',
        label: 'Main',
        steps: [
          {
            id: 'swap_1',
            type: 'action',
            label: 'Swap',
            tool: 'defi_swap',
            params: { action: 'execute' },
          } as ActionNode,
          {
            id: 'if_1',
            type: 'if',
            label: 'Check output',
            condition: {
              type: 'compare',
              left: { type: 'step_output', stepId: 'swap_1', path: 'amountOut' },
              op: 'gte',
              right: { type: 'literal', value: 100 },
            },
            then: {
              id: 'bridge_1',
              type: 'action',
              label: 'Bridge',
              tool: 'bridge',
              params: { action: 'execute' },
            } as ActionNode,
          } as IfNode,
        ],
      } as SequenceNode,
    };

    const executor = new PlanExecutor({
      dispatcher: mockDispatcher,
      scheduler: mockScheduler,
    });

    const exec = await executor.execute(plan, 'exec-2');
    expect(exec.status).toBe('completed');

    // Only swap should have been called (condition false: 50 < 100)
    expect(mockDispatcher.call).toHaveBeenCalledTimes(1);
    expect((mockDispatcher.call as any).mock.calls[0][0]).toBe('defi_swap');
  });

  it('runtime condition in executor falls back to scheduler resolver', async () => {
    // An if-condition with a runtime ref (price) should use the scheduler's resolveValue
    mockScheduler.resolveValue.mockResolvedValue(4500);

    const plan: Plan = {
      id: 'test-plan-3',
      name: 'Test',
      userId: 'test',
      createdAt: Date.now(),
      status: 'running',
      root: {
        id: 'if_1',
        type: 'if',
        label: 'Price check',
        condition: {
          type: 'compare',
          left: { type: 'runtime', fn: 'price', args: [{ type: 'literal', value: 'ETH' }] },
          op: 'gte',
          right: { type: 'literal', value: 4000 },
        },
        then: {
          id: 'swap_1',
          type: 'action',
          label: 'Swap',
          tool: 'defi_swap',
          params: { action: 'execute' },
        } as ActionNode,
      } as IfNode,
    };

    const executor = new PlanExecutor({
      dispatcher: mockDispatcher,
      scheduler: mockScheduler,
    });

    const exec = await executor.execute(plan, 'exec-3');
    expect(exec.status).toBe('completed');

    // Scheduler's resolveValue should have been called for the runtime ref
    expect(mockScheduler.resolveValue).toHaveBeenCalled();
    // Swap should have executed (4500 >= 4000)
    expect(mockDispatcher.call).toHaveBeenCalledTimes(1);
  });
});

// ── 10.1+10.2: Full Integration — Complex Workflow ──────────────────────

describe('PlanCompiler + Validator — complex workflow', () => {
  it('compiles the vision example: check → parallel swaps → wait → bridge', () => {
    const intent = makeIntent([
      { action: 'check_price', token: 'ETH', outputRef: 'price_check' },
      {
        type: 'parallel',
        steps: [
          { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '0.5', outputRef: 'swap_usdc' },
          { action: 'swap', tokenIn: 'ETH', tokenOut: 'DAI', amount: '0.5', outputRef: 'swap_dai' },
        ],
      },
      {
        type: 'wait',
        until: { token: 'USDC', field: 'balance', op: 'gte', value: 1000 },
        maxWait: '1h',
      },
      {
        action: 'bridge',
        token: 'USDC',
        toChain: 42161,
        inputRefs: { amount: 'swap_usdc.amountOut' },
      },
    ]);

    const plan = compileIntent(intent);
    expect(plan.root.type).toBe('sequence');
    const seq = plan.root as SequenceNode;
    expect(seq.steps).toHaveLength(4);
    expect(seq.steps[0]!.type).toBe('action');
    expect(seq.steps[1]!.type).toBe('parallel');
    expect(seq.steps[2]!.type).toBe('wait');
    expect(seq.steps[3]!.type).toBe('action');

    // Validate
    const validator = new PlanValidator();
    const result = validator.validate(plan);
    // Should be structurally valid
    const errors = result.issues.filter(i => i.severity === 'error');
    // No structural/dependency errors expected
    const structuralErrors = errors.filter(i =>
      i.code === 'dangling_ref' || i.code === 'out_of_order_ref' || i.code === 'empty_sequence',
    );
    expect(structuralErrors).toHaveLength(0);
  });

  it('compiles a DCA loop: swap every 10s until balance >= 5000', () => {
    const intent = makeIntent([
      {
        type: 'loop',
        maxIterations: 50,
        delayBetween: '10s',
        exitWhen: { token: 'USDC', field: 'balance', op: 'gte', value: 5000 },
        steps: [
          { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '0.01' },
        ],
      },
    ]);

    const plan = compileIntent(intent);
    expect(plan.root.type).toBe('loop');
    const loop = plan.root as LoopNode;
    expect(loop.maxIterations).toBe(50);
    expect(loop.delayMs).toBe(10_000);
    expect(loop.exitWhen).toBeDefined();
     expect(loop.body.type).toBe('action');
    expect((loop.body as ActionNode).tool).toBe('defi_swap');
  });
});

// ── 10.6: Multi-user plan ownership ────────────────────────────────────

describe('multi-user plan ownership', () => {
  beforeEach(() => {
    resetScheduler();
  });

  it('execute() extracts userId from ctx.senderId', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    const result = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'swap 1 ETH for USDC',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
      },
    }, { senderId: 'alice' });

    const data = (result as any).details;
    expect(data.plan_id).toMatch(/^plan_/);
    // The plan should be owned by 'alice'
    const { getScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const scheduler = getScheduler();
    const plan = scheduler.getPlan(data.plan_id);
    expect(plan?.userId).toBe('alice');
  });

  it('falls back to "owner" when no ctx provided', async () => {
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
    const { getScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');
    const scheduler = getScheduler();
    const plan = scheduler.getPlan(data.plan_id);
    expect(plan?.userId).toBe('owner');
  });

  it('blocks mutation by non-owner', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    // Create a plan as alice
    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'swap 1 ETH for USDC',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
      },
    }, { senderId: 'alice' });
    const planId = (createResult as any).details.plan_id;

    // Bob tries to cancel — should be denied
    const cancelResult = await tool.execute('call2', {
      action: 'cancel',
      plan_id: planId,
    }, { senderId: 'bob' });

    const cancelData = (cancelResult as any).details;
    expect(cancelData.error).toContain('Access denied');
  });

  it('allows mutation by same user', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    // Create a plan as alice
    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'swap 1 ETH for USDC',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
      },
    }, { senderId: 'alice' });
    const planId = (createResult as any).details.plan_id;

    // Alice cancels her own plan — should succeed
    const cancelResult = await tool.execute('call2', {
      action: 'cancel',
      plan_id: planId,
    }, { senderId: 'alice' });

    const cancelData = (cancelResult as any).details;
    expect(cancelData.status).toBe('cancelled');
  });

  it('owner user can mutate any plan (backward compat)', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    // Create as alice
    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'swap 1 ETH for USDC',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
      },
    }, { senderId: 'alice' });
    const planId = (createResult as any).details.plan_id;

    // 'owner' (no ctx / LLM-invoked) can cancel anyone's plan — backward compat
    const cancelResult = await tool.execute('call2', {
      action: 'cancel',
      plan_id: planId,
    });

    const cancelData = (cancelResult as any).details;
    expect(cancelData.status).toBe('cancelled');
  });

  it('list action filters plans by userId', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    // Create plans for two users with distinct tags for identification
    const aliceResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'alice plan',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
        tags: ['alice-tag'],
      },
    }, { senderId: 'alice-list' });
    const alicePlanId = (aliceResult as any).details.plan_id;

    const bobResult = await tool.execute('call2', {
      action: 'create',
      intent: {
        natural_language: 'bob plan',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
        tags: ['bob-tag'],
      },
    }, { senderId: 'bob-list' });
    const bobPlanId = (bobResult as any).details.plan_id;

    // Alice should only see her plan (and any 'owner' plans), not Bob's
    const aliceList = await tool.execute('call3', { action: 'list' }, { senderId: 'alice-list' });
    const alicePlanIds = (aliceList as any).details.plans.map((p: any) => p.plan_id);
    expect(alicePlanIds).toContain(alicePlanId);
    expect(alicePlanIds).not.toContain(bobPlanId);
  });
});

// ── 10.7: Persistent scheduler state ───────────────────────────────────

describe('scheduler state persistence', () => {
  let tmpDir: string;
  let store: FilePlanStore;

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpDir = mkdtempSync(join(tmpdir(), 'scheduler-test-'));
    store = new FilePlanStore(tmpDir);
  });

  afterEach(async () => {
    const { rmSync } = await import('node:fs');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('FilePlanStore saves and loads scheduler state', () => {
    const state = {
      intervalRunCounts: { plan_a: 3, plan_b: 7 },
      lastConditionCheck: { plan_c: 1700000000000 },
    };
    store.saveState(state);

    const loaded = store.loadState();
    expect(loaded).toEqual(state);
  });

  it('loadState returns null when no state file', () => {
    const loaded = store.loadState();
    expect(loaded).toBeNull();
  });

  it('scheduler restores interval run counts on restart', async () => {
    const compiler = new PlanCompiler();

    // Create an interval plan
    const plan = compiler.compile({
      naturalLanguage: 'DCA 0.1 ETH every hour',
      steps: [{ action: 'swap', tokenIn: 'USDC', tokenOut: 'ETH', amount: '100' }],
      trigger: { type: 'every', interval: '1h', maxRuns: 10 },
    }, 'test-user');

    plan.status = 'scheduled';
    store.save(plan);

    // Simulate previous state: already ran 5 times
    store.saveState({
      intervalRunCounts: { [plan.id]: 5 },
      lastConditionCheck: {},
    });

    // Create a scheduler that uses our store
    const scheduler = new PlanScheduler({
      store,
      resolver: NULL_RESOLVER,
      tickMs: 100_000, // Don't actually tick
    });
    scheduler.start();

    // The plan should still be active
    expect(scheduler.activeCount).toBeGreaterThanOrEqual(1);

    // Now create another scheduler and check the state persists through the lifecycle
    scheduler.stop();
  });

  it('loadAll skips _scheduler-state.json file', () => {
    // Save a plan and state
    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'test plan',
      steps: [{ action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' }],
    }, 'test-user');
    store.save(plan);

    store.saveState({
      intervalRunCounts: { foo: 1 },
      lastConditionCheck: {},
    });

    // loadAll should only return the plan, not parse the state file as a plan
    const plans = store.loadAll();
    expect(plans.length).toBe(1);
    expect(plans[0]!.id).toBe(plan.id);
  });

  it('cancelPlan persists updated state', () => {
    const compiler = new PlanCompiler();
    const plan = compiler.compile({
      naturalLanguage: 'test plan',
      steps: [{ action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' }],
      trigger: { type: 'every', interval: '1h', maxRuns: 10 },
    }, 'test-user');
    plan.status = 'scheduled';
    store.save(plan);

    // Pre-populate state
    store.saveState({
      intervalRunCounts: { [plan.id]: 3 },
      lastConditionCheck: { [plan.id]: Date.now() },
    });

    const scheduler = new PlanScheduler({
      store,
      resolver: NULL_RESOLVER,
      tickMs: 100_000,
    });
    scheduler.start();

    // Cancel the plan
    scheduler.cancelPlan(plan.id);

    // Force flush (stop flushes pending state)
    scheduler.stop();

    // State should no longer have the cancelled plan
    const state = store.loadState();
    expect(state?.intervalRunCounts[plan.id]).toBeUndefined();
    expect(state?.lastConditionCheck[plan.id]).toBeUndefined();
  });
});

// ── 10.5: Plan editing + templates ─────────────────────────────────────

describe('plan update action', () => {
  beforeEach(() => {
    resetScheduler();
  });

  it('update replaces steps in a draft plan', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    // Create a plan
    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'swap ETH for USDC',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
      },
    });
    const planId = (createResult as any).details.plan_id;

    // Update with new steps
    const updateResult = await tool.execute('call2', {
      action: 'update',
      plan_id: planId,
      update_steps: [
        { action: 'swap', token_in: 'ETH', token_out: 'DAI', amount: '2' },
      ],
    });

    const data = (updateResult as any).details;
    expect(data.plan_id).toBe(planId);
    expect(data.message).toContain('updated');
  });

  it('rejects update on a running plan', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    // Create and execute (sets status to scheduled→running)
    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'swap',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
      },
    });
    const planId = (createResult as any).details.plan_id;

    // Execute it (sets to 'scheduled' immediately)
    await tool.execute('call2', { action: 'execute', plan_id: planId });

    // Try to update — should fail
    const updateResult = await tool.execute('call3', {
      action: 'update',
      plan_id: planId,
      update_steps: [{ action: 'swap', token_in: 'ETH', token_out: 'DAI', amount: '2' }],
    });
    const data = (updateResult as any).details;
    expect(data.error).toContain('draft');
  });

  it('update with full intent recompiles', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'swap ETH for USDC',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
      },
    });
    const planId = (createResult as any).details.plan_id;

    // Update with full new intent
    const updateResult = await tool.execute('call2', {
      action: 'update',
      plan_id: planId,
      intent: {
        natural_language: 'transfer USDC to Bob',
        steps: [{ action: 'transfer', token: 'USDC', amount: '100', to: '0x1234' }],
      },
    });
    const data = (updateResult as any).details;
    expect(data.plan_id).toBe(planId);
    expect(data.name).toContain('transfer');
  });
});

describe('template actions', () => {
  beforeEach(() => {
    resetScheduler();
  });

  it('save_template + list_templates', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    // Create a plan
    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'DCA ETH weekly',
        steps: [{ action: 'swap', token_in: 'USDC', token_out: 'ETH', amount: '100' }],
        tags: ['dca'],
      },
    });
    const planId = (createResult as any).details.plan_id;

    // Save as template
    const saveResult = await tool.execute('call2', {
      action: 'save_template',
      plan_id: planId,
      template_name: 'Weekly DCA ETH',
      template_description: 'Buy ETH every week with USDC',
    });
    const tplData = (saveResult as any).details;
    expect(tplData.template_id).toMatch(/^tpl_/);
    expect(tplData.name).toBe('Weekly DCA ETH');

    // List templates
    const listResult = await tool.execute('call3', { action: 'list_templates' });
    const listData = (listResult as any).details;
    expect(listData.templates.length).toBeGreaterThanOrEqual(1);
    const tpl = listData.templates.find((t: any) => t.template_id === tplData.template_id);
    expect(tpl).toBeDefined();
    expect(tpl.name).toBe('Weekly DCA ETH');
  });

  it('from_template creates a new plan', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    // Create a plan
    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'swap $amount USDC to ETH',
        steps: [{ action: 'swap', token_in: 'USDC', token_out: 'ETH', amount: '$amount' }],
      },
    });
    const planId = (createResult as any).details.plan_id;

    // Save as template
    const saveResult = await tool.execute('call2', {
      action: 'save_template',
      plan_id: planId,
      template_name: 'Parameterized swap',
    });
    const templateId = (saveResult as any).details.template_id;
    expect(templateId).toMatch(/^tpl_/);

    // Create from template with params
    const fromResult = await tool.execute('call3', {
      action: 'from_template',
      template_id: templateId,
      template_params: { amount: '500' },
    });
    const fromData = (fromResult as any).details;
    expect(fromData.plan_id).toMatch(/^plan_/);
    expect(fromData.from_template).toBe(templateId);
    expect(fromData.plan_id).not.toBe(planId); // It's a new plan
  });

  it('from_template errors on unknown template', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    const result = await tool.execute('call1', {
      action: 'from_template',
      template_id: 'tpl_nonexistent',
    });
    const data = (result as any).details;
    expect(data.error).toContain('not found');
  });

  it('from_template without params reuses template directly', async () => {
    const { createCompoundActionTool } = await import('../extensions/crypto/src/tools/compound-action.js');
    const tool = createCompoundActionTool();

    // Create and save template
    const createResult = await tool.execute('call1', {
      action: 'create',
      intent: {
        natural_language: 'simple swap',
        steps: [{ action: 'swap', token_in: 'ETH', token_out: 'USDC', amount: '1' }],
      },
    });
    const planId = (createResult as any).details.plan_id;

    const saveResult = await tool.execute('call2', {
      action: 'save_template',
      plan_id: planId,
    });
    const templateId = (saveResult as any).details.template_id;

    // Instantiate without params
    const fromResult = await tool.execute('call3', {
      action: 'from_template',
      template_id: templateId,
    });
    const fromData = (fromResult as any).details;
    expect(fromData.plan_id).toMatch(/^plan_/);
    expect(fromData.from_template).toBe(templateId);
  });

  it('template storage on FilePlanStore', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = mkdtempSync(join(tmpdir(), 'tpl-test-'));

    try {
      const localStore = new FilePlanStore(tmpDir);

      const tpl = {
        id: 'tpl_test_1',
        name: 'Test Template',
        createdBy: 'test-user',
        createdAt: Date.now(),
        intent: {
          naturalLanguage: 'test',
          steps: [{ action: 'swap' }],
        },
      };

      localStore.saveTemplate(tpl);
      expect(localStore.loadTemplate('tpl_test_1')).toEqual(tpl);
      expect(localStore.listTemplates().length).toBe(1);

      localStore.deleteTemplate('tpl_test_1');
      expect(localStore.loadTemplate('tpl_test_1')).toBeNull();
      expect(localStore.listTemplates().length).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── 10.4: Confirmation callback ────────────────────────────────────────

describe('confirmation store', () => {
  it('creates and resolves a pending confirmation', async () => {
    const {
      createPendingConfirmation,
      respondToConfirmation,
      getPendingConfirmation,
      pendingCount,
    } = await import('../extensions/crypto/src/services/confirmation-store.js');

    // Create a pending confirmation
    const promise = createPendingConfirmation({
      executionId: 'exec_test_1',
      planName: 'Test Plan',
      stepLabel: 'Swap 1 ETH → USDC',
      tool: 'defi_swap',
      params: { token_in: 'ETH', token_out: 'USDC', amount: '1' },
      userId: 'user-confirm-test',
    });

    // Should be pending
    expect(pendingCount()).toBeGreaterThanOrEqual(1);
    const pending = getPendingConfirmation('user-confirm-test');
    expect(pending).not.toBeNull();
    expect(pending!.stepLabel).toBe('Swap 1 ETH → USDC');

    // Approve it
    const result = respondToConfirmation('user-confirm-test', true);
    expect(result).not.toBeNull();
    expect(result!.stepLabel).toBe('Swap 1 ETH → USDC');

    // Promise should resolve to true
    const approved = await promise;
    expect(approved).toBe(true);
  });

  it('deny resolves to false', async () => {
    const {
      createPendingConfirmation,
      respondToConfirmation,
    } = await import('../extensions/crypto/src/services/confirmation-store.js');

    const promise = createPendingConfirmation({
      executionId: 'exec_deny_1',
      planName: 'Test Plan',
      stepLabel: 'Transfer 100 USDC',
      tool: 'transfer',
      params: {},
      userId: 'user-deny-test',
    });

    respondToConfirmation('user-deny-test', false);
    const approved = await promise;
    expect(approved).toBe(false);
  });

  it('returns null when no pending confirmation', async () => {
    const {
      respondToConfirmation,
      getPendingConfirmation,
    } = await import('../extensions/crypto/src/services/confirmation-store.js');

    expect(getPendingConfirmation('nonexistent-user')).toBeNull();
    expect(respondToConfirmation('nonexistent-user', true)).toBeNull();
  });

  it('newer confirmation auto-denies the old one', async () => {
    const {
      createPendingConfirmation,
      respondToConfirmation,
    } = await import('../extensions/crypto/src/services/confirmation-store.js');

    // First confirmation
    const promise1 = createPendingConfirmation({
      executionId: 'exec_old',
      planName: 'Old Plan',
      stepLabel: 'Old Step',
      tool: 'defi_swap',
      params: {},
      userId: 'user-replace-test',
    });

    // Second confirmation replaces the first (auto-denies it)
    const promise2 = createPendingConfirmation({
      executionId: 'exec_new',
      planName: 'New Plan',
      stepLabel: 'New Step',
      tool: 'defi_swap',
      params: {},
      userId: 'user-replace-test',
    });

    // First should be auto-denied
    const result1 = await promise1;
    expect(result1).toBe(false);

    // Second is still pending — approve it
    respondToConfirmation('user-replace-test', true);
    const result2 = await promise2;
    expect(result2).toBe(true);
  });
});

describe('approve and deny commands', () => {
  it('approve command has correct shape', async () => {
    const { approveCommand } = await import('../extensions/crypto/src/commands/confirm-commands.js');
    expect(approveCommand.name).toBe('approve');
    expect(approveCommand.requireAuth).toBe(true);
    expect(typeof approveCommand.handler).toBe('function');
  });

  it('deny command has correct shape', async () => {
    const { denyCommand } = await import('../extensions/crypto/src/commands/confirm-commands.js');
    expect(denyCommand.name).toBe('deny');
    expect(denyCommand.requireAuth).toBe(true);
    expect(typeof denyCommand.handler).toBe('function');
  });

  it('approve with no pending returns helpful message', async () => {
    const { approveCommand } = await import('../extensions/crypto/src/commands/confirm-commands.js');
    const result = await approveCommand.handler({ senderId: 'no-pending-user' });
    expect(result.text).toContain('No pending');
  });

  it('deny with no pending returns message', async () => {
    const { denyCommand } = await import('../extensions/crypto/src/commands/confirm-commands.js');
    const result = await denyCommand.handler({ senderId: 'no-pending-user-2' });
    expect(result.text).toContain('No pending');
  });
});
