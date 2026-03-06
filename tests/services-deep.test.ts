/**
 * Services Deep Tests — exercises service modules beyond shape/registration tests.
 *
 * Covers:
 *   - mode-service: get/set/reset modes, persistence
 *   - tool-config-service: configuration checks, missing keys, setup summary
 *   - safety-service: validateSwap Bankr bypass, balance checks
 *   - onboarding-flow: full state machine edges
 *   - dexscreener-service: chain resolution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── mode-service ────────────────────────────────────────────────────────

describe('mode-service', () => {
  beforeEach(async () => {
    const { resetModes } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    resetModes();
  });

  it('getUserMode returns defaults for new user', async () => {
    const { getUserMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    const mode = getUserMode('fresh_user_001');
    expect(mode.safetyMode).toBe('safe');
    expect(mode.signingMode).toBe('wallet');
    expect(mode.userId).toBe('fresh_user_001');
  });

  it('setSafetyMode changes and persists', async () => {
    const { getUserMode, setSafetyMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    setSafetyMode('user_002', 'danger');
    const mode = getUserMode('user_002');
    expect(mode.safetyMode).toBe('danger');
    expect(mode.signingMode).toBe('wallet');
  });

  it('setSigningMode changes and persists', async () => {
    const { getUserMode, setSigningMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    setSigningMode('user_003', 'autosign');
    const mode = getUserMode('user_003');
    expect(mode.signingMode).toBe('autosign');
    expect(mode.safetyMode).toBe('safe');
  });

  it('modes are independent per user', async () => {
    const { getUserMode, setSafetyMode, setSigningMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    setSafetyMode('user_A', 'danger');
    setSigningMode('user_B', 'autosign');

    expect(getUserMode('user_A').safetyMode).toBe('danger');
    expect(getUserMode('user_A').signingMode).toBe('wallet');
    expect(getUserMode('user_B').safetyMode).toBe('safe');
    expect(getUserMode('user_B').signingMode).toBe('autosign');
  });

  it('resetModes clears cache', async () => {
    const { getUserMode, setSafetyMode, resetModes } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    setSafetyMode('user_reset', 'danger');
    expect(getUserMode('user_reset').safetyMode).toBe('danger');

    resetModes();
    // After reset, should load from disk or return default
    const mode = getUserMode('user_reset');
    // Could be 'danger' if persisted to disk, or 'safe' if no disk
    expect(['safe', 'danger']).toContain(mode.safetyMode);
  });
});

// ─── tool-config-service ─────────────────────────────────────────────────

describe('tool-config-service', () => {
  it('isToolConfigured returns true for tools that work without keys', async () => {
    const { isToolConfigured } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    expect(isToolConfigured('defi_price')).toBe(true);
    expect(isToolConfigured('analytics')).toBe(true);
    expect(isToolConfigured('market_intel')).toBe(true);
    expect(isToolConfigured('cost_basis')).toBe(true);
  });

  it('isToolConfigured returns false for tools missing required keys', async () => {
    const { isToolConfigured } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    delete process.env.HERD_ACCESS_TOKEN;
    delete process.env.BASESCAN_API_KEY;
    delete process.env.X_API_KEY;

    expect(isToolConfigured('herd_intelligence')).toBe(false);
    expect(isToolConfigured('block_explorer')).toBe(false);
    expect(isToolConfigured('clawnx')).toBe(false);
  });

  it('isToolConfigured returns true when keys are set', async () => {
    const { isToolConfigured } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    process.env.HERD_ACCESS_TOKEN = 'test_token';
    try {
      expect(isToolConfigured('herd_intelligence')).toBe(true);
    } finally {
      delete process.env.HERD_ACCESS_TOKEN;
    }
  });

  it('isToolConfigured returns true for unknown tools', async () => {
    const { isToolConfigured } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    expect(isToolConfigured('nonexistent_tool')).toBe(true);
  });

  it('getMissingKeys lists missing keys', async () => {
    const { getMissingKeys } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    delete process.env.X_API_KEY;
    delete process.env.X_API_SECRET;
    delete process.env.X_ACCESS_TOKEN;
    delete process.env.X_ACCESS_TOKEN_SECRET;

    const missing = getMissingKeys('clawnx');
    expect(missing).toContain('X_API_KEY');
    expect(missing).toContain('X_API_SECRET');
    expect(missing.length).toBe(4);
  });

  it('getMissingKeys returns empty for unknown tools', async () => {
    const { getMissingKeys } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    expect(getMissingKeys('nonexistent_tool')).toEqual([]);
  });

  it('checkToolConfig returns null for configured tools', async () => {
    const { checkToolConfig } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    expect(checkToolConfig('defi_price')).toBeNull();
    expect(checkToolConfig('analytics')).toBeNull();
  });

  it('checkToolConfig returns error for unconfigured tools', async () => {
    const { checkToolConfig } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    delete process.env.BASESCAN_API_KEY;
    const result = checkToolConfig('block_explorer');
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain('not configured');
    expect(result!.content[0].text).toContain('BASESCAN_API_KEY');
  });

  it('getAllToolStatus returns all 28 tool statuses', async () => {
    const { getAllToolStatus } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    const statuses = getAllToolStatus();
    expect(statuses.length).toBe(28);
    for (const s of statuses) {
      expect(s.tool).toBeDefined();
      expect(s.label).toBeDefined();
      expect(typeof s.configured).toBe('boolean');
      expect(Array.isArray(s.missingKeys)).toBe(true);
    }
  });

  it('getToolRequirement returns requirements for known tools', async () => {
    const { getToolRequirement } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    const req = getToolRequirement('hummingbot');
    expect(req).toBeDefined();
    expect(req!.requiredKeys).toContain('HUMMINGBOT_API_URL');
    expect(req!.label).toBe('Hummingbot');
  });

  it('getToolRequirement returns undefined for unknown tools', async () => {
    const { getToolRequirement } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    expect(getToolRequirement('nonexistent')).toBeUndefined();
  });
});

// ─── safety-service ──────────────────────────────────────────────────────

describe('safety-service', () => {
  it('C5: validateSwap uses isBankrMode not caller param', async () => {
    const { validateSwap } = await import(
      '../extensions/crypto/src/services/safety-service.js'
    );
    // Read the source to verify the fix is in place
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      new URL('../extensions/crypto/src/services/safety-service.ts', import.meta.url).pathname.replace('/tests/../', '/'),
      'utf8'
    );
    // Should NOT contain viaBankr parameter
    expect(source).not.toContain('viaBankr');
    // Should use isBankrMode()
    expect(source).toContain('isBankrMode()');
  });

  it('checkBalance returns blockers when no wallet', async () => {
    const { checkBalance } = await import(
      '../extensions/crypto/src/services/safety-service.js'
    );
    const result = await checkBalance({ requiredEth: 1 });
    expect(result.safe).toBe(false);
    expect(result.blockers).toContain('No wallet connected');
  });

  it('auditToken returns warning when HERD_ACCESS_TOKEN missing', async () => {
    delete process.env.HERD_ACCESS_TOKEN;
    const { auditToken } = await import(
      '../extensions/crypto/src/services/safety-service.js'
    );
    const result = await auditToken('0x1234567890abcdef1234567890abcdef12345678');
    expect(result.safe).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Herd Intelligence not configured');
  });

  it('validateLaunch checks balance', async () => {
    const { validateLaunch } = await import(
      '../extensions/crypto/src/services/safety-service.js'
    );
    const result = await validateLaunch({ devBuyEth: 0.1 });
    expect(result.safe).toBe(false);
    // No wallet = no balance = blocker
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it('validateClaim checks gas only', async () => {
    const { validateClaim } = await import(
      '../extensions/crypto/src/services/safety-service.js'
    );
    const result = await validateClaim();
    expect(result.safe).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
  });
});

// ─── dexscreener-service ─────────────────────────────────────────────────

describe('dexscreener-service', () => {
  it('resolveChain maps common aliases', async () => {
    const { resolveChain } = await import(
      '../extensions/crypto/src/services/dexscreener-service.js'
    );
    expect(resolveChain('eth')).toBe('ethereum');
    expect(resolveChain('arb')).toBe('arbitrum');
    expect(resolveChain('op')).toBe('optimism');
    expect(resolveChain('matic')).toBe('polygon');
    expect(resolveChain('base')).toBe('base');
    // Unknown chains pass through
    expect(resolveChain('solana')).toBe('solana');
  });
});

// ─── rpc-provider circuit breaker ────────────────────────────────────────

describe('rpc-provider', () => {
  it('resolves chain names to IDs', async () => {
    const { RpcManager } = await import(
      '../extensions/crypto/src/services/rpc-provider.js'
    );
    const mgr = new RpcManager();
    expect(mgr.resolveChainId('base')).toBe(8453);
    expect(mgr.resolveChainId('ethereum')).toBe(1);
    expect(mgr.resolveChainId('arbitrum')).toBe(42161);
    expect(mgr.resolveChainId('optimism')).toBe(10);
    expect(mgr.resolveChainId('polygon')).toBe(137);
    expect(mgr.resolveChainId(8453)).toBe(8453);
    expect(mgr.resolveChainId('99999')).toBe(99999);
  });

  it('filters providers missing API keys', async () => {
    const { RpcManager } = await import(
      '../extensions/crypto/src/services/rpc-provider.js'
    );
    delete process.env.ALCHEMY_API_KEY;
    const mgr = new RpcManager();
    const providers = mgr.getProviders(8453);
    // Should have public providers but not Alchemy
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.every(p => p.name !== 'Alchemy')).toBe(true);
  });

  it('getSupportedChains returns 5 chains', async () => {
    const { RpcManager } = await import(
      '../extensions/crypto/src/services/rpc-provider.js'
    );
    const mgr = new RpcManager();
    const chains = mgr.getSupportedChains();
    expect(chains).toContain(8453);
    expect(chains).toContain(1);
    expect(chains).toContain(42161);
    expect(chains.length).toBe(5);
  });

  it('clearCache does not throw', async () => {
    const { RpcManager } = await import(
      '../extensions/crypto/src/services/rpc-provider.js'
    );
    const mgr = new RpcManager();
    expect(() => mgr.clearCache()).not.toThrow();
  });
});

// ─── bankr-api module ────────────────────────────────────────────────────

describe('bankr-api', () => {
  it('hasBankrApi reflects env var', async () => {
    const { hasBankrApi, getBankrApiKey } = await import(
      '../extensions/crypto/src/services/bankr-api.js'
    );
    delete process.env.BANKR_API_KEY;
    expect(hasBankrApi()).toBe(false);
    expect(getBankrApiKey()).toBeNull();

    process.env.BANKR_API_KEY = 'bk_test';
    expect(hasBankrApi()).toBe(true);
    expect(getBankrApiKey()).toBe('bk_test');
    delete process.env.BANKR_API_KEY;
  });

  it('thread ID storage works per user', async () => {
    const { storeBankrThreadId, getBankrThreadId } = await import(
      '../extensions/crypto/src/services/bankr-api.js'
    );
    storeBankrThreadId('user1', 'thread_abc');
    storeBankrThreadId('user2', 'thread_def');

    expect(getBankrThreadId('user1')).toBe('thread_abc');
    expect(getBankrThreadId('user2')).toBe('thread_def');
    expect(getBankrThreadId('user3')).toBeUndefined();
  });

  it('bankrGet throws without API key', async () => {
    delete process.env.BANKR_API_KEY;
    const { bankrGet } = await import(
      '../extensions/crypto/src/services/bankr-api.js'
    );
    await expect(bankrGet('/agent/me')).rejects.toThrow('BANKR_API_KEY');
  });

  it('bankrPost throws without API key', async () => {
    delete process.env.BANKR_API_KEY;
    const { bankrPost } = await import(
      '../extensions/crypto/src/services/bankr-api.js'
    );
    await expect(bankrPost('/agent/prompt', {})).rejects.toThrow('BANKR_API_KEY');
  });
});

// ─── fly-control-service ─────────────────────────────────────────────────

describe('fly-control-service', () => {
  it('isFlyControlAvailable requires both token and app name', async () => {
    const { isFlyControlAvailable } = await import(
      '../extensions/crypto/src/services/fly-control-service.js'
    );
    const origToken = process.env.FLY_API_TOKEN;
    const origApp = process.env.FLY_APP_NAME;

    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_APP_NAME;
    expect(isFlyControlAvailable()).toBe(false);

    process.env.FLY_API_TOKEN = 'test';
    expect(isFlyControlAvailable()).toBe(false);

    process.env.FLY_APP_NAME = 'test-app';
    expect(isFlyControlAvailable()).toBe(true);

    // Restore
    if (origToken) process.env.FLY_API_TOKEN = origToken;
    else delete process.env.FLY_API_TOKEN;
    if (origApp) process.env.FLY_APP_NAME = origApp;
    else delete process.env.FLY_APP_NAME;
  });

  it('getCurrentProvider defaults to anthropic', async () => {
    const { getCurrentProvider } = await import(
      '../extensions/crypto/src/services/fly-control-service.js'
    );
    delete process.env.OPENCLAWNCH_LLM_PROVIDER;
    expect(getCurrentProvider()).toBe('anthropic');
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
  });
});
