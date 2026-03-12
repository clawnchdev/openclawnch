/**
 * Sprint 11 — Error Handling Tests (11.1, 11.2, 11.3)
 *
 * Tests:
 * - Exponential backoff retry logic
 * - Fallback (onError) branches
 * - Dead-letter logging
 * - Dead-letter persistence (FilePlanStore)
 * - Dead-letter compound_action
 * - Checkpoint persistence + resume
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Plan,
  ActionNode,
  SequenceNode,
  FailurePolicy,
  DeadLetterEntry,
  ExecutionCheckpoint,
  StepExecution,
} from '../extensions/crypto/src/services/plan-types.js';

// ─── Helper Factories ──────────────────────────────────────────────────

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: overrides.id ?? `plan_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: overrides.name ?? 'test plan',
    userId: overrides.userId ?? 'test-user',
    status: overrides.status ?? 'validated',
    root: overrides.root ?? {
      id: 'root',
      type: 'action',
      tool: 'defi_swap',
      label: 'Test action',
      params: { token_in: 'ETH', token_out: 'USDC', amount: '1.0' },
    },
    trigger: overrides.trigger ?? { type: 'immediate' },
    createdAt: overrides.createdAt ?? Date.now(),
    validation: overrides.validation ?? {
      valid: true,
      issues: [],
      toolsUsed: [],
      chainsUsed: [],
    },
  };
}

function makeAction(overrides: Partial<ActionNode> = {}): ActionNode {
  return {
    id: overrides.id ?? 'action_1',
    type: 'action',
    tool: overrides.tool ?? 'defi_swap',
    label: overrides.label ?? 'Swap ETH for USDC',
    params: overrides.params ?? { token_in: 'ETH', token_out: 'USDC', amount: '1.0' },
    onFailure: overrides.onFailure,
    onError: overrides.onError,
    requireConfirmation: overrides.requireConfirmation,
  };
}

// ─── 11.1: Exponential Backoff ──────────────────────────────────────────

describe('Sprint 11.1 — Exponential Backoff', () => {
  it('FailurePolicy type supports backoffMultiplier', () => {
    const policy: FailurePolicy = {
      strategy: 'retry',
      maxAttempts: 3,
      delayMs: 1000,
      backoffMultiplier: 2,
    };
    expect(policy.strategy).toBe('retry');
    expect(policy.backoffMultiplier).toBe(2);
    expect(policy.delayMs).toBe(1000);
    expect(policy.maxAttempts).toBe(3);
  });

  it('executor retries with exponential backoff delays', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    let callCount = 0;
    const delays: number[] = [];

    // Mock setTimeout to capture delays
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, delay?: number) => {
      if (delay && delay > 0) delays.push(delay);
      if (typeof fn === 'function') fn();
      return 0 as any;
    });

    const mockDispatcher = {
      call: vi.fn(async () => {
        callCount++;
        if (callCount <= 3) throw new Error(`attempt ${callCount} failed`);
        return { success: true };
      }),
      exists: vi.fn(() => true),
    };

    const scheduler = new PlanScheduler();
    const executor = new PlanExecutor({
      dispatcher: mockDispatcher,
      scheduler,
    });

    const plan = makePlan({
      root: {
        ...makeAction(),
        onFailure: {
          strategy: 'retry',
          maxAttempts: 4,
          delayMs: 100,
          backoffMultiplier: 2,
        },
      },
    });

    const result = await executor.execute(plan, 'exec_test_backoff');

    expect(callCount).toBe(4); // 1 initial + 3 retries
    expect(result.status).toBe('completed');

    // Delays should be exponential: 100, 200, 400
    expect(delays.length).toBeGreaterThanOrEqual(3);
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
    expect(delays[2]).toBe(400);

    vi.restoreAllMocks();
  });
});

// ─── 11.2: Fallback Branches + Dead-Letter ──────────────────────────────

describe('Sprint 11.2 — Fallback Branches', () => {
  it('ActionNode type supports onError field', () => {
    const node: ActionNode = makeAction({
      onError: {
        id: 'fallback_1',
        type: 'action',
        tool: 'defi_swap',
        label: 'Fallback swap',
        params: { token_in: 'ETH', token_out: 'DAI', amount: '1.0' },
      },
    });
    expect(node.onError).toBeDefined();
    expect(node.onError!.type).toBe('action');
  });

  it('executor runs fallback on primary failure', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const callLog: string[] = [];
    const mockDispatcher = {
      call: vi.fn(async (tool: string, params: any) => {
        callLog.push(`${tool}:${params.token_out}`);
        if (params.token_out === 'USDC') {
          throw new Error('Primary swap failed: slippage too high');
        }
        return { success: true };
      }),
      exists: vi.fn(() => true),
    };

    const scheduler = new PlanScheduler();
    const executor = new PlanExecutor({
      dispatcher: mockDispatcher,
      scheduler,
    });

    const plan = makePlan({
      root: makeAction({
        id: 'primary',
        tool: 'defi_swap',
        params: { token_in: 'ETH', token_out: 'USDC', amount: '1.0' },
        onFailure: { strategy: 'abort' },
        onError: makeAction({
          id: 'fallback',
          tool: 'defi_swap',
          params: { token_in: 'ETH', token_out: 'DAI', amount: '1.0' },
        }),
      }),
    });

    const result = await executor.execute(plan, 'exec_test_fallback');

    // Primary failed, fallback succeeded
    expect(callLog.length).toBe(2);
    expect(callLog[0]).toContain('USDC'); // primary
    expect(callLog[1]).toContain('DAI');  // fallback
    expect(result.status).toBe('completed');
  });
});

describe('Sprint 11.2 — Dead-Letter Logging', () => {
  it('DeadLetterEntry type has correct shape', () => {
    const entry: DeadLetterEntry = {
      planId: 'plan_123',
      nodeId: 'action_1',
      executionId: 'exec_123',
      userId: 'user_1',
      error: 'Transaction reverted',
      retryCount: 3,
      tool: 'defi_swap',
      params: { token_in: 'ETH' },
      timestamp: Date.now(),
    };
    expect(entry.planId).toBe('plan_123');
    expect(entry.retryCount).toBe(3);
    expect(entry.tool).toBe('defi_swap');
  });

  it('executor calls onDeadLetter on terminal failure', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const deadLetters: DeadLetterEntry[] = [];
    const mockDispatcher = {
      call: vi.fn(async () => { throw new Error('permanent failure'); }),
      exists: vi.fn(() => true),
    };

    const scheduler = new PlanScheduler();
    const executor = new PlanExecutor({
      dispatcher: mockDispatcher,
      scheduler,
      onDeadLetter: (entry) => deadLetters.push(entry),
    });

    const plan = makePlan({
      root: makeAction({
        onFailure: { strategy: 'abort' },
      }),
    });

    const result = await executor.execute(plan, 'exec_test_deadletter');

    expect(result.status).toBe('failed');
    expect(deadLetters.length).toBe(1);
    expect(deadLetters[0].error).toContain('permanent failure');
    expect(deadLetters[0].planId).toBe(plan.id);
    expect(deadLetters[0].userId).toBe('test-user');
  });

  it('FilePlanStore persists and loads dead-letter entries', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { FilePlanStore } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const tmpDir = path.join(process.env.HOME ?? '/tmp', '.openclawnch', 'test-dead-letter-' + Date.now());
    const store = new FilePlanStore(tmpDir);

    try {
      const entry: DeadLetterEntry = {
        planId: 'plan_dl_test',
        nodeId: 'action_1',
        executionId: 'exec_dl_test',
        userId: 'user_1',
        error: 'Gas estimation failed',
        retryCount: 2,
        tool: 'defi_swap',
        params: { amount: '1.0' },
        timestamp: Date.now(),
      };

      store.saveDeadLetter(entry);

      const loaded = store.loadDeadLetters();
      expect(loaded.length).toBe(1);
      expect(loaded[0].planId).toBe('plan_dl_test');
      expect(loaded[0].error).toBe('Gas estimation failed');

      const filtered = store.loadDeadLetters('nonexistent');
      expect(filtered.length).toBe(0);

      const cleared = store.clearDeadLetters();
      expect(cleared).toBe(1);

      const afterClear = store.loadDeadLetters();
      expect(afterClear.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── 11.3: Checkpoint Persistence ───────────────────────────────────────

describe('Sprint 11.3 — Execution Checkpoints', () => {
  it('ExecutionCheckpoint type has correct shape', () => {
    const cp: ExecutionCheckpoint = {
      executionId: 'exec_cp_1',
      planId: 'plan_cp_1',
      userId: 'user_1',
      currentNodeId: 'action_3',
      stepResults: [['action_1', { price: 4000 }], ['action_2', { txHash: '0x123' }]],
      steps: [],
      status: 'running',
      startedAt: Date.now() - 5000,
      updatedAt: Date.now(),
    };
    expect(cp.executionId).toBe('exec_cp_1');
    expect(cp.stepResults).toHaveLength(2);
    expect(cp.status).toBe('running');
  });

  it('FilePlanStore persists and loads checkpoints', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { FilePlanStore } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const tmpDir = path.join(process.env.HOME ?? '/tmp', '.openclawnch', 'test-checkpoints-' + Date.now());
    const store = new FilePlanStore(tmpDir);

    try {
      const cp: ExecutionCheckpoint = {
        executionId: 'exec_cp_test',
        planId: 'plan_cp_test',
        userId: 'user_1',
        currentNodeId: 'action_2',
        stepResults: [['action_1', { result: 'ok' }]],
        steps: [{
          nodeId: 'action_1',
          status: 'completed' as const,
          startedAt: Date.now(),
          completedAt: Date.now(),
        }],
        status: 'running',
        startedAt: Date.now() - 1000,
        updatedAt: Date.now(),
      };

      store.saveCheckpoint(cp);

      const loaded = store.loadCheckpoint('exec_cp_test');
      expect(loaded).not.toBeNull();
      expect(loaded!.executionId).toBe('exec_cp_test');
      expect(loaded!.currentNodeId).toBe('action_2');
      expect(loaded!.stepResults).toHaveLength(1);

      const all = store.loadAllCheckpoints();
      expect(all.length).toBe(1);

      const deleted = store.deleteCheckpoint('exec_cp_test');
      expect(deleted).toBe(true);

      const afterDelete = store.loadCheckpoint('exec_cp_test');
      expect(afterDelete).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('executor writes and clears checkpoints during execution', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const checkpointWrites: string[] = [];
    const checkpointDeletes: string[] = [];

    const scheduler = new PlanScheduler();
    vi.spyOn(scheduler, 'saveCheckpoint').mockImplementation((cp) => {
      checkpointWrites.push(cp.currentNodeId);
    });
    vi.spyOn(scheduler, 'deleteCheckpoint').mockImplementation((id) => {
      checkpointDeletes.push(id);
      return true;
    });

    const mockDispatcher = {
      call: vi.fn(async () => ({ success: true })),
      exists: vi.fn(() => true),
    };

    const executor = new PlanExecutor({
      dispatcher: mockDispatcher,
      scheduler,
    });

    const plan = makePlan({
      root: {
        id: 'seq_1',
        type: 'sequence',
        label: 'Test sequence',
        steps: [
          makeAction({ id: 'step_1' }),
          makeAction({ id: 'step_2' }),
        ],
      } as SequenceNode,
    });

    const result = await executor.execute(plan, 'exec_cp_lifecycle');

    expect(result.status).toBe('completed');
    // Should have written checkpoints for: seq_1, step_1, step_2
    expect(checkpointWrites.length).toBeGreaterThanOrEqual(3);
    expect(checkpointWrites).toContain('seq_1');
    expect(checkpointWrites).toContain('step_1');
    expect(checkpointWrites).toContain('step_2');
    // Should delete checkpoint on completion
    expect(checkpointDeletes).toContain('exec_cp_lifecycle');
  });

  it('executor resumeFromCheckpoint returns null for missing checkpoint', async () => {
    const { PlanExecutor } = await import('../extensions/crypto/src/services/plan-executor.js');
    const { PlanScheduler } = await import('../extensions/crypto/src/services/plan-scheduler.js');

    const scheduler = new PlanScheduler();
    vi.spyOn(scheduler, 'loadCheckpoint').mockReturnValue(null);

    const executor = new PlanExecutor({
      dispatcher: { call: vi.fn(), exists: vi.fn(() => true) },
      scheduler,
    });

    const plan = makePlan();
    const result = await executor.resumeFromCheckpoint(plan, 'nonexistent');
    expect(result).toBeNull();
  });
});
