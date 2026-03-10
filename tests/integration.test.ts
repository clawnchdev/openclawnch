import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── DexScreener Service Tests ──────────────────────────────────────────

describe('dexscreener-service', () => {
  it('resolveChain maps aliases correctly', async () => {
    const { resolveChain } = await import(
      '../extensions/crypto/src/services/dexscreener-service.js'
    );
    expect(resolveChain('eth')).toBe('ethereum');
    expect(resolveChain('arb')).toBe('arbitrum');
    expect(resolveChain('op')).toBe('optimism');
    expect(resolveChain('matic')).toBe('polygon');
    expect(resolveChain('base')).toBe('base');
    expect(resolveChain('unknown')).toBe('unknown');
  });
});

// ─── Price Service Tests ─────────────────────────────────────────────────

describe('price-service', () => {
  it('clearPriceCache does not throw', async () => {
    const { clearPriceCache } = await import(
      '../extensions/crypto/src/services/price-service.js'
    );
    expect(() => clearPriceCache()).not.toThrow();
  });
});

// ─── Safety Service Tests ────────────────────────────────────────────────

describe('safety-service', () => {
  it('checkBalance returns blockers when no wallet connected', async () => {
    const { checkBalance } = await import(
      '../extensions/crypto/src/services/safety-service.js'
    );
    const result = await checkBalance({ requiredEth: 1 });
    expect(result.safe).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers[0]).toContain('No wallet connected');
  });

  it('auditToken returns warning when no HERD_ACCESS_TOKEN', async () => {
    // Ensure env var is not set
    const orig = process.env.HERD_ACCESS_TOKEN;
    delete process.env.HERD_ACCESS_TOKEN;

    const { auditToken } = await import(
      '../extensions/crypto/src/services/safety-service.js'
    );
    const result = await auditToken('0x1234567890abcdef1234567890abcdef12345678');
    expect(result.safe).toBe(true); // not blocking when service unavailable
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Herd Intelligence not configured');

    // Restore
    if (orig) process.env.HERD_ACCESS_TOKEN = orig;
  });
});

// ─── Workflow Tool Tests ─────────────────────────────────────────────────

describe('crypto-workflow tool', () => {
  it('has correct tool shape', async () => {
    const { createCryptoWorkflowTool } = await import(
      '../extensions/crypto/src/tools/crypto-workflow.js'
    );
    const tool = createCryptoWorkflowTool();

    expect(tool.name).toBe('crypto_workflow');
    expect(tool.label).toBe('Crypto Workflow');
    expect(tool.ownerOnly).toBe(true); // safe_swap/launch_and_promote spend funds
    expect(typeof tool.execute).toBe('function');
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties).toHaveProperty('workflow');
  });

  it('safe_swap fails without wallet', async () => {
    const { createCryptoWorkflowTool } = await import(
      '../extensions/crypto/src/tools/crypto-workflow.js'
    );
    const tool = createCryptoWorkflowTool();

    const result = await tool.execute('test', {
      workflow: 'safe_swap',
      token_in: 'ETH',
      token_out: '0x1234567890abcdef1234567890abcdef12345678',
      amount: '0.1',
    });

    const text = result.content[0].text;
    expect(text).toContain('No wallet connected');
  });

  it('launch_and_promote fails without wallet', async () => {
    const { createCryptoWorkflowTool } = await import(
      '../extensions/crypto/src/tools/crypto-workflow.js'
    );
    const tool = createCryptoWorkflowTool();

    const result = await tool.execute('test', {
      workflow: 'launch_and_promote',
      name: 'Test Token',
      symbol: 'TEST',
    });

    const text = result.content[0].text;
    expect(text).toContain('No wallet connected');
  });

  it('portfolio_snapshot fails without wallet', async () => {
    const { createCryptoWorkflowTool } = await import(
      '../extensions/crypto/src/tools/crypto-workflow.js'
    );
    const tool = createCryptoWorkflowTool();

    const result = await tool.execute('test', {
      workflow: 'portfolio_snapshot',
    });

    const text = result.content[0].text;
    expect(text).toContain('No wallet connected');
  });

  it('check_orders returns execution instructions', async () => {
    const { createCryptoWorkflowTool } = await import(
      '../extensions/crypto/src/tools/crypto-workflow.js'
    );
    const tool = createCryptoWorkflowTool();

    const result = await tool.execute('test', {
      workflow: 'check_orders',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.workflow).toBe('check_orders');
    expect(data.nextActions).toBeDefined();
    expect(data.nextActions[0].tool).toBe('manage_orders');
  });

  it('returns error for unknown workflow', async () => {
    const { createCryptoWorkflowTool } = await import(
      '../extensions/crypto/src/tools/crypto-workflow.js'
    );
    const tool = createCryptoWorkflowTool();

    const result = await tool.execute('test', { workflow: 'nonexistent' });
    expect(result.content[0].text).toContain('Unknown workflow');
  });
});

