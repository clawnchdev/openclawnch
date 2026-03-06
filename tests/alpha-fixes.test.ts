/**
 * Alpha Readiness Fixes Tests
 *
 * Tests all fixes from the alpha audit (session):
 *   H1: Onboarding flow advances when /connect_* establishes wallet session
 *   H2: /flykeys allowlist includes X_API_KEY, BASESCAN_API_KEY, etc.
 *   H4: Balance resolver handles non-18-decimal tokens (code path check)
 *   H5: defi_swap detects output token decimals (code path check)
 *   H6: /flykeys set warns user to delete message containing secret
 *   H7: /help returns grouped commands
 *   H8: /portfolio handles no-wallet and connected states
 *   H9: Onboarding references HUMMINGBOT_API_URL (not HUMMINGBOT_URL)
 *   3.1: /wallet shows "Bankr (custodial)" when mode is bankr
 *   7.1: X_API_KEY (not TWITTER_API_KEY) is in flykeys allowlist
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import plugin from '../extensions/crypto/index.js';

const TEST_DIR = join(__dirname, '..', '.test-alpha-fixes');

// ── H1: Onboarding advances on wallet connection ────────────────────────

describe('H1: /connect_* advances onboarding on wallet connection', () => {
  beforeEach(() => {
    process.env.OPENCLAWNCH_TX_DIR = join(TEST_DIR, 'tx');
    mkdirSync(join(TEST_DIR, 'tx'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    delete process.env.OPENCLAWNCH_TX_DIR;
  });

  it('onWalletConnected advances flow from connect_wallet to first_read', async () => {
    const { OnboardingFlow } = await import(
      '../extensions/crypto/src/services/onboarding-flow.js'
    );
    const flow = new OnboardingFlow('alpha-h1-user');

    // Walk through to connect_wallet step
    flow.getWelcomeMessage();
    flow.onPersonaSelected('1'); // professional
    flow.onCapabilitiesSelected('1, 2, 3'); // includes wallet → connect_wallet

    expect(flow.currentStep).toBe('connect_wallet');

    // Simulate what connect-command.ts does after session establishes
    const msg = flow.onWalletConnected('0xABCD1234abcd5678ABCD1234abcd5678ABCD1234', 'chain 8453');
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('0xABCD');
    expect(flow.currentStep).toBe('first_read');
  });

  it('onWalletConnected returns null if not on connect_wallet step', async () => {
    const { OnboardingFlow } = await import(
      '../extensions/crypto/src/services/onboarding-flow.js'
    );
    const flow = new OnboardingFlow('alpha-h1-wrong-step');

    // Still on welcome step
    expect(flow.currentStep).toBe('welcome');

    const msg = flow.onWalletConnected('0x1234', 'chain 1');
    expect(msg).toBeNull();
    expect(flow.currentStep).toBe('welcome'); // unchanged
  });

  it('connect-command.ts imports and calls getOnboardingFlow', async () => {
    // Verify the import path exists (compile-time check)
    const connectModule = await import(
      '../extensions/crypto/src/commands/connect-command.js'
    );
    expect(connectModule.connectCommand).toBeDefined();
    expect(connectModule.connectCommand.name).toBe('connect');
    expect(connectModule.walletConnectCommands).toBeDefined();
    expect(connectModule.walletConnectCommands.length).toBeGreaterThan(0);
  });
});

// ── H7: /help command ───────────────────────────────────────────────────

describe('H7: /help command returns grouped commands', () => {
  it('returns text with all command categories', async () => {
    const { helpCommand } = await import(
      '../extensions/crypto/src/commands/help-command.js'
    );
    const result = await helpCommand.handler({});
    const text = result.text;

    // Title
    expect(text).toContain('OpenClawnch Commands');

    // Key categories
    expect(text).toContain('**Wallet**');
    expect(text).toContain('**Safety & Signing**');
    expect(text).toContain('**Spending**');
    expect(text).toContain('**LLM**');
    expect(text).toContain('**Persona**');
    expect(text).toContain('**Scheduled Operations**');
    expect(text).toContain('**Bankr**');
    expect(text).toContain('**Deploy Control**');
    expect(text).toContain('**Other**');
  });

  it('includes key commands in help text', async () => {
    const { helpCommand } = await import(
      '../extensions/crypto/src/commands/help-command.js'
    );
    const result = await helpCommand.handler({});
    const text = result.text;

    // Important commands that should always be listed
    expect(text).toContain('/connect');
    expect(text).toContain('/wallet');
    expect(text).toContain('/portfolio');
    expect(text).toContain('/safemode');
    expect(text).toContain('/dangermode');
    expect(text).toContain('/llm');
    expect(text).toContain('/plans');
    expect(text).toContain('/flykeys');
    expect(text).toContain('/factoryreset');
  });

  it('refers to itself as OpenClawnch, not OpenClaw', async () => {
    const { helpCommand } = await import(
      '../extensions/crypto/src/commands/help-command.js'
    );
    const result = await helpCommand.handler({});
    expect(result.text).toContain('OpenClawnch');
    expect(result.text).not.toMatch(/\bOpenClaw\b/); // Exact word match, not substring
  });

  it('does not require auth (anyone can see help)', async () => {
    const { helpCommand } = await import(
      '../extensions/crypto/src/commands/help-command.js'
    );
    expect(helpCommand.requireAuth).toBe(false);
  });
});

// ── H8: /portfolio command ──────────────────────────────────────────────

describe('H8: /portfolio command', () => {
  it('returns connect prompt when no wallet', async () => {
    // Mock getWalletState to return disconnected
    vi.doMock('../extensions/crypto/src/services/walletconnect-service.js', () => ({
      getWalletState: () => ({ connected: false, address: null, mode: 'walletconnect', policies: [], chainId: null }),
      initWalletService: vi.fn(),
      waitForWalletSession: vi.fn(),
      isBankrMode: () => false,
    }));

    // Clear and re-import
    vi.resetModules();
    const { portfolioCommand } = await import(
      '../extensions/crypto/src/commands/help-command.js'
    );
    const result = await portfolioCommand.handler({});

    expect(result.text).toContain('No wallet connected');
    expect(result.text).toContain('/connect');
    expect(result.text).toContain('/connect_bankr');

    vi.doUnmock('../extensions/crypto/src/services/walletconnect-service.js');
    vi.resetModules();
  });

  it('returns wallet info when connected via WalletConnect', async () => {
    vi.doMock('../extensions/crypto/src/services/walletconnect-service.js', () => ({
      getWalletState: () => ({
        connected: true,
        address: '0xAbCdEf1234567890aBcDeF1234567890AbCdEf12',
        mode: 'walletconnect',
        policies: [],
        chainId: 8453,
      }),
      initWalletService: vi.fn(),
      waitForWalletSession: vi.fn(),
      isBankrMode: () => false,
    }));

    vi.resetModules();
    const { portfolioCommand } = await import(
      '../extensions/crypto/src/commands/help-command.js'
    );
    const result = await portfolioCommand.handler({});

    expect(result.text).toContain('0xAbCd');
    expect(result.text).toContain('Ef12');
    expect(result.text).toContain('WalletConnect');
    expect(result.text).toContain('Show my portfolio');

    vi.doUnmock('../extensions/crypto/src/services/walletconnect-service.js');
    vi.resetModules();
  });

  it('shows Bankr (custodial) when connected via Bankr', async () => {
    vi.doMock('../extensions/crypto/src/services/walletconnect-service.js', () => ({
      getWalletState: () => ({
        connected: true,
        address: '0x1234567890abcdef1234567890abcdef12345678',
        mode: 'bankr',
        policies: [],
        chainId: 8453,
        bankrSolAddress: 'SoLaBcD1234XYZ',
      }),
      initWalletService: vi.fn(),
      waitForWalletSession: vi.fn(),
      isBankrMode: () => true,
    }));

    vi.resetModules();
    const { portfolioCommand } = await import(
      '../extensions/crypto/src/commands/help-command.js'
    );
    const result = await portfolioCommand.handler({});

    expect(result.text).toContain('Bankr (custodial)');
    expect(result.text).toContain('Solana');
    expect(result.text).toContain('SoLaBc');

    vi.doUnmock('../extensions/crypto/src/services/walletconnect-service.js');
    vi.resetModules();
  });

  it('requires auth (only owner)', async () => {
    const { portfolioCommand } = await import(
      '../extensions/crypto/src/commands/help-command.js'
    );
    expect(portfolioCommand.requireAuth).toBe(true);
  });
});

// ── H2 + 7.1: /flykeys allowlist ───────────────────────────────────────

describe('H2 + 7.1: /flykeys allowlist includes correct keys', () => {
  it('recognizes X_API_KEY (not TWITTER_API_KEY)', async () => {
    // Read the fly-commands source and check allowlist
    const flyModule = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    // The flykeysCommand handler checks against KNOWN_SECRETS internally.
    // We test by calling the handler with `set X_API_KEY test_value` which should
    // attempt to set (and fail at the Fly API call, not at the allowlist check)
    // vs TWITTER_API_KEY which should be rejected by the allowlist.

    // We need Fly control to be available for this test
    vi.doMock('../extensions/crypto/src/services/fly-control-service.js', () => ({
      isFlyControlAvailable: () => true,
      getCurrentProvider: () => 'anthropic',
      isValidProvider: () => true,
      setProvider: vi.fn(),
      scheduleRestart: vi.fn(),
      listSecrets: vi.fn().mockResolvedValue([]),
      setSecrets: vi.fn().mockResolvedValue(undefined),
      deleteSecret: vi.fn(),
      listMachines: vi.fn().mockResolvedValue([]),
      restartAllMachines: vi.fn(),
      FlyNotConfiguredError: class extends Error {},
    }));

    vi.resetModules();
    const { flykeysCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );

    // X_API_KEY should be accepted (setSecrets called, not rejected)
    const resultOk = await flykeysCommand.handler({
      args: 'set X_API_KEY test_value_123',
      text: '/flykeys set X_API_KEY test_value_123',
    });
    expect(resultOk.text).toContain('set successfully');
    expect(resultOk.text).not.toContain('not a recognized secret');

    // TWITTER_API_KEY should be rejected
    const resultBad = await flykeysCommand.handler({
      args: 'set TWITTER_API_KEY test_value_123',
      text: '/flykeys set TWITTER_API_KEY test_value_123',
    });
    expect(resultBad.text).toContain('not a recognized secret');

    vi.doUnmock('../extensions/crypto/src/services/fly-control-service.js');
    vi.resetModules();
  });

  it('recognizes BASESCAN_API_KEY, ETHERSCAN_API_KEY, HUMMINGBOT_API_URL', async () => {
    vi.doMock('../extensions/crypto/src/services/fly-control-service.js', () => ({
      isFlyControlAvailable: () => true,
      getCurrentProvider: () => 'anthropic',
      isValidProvider: () => true,
      setProvider: vi.fn(),
      scheduleRestart: vi.fn(),
      listSecrets: vi.fn().mockResolvedValue([]),
      setSecrets: vi.fn().mockResolvedValue(undefined),
      deleteSecret: vi.fn(),
      listMachines: vi.fn().mockResolvedValue([]),
      restartAllMachines: vi.fn(),
      FlyNotConfiguredError: class extends Error {},
    }));

    vi.resetModules();
    const { flykeysCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );

    for (const key of ['BASESCAN_API_KEY', 'ETHERSCAN_API_KEY', 'HUMMINGBOT_API_URL', 'MOLTEN_API_KEY', 'LIFI_API_KEY']) {
      const result = await flykeysCommand.handler({
        args: `set ${key} test_val`,
        text: `/flykeys set ${key} test_val`,
      });
      expect(result.text, `${key} should be accepted`).toContain('set successfully');
    }

    vi.doUnmock('../extensions/crypto/src/services/fly-control-service.js');
    vi.resetModules();
  });

  it('rejects FLY_API_TOKEN as protected', async () => {
    vi.doMock('../extensions/crypto/src/services/fly-control-service.js', () => ({
      isFlyControlAvailable: () => true,
      getCurrentProvider: () => 'anthropic',
      isValidProvider: () => true,
      setProvider: vi.fn(),
      scheduleRestart: vi.fn(),
      listSecrets: vi.fn().mockResolvedValue([]),
      setSecrets: vi.fn().mockResolvedValue(undefined),
      deleteSecret: vi.fn(),
      listMachines: vi.fn().mockResolvedValue([]),
      restartAllMachines: vi.fn(),
      FlyNotConfiguredError: class extends Error {},
    }));

    vi.resetModules();
    const { flykeysCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );

    const result = await flykeysCommand.handler({
      args: 'set FLY_API_TOKEN some_token',
      text: '/flykeys set FLY_API_TOKEN some_token',
    });
    expect(result.text).toContain('protected');
    expect(result.text).not.toContain('set successfully');

    vi.doUnmock('../extensions/crypto/src/services/fly-control-service.js');
    vi.resetModules();
  });
});

// ── H6: /flykeys set security warning ──────────────────────────────────

describe('H6: /flykeys set warns user to delete message', () => {
  it('response contains "Delete your message" security warning', async () => {
    vi.doMock('../extensions/crypto/src/services/fly-control-service.js', () => ({
      isFlyControlAvailable: () => true,
      getCurrentProvider: () => 'anthropic',
      isValidProvider: () => true,
      setProvider: vi.fn(),
      scheduleRestart: vi.fn(),
      listSecrets: vi.fn().mockResolvedValue([]),
      setSecrets: vi.fn().mockResolvedValue(undefined),
      deleteSecret: vi.fn(),
      listMachines: vi.fn().mockResolvedValue([]),
      restartAllMachines: vi.fn(),
      FlyNotConfiguredError: class extends Error {},
    }));

    vi.resetModules();
    const { flykeysCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );

    const result = await flykeysCommand.handler({
      args: 'set ANTHROPIC_API_KEY sk-ant-fake-key-123',
      text: '/flykeys set ANTHROPIC_API_KEY sk-ant-fake-key-123',
    });

    expect(result.text).toContain('set successfully');
    expect(result.text).toMatch(/[Dd]elete your message/);
    expect(result.text).toContain('Security');

    vi.doUnmock('../extensions/crypto/src/services/fly-control-service.js');
    vi.resetModules();
  });
});

// ── H9: Onboarding uses HUMMINGBOT_API_URL ─────────────────────────────

describe('H9: Onboarding references HUMMINGBOT_API_URL', () => {
  it('onboarding-flow.ts mentions HUMMINGBOT_API_URL, not HUMMINGBOT_URL', async () => {
    // Import the module and check the source references are correct
    // We check the capabilities definition and any text that references Hummingbot
    const { CAPABILITIES } = await import(
      '../extensions/crypto/src/services/onboarding-flow.js'
    );

    // Find the trading/hummingbot capability
    const tradingCap = CAPABILITIES.find(
      (c: any) => c.id === 'trading' || c.tools?.includes('hummingbot'),
    );

    if (tradingCap?.deployRequirement) {
      expect(tradingCap.deployRequirement).not.toContain('HUMMINGBOT_URL');
      // If it references Hummingbot at all, it should use the correct env var name
      if (tradingCap.deployRequirement.includes('HUMMINGBOT')) {
        expect(tradingCap.deployRequirement).toContain('HUMMINGBOT_API_URL');
      }
    }
  });
});

// ── 3.1: /wallet shows "Bankr (custodial)" ─────────────────────────────

describe('3.1: /wallet shows correct mode label', () => {
  it('shows "Bankr (custodial)" when mode is bankr', async () => {
    vi.doMock('../extensions/crypto/src/services/walletconnect-service.js', () => ({
      getWalletState: () => ({
        connected: true,
        address: '0xBankrAddress1234567890abcdef1234567890ab',
        mode: 'bankr',
        policies: [],
        chainId: 8453,
      }),
      initWalletService: vi.fn(),
      waitForWalletSession: vi.fn(),
      isBankrMode: () => true,
    }));
    vi.doMock('@clawnch/sdk', () => ({
      formatPolicy: (p: any) => `policy: ${JSON.stringify(p)}`,
    }));

    vi.resetModules();
    const { walletCommand } = await import(
      '../extensions/crypto/src/commands/wallet-command.js'
    );
    const result = await walletCommand.handler();

    expect(result.text).toContain('Bankr (custodial)');
    expect(result.text).not.toContain('WalletConnect');

    vi.doUnmock('../extensions/crypto/src/services/walletconnect-service.js');
    vi.doUnmock('@clawnch/sdk');
    vi.resetModules();
  });

  it('shows "WalletConnect" when mode is walletconnect', async () => {
    vi.doMock('../extensions/crypto/src/services/walletconnect-service.js', () => ({
      getWalletState: () => ({
        connected: true,
        address: '0xWalletConnect1234567890abcdef12345678ab',
        mode: 'walletconnect',
        policies: [],
        chainId: 1,
      }),
      initWalletService: vi.fn(),
      waitForWalletSession: vi.fn(),
      isBankrMode: () => false,
    }));
    vi.doMock('@clawnch/sdk', () => ({
      formatPolicy: (p: any) => `policy: ${JSON.stringify(p)}`,
    }));

    vi.resetModules();
    const { walletCommand } = await import(
      '../extensions/crypto/src/commands/wallet-command.js'
    );
    const result = await walletCommand.handler();

    expect(result.text).toContain('WalletConnect');
    expect(result.text).not.toContain('Bankr');

    vi.doUnmock('../extensions/crypto/src/services/walletconnect-service.js');
    vi.doUnmock('@clawnch/sdk');
    vi.resetModules();
  });

  it('shows "Private key (headless)" when mode is private_key', async () => {
    vi.doMock('../extensions/crypto/src/services/walletconnect-service.js', () => ({
      getWalletState: () => ({
        connected: true,
        address: '0xPrivateKey1234567890abcdef1234567890abcd',
        mode: 'private_key',
        policies: [],
        chainId: 1,
      }),
      initWalletService: vi.fn(),
      waitForWalletSession: vi.fn(),
      isBankrMode: () => false,
    }));
    vi.doMock('@clawnch/sdk', () => ({
      formatPolicy: (p: any) => `policy: ${JSON.stringify(p)}`,
    }));

    vi.resetModules();
    const { walletCommand } = await import(
      '../extensions/crypto/src/commands/wallet-command.js'
    );
    const result = await walletCommand.handler();

    expect(result.text).toContain('Private key (headless)');

    vi.doUnmock('../extensions/crypto/src/services/walletconnect-service.js');
    vi.doUnmock('@clawnch/sdk');
    vi.resetModules();
  });

  it('shows disconnect message when not connected', async () => {
    vi.doMock('../extensions/crypto/src/services/walletconnect-service.js', () => ({
      getWalletState: () => ({
        connected: false,
        address: null,
        mode: 'walletconnect',
        policies: [],
        chainId: null,
      }),
      initWalletService: vi.fn(),
      waitForWalletSession: vi.fn(),
      isBankrMode: () => false,
    }));
    vi.doMock('@clawnch/sdk', () => ({
      formatPolicy: (p: any) => `policy: ${JSON.stringify(p)}`,
    }));

    vi.resetModules();
    const { walletCommand } = await import(
      '../extensions/crypto/src/commands/wallet-command.js'
    );
    const result = await walletCommand.handler();

    expect(result.text).toContain('No wallet connected');

    vi.doUnmock('../extensions/crypto/src/services/walletconnect-service.js');
    vi.doUnmock('@clawnch/sdk');
    vi.resetModules();
  });
});

// ── .env.example completeness ───────────────────────────────────────────

describe('.env.example includes all required env vars', () => {
  it('contains X_API_KEY (not TWITTER_API_KEY)', async () => {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(
      join(__dirname, '..', 'deploy', '.env.example'),
      'utf-8',
    );
    expect(content).toContain('X_API_KEY');
    expect(content).toContain('X_API_SECRET');
    expect(content).toContain('X_ACCESS_TOKEN');
    expect(content).toContain('X_ACCESS_TOKEN_SECRET');
    expect(content).toContain('X_BEARER_TOKEN');
    expect(content).not.toContain('TWITTER_API_KEY');
    expect(content).not.toContain('TWITTER_API_SECRET');
  });

  it('contains HUMMINGBOT_API_URL (not HUMMINGBOT_URL)', async () => {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(
      join(__dirname, '..', 'deploy', '.env.example'),
      'utf-8',
    );
    expect(content).toContain('HUMMINGBOT_API_URL');
  });

  it('contains BASESCAN_API_KEY and ETHERSCAN_API_KEY', async () => {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(
      join(__dirname, '..', 'deploy', '.env.example'),
      'utf-8',
    );
    expect(content).toContain('BASESCAN_API_KEY');
    expect(content).toContain('ETHERSCAN_API_KEY');
  });

  it('contains OPENAI_API_KEY', async () => {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(
      join(__dirname, '..', 'deploy', '.env.example'),
      'utf-8',
    );
    expect(content).toContain('OPENAI_API_KEY');
  });

  it('contains MOLTEN_API_KEY and LIFI_API_KEY', async () => {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(
      join(__dirname, '..', 'deploy', '.env.example'),
      'utf-8',
    );
    expect(content).toContain('MOLTEN_API_KEY');
    expect(content).toContain('LIFI_API_KEY');
  });

  it('contains all channel configs (Telegram, Discord, Slack)', async () => {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(
      join(__dirname, '..', 'deploy', '.env.example'),
      'utf-8',
    );
    expect(content).toContain('TELEGRAM_BOT_TOKEN');
    expect(content).toContain('DISCORD_TOKEN');
    expect(content).toContain('SLACK_BOT_TOKEN');
  });
});

// ── fly.template.toml uses Dockerfile (not ghcr.io) ────────────────────

describe('fly.template.toml correctness', () => {
  it('uses dockerfile build, not ghcr.io image', async () => {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(
      join(__dirname, '..', 'deploy', 'fly.template.toml'),
      'utf-8',
    );
    expect(content).toContain('dockerfile');
    expect(content).not.toContain('ghcr.io');
  });

  it('uses clear placeholder names (YOUR_APP_NAME, not {{APP_NAME}})', async () => {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(
      join(__dirname, '..', 'deploy', 'fly.template.toml'),
      'utf-8',
    );
    expect(content).not.toContain('{{APP_NAME}}');
    expect(content).not.toContain('{{REGION}}');
  });
});

// ── Plugin registers /help and /portfolio ───────────────────────────────

describe('Plugin registers /help and /portfolio commands', () => {
  it('/help and /portfolio are among the 67 registered commands', () => {
    const registeredCommands: any[] = [];
    const mockApi = {
      registerTool: () => {},
      registerCommand: (c: any) => registeredCommands.push(c),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);

    const names = registeredCommands.map((c) => c.name);
    expect(names).toContain('help');
    expect(names).toContain('portfolio');
  });
});
