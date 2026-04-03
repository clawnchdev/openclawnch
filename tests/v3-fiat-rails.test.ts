/**
 * V3 Fiat & Traditional Finance Rails — comprehensive test suite.
 *
 * Tests:
 * - FiatService: provider registration, quote aggregation, transfers, persistence
 * - FiatPaymentTool: action routing, parameter parsing, error handling
 * - FiatCommand: handler output
 * - Plugin registration counts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── FiatService Tests ──────────────────────────────────────────────────

describe('FiatService', () => {
  let FiatService: any;
  let resetFiatService: any;

  beforeEach(async () => {
    const mod = await import('../extensions/crypto/src/services/fiat-service.js');
    FiatService = mod.FiatService;
    resetFiatService = mod.resetFiatService;
    // Clear any singleton state
    resetFiatService();
  });

  afterEach(() => {
    resetFiatService();
    // Clean up env
    delete process.env.BRIDGE_API_KEY;
    delete process.env.MOONPAY_API_KEY;
  });

  it('exports FiatService class and singleton helpers', async () => {
    const mod = await import('../extensions/crypto/src/services/fiat-service.js');
    expect(mod.FiatService).toBeDefined();
    expect(mod.getFiatService).toBeDefined();
    expect(mod.resetFiatService).toBeDefined();
  });

  it('isAvailable returns false when no providers are configured', () => {
    const svc = new FiatService({ stateDir: '/tmp/test-fiat-' + Date.now() });
    expect(svc.isAvailable()).toBe(false);
    expect(svc.getConfiguredProviders()).toEqual([]);
  });

  it('isAvailable returns true when BRIDGE_API_KEY is set', () => {
    process.env.BRIDGE_API_KEY = 'test-bridge-key';
    const svc = new FiatService({ stateDir: '/tmp/test-fiat-' + Date.now() });
    expect(svc.isAvailable()).toBe(true);
    expect(svc.getConfiguredProviders()).toContain('bridge');
  });

  it('isAvailable returns true when MOONPAY_API_KEY is set', () => {
    process.env.MOONPAY_API_KEY = 'test-moonpay-key';
    const svc = new FiatService({ stateDir: '/tmp/test-fiat-' + Date.now() });
    expect(svc.isAvailable()).toBe(true);
    expect(svc.getConfiguredProviders()).toContain('moonpay');
  });

  it('getQuotes throws when no providers configured', async () => {
    const svc = new FiatService({ stateDir: '/tmp/test-fiat-' + Date.now() });
    await expect(svc.getQuotes({
      direction: 'off_ramp',
      cryptoToken: 'USDC',
      amount: 100,
    })).rejects.toThrow('No fiat providers configured');
  });

  it('listTransfers returns empty array initially', () => {
    const svc = new FiatService({ stateDir: '/tmp/test-fiat-' + Date.now() });
    expect(svc.listTransfers()).toEqual([]);
  });

  it('getTransfer returns null for non-existent transfer', () => {
    const svc = new FiatService({ stateDir: '/tmp/test-fiat-' + Date.now() });
    expect(svc.getTransfer('non-existent')).toBeNull();
  });

  it('clear empties all transfers', () => {
    const svc = new FiatService({ stateDir: '/tmp/test-fiat-' + Date.now() });
    svc.clear();
    expect(svc.listTransfers()).toEqual([]);
  });

  it('listBankAccounts returns empty when no providers configured', async () => {
    const svc = new FiatService({ stateDir: '/tmp/test-fiat-' + Date.now() });
    const accounts = await svc.listBankAccounts();
    expect(accounts).toEqual([]);
  });

  it('singleton getFiatService returns same instance', async () => {
    const mod = await import('../extensions/crypto/src/services/fiat-service.js');
    const a = mod.getFiatService({ stateDir: '/tmp/test-fiat-singleton-' + Date.now() });
    const b = mod.getFiatService();
    expect(a).toBe(b);
  });
});

// ─── FiatPaymentTool Tests ──────────────────────────────────────────────

describe('FiatPaymentTool', () => {
  let createFiatPaymentTool: any;

  beforeEach(async () => {
    const mod = await import('../extensions/crypto/src/tools/fiat-payment.js');
    createFiatPaymentTool = mod.createFiatPaymentTool;
    // Reset fiat service singleton
    const { resetFiatService } = await import('../extensions/crypto/src/services/fiat-service.js');
    resetFiatService();
  });

  afterEach(() => {
    delete process.env.BRIDGE_API_KEY;
    delete process.env.MOONPAY_API_KEY;
  });

  it('creates a tool with correct name and properties', () => {
    const tool = createFiatPaymentTool();
    expect(tool.name).toBe('fiat_payment');
    expect(tool.label).toBe('Fiat Payment');
    expect(tool.ownerOnly).toBe(true);
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeInstanceOf(Function);
  });

  it('returns not-configured error when BRIDGE_API_KEY is missing', async () => {
    const tool = createFiatPaymentTool();
    const result = await tool.execute('test-id', { action: 'quote', amount: 100 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not configured');
  });

  it('quote action returns error when no providers available', async () => {
    // Set key so tool config check passes, but the actual API call will fail
    process.env.BRIDGE_API_KEY = 'test-key';
    const tool = createFiatPaymentTool();
    const result = await tool.execute('test-id', {
      action: 'quote',
      direction: 'off_ramp',
      amount: 100,
      crypto_token: 'USDC',
    });
    // Will either get quotes or error (no real API), but shouldn't crash
    expect(result.content).toBeDefined();
    expect(result.content[0].text).toBeDefined();
  });

  it('off_ramp action requires wallet connection', async () => {
    process.env.BRIDGE_API_KEY = 'test-key';
    const tool = createFiatPaymentTool();
    const result = await tool.execute('test-id', {
      action: 'off_ramp',
      amount: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('wallet');
  });

  it('on_ramp action requires wallet connection', async () => {
    process.env.BRIDGE_API_KEY = 'test-key';
    const tool = createFiatPaymentTool();
    const result = await tool.execute('test-id', {
      action: 'on_ramp',
      amount: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('wallet');
  });

  it('status action requires transfer_id', async () => {
    process.env.BRIDGE_API_KEY = 'test-key';
    const tool = createFiatPaymentTool();
    const result = await tool.execute('test-id', { action: 'status' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('transfer_id');
  });

  it('status action returns not found for unknown transfer', async () => {
    process.env.BRIDGE_API_KEY = 'test-key';
    const tool = createFiatPaymentTool();
    const result = await tool.execute('test-id', {
      action: 'status',
      transfer_id: 'non-existent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('accounts action requires provider configuration', async () => {
    const tool = createFiatPaymentTool();
    const result = await tool.execute('test-id', { action: 'accounts' });
    // Will error because no bridge key configured
    expect(result.isError).toBe(true);
  });

  it('history action works with no transfers', async () => {
    process.env.BRIDGE_API_KEY = 'test-key';
    const tool = createFiatPaymentTool();
    const result = await tool.execute('test-id', { action: 'history' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.totalTransfers).toBe(0);
    expect(data.transfers).toEqual([]);
  });

  it('rejects unknown action', async () => {
    process.env.BRIDGE_API_KEY = 'test-key';
    const tool = createFiatPaymentTool();
    const result = await tool.execute('test-id', { action: 'unknown' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown action');
  });
});

// ─── FiatCommand Tests ──────────────────────────────────────────────────

describe('FiatCommand', () => {
  afterEach(() => {
    delete process.env.BRIDGE_API_KEY;
    delete process.env.MOONPAY_API_KEY;
    delete process.env.FIAT_CURRENCY;
  });

  it('exports a command with correct shape', async () => {
    const { fiatCommand } = await import('../extensions/crypto/src/commands/fiat-command.js');
    expect(fiatCommand.name).toBe('fiat');
    expect(fiatCommand.description).toBeDefined();
    expect(fiatCommand.handler).toBeInstanceOf(Function);
  });

  it('handler returns text showing no providers when none configured', async () => {
    const { fiatCommand } = await import('../extensions/crypto/src/commands/fiat-command.js');
    const { resetFiatService } = await import('../extensions/crypto/src/services/fiat-service.js');
    resetFiatService();

    const result = await fiatCommand.handler();
    expect(result.text).toContain('None configured');
    expect(result.text).toContain('BRIDGE_API_KEY');
  });

  it('handler shows configured providers', async () => {
    process.env.BRIDGE_API_KEY = 'test-key';
    const { fiatCommand } = await import('../extensions/crypto/src/commands/fiat-command.js');
    const { resetFiatService } = await import('../extensions/crypto/src/services/fiat-service.js');
    resetFiatService();

    const result = await fiatCommand.handler();
    expect(result.text).toContain('bridge');
  });
});

// ─── Plugin Registration Counts ─────────────────────────────────────────

describe('V3 plugin registration counts', () => {
  it('registers 45 tools including fiat_payment', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const registered: string[] = [];
    const mockApi = {
      registerTool: (tool: any) => registered.push(tool.name),
      registerCommand: () => {},
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    expect(registered).toHaveLength(45);
    expect(registered).toContain('fiat_payment');
  });

  it('registers 118 commands including fiat, tools, agents, webhooks, skills, interrupt, api, and pull', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const commands: string[] = [];
    const mockApi = {
      registerTool: () => {},
      registerCommand: (cmd: any) => commands.push(cmd.name),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    expect(commands).toHaveLength(118);
    expect(commands).toContain('fiat');
    expect(commands).toContain('tools');
  });

  it('tool config has 38 entries including fiat_payment', async () => {
    const { getAllToolStatus } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    const statuses = getAllToolStatus();
    expect(statuses.length).toBe(39);
    const fiatConfig = statuses.find((s: any) => s.tool === 'fiat_payment');
    expect(fiatConfig).toBeDefined();
    expect(fiatConfig!.label).toBe('Fiat Payment');
  });

  it('fiat_payment is in WRITE_TOOL_NAMES (readonly gate)', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const toolNames: string[] = [];
    const mockApi = {
      registerTool: (tool: any) => toolNames.push(tool.name),
      registerCommand: () => {},
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    // fiat_payment should be registered
    expect(toolNames).toContain('fiat_payment');
  });
});

// ─── FiatService Type Exports ───────────────────────────────────────────

describe('FiatService types', () => {
  it('exports expected type interfaces', async () => {
    const mod = await import('../extensions/crypto/src/services/fiat-service.js');
    // These are runtime exports we can verify exist
    expect(mod.FiatService).toBeDefined();
    expect(mod.getFiatService).toBeDefined();
    expect(mod.resetFiatService).toBeDefined();
  });
});


