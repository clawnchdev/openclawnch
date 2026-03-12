/**
 * Safety Services Tests — tests for the 5 new security/safety services
 * added in the OpenClawnch hardening sprint.
 *
 * 1. Budget Enforcement Service
 * 2. Endpoint Allowlist
 * 3. Credential Vault
 * 4. Readonly Mode
 * 5. /doctor Command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── 1. Budget Enforcement Service ───────────────────────────────────────────

describe('Budget Enforcement Service', () => {
  beforeEach(async () => {
    const { resetBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    resetBudgetService();
  });

  it('getBudgetService returns a singleton', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const a = getBudgetService();
    const b = getBudgetService();
    expect(a).toBe(b);
  });

  it('startSession creates a session with default limits', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({ userId: 'test-user' });

    expect(session.id).toMatch(/^budget_/);
    expect(session.userId).toBe('test-user');
    expect(session.status).toBe('active');
    expect(session.limits.maxGasUsd).toBe(10);
    expect(session.limits.maxTotalCostUsd).toBe(25);
    expect(session.limits.maxTransactions).toBe(10);
    expect(session.costs).toHaveLength(0);
  });

  it('startSession respects custom limits', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({
      userId: 'test-user',
      limits: { maxGasUsd: 50, maxTotalCostUsd: 100 },
      label: 'big swap',
    });

    expect(session.limits.maxGasUsd).toBe(50);
    expect(session.limits.maxTotalCostUsd).toBe(100);
    expect(session.limits.maxTransactions).toBe(10); // default kept
    expect(session.label).toBe('big swap');
  });

  it('starting a new session for same user ends the previous one', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const s1 = svc.startSession({ userId: 'user1' });
    const s2 = svc.startSession({ userId: 'user1' });

    expect(s1.id).not.toBe(s2.id);
    // s1 should be completed since s2 replaced it
    const s1After = svc.getSession(s1.id);
    expect(s1After?.status).toBe('completed');
    expect(s1After?.endedAt).toBeDefined();
  });

  it('recordCost tracks costs in the session', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({ userId: 'user1' });

    svc.recordCost(session.id, {
      stepLabel: 'swap ETH→USDC',
      gasUsd: 0.50,
      slippageUsd: 1.20,
      tradeValueUsd: 100,
      txHash: '0xabc123',
    });

    svc.recordCost(session.id, {
      stepLabel: 'swap USDC→DAI',
      gasUsd: 0.30,
    });

    expect(session.costs).toHaveLength(2);
    expect(session.costs[0]!.gasUsd).toBe(0.50);
    expect(session.costs[0]!.slippageUsd).toBe(1.20);
    expect(session.costs[1]!.gasUsd).toBe(0.30);
    expect(session.costs[1]!.slippageUsd).toBe(0); // defaults to 0
  });

  it('recordCost ignores ended sessions', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({ userId: 'user1' });
    svc.endSession(session.id);

    svc.recordCost(session.id, {
      stepLabel: 'should not appear',
      gasUsd: 999,
    });

    expect(session.costs).toHaveLength(0);
  });

  it('checkBudget returns ok when within limits', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({ userId: 'user1', limits: { maxGasUsd: 10 } });

    svc.recordCost(session.id, { stepLabel: 'step1', gasUsd: 2.0 });

    const check = svc.checkBudget(session.id);
    expect(check.ok).toBe(true);
    expect(check.totalGasUsd).toBe(2.0);
    expect(check.remainingGasUsd).toBe(8.0);
    expect(check.blockers).toHaveLength(0);
    expect(check.warnings).toHaveLength(0);
  });

  it('checkBudget returns warning at 80% gas usage', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({ userId: 'user1', limits: { maxGasUsd: 10 } });

    svc.recordCost(session.id, { stepLabel: 'step1', gasUsd: 8.5 });

    const check = svc.checkBudget(session.id);
    expect(check.ok).toBe(true); // not blocked, just warned
    expect(check.warnings.length).toBeGreaterThan(0);
    expect(check.warnings[0]).toMatch(/80%/);
  });

  it('checkBudget blocks when gas limit exceeded', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({ userId: 'user1', limits: { maxGasUsd: 5 } });

    svc.recordCost(session.id, { stepLabel: 'step1', gasUsd: 3.0 });
    svc.recordCost(session.id, { stepLabel: 'step2', gasUsd: 3.0 });

    const check = svc.checkBudget(session.id);
    expect(check.ok).toBe(false);
    expect(check.blockers.length).toBeGreaterThan(0);
    expect(check.blockers[0]).toMatch(/Gas budget exceeded/);
    expect(session.status).toBe('exceeded');
  });

  it('checkBudget blocks when total cost limit exceeded', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({
      userId: 'user1',
      limits: { maxGasUsd: 100, maxTotalCostUsd: 10 },
    });

    svc.recordCost(session.id, { stepLabel: 'step1', gasUsd: 3, slippageUsd: 4, feesUsd: 4 });

    const check = svc.checkBudget(session.id);
    expect(check.ok).toBe(false);
    expect(check.totalCostUsd).toBe(11);
    expect(check.blockers[0]).toMatch(/Total cost budget exceeded/);
  });

  it('checkBudget blocks when transaction limit reached', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({
      userId: 'user1',
      limits: { maxTransactions: 2, maxGasUsd: 999, maxTotalCostUsd: 999 },
    });

    svc.recordCost(session.id, { stepLabel: 'tx1', gasUsd: 0.1, txHash: '0x001' });
    svc.recordCost(session.id, { stepLabel: 'tx2', gasUsd: 0.1, txHash: '0x002' });

    const check = svc.checkBudget(session.id);
    expect(check.ok).toBe(false);
    expect(check.blockers[0]).toMatch(/Transaction limit reached/);
  });

  it('checkBudget warns on high per-trade slippage', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({
      userId: 'user1',
      limits: { maxSlippagePercent: 2 },
    });

    svc.recordCost(session.id, {
      stepLabel: 'bad swap',
      gasUsd: 0.1,
      slippageUsd: 5,
      tradeValueUsd: 100, // 5% slippage
    });

    const check = svc.checkBudget(session.id);
    expect(check.warnings.some(w => /High slippage/.test(w))).toBe(true);
  });

  it('checkBudget for unknown session returns ok (no tracking)', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const check = svc.checkBudget('nonexistent');
    expect(check.ok).toBe(true);
    expect(check.remainingGasUsd).toBe(Infinity);
  });

  it('endSession marks session as completed', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({ userId: 'user1' });
    const ended = svc.endSession(session.id);

    expect(ended?.status).toBe('completed');
    expect(ended?.endedAt).toBeDefined();
    expect(svc.getActiveSession('user1')).toBeNull();
  });

  it('endSession with cancelled status', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({ userId: 'user1' });
    const ended = svc.endSession(session.id, 'cancelled');

    expect(ended?.status).toBe('cancelled');
  });

  it('endSession returns null for unknown session', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    expect(svc.endSession('nonexistent')).toBeNull();
  });

  it('getActiveSession returns active session for user', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({ userId: 'user1' });

    const active = svc.getActiveSession('user1');
    expect(active?.id).toBe(session.id);
    expect(svc.getActiveSession('unknown-user')).toBeNull();
  });

  it('formatBudgetCheck produces readable output', async () => {
    const { getBudgetService } = await import(
      '../extensions/crypto/src/services/budget-service.js'
    );
    const svc = getBudgetService();
    const session = svc.startSession({ userId: 'user1' });
    svc.recordCost(session.id, { stepLabel: 'test', gasUsd: 1.5, slippageUsd: 0.3 });

    const check = svc.checkBudget(session.id);
    const formatted = svc.formatBudgetCheck(check);

    expect(formatted).toContain('Cost so far');
    expect(formatted).toContain('$1.80');
    expect(formatted).toContain('Remaining budget');
  });
});

// ── 2. Endpoint Allowlist ───────────────────────────────────────────────────

describe('Endpoint Allowlist', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('isAllowedEndpoint approves known DEX aggregator hosts', async () => {
    const { isAllowedEndpoint } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    expect(isAllowedEndpoint('https://api.0x.org/swap/v1/quote')).toBe(true);
    expect(isAllowedEndpoint('https://api.1inch.dev/v5.0/1/quote')).toBe(true);
    expect(isAllowedEndpoint('https://apiv5.paraswap.io/prices')).toBe(true);
    expect(isAllowedEndpoint('https://api.odos.xyz/sor/quote/v2')).toBe(true);
  });

  it('isAllowedEndpoint approves known price feed hosts', async () => {
    const { isAllowedEndpoint } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    expect(isAllowedEndpoint('https://api.coingecko.com/api/v3/simple/price')).toBe(true);
    expect(isAllowedEndpoint('https://api.dexscreener.com/latest/dex/tokens')).toBe(true);
    expect(isAllowedEndpoint('https://public-api.birdeye.so/public/price')).toBe(true);
  });

  it('isAllowedEndpoint approves RPC providers', async () => {
    const { isAllowedEndpoint } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    expect(isAllowedEndpoint('https://base-mainnet.g.alchemy.com/v2/key')).toBe(true);
    expect(isAllowedEndpoint('https://base.llamarpc.com')).toBe(true);
    expect(isAllowedEndpoint('https://mainnet.base.org')).toBe(true);
  });

  it('isAllowedEndpoint approves Bankr and WalletConnect hosts', async () => {
    const { isAllowedEndpoint } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    expect(isAllowedEndpoint('https://api.bankr.bot/v1/agents')).toBe(true);
    expect(isAllowedEndpoint('https://relay.walletconnect.com')).toBe(true);
  });

  it('isAllowedEndpoint blocks unknown hosts', async () => {
    const { isAllowedEndpoint } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    expect(isAllowedEndpoint('https://evil.com/steal-keys')).toBe(false);
    expect(isAllowedEndpoint('https://attacker.io/exfiltrate')).toBe(false);
    expect(isAllowedEndpoint('https://not-a-real-dex.xyz/swap')).toBe(false);
  });

  it('isAllowedEndpoint handles bare hostnames', async () => {
    const { isAllowedEndpoint } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    expect(isAllowedEndpoint('localhost')).toBe(true);
    expect(isAllowedEndpoint('localhost:3000')).toBe(true);
    expect(isAllowedEndpoint('127.0.0.1')).toBe(true);
    expect(isAllowedEndpoint('evil.com')).toBe(false);
  });

  it('isAllowedEndpoint allows subdomains of allowed hosts', async () => {
    const { isAllowedEndpoint } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    // v2.api.0x.org should be allowed because api.0x.org is in the list
    expect(isAllowedEndpoint('https://v2.api.0x.org/swap')).toBe(true);
  });

  it('isAllowedEndpoint denies malformed URLs', async () => {
    const { isAllowedEndpoint } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    expect(isAllowedEndpoint('')).toBe(false);
  });

  it('addAllowedHost extends the runtime allowlist', async () => {
    const { isAllowedEndpoint, addAllowedHost } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    expect(isAllowedEndpoint('https://my-custom-rpc.example.com/rpc')).toBe(false);
    addAllowedHost('my-custom-rpc.example.com');
    expect(isAllowedEndpoint('https://my-custom-rpc.example.com/rpc')).toBe(true);
  });

  it('getAllowedHosts returns sorted host list', async () => {
    const { getAllowedHosts } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    const hosts = getAllowedHosts();
    expect(hosts.length).toBeGreaterThan(30);
    // Should be sorted
    const sorted = [...hosts].sort();
    expect(hosts).toEqual(sorted);
    // Spot-check known hosts
    expect(hosts).toContain('api.0x.org');
    expect(hosts).toContain('api.bankr.bot');
    expect(hosts).toContain('localhost');
  });

  it('EndpointBlockedError has correct shape', async () => {
    const { EndpointBlockedError } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    const err = new EndpointBlockedError('https://evil.com/steal');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EndpointBlockedError');
    expect(err.blockedUrl).toBe('https://evil.com/steal');
    expect(err.message).toContain('not in the endpoint allowlist');
  });

  it('guardedFetch blocks non-allowlisted URLs in enforce mode', async () => {
    const { guardedFetch, EndpointBlockedError } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    process.env.OPENCLAWNCH_ALLOWLIST_MODE = 'enforce';

    await expect(guardedFetch('https://evil.com/exfil'))
      .rejects
      .toThrow(EndpointBlockedError);
  });

  it('guardedFetch allows allowlisted URLs in enforce mode', async () => {
    const { guardedFetch } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    process.env.OPENCLAWNCH_ALLOWLIST_MODE = 'enforce';

    // Mock global fetch to avoid making a real HTTP request
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mockFetch);

    await guardedFetch('https://api.coingecko.com/api/v3/ping');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('guardedFetch warns but allows in warn mode', async () => {
    const { guardedFetch, _resetAllowlistMode } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    process.env.OPENCLAWNCH_ALLOWLIST_MODE = 'warn';
    _resetAllowlistMode();

    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mockFetch);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await guardedFetch('https://unknown-host.xyz/data');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Blocked'));

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
    process.env.OPENCLAWNCH_ALLOWLIST_MODE = 'enforce';
    _resetAllowlistMode();
  });

  it('guardedFetch skips checks in off mode', async () => {
    const { guardedFetch, _resetAllowlistMode } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );

    process.env.OPENCLAWNCH_ALLOWLIST_MODE = 'off';
    _resetAllowlistMode();

    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mockFetch);

    await guardedFetch('https://anything.evil.com/data');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    process.env.OPENCLAWNCH_ALLOWLIST_MODE = 'enforce';
    _resetAllowlistMode();
  });
});

// ── 3. Credential Vault ─────────────────────────────────────────────────────

describe('Credential Vault', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    const { resetCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    resetCredentialVault();
    // Set up some test secrets
    process.env.CLAWNCHER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    process.env.ZEROX_API_KEY = 'test-zerox-key-12345678';
    process.env.ALCHEMY_API_KEY = 'test-alchemy-key-abcdef';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('getCredentialVault returns a singleton', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const a = getCredentialVault();
    const b = getCredentialVault();
    expect(a).toBe(b);
  });

  it('getSecret returns env var value for known logical name', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    const key = vault.getSecret('wallet.privateKey', 'test-tool');
    expect(key).toBe('0x' + 'ab'.repeat(32));

    const zerox = vault.getSecret('dex.0x.apiKey', 'swap-tool');
    expect(zerox).toBe('test-zerox-key-12345678');
  });

  it('getSecret returns null for unknown logical name', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    expect(vault.getSecret('nonexistent.key', 'test')).toBeNull();
  });

  it('getSecret returns null when env var is not set', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    delete process.env.BANKR_API_KEY;
    expect(vault.getSecret('bankr.apiKey', 'test')).toBeNull();
  });

  it('getSecret logs access for auditing', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    vault.getSecret('wallet.privateKey', 'defi-swap');
    vault.getSecret('dex.0x.apiKey', 'dex-aggregator');

    const log = vault.getAccessLog();
    expect(log).toHaveLength(2);
    expect(log[0]!.key).toBe('wallet.privateKey');
    expect(log[0]!.tool).toBe('defi-swap');
    expect(log[1]!.key).toBe('dex.0x.apiKey');
    expect(log[1]!.tool).toBe('dex-aggregator');
  });

  it('hasSecret checks without revealing value', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    expect(vault.hasSecret('wallet.privateKey')).toBe(true);
    expect(vault.hasSecret('bankr.apiKey')).toBe(false);
    expect(vault.hasSecret('nonexistent')).toBe(false);
  });

  it('getEnvVarName returns env var name for logical name', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    expect(vault.getEnvVarName('wallet.privateKey')).toBe('CLAWNCHER_PRIVATE_KEY');
    expect(vault.getEnvVarName('dex.0x.apiKey')).toBe('ZEROX_API_KEY');
    expect(vault.getEnvVarName('nonexistent')).toBeNull();
  });

  it('scanForLeaks detects actual secret values in text', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    const secretValue = process.env.ZEROX_API_KEY!;
    const text = `Here is some output: the key is ${secretValue} and more text`;

    const result = vault.scanForLeaks(text);
    expect(result.clean).toBe(false);
    expect(result.leaks.length).toBeGreaterThan(0);
    expect(result.leaks.some(l => l.type.includes('dex.0x.apiKey'))).toBe(true);
    expect(result.redactedText).toContain('[REDACTED:ZEROX_API_KEY]');
    expect(result.redactedText).not.toContain(secretValue);
  });

  it('scanForLeaks detects private key patterns', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    // Use a high-entropy fake key (realistic — real keys have many distinct nibbles)
    const fakeKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    // Use danger-context words so the context-positive filter triggers
    const text = `My private key is ${fakeKey} please keep safe`;

    const result = vault.scanForLeaks(text);
    expect(result.clean).toBe(false);
    // Should detect either as a known secret value or as a private_key pattern
    expect(result.leaks.length).toBeGreaterThan(0);
  });

  it('scanForLeaks detects API key prefix patterns', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    const text = 'The API key is sk-abcdefghijklmnopqrstuvwxyz12345 in the config';

    const result = vault.scanForLeaks(text);
    expect(result.clean).toBe(false);
    expect(result.leaks.some(l => l.type === 'api_key_pattern')).toBe(true);
  });

  it('scanForLeaks returns clean for safe text', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    const text = 'Your balance is 1.5 ETH on Base. Gas price is 0.001 gwei.';

    const result = vault.scanForLeaks(text);
    expect(result.clean).toBe(true);
    expect(result.leaks).toHaveLength(0);
    expect(result.redactedText).toBe(text);
  });

  it('scanForLeaks skips tx hash context for 64-hex patterns', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    // This looks like a private key pattern but is in a tx hash context
    const txHash = 'ef'.repeat(32);
    const text = `transaction hash: 0x${txHash}`;

    const result = vault.scanForLeaks(text);
    // The pattern should be skipped because of the "transaction" context word
    const privateKeyLeaks = result.leaks.filter(l => l.type === 'private_key');
    expect(privateKeyLeaks).toHaveLength(0);
  });

  it('getConfigurationSummary reports configured vs missing secrets', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    const summary = vault.getConfigurationSummary();
    expect(summary.length).toBeGreaterThan(10); // We have 20+ registered secrets

    // CLAWNCHER_PRIVATE_KEY is set
    const pkEntry = summary.find(s => s.name === 'wallet.privateKey');
    expect(pkEntry).toBeDefined();
    expect(pkEntry!.configured).toBe(true);
    expect(pkEntry!.sensitive).toBe('critical');

    // BANKR_API_KEY is not set
    const bankrEntry = summary.find(s => s.name === 'bankr.apiKey');
    expect(bankrEntry).toBeDefined();
    expect(bankrEntry!.configured).toBe(false);

    // Every entry has required fields
    for (const entry of summary) {
      expect(entry.name).toBeDefined();
      expect(entry.envVar).toBeDefined();
      expect(entry.description).toBeDefined();
      expect(typeof entry.configured).toBe('boolean');
      expect(['critical', 'high', 'medium']).toContain(entry.sensitive);
    }
  });

  it('access log trims when exceeding max size', async () => {
    const { getCredentialVault } = await import(
      '../extensions/crypto/src/services/credential-vault.js'
    );
    const vault = getCredentialVault();

    // Trigger many accesses to exceed the 1000 entry max
    for (let i = 0; i < 1050; i++) {
      vault.getSecret('rpc.alchemy.apiKey', `tool-${i}`);
    }

    // Log should have been trimmed (to ~500 after trimming at 1000)
    const log = vault.getAccessLog(2000);
    expect(log.length).toBeLessThan(1050);
    expect(log.length).toBeGreaterThan(0);
  });
});

// ── 4. Readonly Mode ────────────────────────────────────────────────────────

describe('Readonly Mode', () => {
  beforeEach(async () => {
    const { resetModes } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    resetModes();
  });

  it('isReadonly returns false by default (safe mode)', async () => {
    const { isReadonly } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    expect(isReadonly('test-user-readonly')).toBe(false);
  });

  it('setting readonly mode makes isReadonly return true', async () => {
    const { isReadonly, setSafetyMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );

    setSafetyMode('test-user-readonly-2', 'readonly');
    expect(isReadonly('test-user-readonly-2')).toBe(true);
  });

  it('switching from readonly to safe clears readonly', async () => {
    const { isReadonly, setSafetyMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );

    setSafetyMode('test-user-readonly-3', 'readonly');
    expect(isReadonly('test-user-readonly-3')).toBe(true);

    setSafetyMode('test-user-readonly-3', 'safe');
    expect(isReadonly('test-user-readonly-3')).toBe(false);
  });

  it('switching from readonly to danger clears readonly', async () => {
    const { isReadonly, setSafetyMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );

    setSafetyMode('test-user-readonly-4', 'readonly');
    expect(isReadonly('test-user-readonly-4')).toBe(true);

    setSafetyMode('test-user-readonly-4', 'danger');
    expect(isReadonly('test-user-readonly-4')).toBe(false);
  });

  it('SafetyMode type includes readonly', async () => {
    const { getUserMode, setSafetyMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );

    setSafetyMode('test-user-readonly-5', 'readonly');
    const mode = getUserMode('test-user-readonly-5');
    expect(mode.safetyMode).toBe('readonly');
  });

  it('/readonly command sets readonly mode', async () => {
    const { readonlyCommand } = await import(
      '../extensions/crypto/src/commands/mode-commands.js'
    );

    const result = await readonlyCommand.handler({
      senderId: 'test-user-cmd-readonly',
    });

    expect(result.text).toContain('Read-only mode enabled');
    expect(result.text).toContain('BLOCKED');

    // Verify mode was actually set
    const { isReadonly } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    expect(isReadonly('test-user-cmd-readonly')).toBe(true);
  });

  it('/readonly command response lists what you can still do', async () => {
    const { readonlyCommand } = await import(
      '../extensions/crypto/src/commands/mode-commands.js'
    );

    const result = await readonlyCommand.handler({
      senderId: 'test-user-cmd-readonly-2',
    });

    expect(result.text).toContain('Check prices');
    expect(result.text).toContain('View balances');
    expect(result.text).toContain('analytics');
  });

  it('readonlyCommand has correct shape', async () => {
    const { readonlyCommand } = await import(
      '../extensions/crypto/src/commands/mode-commands.js'
    );

    expect(readonlyCommand.name).toBe('readonly');
    expect(readonlyCommand.description).toBeDefined();
    expect(typeof readonlyCommand.handler).toBe('function');
  });
});

// ── 5. /doctor Command ──────────────────────────────────────────────────────

// Mock the RPC provider so /doctor doesn't hit real endpoints
vi.mock('../extensions/crypto/src/services/rpc-provider.js', async () => {
  const actual = await vi.importActual('../extensions/crypto/src/services/rpc-provider.js') as any;
  const mockClient = {
    getBlockNumber: vi.fn().mockResolvedValue(12345678n),
  };
  return {
    ...actual,
    getRpcManager: vi.fn(() => ({
      getClient: vi.fn().mockResolvedValue(mockClient),
      getHealthReport: vi.fn().mockReturnValue([
        { name: 'LlamaNodes', url: 'https://base.llamarpc.com', available: true, failures: 0, circuitOpen: false },
        { name: 'Base Public', url: 'https://mainnet.base.org', available: true, failures: 0, circuitOpen: false },
      ]),
      getSupportedChains: vi.fn().mockReturnValue([8453, 1, 42161, 10, 137]),
      isMevProtectionEnabled: vi.fn().mockReturnValue(true),
    })),
  };
});

describe('/doctor Command', () => {
  it('doctorCommand has correct shape', async () => {
    const { doctorCommand } = await import(
      '../extensions/crypto/src/commands/doctor-command.js'
    );

    expect(doctorCommand.name).toBe('doctor');
    expect(doctorCommand.description).toBeDefined();
    expect(doctorCommand.description).toContain('diagnostics');
    expect(typeof doctorCommand.handler).toBe('function');
    expect(doctorCommand.acceptsArgs).toBe(false);
    expect(doctorCommand.requireAuth).toBe(true);
  });

  it('/doctor produces diagnostic output with status icons', async () => {
    const { doctorCommand } = await import(
      '../extensions/crypto/src/commands/doctor-command.js'
    );

    const result = await doctorCommand.handler({
      senderId: 'test-doctor-user',
    });

    expect(result.text).toBeDefined();
    expect(result.text).toContain('**Diagnostics**');
    // Should contain at least some status icons
    const hasStatusIcon = result.text.includes('[OK]') ||
      result.text.includes('[!!]') ||
      result.text.includes('[FAIL]') ||
      result.text.includes('[--]');
    expect(hasStatusIcon).toBe(true);
  });

  it('/doctor includes summary line', async () => {
    const { doctorCommand } = await import(
      '../extensions/crypto/src/commands/doctor-command.js'
    );

    const result = await doctorCommand.handler({
      senderId: 'test-doctor-user-2',
    });

    // Should have counts for ok/warnings/failures
    expect(result.text).toMatch(/\d+ ok/);
    expect(result.text).toMatch(/\d+ warnings/);
    expect(result.text).toMatch(/\d+ failures/);
  });

  it('/doctor checks Safety Mode', async () => {
    const { doctorCommand } = await import(
      '../extensions/crypto/src/commands/doctor-command.js'
    );

    const result = await doctorCommand.handler({
      senderId: 'test-doctor-safety',
    });

    expect(result.text).toContain('Safety Mode');
  });

  it('/doctor checks Endpoint Allowlist', async () => {
    const { doctorCommand } = await import(
      '../extensions/crypto/src/commands/doctor-command.js'
    );

    const result = await doctorCommand.handler({
      senderId: 'test-doctor-allowlist',
    });

    expect(result.text).toContain('Endpoint Allowlist');
    expect(result.text).toContain('hosts allowed');
  });

  it('/doctor checks Budget Tracker', async () => {
    const { doctorCommand } = await import(
      '../extensions/crypto/src/commands/doctor-command.js'
    );

    const result = await doctorCommand.handler({
      senderId: 'test-doctor-budget',
    });

    expect(result.text).toContain('Budget Tracker');
  });

  it('/doctor checks API Keys via Credential Vault', async () => {
    const { doctorCommand } = await import(
      '../extensions/crypto/src/commands/doctor-command.js'
    );

    const result = await doctorCommand.handler({
      senderId: 'test-doctor-keys',
    });

    expect(result.text).toContain('API Keys');
    // Should mention how many are configured
    expect(result.text).toMatch(/\d+\/\d+ configured/);
  });

  it('/doctor warns about danger+autosign combo', async () => {
    // Set up dangerous mode
    const { setSafetyMode, setSigningMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    setSafetyMode('test-doctor-danger', 'danger');
    setSigningMode('test-doctor-danger', 'autosign');

    const { doctorCommand } = await import(
      '../extensions/crypto/src/commands/doctor-command.js'
    );

    const result = await doctorCommand.handler({
      senderId: 'test-doctor-danger',
    });

    expect(result.text).toContain('MAXIMUM RISK');
    expect(result.text).toContain('[!!]');
  });

  it('/doctor with no channels shows warning', async () => {
    const origTelegram = process.env.TELEGRAM_BOT_TOKEN;
    const origDiscord = process.env.DISCORD_TOKEN;
    const origSlack = process.env.SLACK_BOT_TOKEN;

    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;

    const { doctorCommand } = await import(
      '../extensions/crypto/src/commands/doctor-command.js'
    );

    const result = await doctorCommand.handler({
      senderId: 'test-doctor-channels',
    });

    expect(result.text).toContain('No messaging channels configured');

    // Restore
    if (origTelegram) process.env.TELEGRAM_BOT_TOKEN = origTelegram;
    if (origDiscord) process.env.DISCORD_TOKEN = origDiscord;
    if (origSlack) process.env.SLACK_BOT_TOKEN = origSlack;
  });
});