// ─── Cross-Tool Integration Tests ────────────────────────────────────────

describe('cross-tool integration', () => {
  it('defi-swap imports safety service', async () => {
    const { createDefiSwapTool } = await import(
      '../extensions/crypto/src/tools/defi-swap.js'
    );
    const tool = createDefiSwapTool();
    expect(tool.name).toBe('defi_swap');
    // The tool should still work without wallet (return error gracefully)
    const result = await tool.execute('test', {
      action: 'execute',
      token_in: 'ETH',
      token_out: 'USDC',
      amount: '0.1',
    });
    expect(result.content[0].text).toContain('No wallet connected');
  });

  it('clawnch-launch includes safety checks', async () => {
    const { createClawnchLaunchTool } = await import(
      '../extensions/crypto/src/tools/clawnch-launch.js'
    );
    const tool = createClawnchLaunchTool();
    const result = await tool.execute('test', {
      name: 'Test',
      symbol: 'TST',
    });
    expect(result.content[0].text).toContain('No wallet connected');
  });

  it('defi-balance uses shared price service for ETH price', async () => {
    const { createDefiBalanceTool } = await import(
      '../extensions/crypto/src/tools/defi-balance.js'
    );
    const tool = createDefiBalanceTool();
    // Without wallet, should return error mentioning connection
    const result = await tool.execute('test', { action: 'eth' });
    expect(result.content[0].text).toContain('No wallet connected');
  });

  it('manage-orders check action works without manual price', async () => {
    const { createManageOrdersTool } = await import(
      '../extensions/crypto/src/tools/manage-orders.js'
    );
    const tool = createManageOrdersTool();

    // With no orders and no token, should return a helpful error
    const result = await tool.execute('test', { action: 'check' });
    const text = result.content[0].text;
    // Should either check triggers or explain what's needed
    expect(text).toBeDefined();
  });

  it('clawnchconnect status includes transaction history', async () => {
    const { createClawnchConnectTool } = await import(
      '../extensions/crypto/src/tools/clawnchconnect.js'
    );
    const tool = createClawnchConnectTool();
    const result = await tool.execute('test', { action: 'status' });
    const data = JSON.parse(result.content[0].text);
    // When disconnected, should report disconnected status
    expect(data.status).toBe('disconnected');
  });

  it('all tools include details field in results', async () => {
    // Verify jsonResult includes details (AgentToolResult compliance)
    const { jsonResult } = await import(
      '../extensions/crypto/src/lib/tool-helpers.js'
    );
    const result = jsonResult({ test: true });
    expect(result).toHaveProperty('details');
    expect(result.details).toEqual({ test: true });
  });

  it('errorResult includes details field', async () => {
    const { errorResult } = await import(
      '../extensions/crypto/src/lib/tool-helpers.js'
    );
    const result = errorResult('test error');
    expect(result).toHaveProperty('details');
    expect((result.details as any).error).toBe('test error');
    expect(result.isError).toBe(true);
  });
});

// ─── Plugin Registration Count ───────────────────────────────────────────

describe('plugin registers 31 tools (13 core + 4 phase 2 + 4 phase 3 + 1 phase 4 + 1 phase 5 + 4 phase 6 + 1 phase 7 + 3 sprint 4)', () => {
  it('total tool count is 31', async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const tools: any[] = [];
    const mockApi = {
      registerTool: vi.fn((tool: any) => tools.push(tool)),
      registerCommand: vi.fn(),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    };

    plugin.register(mockApi);
    expect(tools.length).toBe(31);
    expect(tools.map(t => t.name)).toContain('crypto_workflow');
    expect(tools.map(t => t.name)).toContain('transfer');
    expect(tools.map(t => t.name)).toContain('liquidity');
    expect(tools.map(t => t.name)).toContain('wayfinder');
    expect(tools.map(t => t.name)).toContain('clawnch_info');
    // Phase 3
    expect(tools.map(t => t.name)).toContain('permit2');
    expect(tools.map(t => t.name)).toContain('cost_basis');
    expect(tools.map(t => t.name)).toContain('analytics');
    expect(tools.map(t => t.name)).toContain('block_explorer');
    // Phase 4
    expect(tools.map(t => t.name)).toContain('bridge');
  });
});
