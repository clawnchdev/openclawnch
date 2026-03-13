/**
 * V4 User-Defined Tools & Composability — comprehensive test suite.
 *
 * Tests:
 * - UserToolService: CRUD, name validation, definition validation, persistence, lifecycle
 * - SandboxRuntime: budget enforcement, timeout, call count, API connector, composed execution
 * - ToolCompiler: schema generation, tool compilation, batch compilation
 * - ToolsCommand: list, info, enable, disable, delete subcommands
 * - Plugin registration counts (43 tools, 97 commands, 37 tool configs)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── UserToolService Tests ──────────────────────────────────────────────

describe('UserToolService', () => {
  let UserToolService: any;
  let UserToolError: any;
  let resetUserToolService: any;

  beforeEach(async () => {
    const mod = await import('../extensions/crypto/src/services/user-tool-service.js');
    UserToolService = mod.UserToolService;
    UserToolError = mod.UserToolError;
    resetUserToolService = mod.resetUserToolService;
    resetUserToolService();
  });

  afterEach(() => {
    resetUserToolService();
  });

  it('exports service class, error class, and singleton helpers', async () => {
    const mod = await import('../extensions/crypto/src/services/user-tool-service.js');
    expect(mod.UserToolService).toBeDefined();
    expect(mod.UserToolError).toBeDefined();
    expect(mod.getUserToolService).toBeDefined();
    expect(mod.resetUserToolService).toBeDefined();
  });

  it('creates an api_connector tool', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const tool = svc.create({
      name: 'price_check',
      label: 'Price Check',
      description: 'Checks token price from CoinGecko',
      createdBy: 'user-123',
      params: [
        { name: 'token', type: 'string', description: 'Token ID', required: true },
      ],
      definition: {
        type: 'api_connector',
        baseUrl: 'https://api.coingecko.com/api/v3',
        method: 'GET' as const,
        path: '/simple/price?ids={{token}}&vs_currencies=usd',
        resultPath: 'token.usd',
      },
    });

    expect(tool.id).toMatch(/^ut_/);
    expect(tool.name).toBe('price_check');
    expect(tool.label).toBe('Price Check');
    expect(tool.enabled).toBe(true);
    expect(tool.usageCount).toBe(0);
    expect(tool.definition.type).toBe('api_connector');
    expect(tool.maxBudgetUsd).toBe(1);
  });

  it('creates a composed tool', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const tool = svc.create({
      name: 'swap_and_check',
      label: 'Swap and Check',
      description: 'Swaps tokens then checks balance',
      createdBy: 'user-123',
      params: [
        { name: 'amount', type: 'number', description: 'Amount to swap', required: true },
      ],
      definition: {
        type: 'composed',
        steps: [
          { label: 'Swap', tool: 'defi_swap', args: { amount: '$arg.amount' } },
          { label: 'Check', tool: 'defi_balance', args: {} },
        ],
      },
      isWrite: true,
    });

    expect(tool.definition.type).toBe('composed');
    expect(tool.isWrite).toBe(true);
    expect((tool.definition as any).steps).toHaveLength(2);
  });

  it('creates a custom tool', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const tool = svc.create({
      name: 'smart_rebalance',
      label: 'Smart Rebalance',
      description: 'Rebalances portfolio based on targets',
      createdBy: 'user-123',
      params: [],
      definition: {
        type: 'custom',
        behavior: 'Check current portfolio allocation and rebalance to match 60% ETH, 30% USDC, 10% other',
        allowedTools: ['defi_balance', 'defi_swap', 'defi_price'],
        maxCalls: 8,
      },
    });

    expect(tool.definition.type).toBe('custom');
    expect((tool.definition as any).behavior).toContain('rebalance');
    expect((tool.definition as any).allowedTools).toHaveLength(3);
  });

  // Name validation
  it('rejects invalid tool names', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const base = {
      label: 'Test',
      description: 'Test tool',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom' as const, behavior: 'does something useful for testing', allowedTools: ['defi_price'] },
    };

    // Too short
    expect(() => svc.create({ ...base, name: 'ab' })).toThrow('Invalid tool name');
    // Starts with number
    expect(() => svc.create({ ...base, name: '1test' })).toThrow('Invalid tool name');
    // Has uppercase
    expect(() => svc.create({ ...base, name: 'MyTool' })).toThrow('Invalid tool name');
    // Has spaces
    expect(() => svc.create({ ...base, name: 'my tool' })).toThrow('Invalid tool name');
  });

  it('rejects reserved names and prefixes', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const base = {
      label: 'Test',
      description: 'Test tool',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom' as const, behavior: 'does something useful for testing', allowedTools: ['defi_price'] },
    };

    // Reserved name
    expect(() => svc.create({ ...base, name: 'transfer' })).toThrow('conflicts');
    expect(() => svc.create({ ...base, name: 'bridge' })).toThrow('conflicts');
    // Reserved prefix
    expect(() => svc.create({ ...base, name: 'defi_my_tool' })).toThrow('conflicts');
    expect(() => svc.create({ ...base, name: 'bankr_anything' })).toThrow('conflicts');
    expect(() => svc.create({ ...base, name: 'fiat_test' })).toThrow('conflicts');
  });

  it('rejects duplicate names', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const base = {
      label: 'Test',
      description: 'Test tool',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom' as const, behavior: 'does something useful for testing', allowedTools: ['defi_price'] },
    };

    svc.create({ ...base, name: 'my_custom_tool' });
    expect(() => svc.create({ ...base, name: 'my_custom_tool' })).toThrow('already exists');
  });

  // Definition validation
  it('rejects api_connector without required fields', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const base = {
      name: 'test_api',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
    };

    expect(() => svc.create({ ...base, definition: { type: 'api_connector' as const, baseUrl: '', method: 'GET' as const, path: '/test' } })).toThrow('baseUrl');
    expect(() => svc.create({ ...base, definition: { type: 'api_connector' as const, baseUrl: 'https://api.test.com', method: 'GET' as const, path: '' } })).toThrow('path');
    expect(() => svc.create({ ...base, definition: { type: 'api_connector' as const, baseUrl: 'not-a-url', method: 'GET' as const, path: '/test' } })).toThrow('Invalid baseUrl');
  });

  it('rejects composed tool without steps', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    expect(() => svc.create({
      name: 'empty_composed',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'composed', steps: [] },
    })).toThrow('at least one step');
  });

  it('rejects composed tool with more than 10 steps', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const steps = Array.from({ length: 11 }, (_, i) => ({
      label: `Step ${i}`,
      tool: 'defi_price',
      args: {},
    }));
    expect(() => svc.create({
      name: 'too_many_steps',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'composed', steps },
    })).toThrow('more than 10');
  });

  it('rejects custom tool with short behavior', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    expect(() => svc.create({
      name: 'short_behavior',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'short', allowedTools: ['defi_price'] },
    })).toThrow('at least 10 chars');
  });

  it('rejects custom tool without allowed tools', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    expect(() => svc.create({
      name: 'no_allowed',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'does something useful for testing purposes', allowedTools: [] },
    })).toThrow('at least one allowed tool');
  });

  it('rejects custom tool with maxCalls > 20', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    expect(() => svc.create({
      name: 'too_many_calls',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'does something useful for testing purposes', allowedTools: ['defi_price'], maxCalls: 25 },
    })).toThrow('cannot exceed 20');
  });

  // CRUD operations
  it('updates a tool', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const tool = svc.create({
      name: 'updatable',
      label: 'Original',
      description: 'Original description',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'original behavior description for test', allowedTools: ['defi_price'] },
    });

    const updated = svc.update(tool.id, { label: 'Updated', description: 'New description' });
    expect(updated!.label).toBe('Updated');
    expect(updated!.description).toBe('New description');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(tool.updatedAt);
  });

  it('update returns null for missing tool', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    expect(svc.update('nonexistent', { label: 'X' })).toBeNull();
  });

  it('deletes a tool', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const tool = svc.create({
      name: 'deletable',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'test behavior for deletion test', allowedTools: ['defi_price'] },
    });

    expect(svc.delete(tool.id)).toBe(true);
    expect(svc.get(tool.id)).toBeNull();
    expect(svc.delete(tool.id)).toBe(false);
  });

  it('lists tools with filters', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    svc.create({
      name: 'tool_alpha',
      label: 'Alpha',
      description: 'Alpha tool',
      createdBy: 'user-1',
      params: [],
      definition: { type: 'custom', behavior: 'alpha behavior for test purpose', allowedTools: ['defi_price'] },
    });
    svc.create({
      name: 'tool_beta',
      label: 'Beta',
      description: 'Beta tool',
      createdBy: 'user-2',
      params: [],
      definition: { type: 'api_connector', baseUrl: 'https://api.test.com', method: 'GET' as const, path: '/test' },
    });

    expect(svc.list()).toHaveLength(2);
    expect(svc.list({ createdBy: 'user-1' })).toHaveLength(1);
    expect(svc.list({ type: 'api_connector' })).toHaveLength(1);
    expect(svc.list({ type: 'composed' })).toHaveLength(0);
  });

  it('enables and disables tools', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const tool = svc.create({
      name: 'toggleable',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'toggleable behavior for test', allowedTools: ['defi_price'] },
    });

    svc.update(tool.id, { enabled: false });
    expect(svc.get(tool.id)!.enabled).toBe(false);
    expect(svc.getEnabledTools()).toHaveLength(0);

    svc.update(tool.id, { enabled: true });
    expect(svc.get(tool.id)!.enabled).toBe(true);
    expect(svc.getEnabledTools()).toHaveLength(1);
  });

  it('records usage count', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    const tool = svc.create({
      name: 'countable',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'countable behavior for test purpose', allowedTools: ['defi_price'] },
    });

    expect(tool.usageCount).toBe(0);
    svc.recordUsage(tool.id);
    svc.recordUsage(tool.id);
    svc.recordUsage(tool.id);
    expect(svc.get(tool.id)!.usageCount).toBe(3);
  });

  it('isNameAvailable reports correctly', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    
    // Valid, available
    expect(svc.isNameAvailable('my_new_tool')).toEqual({ available: true });
    
    // Invalid format
    expect(svc.isNameAvailable('ab').available).toBe(false);
    
    // Reserved
    expect(svc.isNameAvailable('transfer').available).toBe(false);
    
    // Create a tool, then check it's not available
    svc.create({
      name: 'taken_name',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'behavior for name availability test', allowedTools: ['defi_price'] },
    });
    expect(svc.isNameAvailable('taken_name').available).toBe(false);
  });

  it('getByName finds tools by name', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    svc.create({
      name: 'findable',
      label: 'Find Me',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'findable behavior for name test', allowedTools: ['defi_price'] },
    });

    const found = svc.getByName('findable');
    expect(found).not.toBeNull();
    expect(found!.label).toBe('Find Me');
    expect(svc.getByName('nonexistent')).toBeNull();
  });

  it('clear removes all tools', () => {
    const svc = new UserToolService({ stateDir: '/tmp/test-user-tools-' + Date.now() });
    svc.create({
      name: 'clearable_one',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'clearable behavior for clear test', allowedTools: ['defi_price'] },
    });
    svc.create({
      name: 'clearable_two',
      label: 'Test',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'second clearable behavior for test', allowedTools: ['defi_price'] },
    });

    expect(svc.list()).toHaveLength(2);
    svc.clear();
    expect(svc.list()).toHaveLength(0);
  });
});

// ─── SandboxRuntime Tests ───────────────────────────────────────────────

describe('SandboxRuntime', () => {
  let createSandboxContext: any;
  let executeApiConnector: any;
  let executeComposedTool: any;

  beforeEach(async () => {
    const mod = await import('../extensions/crypto/src/services/sandbox-runtime.js');
    createSandboxContext = mod.createSandboxContext;
    executeApiConnector = mod.executeApiConnector;
    executeComposedTool = mod.executeComposedTool;
  });

  it('exports runtime functions', async () => {
    const mod = await import('../extensions/crypto/src/services/sandbox-runtime.js');
    expect(mod.createSandboxContext).toBeDefined();
    expect(mod.executeApiConnector).toBeDefined();
    expect(mod.executeComposedTool).toBeDefined();
  });

  it('createSandboxContext initializes correctly for api_connector', () => {
    const tool = {
      id: 'ut_test_1',
      name: 'test_api',
      label: 'Test API',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'api_connector' as const, baseUrl: 'https://api.test.com', method: 'GET' as const, path: '/test' },
      isWrite: false,
      enabled: true,
      usageCount: 0,
      maxBudgetUsd: 5,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ctx = createSandboxContext(tool, 'user-123');
    expect(ctx.budgetRemainingUsd).toBe(5);
    expect(ctx.callCount).toBe(0);
    expect(ctx.maxCalls).toBe(1); // api_connector = 1
    expect(ctx.auditLog).toEqual([]);
    expect(ctx.userId).toBe('user-123');
  });

  it('createSandboxContext sets maxCalls from composed step count', () => {
    const tool = {
      id: 'ut_test_2',
      name: 'test_composed',
      label: 'Test Composed',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: {
        type: 'composed' as const,
        steps: [
          { label: 'Step 1', tool: 'defi_price', args: {} },
          { label: 'Step 2', tool: 'defi_balance', args: {} },
          { label: 'Step 3', tool: 'defi_swap', args: {} },
        ],
      },
      isWrite: true,
      enabled: true,
      usageCount: 0,
      maxBudgetUsd: 2,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ctx = createSandboxContext(tool, 'user-456');
    expect(ctx.maxCalls).toBe(3); // 3 steps
  });

  it('createSandboxContext uses custom maxCalls for custom tools', () => {
    const tool = {
      id: 'ut_test_3',
      name: 'test_custom',
      label: 'Test Custom',
      description: 'Test',
      createdBy: 'user-123',
      params: [],
      definition: {
        type: 'custom' as const,
        behavior: 'does something complex with multiple steps',
        allowedTools: ['defi_price', 'defi_balance'],
        maxCalls: 12,
      },
      isWrite: false,
      enabled: true,
      usageCount: 0,
      maxBudgetUsd: 1,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ctx = createSandboxContext(tool, 'user-789');
    expect(ctx.maxCalls).toBe(12);
  });

  it('executeApiConnector returns error when budget exhausted', async () => {
    const def = {
      type: 'api_connector' as const,
      baseUrl: 'https://api.test.com',
      method: 'GET' as const,
      path: '/test',
    };
    const ctx = {
      tool: {} as any,
      userId: 'user-123',
      budgetRemainingUsd: 0,
      callCount: 0,
      maxCalls: 1,
      startedAt: Date.now(),
      timeoutMs: 30000,
      auditLog: [],
    };

    const result = await executeApiConnector(def, {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Budget exhausted');
  });

  it('executeApiConnector returns error when timed out', async () => {
    const def = {
      type: 'api_connector' as const,
      baseUrl: 'https://api.test.com',
      method: 'GET' as const,
      path: '/test',
    };
    const ctx = {
      tool: {} as any,
      userId: 'user-123',
      budgetRemainingUsd: 5,
      callCount: 0,
      maxCalls: 1,
      startedAt: Date.now() - 60000, // 60s ago
      timeoutMs: 1000, // 1s timeout
      auditLog: [],
    };

    const result = await executeApiConnector(def, {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timed out');
  });

  it('executeComposedTool returns error when budget exhausted mid-chain', async () => {
    const steps = [
      { label: 'Step 1', tool: 'defi_price', args: {} },
      { label: 'Step 2', tool: 'defi_balance', args: {} },
    ];
    const ctx = {
      tool: {} as any,
      userId: 'user-123',
      budgetRemainingUsd: 0,
      callCount: 0,
      maxCalls: 5,
      startedAt: Date.now(),
      timeoutMs: 30000,
      auditLog: [],
    };
    const dispatcher = { call: vi.fn() };

    const result = await executeComposedTool(steps, {}, ctx, dispatcher);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Budget exhausted');
    expect(dispatcher.call).not.toHaveBeenCalled();
  });

  it('executeComposedTool returns error when max calls reached', async () => {
    const steps = [
      { label: 'Step 1', tool: 'defi_price', args: {} },
    ];
    const ctx = {
      tool: {} as any,
      userId: 'user-123',
      budgetRemainingUsd: 5,
      callCount: 5,
      maxCalls: 5,
      startedAt: Date.now(),
      timeoutMs: 30000,
      auditLog: [],
    };
    const dispatcher = { call: vi.fn() };

    const result = await executeComposedTool(steps, {}, ctx, dispatcher);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Max tool calls');
  });

  it('executeComposedTool runs steps sequentially with dispatcher', async () => {
    const steps = [
      { label: 'Get Price', tool: 'defi_price', args: { token: 'ETH' } },
      { label: 'Get Balance', tool: 'defi_balance', args: { token: 'ETH' } },
    ];
    const ctx = {
      tool: {} as any,
      userId: 'user-123',
      budgetRemainingUsd: 5,
      callCount: 0,
      maxCalls: 5,
      startedAt: Date.now(),
      timeoutMs: 30000,
      auditLog: [],
    };
    const dispatcher = {
      call: vi.fn()
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"price": 3000}' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"balance": 1.5}' }] }),
    };

    const result = await executeComposedTool(steps, {}, ctx, dispatcher);
    expect(result.isError).toBeUndefined();
    expect(dispatcher.call).toHaveBeenCalledTimes(2);
    expect(dispatcher.call).toHaveBeenCalledWith('defi_price', { token: 'ETH' });
    expect(dispatcher.call).toHaveBeenCalledWith('defi_balance', { token: 'ETH' });

    // Result has step results
    const data = JSON.parse(result.content[0].text);
    expect(data.stepsCompleted).toBe(2);
    expect(data.totalSteps).toBe(2);
    expect(data.results).toHaveLength(2);
  });

  it('executeComposedTool resolves $arg references', async () => {
    const steps = [
      { label: 'Price', tool: 'defi_price', args: { token: '$arg.token_id' } },
    ];
    const ctx = {
      tool: {} as any,
      userId: 'user-123',
      budgetRemainingUsd: 5,
      callCount: 0,
      maxCalls: 5,
      startedAt: Date.now(),
      timeoutMs: 30000,
      auditLog: [],
    };
    const dispatcher = {
      call: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"price": 3000}' }] }),
    };

    await executeComposedTool(steps, { token_id: 'ETH' }, ctx, dispatcher);
    expect(dispatcher.call).toHaveBeenCalledWith('defi_price', { token: 'ETH' });
  });

  it('executeComposedTool resolves $step references', async () => {
    const steps = [
      { label: 'Get Price', tool: 'defi_price', args: { token: 'ETH' } },
      { label: 'Use Price', tool: 'analytics', args: { price: '$step.0.price' } },
    ];
    const ctx = {
      tool: {} as any,
      userId: 'user-123',
      budgetRemainingUsd: 5,
      callCount: 0,
      maxCalls: 5,
      startedAt: Date.now(),
      timeoutMs: 30000,
      auditLog: [],
    };
    const dispatcher = {
      call: vi.fn()
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"price": 3000}' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok": true}' }] }),
    };

    await executeComposedTool(steps, {}, ctx, dispatcher);
    expect(dispatcher.call).toHaveBeenCalledTimes(2);
    // Second call should have resolved price from step 0 result
    expect(dispatcher.call).toHaveBeenNthCalledWith(2, 'analytics', { price: 3000 });
  });

  it('executeComposedTool stops on failure when stopOnFailure=true', async () => {
    const steps = [
      { label: 'Fail', tool: 'defi_price', args: {} },
      { label: 'Should not run', tool: 'defi_balance', args: {} },
    ];
    const ctx = {
      tool: {} as any,
      userId: 'user-123',
      budgetRemainingUsd: 5,
      callCount: 0,
      maxCalls: 5,
      startedAt: Date.now(),
      timeoutMs: 30000,
      auditLog: [],
    };
    const dispatcher = {
      call: vi.fn().mockResolvedValueOnce({ content: [{ type: 'text', text: 'Error: API failed' }], isError: true }),
    };

    const result = await executeComposedTool(steps, {}, ctx, dispatcher);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Step 1');
    expect(dispatcher.call).toHaveBeenCalledTimes(1);
  });

  it('executeComposedTool continues on failure when stopOnFailure=false', async () => {
    const steps = [
      { label: 'Fail', tool: 'defi_price', args: {}, stopOnFailure: false },
      { label: 'Continue', tool: 'defi_balance', args: {} },
    ];
    const ctx = {
      tool: {} as any,
      userId: 'user-123',
      budgetRemainingUsd: 5,
      callCount: 0,
      maxCalls: 5,
      startedAt: Date.now(),
      timeoutMs: 30000,
      auditLog: [],
    };
    const dispatcher = {
      call: vi.fn()
        .mockRejectedValueOnce(new Error('API failed'))
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok": true}' }] }),
    };

    const result = await executeComposedTool(steps, {}, ctx, dispatcher);
    expect(result.isError).toBeUndefined();
    expect(dispatcher.call).toHaveBeenCalledTimes(2);
  });

  it('audit log is populated during execution', async () => {
    const steps = [
      { label: 'Price', tool: 'defi_price', args: {} },
    ];
    const ctx = {
      tool: {} as any,
      userId: 'user-123',
      budgetRemainingUsd: 5,
      callCount: 0,
      maxCalls: 5,
      startedAt: Date.now(),
      timeoutMs: 30000,
      auditLog: [] as any[],
    };
    const dispatcher = {
      call: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] }),
    };

    await executeComposedTool(steps, {}, ctx, dispatcher);
    expect(ctx.auditLog).toHaveLength(1);
    expect(ctx.auditLog[0].action).toBe('tool_call');
    expect(ctx.auditLog[0].detail).toContain('defi_price');
    expect(ctx.callCount).toBe(1);
  });
});

// ─── ToolCompiler Tests ─────────────────────────────────────────────────

describe('ToolCompiler', () => {
  let buildSchemaFromParams: any;
  let compileTool: any;
  let compileAllEnabledTools: any;
  let resetUserToolService: any;

  beforeEach(async () => {
    const compilerMod = await import('../extensions/crypto/src/services/tool-compiler.js');
    buildSchemaFromParams = compilerMod.buildSchemaFromParams;
    compileTool = compilerMod.compileTool;
    compileAllEnabledTools = compilerMod.compileAllEnabledTools;

    const userToolMod = await import('../extensions/crypto/src/services/user-tool-service.js');
    resetUserToolService = userToolMod.resetUserToolService;
    resetUserToolService();
  });

  afterEach(() => {
    resetUserToolService();
  });

  it('exports compiler functions', async () => {
    const mod = await import('../extensions/crypto/src/services/tool-compiler.js');
    expect(mod.buildSchemaFromParams).toBeDefined();
    expect(mod.compileTool).toBeDefined();
    expect(mod.compileAllEnabledTools).toBeDefined();
  });

  it('buildSchemaFromParams generates empty object for no params', () => {
    const schema = buildSchemaFromParams([]);
    expect(schema.type).toBe('object');
    expect(schema.properties).toEqual({});
  });

  it('buildSchemaFromParams generates string, number, boolean properties', () => {
    const schema = buildSchemaFromParams([
      { name: 'token', type: 'string', description: 'Token ID', required: true },
      { name: 'amount', type: 'number', description: 'Amount', required: true },
      { name: 'confirm', type: 'boolean', description: 'Confirm', required: false },
    ]);

    expect(schema.type).toBe('object');
    expect(schema.properties.token).toBeDefined();
    expect(schema.properties.amount).toBeDefined();
    expect(schema.properties.confirm).toBeDefined();
  });

  it('buildSchemaFromParams marks optional params correctly', () => {
    const schema = buildSchemaFromParams([
      { name: 'required_field', type: 'string', description: 'Required', required: true },
      { name: 'optional_field', type: 'string', description: 'Optional', required: false },
    ]);

    // Required fields should be in the required array
    expect(schema.required).toContain('required_field');
    // Optional fields should not be
    expect(schema.required).not.toContain('optional_field');
  });

  it('compileTool produces AnyAgentTool-compatible object', () => {
    const tool = {
      id: 'ut_test_compile',
      name: 'test_compiled',
      label: 'Test Compiled',
      description: 'A compiled test tool',
      createdBy: 'user-123',
      params: [
        { name: 'input', type: 'string' as const, description: 'Input value', required: true },
      ],
      definition: {
        type: 'api_connector' as const,
        baseUrl: 'https://api.test.com',
        method: 'GET' as const,
        path: '/data/{{input}}',
      },
      isWrite: false,
      enabled: true,
      usageCount: 0,
      maxBudgetUsd: 1,
      tags: ['test'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const dispatcher = { call: vi.fn() };
    const compiled = compileTool(tool, dispatcher);

    // Check AnyAgentTool shape
    expect(compiled.name).toBe('test_compiled');
    expect(compiled.label).toBe('Test Compiled');
    expect(compiled.ownerOnly).toBe(false); // isWrite: false
    expect(compiled.description).toContain('[User Tool]');
    expect(compiled.description).toContain('A compiled test tool');
    expect(compiled.parameters).toBeDefined();
    expect(compiled.parameters.type).toBe('object');
    expect(typeof compiled.execute).toBe('function');
  });

  it('compileTool sets ownerOnly based on isWrite', () => {
    const baseTool = {
      id: 'ut_test_owner',
      name: 'test_write_tool',
      label: 'Write Tool',
      description: 'A write tool',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom' as const, behavior: 'does something that writes', allowedTools: ['defi_swap'] },
      isWrite: true,
      enabled: true,
      usageCount: 0,
      maxBudgetUsd: 1,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const dispatcher = { call: vi.fn() };
    const compiled = compileTool(baseTool, dispatcher);
    expect(compiled.ownerOnly).toBe(true);
  });

  it('compileTool execute returns error for disabled tool', async () => {
    const { getUserToolService } = await import('../extensions/crypto/src/services/user-tool-service.js');
    resetUserToolService();
    const svc = getUserToolService({ stateDir: '/tmp/test-compiler-' + Date.now() });
    const tool = svc.create({
      name: 'disabled_tool',
      label: 'Disabled',
      description: 'Will be disabled',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'will be disabled during test run', allowedTools: ['defi_price'] },
    });

    const dispatcher = { call: vi.fn() };
    const compiled = compileTool(tool, dispatcher);

    // Disable the tool
    svc.update(tool.id, { enabled: false });

    // Execute should return error
    const result = await compiled.execute('test-call-1', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disabled');
  });

  it('compileTool execute handles custom tool type', async () => {
    const { getUserToolService } = await import('../extensions/crypto/src/services/user-tool-service.js');
    resetUserToolService();
    const svc = getUserToolService({ stateDir: '/tmp/test-compiler-custom-' + Date.now() });
    const tool = svc.create({
      name: 'custom_executor',
      label: 'Custom Executor',
      description: 'Runs custom logic',
      createdBy: 'user-123',
      params: [{ name: 'query', type: 'string', description: 'Query input', required: true }],
      definition: {
        type: 'custom',
        behavior: 'Analyze the query and provide market intelligence',
        allowedTools: ['defi_price', 'market_intel'],
        maxCalls: 3,
      },
    });

    const dispatcher = { call: vi.fn() };
    const compiled = compileTool(tool, dispatcher);

    const result = await compiled.execute('test-call-2', { query: 'ETH analysis' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.type).toBe('custom_tool_invocation');
    expect(data.behavior).toContain('market intelligence');
    expect(data.allowedTools).toContain('defi_price');
    expect(data.inputArgs.query).toBe('ETH analysis');
  });

  it('compileAllEnabledTools compiles all enabled tools', async () => {
    const { UserToolService, getUserToolService } = await import('../extensions/crypto/src/services/user-tool-service.js');
    // Reset and create through singleton
    resetUserToolService();
    const svc = getUserToolService({ stateDir: '/tmp/test-compile-all-' + Date.now() });
    
    svc.create({
      name: 'batch_tool_one',
      label: 'Batch 1',
      description: 'First batch tool',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'first tool in batch compilation test', allowedTools: ['defi_price'] },
    });
    svc.create({
      name: 'batch_tool_two',
      label: 'Batch 2',
      description: 'Second batch tool',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'second tool in batch compilation test', allowedTools: ['defi_price'] },
    });
    
    // Disable one
    const tools = svc.list();
    svc.update(tools[0]!.id, { enabled: false });

    const dispatcher = { call: vi.fn() };
    const compiled = compileAllEnabledTools(dispatcher);
    expect(compiled).toHaveLength(1); // Only the enabled one
  });
});

// ─── ToolsCommand Tests ─────────────────────────────────────────────────

describe('ToolsCommand', () => {
  let toolsCommand: any;
  let resetUserToolService: any;
  let UserToolService: any;

  beforeEach(async () => {
    const cmdMod = await import('../extensions/crypto/src/commands/tools-command.js');
    toolsCommand = cmdMod.toolsCommand;
    const svcMod = await import('../extensions/crypto/src/services/user-tool-service.js');
    resetUserToolService = svcMod.resetUserToolService;
    UserToolService = svcMod.UserToolService;
    resetUserToolService();
  });

  afterEach(() => {
    resetUserToolService();
  });

  it('has correct command shape', () => {
    expect(toolsCommand.name).toBe('tools');
    expect(toolsCommand.acceptsArgs).toBe(true);
    expect(toolsCommand.requireAuth).toBe(false);
    expect(typeof toolsCommand.handler).toBe('function');
  });

  it('list shows empty state when no tools exist', async () => {
    const result = await toolsCommand.handler({ args: '' });
    expect(result.text).toContain('None defined yet');
    expect(result.text).toContain('natural language');
  });

  it('list shows user tools', async () => {
    const { getUserToolService } = await import('../extensions/crypto/src/services/user-tool-service.js');
    const svc = getUserToolService({ stateDir: '/tmp/test-cmd-list-' + Date.now() });
    svc.create({
      name: 'cmd_test_tool',
      label: 'Command Test',
      description: 'A tool for testing the command',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'test tool for command listing test', allowedTools: ['defi_price'] },
      tags: ['test'],
    });

    const result = await toolsCommand.handler({ args: 'list' });
    expect(result.text).toContain('cmd_test_tool');
    expect(result.text).toContain('1 total');
    expect(result.text).toContain('1 enabled');
  });

  it('info shows tool details', async () => {
    const { getUserToolService } = await import('../extensions/crypto/src/services/user-tool-service.js');
    const svc = getUserToolService({ stateDir: '/tmp/test-cmd-info-' + Date.now() });
    svc.create({
      name: 'info_tool',
      label: 'Info Tool',
      description: 'A detailed tool',
      createdBy: 'user-456',
      params: [
        { name: 'input', type: 'string', description: 'Input value', required: true },
      ],
      definition: {
        type: 'api_connector',
        baseUrl: 'https://api.example.com',
        method: 'GET' as const,
        path: '/data/{{input}}',
        resultPath: 'data.value',
      },
    });

    const result = await toolsCommand.handler({ args: 'info info_tool' });
    expect(result.text).toContain('Info Tool');
    expect(result.text).toContain('api_connector');
    expect(result.text).toContain('user-456');
    expect(result.text).toContain('input');
    expect(result.text).toContain('api.example.com');
  });

  it('info returns not found for missing tool', async () => {
    const result = await toolsCommand.handler({ args: 'info nonexistent' });
    expect(result.text).toContain('No user tool');
  });

  it('info requires a name argument', async () => {
    const result = await toolsCommand.handler({ args: 'info' });
    expect(result.text).toContain('Usage');
  });

  it('enable and disable toggle tool state', async () => {
    const { getUserToolService } = await import('../extensions/crypto/src/services/user-tool-service.js');
    const svc = getUserToolService({ stateDir: '/tmp/test-cmd-toggle-' + Date.now() });
    svc.create({
      name: 'toggle_tool',
      label: 'Toggle',
      description: 'Toggleable',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'toggleable for enable/disable test', allowedTools: ['defi_price'] },
    });

    // Disable
    const disableResult = await toolsCommand.handler({ args: 'disable toggle_tool' });
    expect(disableResult.text).toContain('disabled');
    expect(svc.getByName('toggle_tool')!.enabled).toBe(false);

    // Already disabled
    const alreadyResult = await toolsCommand.handler({ args: 'disable toggle_tool' });
    expect(alreadyResult.text).toContain('already disabled');

    // Enable
    const enableResult = await toolsCommand.handler({ args: 'enable toggle_tool' });
    expect(enableResult.text).toContain('enabled');
    expect(svc.getByName('toggle_tool')!.enabled).toBe(true);

    // Already enabled
    const alreadyEnabled = await toolsCommand.handler({ args: 'enable toggle_tool' });
    expect(alreadyEnabled.text).toContain('already enabled');
  });

  it('delete removes a tool', async () => {
    const { getUserToolService } = await import('../extensions/crypto/src/services/user-tool-service.js');
    const svc = getUserToolService({ stateDir: '/tmp/test-cmd-delete-' + Date.now() });
    svc.create({
      name: 'deletable_tool',
      label: 'Deletable',
      description: 'Will be deleted',
      createdBy: 'user-123',
      params: [],
      definition: { type: 'custom', behavior: 'deletable tool for delete command test', allowedTools: ['defi_price'] },
    });

    const result = await toolsCommand.handler({ args: 'delete deletable_tool' });
    expect(result.text).toContain('permanently deleted');
    expect(svc.getByName('deletable_tool')).toBeNull();
  });

  it('delete returns not found for missing tool', async () => {
    const result = await toolsCommand.handler({ args: 'delete nonexistent' });
    expect(result.text).toContain('No user tool');
  });

  it('unknown subcommand shows help', async () => {
    const result = await toolsCommand.handler({ args: 'foobar' });
    expect(result.text).toContain('Unknown subcommand');
    expect(result.text).toContain('list');
    expect(result.text).toContain('info');
  });

  it('default (no args) acts as list', async () => {
    const result = await toolsCommand.handler({ args: '' });
    expect(result.text).toContain('None defined yet');
  });
});

// ─── Plugin Registration Count Tests ────────────────────────────────────

describe('V4 Plugin Registration', () => {
  it('plugin registers 103 commands including tools, skills, interrupt, and api', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const commands: string[] = [];
    const mockApi = {
      registerTool: () => {},
      registerCommand: (cmd: any) => commands.push(cmd.name),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    expect(commands).toHaveLength(103);
    expect(commands).toContain('tools');
  });

  it('plugin still registers 44 tools (user tools are dynamic)', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const registered: string[] = [];
    const mockApi = {
      registerTool: (tool: any) => registered.push(tool.name),
      registerCommand: () => {},
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    expect(registered).toHaveLength(44);
  });
});
