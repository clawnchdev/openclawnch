/**
 * Workflow Engine Tests — Sprint 10 (Layer 1: Composable Primitives)
 *
 * Tests for:
 * - 10.1: Extended Intent format (parallel, wait, loop step types)
 * - 10.2: Step-output data flow (outputRef / inputRefs)
 * - 10.3: WaitNode condition bug fix (executor resolves step_output in conditions)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanCompiler, type Intent, type IntentStep } from '../extensions/crypto/src/services/plan-compiler.js';
import { PlanValidator } from '../extensions/crypto/src/services/plan-validator.js';
import { PlanExecutor, type ToolDispatcher } from '../extensions/crypto/src/services/plan-executor.js';
import type { Plan, PlanNode, ActionNode, ParallelNode, SequenceNode, WaitNode, LoopNode, IfNode, Condition } from '../extensions/crypto/src/services/plan-types.js';

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
