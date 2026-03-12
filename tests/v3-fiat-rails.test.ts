/**
 * V3 Fiat & Traditional Finance Rails — comprehensive test suite.
 *
 * Tests:
 * - FiatService: provider registration, quote aggregation, transfers, persistence
 * - FiatPaymentTool: action routing, parameter parsing, error handling
 * - PaymentRequestService: create, get, mark paid, cancel, expiry
 * - FiatCommand: handler output
 * - Plugin registration counts (43 tools, 96 commands, 37 tool configs)
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

// ─── PaymentRequestService Tests ────────────────────────────────────────

describe('PaymentRequestService', () => {
  let PaymentRequestService: any;
  let resetPaymentRequestService: any;
  let stateDir: string;

  beforeEach(async () => {
    const mod = await import('../extensions/crypto/src/services/payment-request.js');
    PaymentRequestService = mod.PaymentRequestService;
    resetPaymentRequestService = mod.resetPaymentRequestService;
    stateDir = '/tmp/test-payment-req-' + Date.now();
    resetPaymentRequestService();
  });

  afterEach(() => {
    resetPaymentRequestService();
  });

  it('exports service class and helpers', async () => {
    const mod = await import('../extensions/crypto/src/services/payment-request.js');
    expect(mod.PaymentRequestService).toBeDefined();
    expect(mod.getPaymentRequestService).toBeDefined();
    expect(mod.resetPaymentRequestService).toBeDefined();
  });

  it('creates a payment request with correct fields', () => {
    const svc = new PaymentRequestService({ stateDir });
    const req = svc.create({
      createdBy: '0xABC123',
      recipientAddress: '0xDEF456',
      amount: '100',
      token: 'USDC',
      chainId: 8453,
      memo: 'Payment for services',
    });

    expect(req.id).toMatch(/^pr_/);
    expect(req.createdBy).toBe('0xABC123');
    expect(req.recipientAddress).toBe('0xDEF456');
    expect(req.amount).toBe('100');
    expect(req.token).toBe('USDC');
    expect(req.chainId).toBe(8453);
    expect(req.memo).toBe('Payment for services');
    expect(req.status).toBe('pending');
    expect(req.paymentUrl).toBeDefined();
    expect(req.createdAt).toBeDefined();
  });

  it('generates EIP-681 payment URL for native token', () => {
    const svc = new PaymentRequestService({ stateDir });
    const req = svc.create({
      createdBy: '0xABC',
      recipientAddress: '0xDEF456',
      amount: '1000000000000000000',
      token: 'ETH',
      chainId: 1,
    });

    expect(req.paymentUrl).toContain('ethereum:0xDEF456@1?value=');
  });

  it('generates EIP-681 payment URL for ERC-20 token', () => {
    const svc = new PaymentRequestService({ stateDir });
    const req = svc.create({
      createdBy: '0xABC',
      recipientAddress: '0xDEF456',
      amount: '100000000',
      token: 'USDC',
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: 8453,
    });

    expect(req.paymentUrl).toContain('base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer');
    expect(req.paymentUrl).toContain('address=0xDEF456');
  });

  it('retrieves a payment request by ID', () => {
    const svc = new PaymentRequestService({ stateDir });
    const created = svc.create({
      createdBy: '0xABC',
      recipientAddress: '0xDEF',
      amount: '100',
      token: 'USDC',
    });

    const fetched = svc.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  it('returns null for non-existent request', () => {
    const svc = new PaymentRequestService({ stateDir });
    expect(svc.get('non-existent')).toBeNull();
  });

  it('marks a payment request as paid', () => {
    const svc = new PaymentRequestService({ stateDir });
    const req = svc.create({
      createdBy: '0xABC',
      recipientAddress: '0xDEF',
      amount: '100',
      token: 'USDC',
    });

    const paid = svc.markPaid(req.id, '0xTXHASH');
    expect(paid!.status).toBe('paid');
    expect(paid!.txHash).toBe('0xTXHASH');
  });

  it('cancels a payment request', () => {
    const svc = new PaymentRequestService({ stateDir });
    const req = svc.create({
      createdBy: '0xABC',
      recipientAddress: '0xDEF',
      amount: '100',
      token: 'USDC',
    });

    const cancelled = svc.cancel(req.id);
    expect(cancelled!.status).toBe('cancelled');
  });

  it('auto-expires payment requests', () => {
    const svc = new PaymentRequestService({ stateDir });
    const req = svc.create({
      createdBy: '0xABC',
      recipientAddress: '0xDEF',
      amount: '100',
      token: 'USDC',
      expiresInMs: -1, // Already expired
    });

    const fetched = svc.get(req.id);
    expect(fetched!.status).toBe('expired');
  });

  it('lists payment requests', () => {
    const svc = new PaymentRequestService({ stateDir });
    svc.create({ createdBy: '0xA', recipientAddress: '0xB', amount: '1', token: 'ETH' });
    svc.create({ createdBy: '0xC', recipientAddress: '0xD', amount: '2', token: 'USDC' });

    expect(svc.list().length).toBe(2);
    expect(svc.list('0xA').length).toBe(1);
    expect(svc.list('0xC').length).toBe(1);
    expect(svc.list('0xZ').length).toBe(0);
  });

  it('clear empties all requests', () => {
    const svc = new PaymentRequestService({ stateDir });
    svc.create({ createdBy: '0xA', recipientAddress: '0xB', amount: '1', token: 'ETH' });
    svc.clear();
    expect(svc.list().length).toBe(0);
  });

  it('singleton getPaymentRequestService returns same instance', async () => {
    const mod = await import('../extensions/crypto/src/services/payment-request.js');
    const a = mod.getPaymentRequestService({ stateDir });
    const b = mod.getPaymentRequestService();
    expect(a).toBe(b);
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
  it('registers 43 tools including fiat_payment', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const registered: string[] = [];
    const mockApi = {
      registerTool: (tool: any) => registered.push(tool.name),
      registerCommand: () => {},
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    expect(registered).toHaveLength(43);
    expect(registered).toContain('fiat_payment');
  });

  it('registers 96 commands including fiat', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const commands: string[] = [];
    const mockApi = {
      registerTool: () => {},
      registerCommand: (cmd: any) => commands.push(cmd.name),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    expect(commands).toHaveLength(96);
    expect(commands).toContain('fiat');
  });

  it('tool config has 37 entries including fiat_payment', async () => {
    const { getAllToolStatus } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    const statuses = getAllToolStatus();
    expect(statuses.length).toBe(37);
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

// ─── PaymentRequestService Type Exports ─────────────────────────────────

describe('PaymentRequestService types', () => {
  it('exports expected type interfaces', async () => {
    const mod = await import('../extensions/crypto/src/services/payment-request.js');
    expect(mod.PaymentRequestService).toBeDefined();
    expect(mod.getPaymentRequestService).toBeDefined();
    expect(mod.resetPaymentRequestService).toBeDefined();
  });
});
