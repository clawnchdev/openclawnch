import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Bankr Types ─────────────────────────────────────────────────────────

describe('bankr types', () => {
  it('exports all error classes', async () => {
    const types = await import('../extensions/crypto/src/services/bankr-types.js');
    expect(types.BankrAuthError).toBeDefined();
    expect(types.BankrCreditsError).toBeDefined();
    expect(types.BankrAccessError).toBeDefined();
    expect(types.BankrReadOnlyError).toBeDefined();
    expect(types.BankrRateLimitError).toBeDefined();
    expect(types.BankrServerError).toBeDefined();
  });

  it('BankrAuthError has correct name and message', async () => {
    const { BankrAuthError } = await import('../extensions/crypto/src/services/bankr-types.js');
    const err = new BankrAuthError();
    expect(err.name).toBe('BankrAuthError');
    expect(err.message).toContain('BANKR_API_KEY');
  });

  it('BankrAccessError has correct message', async () => {
    const { BankrAccessError } = await import('../extensions/crypto/src/services/bankr-types.js');
    const err = new BankrAccessError();
    expect(err.name).toBe('BankrAccessError');
    expect(err.message).toContain('Agent API not enabled');
  });

  it('BankrRateLimitError stores resetAt, limit, used', async () => {
    const { BankrRateLimitError } = await import('../extensions/crypto/src/services/bankr-types.js');
    const err = new BankrRateLimitError(1700000000000, 100, 95);
    expect(err.name).toBe('BankrRateLimitError');
    expect(err.resetAt).toBe(1700000000000);
    expect(err.limit).toBe(100);
    expect(err.used).toBe(95);
  });

  it('BankrServerError stores statusCode', async () => {
    const { BankrServerError } = await import('../extensions/crypto/src/services/bankr-types.js');
    const err = new BankrServerError(503);
    expect(err.statusCode).toBe(503);
  });

  it('CHAIN_MAP maps common chain names', async () => {
    const { CHAIN_MAP } = await import('../extensions/crypto/src/services/bankr-types.js');
    expect(CHAIN_MAP.base).toBe('base');
    expect(CHAIN_MAP.ethereum).toBe('mainnet');
    expect(CHAIN_MAP.eth).toBe('mainnet');
    expect(CHAIN_MAP.polygon).toBe('polygon');
    expect(CHAIN_MAP.solana).toBe('solana');
    expect(CHAIN_MAP.sol).toBe('solana');
    expect(CHAIN_MAP.unichain).toBe('unichain');
  });
});

// ─── Bankr API Client ───────────────────────────────────────────────────

describe('bankr API client', () => {
  const originalEnv = process.env.BANKR_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.BANKR_API_KEY = originalEnv;
    } else {
      delete process.env.BANKR_API_KEY;
    }
  });

  it('hasBankrApi returns false when no key set', async () => {
    delete process.env.BANKR_API_KEY;
    const { hasBankrApi } = await import('../extensions/crypto/src/services/bankr-api.js');
    expect(hasBankrApi()).toBe(false);
  });

  it('hasBankrApi returns true when key set', async () => {
    process.env.BANKR_API_KEY = 'bk_test_key';
    const { hasBankrApi } = await import('../extensions/crypto/src/services/bankr-api.js');
    expect(hasBankrApi()).toBe(true);
  });

  it('getBankrApiKey returns key from env', async () => {
    process.env.BANKR_API_KEY = 'bk_test_key';
    const { getBankrApiKey } = await import('../extensions/crypto/src/services/bankr-api.js');
    expect(getBankrApiKey()).toBe('bk_test_key');
  });

  it('getBankrApiKey returns null when not set', async () => {
    delete process.env.BANKR_API_KEY;
    const { getBankrApiKey } = await import('../extensions/crypto/src/services/bankr-api.js');
    expect(getBankrApiKey()).toBeNull();
  });

  it('thread ID storage works', async () => {
    const { storeBankrThreadId, getBankrThreadId } = await import('../extensions/crypto/src/services/bankr-api.js');
    storeBankrThreadId('user1', 'thread_abc');
    expect(getBankrThreadId('user1')).toBe('thread_abc');
    expect(getBankrThreadId('user2')).toBeUndefined();
  });

  it('bankrGet throws BankrAuthError when no key set', async () => {
    delete process.env.BANKR_API_KEY;
    const { bankrGet } = await import('../extensions/crypto/src/services/bankr-api.js');
    await expect(bankrGet('/agent/me')).rejects.toThrow('BANKR_API_KEY');
  });

  it('bankrPost throws BankrAuthError when no key set', async () => {
    delete process.env.BANKR_API_KEY;
    const { bankrPost } = await import('../extensions/crypto/src/services/bankr-api.js');
    await expect(bankrPost('/agent/prompt', { prompt: 'test' })).rejects.toThrow('BANKR_API_KEY');
  });
});

// ─── Bankr Wallet Mode ──────────────────────────────────────────────────

describe('bankr wallet mode in WalletState type', () => {
  it('WalletState supports bankr mode fields', async () => {
    const types = await import('../extensions/crypto/src/lib/types.js');
    // Type-level check: WalletState should accept bankr mode
    const state: import('../extensions/crypto/src/lib/types.js').WalletState = {
      connected: true,
      address: '0x1234567890abcdef1234567890abcdef12345678' as any,
      chainId: 8453,
      mode: 'bankr',
      policies: [],
      wcState: null,
      bankrEvmAddress: '0xABCD',
      bankrSolAddress: '5FHwyz',
      bankrClub: true,
    };
    expect(state.mode).toBe('bankr');
    expect(state.bankrEvmAddress).toBe('0xABCD');
    expect(state.bankrSolAddress).toBe('5FHwyz');
    expect(state.bankrClub).toBe(true);
  });
});

// ─── Plugin Registration with Bankr Tools ────────────────────────────────

describe('plugin registration with bankr', () => {
  it('registers 28 tools including 4 bankr tools', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const registered: string[] = [];
    const mockApi = {
      registerTool: vi.fn((tool: any) => registered.push(tool.name)),
      registerCommand: vi.fn(),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    plugin.register(mockApi);
    expect(registered).toHaveLength(28);
    expect(registered).toContain('bankr_launch');
    expect(registered).toContain('bankr_automate');
    expect(registered).toContain('bankr_polymarket');
    expect(registered).toContain('bankr_leverage');
  });

  it('registers 41 commands including connect_bankr and automations', async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const commands: string[] = [];
    const mockApi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn((cmd: any) => commands.push(cmd.name)),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    plugin.register(mockApi);
    expect(commands).toHaveLength(67);
    expect(commands).toContain('connect_bankr');
    expect(commands).toContain('automations');
    expect(commands).toContain('provider');
    expect(commands).toContain('provider_anthropic');
    expect(commands).toContain('provider_bankr');
    expect(commands).toContain('provider_openrouter');
    expect(commands).toContain('flykeys');
    expect(commands).toContain('flystatus');
    expect(commands).toContain('flyrestart');
    expect(commands).toContain('llm_opus');
    expect(commands).toContain('factoryreset_confirm');
  });
});
