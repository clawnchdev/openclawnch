import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Service tests ──────────────────────────────────────────────────────

describe('fly-control-service', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.FLY_API_TOKEN = 'test-fly-token';
    process.env.FLY_APP_NAME = 'test-app';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('isFlyControlAvailable returns true when both vars set', async () => {
    const { isFlyControlAvailable } = await import(
      '../extensions/crypto/src/services/fly-control-service.js'
    );
    expect(isFlyControlAvailable()).toBe(true);
  });

  it('isFlyControlAvailable returns false when token missing', async () => {
    delete process.env.FLY_API_TOKEN;
    // Re-import to get fresh module
    const mod = await import(
      '../extensions/crypto/src/services/fly-control-service.js'
    );
    expect(mod.isFlyControlAvailable()).toBe(false);
  });

  it('isFlyControlAvailable returns false when app name missing', async () => {
    delete process.env.FLY_APP_NAME;
    const mod = await import(
      '../extensions/crypto/src/services/fly-control-service.js'
    );
    expect(mod.isFlyControlAvailable()).toBe(false);
  });

  it('getCurrentProvider defaults to anthropic', async () => {
    delete process.env.OPENCLAWNCH_LLM_PROVIDER;
    const { getCurrentProvider } = await import(
      '../extensions/crypto/src/services/fly-control-service.js'
    );
    expect(getCurrentProvider()).toBe('anthropic');
  });

  it('getCurrentProvider reads env var', async () => {
    process.env.OPENCLAWNCH_LLM_PROVIDER = 'bankr';
    const { getCurrentProvider } = await import(
      '../extensions/crypto/src/services/fly-control-service.js'
    );
    expect(getCurrentProvider()).toBe('bankr');
  });

  it('isValidProvider validates correctly', async () => {
    const { isValidProvider } = await import(
      '../extensions/crypto/src/services/fly-control-service.js'
    );
    expect(isValidProvider('anthropic')).toBe(true);
    expect(isValidProvider('bankr')).toBe(true);
    expect(isValidProvider('openrouter')).toBe(true);
    expect(isValidProvider('openai')).toBe(true);
    expect(isValidProvider('invalid')).toBe(false);
    expect(isValidProvider('')).toBe(false);
  });
});

// ─── Command shape tests ────────────────────────────────────────────────

describe('fly command shapes', () => {
  it('provider command has correct shape', async () => {
    const { providerCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    expect(providerCommand.name).toBe('provider');
    expect(providerCommand.requireAuth).toBe(true);
    expect(providerCommand.acceptsArgs).toBe(false);
    expect(typeof providerCommand.handler).toBe('function');
    expect(typeof providerCommand.description).toBe('string');
  });

  it('flykeys command has correct shape', async () => {
    const { flykeysCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    expect(flykeysCommand.name).toBe('flykeys');
    expect(flykeysCommand.requireAuth).toBe(true);
    expect(flykeysCommand.acceptsArgs).toBe(true);
    expect(typeof flykeysCommand.handler).toBe('function');
  });

  it('flystatus command has correct shape', async () => {
    const { flystatusCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    expect(flystatusCommand.name).toBe('flystatus');
    expect(flystatusCommand.requireAuth).toBe(true);
    expect(flystatusCommand.acceptsArgs).toBe(false);
    expect(typeof flystatusCommand.handler).toBe('function');
  });

  it('flyrestart command has correct shape', async () => {
    const { flyrestartCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    expect(flyrestartCommand.name).toBe('flyrestart');
    expect(flyrestartCommand.requireAuth).toBe(true);
    expect(flyrestartCommand.acceptsArgs).toBe(false);
    expect(typeof flyrestartCommand.handler).toBe('function');
  });
});

// ─── Command handler tests (without Fly API) ───────────────────────────

describe('fly command handlers (no Fly configured)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Ensure Fly control is NOT available
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_APP_NAME;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('/provider shows current provider even without Fly control', async () => {
    process.env.OPENCLAWNCH_LLM_PROVIDER = 'anthropic';
    const { providerCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await providerCommand.handler({});
    expect(result.text).toContain('Anthropic');
    expect(result.text).toContain('/provider_anthropic');
  });

  it('/provider_bankr shows setup instructions when no Fly control', async () => {
    const { providerBankrCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await providerBankrCommand.handler({});
    expect(result.text).toContain('Fly Control not configured');
    expect(result.text).toContain('FLY_API_TOKEN');
  });

  it('/flykeys shows setup instructions', async () => {
    const { flykeysCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await flykeysCommand.handler({ args: '' });
    expect(result.text).toContain('Fly Control not configured');
  });

  it('/flystatus shows setup instructions', async () => {
    const { flystatusCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await flystatusCommand.handler({});
    expect(result.text).toContain('Fly Control not configured');
  });

  it('/flyrestart shows setup instructions', async () => {
    const { flyrestartCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await flyrestartCommand.handler({});
    expect(result.text).toContain('Fly Control not configured');
  });

  it('/flykeys set with protected key is rejected', async () => {
    // Even when Fly control is available, protected keys should be blocked
    process.env.FLY_API_TOKEN = 'test-token';
    process.env.FLY_APP_NAME = 'test-app';

    const { flykeysCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await flykeysCommand.handler({
      args: '/flykeys set FLY_API_TOKEN malicious-value',
    });
    expect(result.text).toContain('protected');
    expect(result.text).toContain('cannot be modified');
  });

  it('/flykeys set with protected TELEGRAM_BOT_TOKEN is rejected', async () => {
    process.env.FLY_API_TOKEN = 'test-token';
    process.env.FLY_APP_NAME = 'test-app';

    const { flykeysCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await flykeysCommand.handler({
      args: '/flykeys set TELEGRAM_BOT_TOKEN bad-value',
    });
    expect(result.text).toContain('protected');
  });

  it('/flykeys set without value shows usage', async () => {
    process.env.FLY_API_TOKEN = 'test-token';
    process.env.FLY_APP_NAME = 'test-app';

    const { flykeysCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await flykeysCommand.handler({
      args: '/flykeys set BANKR_LLM_KEY',
    });
    expect(result.text).toContain('Usage');
    expect(result.text).toContain('/flykeys set KEY value');
  });

  it('/provider_bankr detects same provider and skips', async () => {
    process.env.FLY_API_TOKEN = 'test-token';
    process.env.FLY_APP_NAME = 'test-app';
    process.env.OPENCLAWNCH_LLM_PROVIDER = 'bankr';
    process.env.BANKR_LLM_KEY = 'bk_test';

    const { providerBankrCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await providerBankrCommand.handler({});
    expect(result.text).toContain('Already using');
  });

  it('/provider_bankr warns about missing API key', async () => {
    process.env.FLY_API_TOKEN = 'test-token';
    process.env.FLY_APP_NAME = 'test-app';
    process.env.OPENCLAWNCH_LLM_PROVIDER = 'anthropic';
    delete process.env.BANKR_LLM_KEY;

    const { providerBankrCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await providerBankrCommand.handler({});
    expect(result.text).toContain('Missing API key');
    expect(result.text).toContain('BANKR_LLM_KEY');
    expect(result.text).toContain('/flykeys');
  });
});

// ─── Plugin registration includes fly commands ──────────────────────────

describe('fly commands registered in plugin', () => {
  it('all fly + provider + model + reset commands are registered', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const commands: string[] = [];
    const mockApi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn((cmd: any) => commands.push(cmd.name)),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    plugin.register(mockApi);

    // Fly control
    expect(commands).toContain('provider');
    expect(commands).toContain('provider_anthropic');
    expect(commands).toContain('provider_bankr');
    expect(commands).toContain('provider_openrouter');
    expect(commands).toContain('flykeys');
    expect(commands).toContain('flystatus');
    expect(commands).toContain('flyrestart');
    // Model shortcuts
    expect(commands).toContain('llm_opus');
    expect(commands).toContain('llm_sonnet');
    expect(commands).toContain('llm_haiku');
    expect(commands).toContain('llm_gemini');
    expect(commands).toContain('llm_gpt');
    // Reset confirm
    expect(commands).toContain('factoryreset_confirm');
  });
});
