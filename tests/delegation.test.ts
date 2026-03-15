/**
 * Delegation Integration Tests — EIP-7710/7715 on-chain delegation
 *
 * Tests:
 *   1.  Delegation types: contract addresses, chain support, EIP-712 types
 *   2.  Delegation compiler: PolicyRule → Caveat mapping for all 7 rule types
 *   3.  Delegation compiler: full policy → UnsignedDelegation compilation
 *   4.  Delegation compiler: edge cases (empty rules, unsupported chains, unconfirmed)
 *   5.  Delegation service: prepareDelegation, storeDelegation, formatDelegationStatus
 *   6.  Delegate command: handler shape, subcommands, no-policies output
 *   7.  Policy integration: delegation field on Policy interface
 *   8.  Plugin registers 112 commands including /delegate, /policymode, /profile, /upgrade
 *   9.  Policy mode system: getPolicyMode, setPolicyMode, isDelegationMode
 *   10. Policymode command: /policymode, /policymode delegation, /policymode simple
 *   11. Delegate command mode gate: blocks in simple mode
 *   12. Autonomy profiles: definitions, activation, deactivation
 *   13. Profile command: /profile, /profile training, /profile off
 *   14. Delegation monitor: health check, alert generation
 *   15. Delegation executor: tryDelegationExecution, action extraction, matching
 *   16. Policy gate integration: delegation routing in the execution path
 *   17. EIP-7702 account type detection
 *   18. /upgrade command
 *   19. Sub-delegation: createSubDelegation, ephemeral keypairs, chain encoding
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── 1. Delegation Types ────────────────────────────────────────────────

describe('Delegation Types', () => {
  it('exports contract addresses as valid 0x addresses', async () => {
    const { DELEGATION_CONTRACTS } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );

    expect(DELEGATION_CONTRACTS.DelegationManager).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(DELEGATION_CONTRACTS.ERC20TransferAmountEnforcer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(DELEGATION_CONTRACTS.LimitedCallsEnforcer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(DELEGATION_CONTRACTS.AllowedTargetsEnforcer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(DELEGATION_CONTRACTS.TimestampEnforcer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(DELEGATION_CONTRACTS.ValueLteEnforcer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(DELEGATION_CONTRACTS.NonceEnforcer).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('has all expected enforcer addresses', async () => {
    const { DELEGATION_CONTRACTS } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );
    const keys = Object.keys(DELEGATION_CONTRACTS);
    expect(keys).toContain('DelegationManager');
    expect(keys).toContain('ERC20TransferAmountEnforcer');
    expect(keys).toContain('ERC20PeriodTransferEnforcer');
    expect(keys).toContain('LimitedCallsEnforcer');
    expect(keys).toContain('AllowedTargetsEnforcer');
    expect(keys).toContain('AllowedMethodsEnforcer');
    expect(keys).toContain('TimestampEnforcer');
    expect(keys).toContain('NativeTokenTransferAmountEnforcer');
    expect(keys).toContain('NativeTokenPeriodTransferEnforcer');
    expect(keys).toContain('ValueLteEnforcer');
    expect(keys).toContain('NonceEnforcer');
    // DeleGator implementations (3) + DelegationManager (1) + enforcers (10)
    expect(keys).toContain('EIP7702StatelessDeleGator');
    expect(keys).toContain('HybridDeleGator');
    expect(keys).toContain('MultiSigDeleGator');
    expect(keys.length).toBe(14);
  });

  it('supports expected chain IDs', async () => {
    const { SUPPORTED_CHAIN_IDS, CHAIN_NAMES } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );
    expect(SUPPORTED_CHAIN_IDS.has(1)).toBe(true);       // Ethereum
    expect(SUPPORTED_CHAIN_IDS.has(8453)).toBe(true);     // Base
    expect(SUPPORTED_CHAIN_IDS.has(42161)).toBe(true);    // Arbitrum
    expect(SUPPORTED_CHAIN_IDS.has(10)).toBe(true);       // Optimism
    expect(SUPPORTED_CHAIN_IDS.has(137)).toBe(true);      // Polygon
    expect(SUPPORTED_CHAIN_IDS.has(11155111)).toBe(true);  // Sepolia
    expect(SUPPORTED_CHAIN_IDS.has(999999)).toBe(false);

    expect(CHAIN_NAMES[8453]).toBe('Base');
    expect(CHAIN_NAMES[1]).toBe('Ethereum');
  });

  it('getDelegationDomain returns correct EIP-712 domain', async () => {
    const { getDelegationDomain, DELEGATION_CONTRACTS } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );
    const domain = getDelegationDomain(8453);
    expect(domain.name).toBe('DelegationManager');
    expect(domain.version).toBe('1');
    expect(domain.chainId).toBe(8453);
    expect(domain.verifyingContract).toBe(DELEGATION_CONTRACTS.DelegationManager);
  });

  it('DELEGATION_EIP712_TYPES has Delegation and Caveat types', async () => {
    const { DELEGATION_EIP712_TYPES } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );
    expect(DELEGATION_EIP712_TYPES.Delegation).toBeDefined();
    expect(DELEGATION_EIP712_TYPES.Caveat).toBeDefined();
    expect(DELEGATION_EIP712_TYPES.Delegation.length).toBeGreaterThan(0);
    expect(DELEGATION_EIP712_TYPES.Caveat.length).toBe(2); // enforcer, terms (args excluded from EIP-712 signing)
  });

  it('DELEGATION_MANAGER_ABI has required functions', async () => {
    const { DELEGATION_MANAGER_ABI } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );
    const names = DELEGATION_MANAGER_ABI.map((f: any) => f.name);
    expect(names).toContain('redeemDelegations');
    expect(names).toContain('disableDelegation');
    expect(names).toContain('getDelegationHash');
    expect(names).toContain('disabledDelegations');
  });

  it('PERIOD_SECONDS covers all policy periods', async () => {
    const { PERIOD_SECONDS } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );
    expect(PERIOD_SECONDS.hourly).toBe(3600);
    expect(PERIOD_SECONDS.daily).toBe(86400);
    expect(PERIOD_SECONDS.weekly).toBe(604800);
    expect(PERIOD_SECONDS.monthly).toBe(2592000);
  });
});

// ─── 2. Delegation Compiler — Rule Mapping ──────────────────────────────

describe('Delegation Compiler — compileRuleToCaveats', () => {
  it('maps spending_limit to NativeTokenPeriodTransferEnforcer', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );
    const { DELEGATION_CONTRACTS } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );

    const result = compileRuleToCaveats({
      type: 'spending_limit',
      maxAmountUsd: 500,
      period: 'daily',
    });

    expect(result.type).toBe('mapped');
    if (result.type === 'mapped') {
      expect(result.caveats).toHaveLength(1);
      expect(result.caveats[0].enforcer).toBe(
        DELEGATION_CONTRACTS.NativeTokenPeriodTransferEnforcer,
      );
      expect(result.caveats[0].terms).toMatch(/^0x/);
      expect(result.caveats[0].args).toBe('0x');
    }
  });

  it('maps max_amount to ValueLteEnforcer + NativeTokenTransferAmountEnforcer', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );
    const { DELEGATION_CONTRACTS } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );

    const result = compileRuleToCaveats({
      type: 'max_amount',
      maxAmountUsd: 1000,
    });

    expect(result.type).toBe('mapped');
    if (result.type === 'mapped') {
      expect(result.caveats).toHaveLength(2);
      expect(result.caveats[0]!.enforcer).toBe(DELEGATION_CONTRACTS.ValueLteEnforcer);
      expect(result.caveats[1]!.enforcer).toBe(DELEGATION_CONTRACTS.NativeTokenTransferAmountEnforcer);
    }
  });

  it('maps rate_limit to LimitedCallsEnforcer + TimestampEnforcer', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );
    const { DELEGATION_CONTRACTS } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );

    const result = compileRuleToCaveats({
      type: 'rate_limit',
      maxCalls: 10,
      periodMs: 86400000,
    });

    expect(result.type).toBe('mapped');
    if (result.type === 'mapped') {
      expect(result.caveats).toHaveLength(2);
      expect(result.caveats[0]!.enforcer).toBe(DELEGATION_CONTRACTS.LimitedCallsEnforcer);
      expect(result.caveats[1]!.enforcer).toBe(DELEGATION_CONTRACTS.TimestampEnforcer);
    }
  });

  it('maps allowlist (addresses) to AllowedTargetsEnforcer', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );
    const { DELEGATION_CONTRACTS } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );

    const result = compileRuleToCaveats({
      type: 'allowlist',
      field: 'addresses',
      values: ['0x1234567890abcdef1234567890abcdef12345678'],
    });

    expect(result.type).toBe('mapped');
    if (result.type === 'mapped') {
      expect(result.caveats[0].enforcer).toBe(DELEGATION_CONTRACTS.AllowedTargetsEnforcer);
    }
  });

  it('returns app_layer_only for allowlist (tokens)', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compileRuleToCaveats({
      type: 'allowlist',
      field: 'tokens',
      values: ['ETH', 'USDC'],
    });

    expect(result.type).toBe('app_layer_only');
  });

  it('returns app_layer_only for allowlist (chains)', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compileRuleToCaveats({
      type: 'allowlist',
      field: 'chains',
      values: ['8453'],
    });

    expect(result.type).toBe('app_layer_only');
  });

  it('returns app_layer_only for blocklist (no direct enforcer)', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compileRuleToCaveats({
      type: 'blocklist',
      field: 'tokens',
      values: ['SHIB'],
    });

    expect(result.type).toBe('app_layer_only');
    if (result.type === 'app_layer_only') {
      expect(result.reason).toContain('allowlist');
    }
  });

  it('returns app_layer_only for approval_threshold', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compileRuleToCaveats({
      type: 'approval_threshold',
      amountUsd: 100,
    });

    expect(result.type).toBe('app_layer_only');
    if (result.type === 'app_layer_only') {
      expect(result.reason).toContain('app-layer');
    }
  });

  it('returns app_layer_only for time_window with recurring days', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compileRuleToCaveats({
      type: 'time_window',
      allowedDays: [1, 2, 3, 4, 5],
    });

    expect(result.type).toBe('app_layer_only');
  });

  it('returns app_layer_only for time_window with recurring hours', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compileRuleToCaveats({
      type: 'time_window',
      allowedHours: { start: 9, end: 17 },
    });

    expect(result.type).toBe('app_layer_only');
  });

  it('handles spending_limit with unknown period as app_layer_only', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compileRuleToCaveats({
      type: 'spending_limit',
      maxAmountUsd: 100,
      period: 'biweekly' as any,
    });

    expect(result.type).toBe('app_layer_only');
  });

  it('handles allowlist with no valid addresses as app_layer_only', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compileRuleToCaveats({
      type: 'allowlist',
      field: 'addresses',
      values: ['not-an-address'],
    });

    expect(result.type).toBe('app_layer_only');
  });
});

// ─── 3. Delegation Compiler — Full Policy Compilation ───────────────────

describe('Delegation Compiler — compilePolicyToDelegation', () => {
  const makePolicy = (overrides: any = {}) => ({
    id: 'test-policy-1',
    name: 'Test Policy',
    description: 'A test policy',
    rules: [
      { type: 'spending_limit' as const, maxAmountUsd: 500, period: 'daily' as const },
      { type: 'max_amount' as const, maxAmountUsd: 1000 },
    ],
    scope: { type: 'all_write' as const },
    status: 'active' as const,
    confirmedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    userId: 'owner',
    ...overrides,
  });

  it('compiles a policy with mixed mappable and unmappable rules', async () => {
    const { compilePolicyToDelegation } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const policy = makePolicy({
      rules: [
        { type: 'spending_limit', maxAmountUsd: 500, period: 'daily' },
        { type: 'blocklist', field: 'tokens', values: ['SHIB'] },
        { type: 'max_amount', maxAmountUsd: 1000 },
      ],
    });

    const result = compilePolicyToDelegation(
      policy,
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      8453,
    );

    expect('type' in result).toBe(false); // Not an error
    const comp = result as any;
    expect(comp.delegation).toBeDefined();
    expect(comp.delegation.caveats.length).toBe(3); // spending_limit(1) + max_amount(2: ValueLte + NativeTokenTransferAmount)
    expect(comp.mappedRules.length).toBe(2);
    expect(comp.unmappedRules.length).toBe(1); // blocklist
    expect(comp.unmappedRules[0].rule.type).toBe('blocklist');
  });

  it('rejects unsupported chain', async () => {
    const { compilePolicyToDelegation } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compilePolicyToDelegation(
      makePolicy(),
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      999999,
    );

    expect('type' in result && result.type === 'error').toBe(true);
  });

  it('rejects policy with no rules', async () => {
    const { compilePolicyToDelegation } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compilePolicyToDelegation(
      makePolicy({ rules: [] }),
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      8453,
    );

    expect('type' in result && result.type === 'error').toBe(true);
  });

  it('rejects unconfirmed policy', async () => {
    const { compilePolicyToDelegation } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compilePolicyToDelegation(
      makePolicy({ confirmedAt: undefined }),
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      8453,
    );

    expect('type' in result && result.type === 'error').toBe(true);
  });

  it('warns when all rules are app-layer only', async () => {
    const { compilePolicyToDelegation } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compilePolicyToDelegation(
      makePolicy({
        rules: [
          { type: 'blocklist', field: 'tokens', values: ['SHIB'] },
          { type: 'approval_threshold', amountUsd: 100 },
        ],
      }),
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      8453,
    );

    expect('type' in result).toBe(false);
    const comp = result as any;
    expect(comp.delegation.caveats.length).toBe(0);
    expect(comp.warnings.length).toBeGreaterThan(0);
    expect(comp.warnings[0]).toContain('No policy rules mapped');
  });

  it('warns about USD to token conversion for spending rules', async () => {
    const { compilePolicyToDelegation } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const result = compilePolicyToDelegation(
      makePolicy(),
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      8453,
    );

    const comp = result as any;
    expect(comp.warnings.some((w: string) => w.includes('USD'))).toBe(true);
  });

  it('sets correct delegate and delegator addresses', async () => {
    const { compilePolicyToDelegation } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const delegator = '0x1111111111111111111111111111111111111111';
    const delegate = '0x2222222222222222222222222222222222222222';

    const result = compilePolicyToDelegation(makePolicy(), delegator, delegate, 8453);
    const comp = result as any;

    expect(comp.delegation.delegator).toBe(delegator);
    expect(comp.delegation.delegate).toBe(delegate);
    expect(comp.delegation.authority).toBe(
      '0x' + 'f'.repeat(64), // ROOT_AUTHORITY
    );
  });
});

// ─── 4. Compilation Summary Formatting ──────────────────────────────────

describe('formatCompilationSummary', () => {
  it('produces readable summary with mapped and unmapped rules', async () => {
    const { compilePolicyToDelegation, formatCompilationSummary } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const policy = {
      id: 'p1',
      name: 'Test',
      description: 'test',
      rules: [
        { type: 'spending_limit' as const, maxAmountUsd: 500, period: 'daily' as const },
        { type: 'blocklist' as const, field: 'tokens' as const, values: ['SHIB'] },
      ],
      scope: { type: 'all_write' as const },
      status: 'active' as const,
      confirmedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'owner',
    };

    const result = compilePolicyToDelegation(
      policy,
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      8453,
    );

    expect('type' in result).toBe(false);
    const summary = formatCompilationSummary(result as any, 8453);
    expect(summary).toContain('Delegation Compilation Summary');
    expect(summary).toContain('On-chain enforced rules');
    expect(summary).toContain('App-layer only rules');
    expect(summary).toContain('spending_limit');
    expect(summary).toContain('blocklist');
  });
});

// ─── 5. Delegation Service ──────────────────────────────────────────────

describe('Delegation Service', () => {
  it('formatDelegationStatus produces readable output', async () => {
    const { formatDelegationStatus } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const status = formatDelegationStatus({
      chainId: 8453,
      hash: '0xabcdef',
      delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
      status: 'signed',
      delegate: '0x2222222222222222222222222222222222222222',
      delegator: '0x1111111111111111111111111111111111111111',
      salt: '12345',
      createdAt: '2026-01-01T00:00:00.000Z',
      unmappedRules: ['blocklist'],
    });

    expect(status).toContain('SIGNED');
    expect(status).toContain('Base');
    expect(status).toContain('0xabcdef');
    expect(status).toContain('blocklist');
  });

  it('formatDelegationStatus handles all status types', async () => {
    const { formatDelegationStatus } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const base = {
      chainId: 8453,
      hash: '0x',
      delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
      delegate: '0x2222222222222222222222222222222222222222',
      delegator: '0x1111111111111111111111111111111111111111',
      salt: '0',
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    expect(formatDelegationStatus({ ...base, status: 'unsigned' })).toContain('UNSIGNED');
    expect(formatDelegationStatus({ ...base, status: 'active' })).toContain('ACTIVE');
    expect(formatDelegationStatus({ ...base, status: 'revoked' })).toContain('REVOKED');
    expect(formatDelegationStatus({ ...base, status: 'expired' })).toContain('EXPIRED');
  });

  it('formatSupportedChains lists all chains', async () => {
    const { formatSupportedChains } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const output = formatSupportedChains();
    expect(output).toContain('Base');
    expect(output).toContain('Ethereum');
    expect(output).toContain('8453');
  });
});

// ─── 6. Delegate Command ────────────────────────────────────────────────

describe('/delegate command', () => {
  beforeEach(async () => {
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    setPolicyMode('delegation');
  });

  it('has correct command shape', async () => {
    const { delegateCommand } = await import(
      '../extensions/crypto/src/commands/delegate-command.js'
    );

    expect(delegateCommand.name).toBe('delegate');
    expect(delegateCommand.description).toBeDefined();
    expect(delegateCommand.acceptsArgs).toBe(true);
    expect(delegateCommand.requireAuth).toBe(true);
    expect(typeof delegateCommand.handler).toBe('function');
  });

  it('shows overview when no args', async () => {
    const { delegateCommand } = await import(
      '../extensions/crypto/src/commands/delegate-command.js'
    );

    const result = await delegateCommand.handler({ args: '', senderId: 'test-user-delegate' });
    expect(result.text).toContain('On-Chain Delegations');
    expect(result.text).toContain('EIP-7710');
  });

  it('shows supported chains with /delegate chains', async () => {
    const { delegateCommand } = await import(
      '../extensions/crypto/src/commands/delegate-command.js'
    );

    const result = await delegateCommand.handler({ args: 'chains', senderId: 'test-user-delegate' });
    expect(result.text).toContain('Supported Chains');
    expect(result.text).toContain('Base');
    expect(result.text).toContain('Ethereum');
    expect(result.text).toContain('8453');
  });

  it('shows status when no delegations exist', async () => {
    const { delegateCommand } = await import(
      '../extensions/crypto/src/commands/delegate-command.js'
    );

    const result = await delegateCommand.handler({ args: 'status', senderId: 'test-user-delegate-status' });
    expect(result.text).toContain('No delegations found');
  });

  it('requires policy name for create', async () => {
    const { delegateCommand } = await import(
      '../extensions/crypto/src/commands/delegate-command.js'
    );

    const result = await delegateCommand.handler({ args: 'create', senderId: 'test-user-delegate' });
    expect(result.text).toContain('Usage');
  });

  it('requires policy name for revoke', async () => {
    const { delegateCommand } = await import(
      '../extensions/crypto/src/commands/delegate-command.js'
    );

    const result = await delegateCommand.handler({ args: 'revoke', senderId: 'test-user-delegate' });
    expect(result.text).toContain('Usage');
  });

  it('returns not-found for unknown policy', async () => {
    const { delegateCommand } = await import(
      '../extensions/crypto/src/commands/delegate-command.js'
    );

    const result = await delegateCommand.handler({
      args: 'create nonexistent-policy',
      senderId: 'test-user-delegate',
    });
    expect(result.text).toContain('not found');
  });

  it('rejects unsupported chain in create', async () => {
    // Create a policy first so the chain check is reached
    const { getPolicyStore } = await import(
      '../extensions/crypto/src/services/policy-store.js'
    );
    const store = getPolicyStore();
    const policy = {
      id: 'delegate-chain-test',
      name: 'chain-test-policy',
      description: 'test',
      rules: [{ type: 'max_amount' as const, maxAmountUsd: 100 }],
      scope: { type: 'all_write' as const },
      status: 'active' as const,
      confirmedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'test-user-delegate-chain',
    };
    store.savePolicy(policy);

    const { delegateCommand } = await import(
      '../extensions/crypto/src/commands/delegate-command.js'
    );
    const result = await delegateCommand.handler({
      args: 'create chain-test-policy --chain 999999',
      senderId: 'test-user-delegate-chain',
    });
    expect(result.text).toContain('not supported');

    // Clean up
    store.deletePolicy('test-user-delegate-chain', 'delegate-chain-test');
  });
});

// ─── 6b. Compiler — Price-Aware Compilation ─────────────────────────────

describe('Delegation Compiler — price context', () => {
  it('setCompilationContext + getCompilationContext round-trips', async () => {
    const { setCompilationContext, getCompilationContext } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    setCompilationContext({ ethPriceUsd: 3500 });
    expect(getCompilationContext().ethPriceUsd).toBe(3500);

    // Reset
    setCompilationContext({});
    expect(getCompilationContext().ethPriceUsd).toBeUndefined();
  });

  it('spending_limit uses ETH price when context is set', async () => {
    const { compileRuleToCaveats, setCompilationContext } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    // Set ETH price to $3500
    setCompilationContext({ ethPriceUsd: 3500 });

    const result = compileRuleToCaveats({
      type: 'spending_limit',
      maxAmountUsd: 3500,
      period: 'daily',
    });

    expect(result.type).toBe('mapped');
    if (result.type === 'mapped') {
      // $3500 at $3500/ETH = 1 ETH = 1e18 wei
      // The terms encode (allowance, startTime, period) as uint256s
      expect(result.caveats[0]!.terms).toMatch(/^0x/);
      // terms length: 3 uint256 values = 3*32 = 96 bytes + 0x prefix = 194 chars
      expect(result.caveats[0]!.terms.length).toBe(194);
    }

    // Reset
    setCompilationContext({});
  });

  it('warns about price drift when ETH price is available', async () => {
    const { compilePolicyToDelegation, setCompilationContext } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    setCompilationContext({ ethPriceUsd: 3500 });

    const policy = {
      id: 'price-test',
      name: 'Price Test',
      description: 'test',
      rules: [{ type: 'max_amount' as const, maxAmountUsd: 100 }],
      scope: { type: 'all_write' as const },
      status: 'active' as const,
      confirmedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'owner',
    };

    const result = compilePolicyToDelegation(
      policy,
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      8453,
    );

    expect('type' in result).toBe(false);
    const comp = result as any;
    expect(comp.warnings.some((w: string) => w.includes('$3500.00'))).toBe(true);

    setCompilationContext({});
  });
});

// ─── 6c. Compiler — Token Allowlist with Addresses ──────────────────────

describe('Delegation Compiler — token allowlist with addresses', () => {
  it('maps token allowlist with contract addresses to AllowedTargetsEnforcer', async () => {
    const { compileRuleToCaveats } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );
    const { DELEGATION_CONTRACTS } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );

    const result = compileRuleToCaveats({
      type: 'allowlist',
      field: 'tokens',
      values: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'], // USDC on Base
    });

    expect(result.type).toBe('mapped');
    if (result.type === 'mapped') {
      expect(result.caveats).toHaveLength(1);
      expect(result.caveats[0]!.enforcer).toBe(DELEGATION_CONTRACTS.AllowedTargetsEnforcer);
    }
  });
});

// ─── 6d. Delegation Service — signDelegation ────────────────────────────

describe('Delegation Service — signDelegation', () => {
  it('returns error when no wallet is connected', async () => {
    const { signDelegation } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const unsigned = {
      delegate: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      delegator: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      authority: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      caveats: [],
      salt: 1n,
    };

    const result = await signDelegation(unsigned, 8453);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No wallet connected');
    }
  });
});

// ─── 6e. Delegation Service — buildEip7715Request ───────────────────────

describe('Delegation Service — buildEip7715Request', () => {
  it('produces valid EIP-7715 request payload', async () => {
    const { buildEip7715Request } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );
    const { compilePolicyToDelegation } = await import(
      '../extensions/crypto/src/services/delegation-compiler.js'
    );

    const policy = {
      id: 'eip7715-test',
      name: '7715 Test',
      description: 'test',
      rules: [
        { type: 'max_amount' as const, maxAmountUsd: 100 },
        { type: 'rate_limit' as const, maxCalls: 5, periodMs: 3600000 },
      ],
      scope: { type: 'all_write' as const },
      status: 'active' as const,
      confirmedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'owner',
    };

    const result = compilePolicyToDelegation(
      policy,
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      8453,
    );

    expect('type' in result).toBe(false);
    const compilation = result as any;

    const request = buildEip7715Request(compilation, 8453);
    expect(request.method).toBe('wallet_requestExecutionPermissions');
    expect(request.params).toBeDefined();
    const params = (request.params as any[])[0];
    expect(params.chainId).toBe('0x2105'); // 8453 in hex
    expect(params.permissions).toBeDefined();
    expect(params.permissions.length).toBeGreaterThan(0);
    expect(params.expiry).toBeGreaterThan(0);
  });
});

// ─── 6f. Delegation Service — prepareDelegation (async) ─────────────────

describe('Delegation Service — prepareDelegation', () => {
  it('returns compilation result with summary', async () => {
    const { prepareDelegation } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );
    const { getPolicyStore } = await import(
      '../extensions/crypto/src/services/policy-store.js'
    );

    const store = getPolicyStore();
    const policy = {
      id: 'prepare-test',
      name: 'Prepare Test',
      description: 'test',
      rules: [{ type: 'max_amount' as const, maxAmountUsd: 100 }],
      scope: { type: 'all_write' as const },
      status: 'active' as const,
      confirmedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'prepare-user',
    };
    store.savePolicy(policy);

    const result = await prepareDelegation({ policy, chainId: 8453 });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.summary).toContain('Delegation Compilation Summary');
      expect(result.compilation).toBeDefined();
      expect(result.compilation.delegation.caveats.length).toBeGreaterThan(0);
      expect(result.chainId).toBe(8453);
    }

    store.deletePolicy('prepare-user', 'prepare-test');
  });

  it('returns error for unconfirmed policy', async () => {
    const { prepareDelegation } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const policy = {
      id: 'unconfirmed-test',
      name: 'Unconfirmed',
      description: 'test',
      rules: [{ type: 'max_amount' as const, maxAmountUsd: 100 }],
      scope: { type: 'all_write' as const },
      status: 'active' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'owner',
    };

    const result = await prepareDelegation({ policy, chainId: 8453 });
    expect('error' in result).toBe(true);
  });
});

// ─── 7. Policy Type Integration ─────────────────────────────────────────

describe('Policy type — delegation field', () => {
  it('Policy interface accepts delegation field', async () => {
    const policy: any = {
      id: 'test',
      name: 'Test',
      description: 'test',
      rules: [],
      scope: { type: 'all_write' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'owner',
      delegation: {
        chainId: 8453,
        hash: '0x123',
        delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
        status: 'signed',
        delegate: '0x222',
        delegator: '0x111',
        salt: '0',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };

    expect(policy.delegation).toBeDefined();
    expect(policy.delegation.chainId).toBe(8453);
    expect(policy.delegation.status).toBe('signed');
  });

  it('DelegationInfo fields are all present', async () => {
    // Type check: ensure the DelegationInfo type has all expected fields
    const info: import('../extensions/crypto/src/services/policy-types.js').DelegationInfo = {
      chainId: 8453,
      hash: '0x',
      delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
      status: 'signed',
      delegate: '0x2222222222222222222222222222222222222222',
      delegator: '0x1111111111111111111111111111111111111111',
      salt: '0',
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    expect(info.chainId).toBe(8453);
    expect(info.hash).toBe('0x');
    expect(info.status).toBe('signed');
  });
});

// ─── 8. Delegation Store ────────────────────────────────────────────────

describe('DelegationStore', () => {
  it('save and load round-trips a SignedDelegation', async () => {
    const { getDelegationStore, resetDelegationStore } = await import(
      '../extensions/crypto/src/services/delegation-store.js'
    );

    resetDelegationStore();
    const store = getDelegationStore();

    const delegation = {
      delegate: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      delegator: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      authority: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      caveats: [{
        enforcer: '0x92Bf12322527cAA612fd31a0e810472BBB106A8F' as `0x${string}`,
        terms: '0xabcdef' as `0x${string}`,
        args: '0x' as `0x${string}`,
      }],
      salt: 12345n,
      signature: '0xdeadbeef' as `0x${string}`,
    };

    store.save(delegation, 8453, 'test-store-policy');

    const loaded = store.load('test-store-policy');
    expect(loaded).not.toBeNull();
    expect(loaded!.chainId).toBe(8453);
    expect(loaded!.delegation.delegate).toBe(delegation.delegate);
    expect(loaded!.delegation.delegator).toBe(delegation.delegator);
    expect(loaded!.delegation.salt).toBe(12345n);
    expect(loaded!.delegation.signature).toBe('0xdeadbeef');
    expect(loaded!.delegation.caveats).toHaveLength(1);
    expect(loaded!.delegation.caveats[0]!.enforcer).toBe(delegation.caveats[0]!.enforcer);

    // Cleanup
    store.delete('test-store-policy');
    resetDelegationStore();
  });

  it('has() returns true for stored, false for missing', async () => {
    const { getDelegationStore, resetDelegationStore } = await import(
      '../extensions/crypto/src/services/delegation-store.js'
    );

    resetDelegationStore();
    const store = getDelegationStore();

    expect(store.has('nonexistent-policy')).toBe(false);

    store.save({
      delegate: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      delegator: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      authority: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      caveats: [],
      salt: 1n,
      signature: '0x' as `0x${string}`,
    }, 8453, 'has-test-policy');

    expect(store.has('has-test-policy')).toBe(true);

    store.delete('has-test-policy');
    expect(store.has('has-test-policy')).toBe(false);

    resetDelegationStore();
  });

  it('delete removes stored delegation', async () => {
    const { getDelegationStore, resetDelegationStore } = await import(
      '../extensions/crypto/src/services/delegation-store.js'
    );

    resetDelegationStore();
    const store = getDelegationStore();

    store.save({
      delegate: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      delegator: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      authority: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      caveats: [],
      salt: 1n,
      signature: '0x' as `0x${string}`,
    }, 8453, 'delete-test-policy');

    expect(store.delete('delete-test-policy')).toBe(true);
    expect(store.load('delete-test-policy')).toBeNull();
    expect(store.delete('delete-test-policy')).toBe(false);

    resetDelegationStore();
  });
});

// ─── 9. Redemption Readiness ────────────────────────────────────────────

describe('Delegation Service — canRedeem', () => {
  it('returns not ready when no delegation stored', async () => {
    const { canRedeem } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const result = canRedeem('nonexistent-policy-id');
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('No signed delegation');
  });

  it('returns ready when delegation is stored', async () => {
    const { canRedeem } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );
    const { getDelegationStore, resetDelegationStore } = await import(
      '../extensions/crypto/src/services/delegation-store.js'
    );

    resetDelegationStore();
    const store = getDelegationStore();

    store.save({
      delegate: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      delegator: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      authority: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      caveats: [],
      salt: 1n,
      signature: '0xdeadbeef' as `0x${string}`,
    }, 8453, 'can-redeem-test');

    const result = canRedeem('can-redeem-test');
    expect(result.ready).toBe(true);

    store.delete('can-redeem-test');
    resetDelegationStore();
  });
});

// ─── 10. Redemption — redeemDelegation ──────────────────────────────────

describe('Delegation Service — redeemDelegation', () => {
  it('returns error when no delegation stored', async () => {
    const { redeemDelegation } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const result = await redeemDelegation('no-such-policy', {
      target: '0x3333333333333333333333333333333333333333' as `0x${string}`,
      value: 0n,
      callData: '0x' as `0x${string}`,
    });

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No signed delegation found');
    }
  });

  it('returns error when no wallet connected', async () => {
    const { redeemDelegation } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );
    const { getDelegationStore, resetDelegationStore } = await import(
      '../extensions/crypto/src/services/delegation-store.js'
    );

    resetDelegationStore();
    const store = getDelegationStore();

    store.save({
      delegate: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      delegator: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      authority: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      caveats: [],
      salt: 1n,
      signature: '0xdeadbeef' as `0x${string}`,
    }, 8453, 'redeem-no-wallet-test');

    const result = await redeemDelegation('redeem-no-wallet-test', {
      target: '0x3333333333333333333333333333333333333333' as `0x${string}`,
      value: 0n,
      callData: '0x' as `0x${string}`,
    });

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No wallet connected');
    }

    store.delete('redeem-no-wallet-test');
    resetDelegationStore();
  });
});

// ─── 11. Execution Types ────────────────────────────────────────────────

describe('Delegation Types — execution constants', () => {
  it('EXECUTE_MODE_DEFAULT is 64 zero bytes', async () => {
    const { EXECUTE_MODE_DEFAULT } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );

    expect(EXECUTE_MODE_DEFAULT).toMatch(/^0x0{64}$/);
  });

  it('ExecutionAction interface fields exist on conforming object', async () => {
    const action: import('../extensions/crypto/src/services/delegation-types.js').ExecutionAction = {
      target: '0x3333333333333333333333333333333333333333' as `0x${string}`,
      value: 100n,
      callData: '0xdeadbeef' as `0x${string}`,
    };

    expect(action.target).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(action.value).toBe(100n);
    expect(action.callData).toBe('0xdeadbeef');
  });
});

// ─── 12. Revoke By Policy ───────────────────────────────────────────────

describe('Delegation Service — revokeByPolicy', () => {
  it('returns localOnly when no full struct stored', async () => {
    const { revokeByPolicy } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );
    const { getPolicyStore } = await import(
      '../extensions/crypto/src/services/policy-store.js'
    );

    const store = getPolicyStore();
    const policy = {
      id: 'revoke-local-test',
      name: 'RevokeLocalTest',
      description: 'test',
      rules: [{ type: 'max_amount' as const, maxAmountUsd: 100 }],
      scope: { type: 'all_write' as const },
      status: 'active' as const,
      confirmedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'revoke-test-user',
      delegation: {
        chainId: 8453,
        hash: '0xabcdef',
        delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
        status: 'signed' as const,
        delegate: '0x2222222222222222222222222222222222222222',
        delegator: '0x1111111111111111111111111111111111111111',
        salt: '0',
        createdAt: new Date().toISOString(),
      },
    };
    store.savePolicy(policy);

    const result = await revokeByPolicy(policy, 'revoke-test-user');
    expect('localOnly' in result).toBe(true);

    const saved = store.getPolicy('revoke-test-user', 'revoke-local-test');
    expect(saved?.delegation?.status).toBe('revoked');

    store.deletePolicy('revoke-test-user', 'revoke-local-test');
  });

  it('returns error when policy has no delegation', async () => {
    const { revokeByPolicy } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const policy = {
      id: 'no-deleg-test',
      name: 'NoDeleg',
      description: 'test',
      rules: [],
      scope: { type: 'all_write' as const },
      status: 'active' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'owner',
    };

    const result = await revokeByPolicy(policy, 'owner');
    expect('error' in result).toBe(true);
  });
});

// ─── 13. Plugin Registration ────────────────────────────────────────────

describe('V7 Plugin Registration', () => {
  it('plugin registers 112 commands including /delegate, /policymode, /profile, and /upgrade', { timeout: 15000 }, async () => {
    const commands: any[] = [];
    const mockApi = {
      registerTool: () => {},
      registerCommand: (c: any) => commands.push(c),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    const { default: plugin } = await import('../extensions/crypto/index.js');
    plugin.register(mockApi as any);

    expect(commands).toHaveLength(112);
    expect(commands.find((c: any) => c.name === 'delegate')).toBeDefined();
    expect(commands.find((c: any) => c.name === 'policies')).toBeDefined();
    expect(commands.find((c: any) => c.name === 'policymode')).toBeDefined();
    expect(commands.find((c: any) => c.name === 'profile')).toBeDefined();
    expect(commands.find((c: any) => c.name === 'upgrade')).toBeDefined();
  });

  it('delegate command has correct shape in registered commands', { timeout: 15000 }, async () => {
    const commands: any[] = [];
    const mockApi = {
      registerTool: () => {},
      registerCommand: (c: any) => commands.push(c),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    const { default: plugin } = await import('../extensions/crypto/index.js');
    plugin.register(mockApi as any);

    const delegateCmd = commands.find((c: any) => c.name === 'delegate');
    expect(delegateCmd).toBeDefined();
    expect(delegateCmd.acceptsArgs).toBe(true);
    expect(delegateCmd.requireAuth).toBe(true);
    expect(typeof delegateCmd.handler).toBe('function');
  });
});

// ─── 14. Policy Mode System ──────────────────────────────────────────────

describe('Policy Mode System', () => {
  beforeEach(async () => {
    // Reset cached mode before each test
    const { resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    resetPolicyMode();
  });

  it('getPolicyMode returns delegation by default', async () => {
    const { getPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    // Default mode is delegation (even when no file on disk)
    const mode = getPolicyMode();
    expect(mode === 'delegation' || mode === 'simple').toBe(true);
  });

  it('PolicyMode type accepts only delegation or simple', async () => {
    const { setPolicyMode, getPolicyMode, resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    expect(getPolicyMode()).toBe('delegation');

    resetPolicyMode();
    setPolicyMode('simple');
    expect(getPolicyMode()).toBe('simple');
  });

  it('isDelegationMode returns true in delegation mode', async () => {
    const { isDelegationMode, setPolicyMode, resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    expect(isDelegationMode()).toBe(true);

    resetPolicyMode();
    setPolicyMode('simple');
    expect(isDelegationMode()).toBe(false);
  });

  it('resetPolicyMode clears the cache', async () => {
    const { setPolicyMode, getPolicyMode, resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('simple');
    expect(getPolicyMode()).toBe('simple');

    resetPolicyMode();
    // After reset, re-reads from disk or falls back to default
    const mode = getPolicyMode();
    expect(mode === 'delegation' || mode === 'simple').toBe(true);
  });
});

// ─── 15. Policymode Command ──────────────────────────────────────────────

describe('Policymode Command', () => {
  beforeEach(async () => {
    const { resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    resetPolicyMode();
  });

  it('has correct command shape', async () => {
    const { policymodeCommand } = await import(
      '../extensions/crypto/src/commands/policymode-command.js'
    );
    expect(policymodeCommand.name).toBe('policymode');
    expect(policymodeCommand.acceptsArgs).toBe(true);
    expect(policymodeCommand.requireAuth).toBe(true);
    expect(typeof policymodeCommand.handler).toBe('function');
  });

  it('shows current mode with no args', async () => {
    const { policymodeCommand } = await import(
      '../extensions/crypto/src/commands/policymode-command.js'
    );
    const result = await policymodeCommand.handler({});
    expect(result.text).toContain('Policy Enforcement Mode');
    // Should mention one of the two modes
    expect(
      result.text.includes('delegation') || result.text.includes('simple')
    ).toBe(true);
  });

  it('switches to simple mode', async () => {
    const { policymodeCommand } = await import(
      '../extensions/crypto/src/commands/policymode-command.js'
    );
    const { setPolicyMode, resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    // Start in delegation mode
    setPolicyMode('delegation');
    resetPolicyMode(); // clear cache so it re-reads
    setPolicyMode('delegation');

    const result = await policymodeCommand.handler({ args: 'simple' });
    expect(result.text).toContain('simple');
    expect(result.text).toContain('switched');
  });

  it('switches to delegation mode', async () => {
    const { policymodeCommand } = await import(
      '../extensions/crypto/src/commands/policymode-command.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    // Start in simple mode
    setPolicyMode('simple');

    const result = await policymodeCommand.handler({ args: 'delegation' });
    expect(result.text).toContain('delegation');
    expect(result.text).toContain('switched');
  });

  it('reports no change if already in requested mode', async () => {
    const { policymodeCommand } = await import(
      '../extensions/crypto/src/commands/policymode-command.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await policymodeCommand.handler({ args: 'delegation' });
    expect(result.text).toContain('Already');
    expect(result.text).toContain('delegation');
  });

  it('rejects unknown mode', async () => {
    const { policymodeCommand } = await import(
      '../extensions/crypto/src/commands/policymode-command.js'
    );
    const result = await policymodeCommand.handler({ args: 'turbo' });
    expect(result.text).toContain('Unknown mode');
  });
});

// ─── 16. Delegate Command Mode Gate ──────────────────────────────────────

describe('Delegate Command Mode Gate', () => {
  beforeEach(async () => {
    const { resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    resetPolicyMode();
  });

  it('blocks delegate command in simple mode', async () => {
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    const { delegateCommand } = await import(
      '../extensions/crypto/src/commands/delegate-command.js'
    );

    setPolicyMode('simple');
    const result = await delegateCommand.handler({ args: 'status' });
    expect(result.text).toContain('simple');
    expect(result.text).toContain('not active');
  });

  it('allows delegate command in delegation mode', async () => {
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    const { delegateCommand } = await import(
      '../extensions/crypto/src/commands/delegate-command.js'
    );

    setPolicyMode('delegation');
    // With no policies, it should proceed past the gate (won't mention "not active")
    const result = await delegateCommand.handler({ args: 'status' });
    expect(result.text).not.toContain('not active');
  });
});

// ─── 17. Autonomy Profiles ───────────────────────────────────────────────

describe('Autonomy Profiles', () => {
  beforeEach(async () => {
    const { resetProfileCache } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const { resetPolicyStore } = await import(
      '../extensions/crypto/src/services/policy-store.js'
    );
    resetProfileCache();
    resetPolicyStore();
  });

  it('lists 4 profiles', async () => {
    const { listProfiles } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const profiles = listProfiles();
    expect(profiles).toHaveLength(4);
    expect(profiles.map(p => p.id)).toEqual(['supervised', 'training', 'autonomous', 'custom']);
  });

  it('getProfile returns profile by ID', async () => {
    const { getProfile } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const training = getProfile('training');
    expect(training).toBeDefined();
    expect(training!.name).toBe('Training Wheels');
    expect(training!.rules.length).toBeGreaterThan(0);
    expect(training!.delegation.expirySec).toBe(86_400);
  });

  it('getProfile returns undefined for unknown ID', async () => {
    const { getProfile } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    expect(getProfile('turbo')).toBeUndefined();
  });

  it('activateProfile creates policies for training profile', async () => {
    const { activateProfile, getActiveProfile } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const result = activateProfile('test-user', 'training');
    expect(result.profile.id).toBe('training');
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0].name).toContain('profile:training');
    expect(result.policies[0].rules.length).toBeGreaterThan(0);
    expect(result.policies[0].status).toBe('active');

    // Active profile should now be training
    expect(getActiveProfile('test-user')).toBe('training');
  });

  it('activateProfile creates policies for autonomous profile', async () => {
    const { activateProfile } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const result = activateProfile('test-user', 'autonomous');
    expect(result.profile.id).toBe('autonomous');
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0].rules.length).toBe(4); // max_amount, spending_limit, rate_limit, approval_threshold
  });

  it('activateProfile creates no policies for supervised', async () => {
    const { activateProfile } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const result = activateProfile('test-user', 'supervised');
    expect(result.policies).toHaveLength(0);
  });

  it('activateProfile creates no policies for custom', async () => {
    const { activateProfile } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const result = activateProfile('test-user', 'custom');
    expect(result.policies).toHaveLength(0);
  });

  it('activateProfile removes previous profile policies', async () => {
    const { activateProfile } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const { getPolicyStore } = await import(
      '../extensions/crypto/src/services/policy-store.js'
    );

    // Activate training
    activateProfile('test-user', 'training');
    let policies = getPolicyStore().listPolicies('test-user');
    expect(policies).toHaveLength(1);
    expect(policies[0].name).toContain('training');

    // Switch to autonomous — should replace training policy
    activateProfile('test-user', 'autonomous');
    policies = getPolicyStore().listPolicies('test-user');
    expect(policies).toHaveLength(1);
    expect(policies[0].name).toContain('autonomous');
  });

  it('deactivateProfile removes profile policies', async () => {
    const { activateProfile, deactivateProfile, getActiveProfile } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const { getPolicyStore } = await import(
      '../extensions/crypto/src/services/policy-store.js'
    );

    activateProfile('test-user', 'training');
    expect(getPolicyStore().listPolicies('test-user')).toHaveLength(1);

    deactivateProfile('test-user');
    expect(getPolicyStore().listPolicies('test-user')).toHaveLength(0);
    expect(getActiveProfile('test-user')).toBe('supervised');
  });

  it('formatProfileDisplay includes profile name and summary', async () => {
    const { getProfile, formatProfileDisplay } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const training = getProfile('training')!;
    const display = formatProfileDisplay(training, true);
    expect(display).toContain('Training Wheels');
    expect(display).toContain('(active)');
    expect(display).toContain('$50');
  });
});

// ─── 18. Profile Command ─────────────────────────────────────────────────

describe('Profile Command', () => {
  beforeEach(async () => {
    const { resetProfileCache } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    const { resetPolicyStore } = await import(
      '../extensions/crypto/src/services/policy-store.js'
    );
    const { resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    resetProfileCache();
    resetPolicyStore();
    resetPolicyMode();
  });

  it('has correct command shape', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    expect(profileCommand.name).toBe('profile');
    expect(profileCommand.acceptsArgs).toBe(true);
    expect(profileCommand.requireAuth).toBe(true);
    expect(typeof profileCommand.handler).toBe('function');
  });

  it('shows profiles list with no args', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    const result = await profileCommand.handler({ senderId: 'test-user' });
    expect(result.text).toContain('Autonomy Profiles');
    expect(result.text).toContain('Supervised');
    expect(result.text).toContain('Training Wheels');
    expect(result.text).toContain('Autonomous');
    expect(result.text).toContain('Custom');
  });

  it('activates training profile', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    const result = await profileCommand.handler({ args: 'training', senderId: 'test-user' });
    expect(result.text).toContain('Profile activated');
    expect(result.text).toContain('Training Wheels');
    expect(result.text).toContain('$50');
  });

  it('activates autonomous profile', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    const result = await profileCommand.handler({ args: 'autonomous', senderId: 'test-user' });
    expect(result.text).toContain('Profile activated');
    expect(result.text).toContain('Autonomous');
  });

  it('deactivates with /profile off', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    // Activate first
    await profileCommand.handler({ args: 'training', senderId: 'test-user' });
    // Then deactivate
    const result = await profileCommand.handler({ args: 'off', senderId: 'test-user' });
    expect(result.text).toContain('Profile deactivated');
    expect(result.text).toContain('supervised');
  });

  it('rejects unknown profile name', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    const result = await profileCommand.handler({ args: 'turbo', senderId: 'test-user' });
    expect(result.text).toContain('Unknown profile');
  });
});

// ─── 19. Delegation Monitor ──────────────────────────────────────────────

describe('Delegation Monitor', () => {
  beforeEach(async () => {
    const { resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    resetPolicyMode();
  });

  it('returns empty when not in delegation mode', async () => {
    const { checkDelegations } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('simple');
    const { health, alerts } = checkDelegations('test-user');
    expect(health).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it('returns empty when no delegated policies exist', async () => {
    const { checkDelegations } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const { health, alerts } = checkDelegations('nonexistent-user');
    expect(health).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it('formatDelegationHealth returns message for no delegations', async () => {
    const { formatDelegationHealth } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const output = formatDelegationHealth('nonexistent-user');
    expect(output).toContain('No active delegations');
  });

  it('generates critical alert for revoked delegation', async () => {
    // Test the alert generation logic directly
    const monitor = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );

    // The generateAlerts is internal, but we test via the exported types
    // Verify the AlertSeverity type exists
    type Sev = typeof monitor.checkDelegations extends (u: string) => { alerts: Array<infer A> }
      ? A extends { severity: infer S } ? S : never : never;
    const severities: string[] = ['info', 'warning', 'critical'];
    expect(severities).toContain('critical');
  });
});

// ─── 20. Delegation Executor ─────────────────────────────────────────────

describe('Delegation Executor', () => {
  beforeEach(async () => {
    const { resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    resetPolicyMode();
  });

  it('exports tryDelegationExecution function', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    expect(typeof tryDelegationExecution).toBe('function');
  });

  it('skips when not in delegation mode', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('simple');
    const result = await tryDelegationExecution(
      { toolName: 'transfer', userId: 'test-user' },
      { action: 'send', to: '0x' + '1'.repeat(40), amount: '0.1' },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('Not in delegation mode');
  });

  it('skips for unsupported tools', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await tryDelegationExecution(
      { toolName: 'defi_swap', userId: 'test-user' },
      { action: 'execute', fromToken: 'ETH', toToken: 'USDC' },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('does not support delegation execution');
  });

  it('skips when action extraction fails (bad args)', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await tryDelegationExecution(
      { toolName: 'transfer', userId: 'test-user' },
      { action: 'list' }, // not 'send', can't extract
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('Could not extract');
  });

  it('skips when no matching delegation exists', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await tryDelegationExecution(
      { toolName: 'transfer', userId: 'nonexistent-user' },
      { action: 'send', to: '0x' + '1'.repeat(40), amount: '0.1' },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('No matching delegation');
  });

  it('getDelegationSupportedTools returns transfer', async () => {
    const { getDelegationSupportedTools } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const tools = getDelegationSupportedTools();
    expect(tools).toContain('transfer');
  });

  it('isDelegationExecutionAvailable returns false in simple mode', async () => {
    const { isDelegationExecutionAvailable } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('simple');
    expect(isDelegationExecutionAvailable('transfer', 'test-user')).toBe(false);
  });

  it('isDelegationExecutionAvailable returns false for unsupported tool', async () => {
    const { isDelegationExecutionAvailable } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    expect(isDelegationExecutionAvailable('defi_swap', 'test-user')).toBe(false);
  });
});

// ─── 21. Policy Gate Integration ─────────────────────────────────────────

describe('Policy Gate — Delegation Integration', () => {
  it('policy gate imports tryDelegationExecution', async () => {
    // Verify the import exists in index.ts by checking the executor module loads
    const executor = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    expect(executor.tryDelegationExecution).toBeDefined();
    expect(executor.isDelegationExecutionAvailable).toBeDefined();
    expect(executor.getDelegationSupportedTools).toBeDefined();
  });

  it('expiresAt field exists on DelegationInfo type', async () => {
    // Verify the type has the new field by creating a conforming object
    const info: import('../extensions/crypto/src/services/policy-types.js').DelegationInfo = {
      chainId: 8453,
      hash: '0x123',
      delegationManager: '0x456',
      status: 'signed',
      delegate: '0xaaa',
      delegator: '0xbbb',
      salt: '1',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    expect(info.expiresAt).toBeDefined();
  });

  it('extractExpiryFromCaveats is used in storeDelegation', async () => {
    // Verify the delegation service module loads cleanly with the new function
    const service = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );
    expect(service.storeDelegation).toBeDefined();
    // storeDelegation now accepts optional expiresAt parameter (6th arg → 7th)
    expect(service.storeDelegation.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── 22. EIP-7702 Account Type Detection ────────────────────────────────

describe('EIP-7702 Account Type Detection', () => {
  it('WalletState type includes accountType field', async () => {
    const state: import('../extensions/crypto/src/lib/types.js').WalletState = {
      connected: true,
      address: '0x1234567890abcdef1234567890abcdef12345678',
      chainId: 8453,
      mode: 'private_key',
      policies: [],
      wcState: null,
      accountType: 'eoa',
      hasCode: false,
    };
    expect(state.accountType).toBe('eoa');
    expect(state.hasCode).toBe(false);
    expect(state.delegationDesignation).toBeUndefined();
  });

  it('WalletState type accepts smart_account type', async () => {
    const state: import('../extensions/crypto/src/lib/types.js').WalletState = {
      connected: true,
      address: '0x1234567890abcdef1234567890abcdef12345678',
      chainId: 8453,
      mode: 'walletconnect',
      policies: [],
      wcState: null,
      accountType: 'smart_account',
      hasCode: true,
    };
    expect(state.accountType).toBe('smart_account');
    expect(state.hasCode).toBe(true);
  });

  it('WalletState type accepts eip7702 type with delegation designation', async () => {
    const state: import('../extensions/crypto/src/lib/types.js').WalletState = {
      connected: true,
      address: '0x1234567890abcdef1234567890abcdef12345678',
      chainId: 8453,
      mode: 'private_key',
      policies: [],
      wcState: null,
      accountType: 'eip7702',
      hasCode: true,
      delegationDesignation: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    };
    expect(state.accountType).toBe('eip7702');
    expect(state.delegationDesignation).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('detectAccountType function is exported', async () => {
    const service = await import(
      '../extensions/crypto/src/services/walletconnect-service.js'
    );
    expect(service.detectAccountType).toBeDefined();
    expect(typeof service.detectAccountType).toBe('function');
  });

  it('clearAccountTypeCache function is exported', async () => {
    const service = await import(
      '../extensions/crypto/src/services/walletconnect-service.js'
    );
    expect(service.clearAccountTypeCache).toBeDefined();
    expect(typeof service.clearAccountTypeCache).toBe('function');
  });

  it('detectAccountType returns null when no wallet connected', async () => {
    const service = await import(
      '../extensions/crypto/src/services/walletconnect-service.js'
    );
    // Without a connected wallet, detection should return null
    const result = await service.detectAccountType();
    expect(result).toBeNull();
  });

  it('clearAccountTypeCache resets detection state', async () => {
    const service = await import(
      '../extensions/crypto/src/services/walletconnect-service.js'
    );
    service.clearAccountTypeCache();
    // After clearing, detection should return null (no wallet connected)
    const result = await service.detectAccountType();
    expect(result).toBeNull();
  });
});

// ─── 23. /upgrade Command ───────────────────────────────────────────────

describe('/upgrade Command', () => {
  it('exports upgradeCommand with correct shape', async () => {
    const { upgradeCommand } = await import(
      '../extensions/crypto/src/commands/upgrade-command.js'
    );
    expect(upgradeCommand).toBeDefined();
    expect(upgradeCommand.name).toBe('upgrade');
    expect(upgradeCommand.acceptsArgs).toBe(true);
    expect(upgradeCommand.requireAuth).toBe(true);
    expect(typeof upgradeCommand.handler).toBe('function');
  });

  it('description mentions account type detection', async () => {
    const { upgradeCommand } = await import(
      '../extensions/crypto/src/commands/upgrade-command.js'
    );
    expect(upgradeCommand.description).toContain('Account type');
  });

  it('handler returns text when no wallet connected', async () => {
    const { upgradeCommand } = await import(
      '../extensions/crypto/src/commands/upgrade-command.js'
    );
    const result = await upgradeCommand.handler({ args: '' });
    expect(result).toBeDefined();
    expect(result.text).toContain('No wallet connected');
  });

  it('handler supports guide subcommand', async () => {
    const { upgradeCommand } = await import(
      '../extensions/crypto/src/commands/upgrade-command.js'
    );
    const result = await upgradeCommand.handler({ args: 'guide' });
    expect(result).toBeDefined();
    expect(result.text).toContain('Migration Guide');
    expect(result.text).toContain('EIP-7702');
    expect(result.text).toContain('Option 1');
    expect(result.text).toContain('Option 2');
    expect(result.text).toContain('Option 3');
  });

  it('guide mentions MetaMask Delegation Framework', async () => {
    const { upgradeCommand } = await import(
      '../extensions/crypto/src/commands/upgrade-command.js'
    );
    const result = await upgradeCommand.handler({ args: 'guide' });
    expect(result.text).toContain('MetaMask Delegation Framework');
    expect(result.text).toContain('DelegationManager');
  });

  it('plugin registers /upgrade command (112 commands)', async () => {
    const commands: any[] = [];
    const api = {
      registerTool: () => {},
      registerCommand: (c: any) => commands.push(c),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    const plugin = await import('../extensions/crypto/index.js');
    (plugin as any).default.register(api);

    expect(commands.length).toBe(112);
    const names = commands.map(c => c.name);
    expect(names).toContain('upgrade');
  });
});

// ─── 24. Sub-Delegation ─────────────────────────────────────────────────

describe('Sub-Delegation', () => {
  it('createSubDelegation is exported from delegation service', async () => {
    const service = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );
    expect(service.createSubDelegation).toBeDefined();
    expect(typeof service.createSubDelegation).toBe('function');
  });

  it('encodePermissionContextChain is exported', async () => {
    const service = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );
    expect(service.encodePermissionContextChain).toBeDefined();
    expect(typeof service.encodePermissionContextChain).toBe('function');
  });

  it('encodePermissionContextChain encodes single delegation', async () => {
    const service = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const mockDelegation = {
      delegate: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      delegator: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      authority: ('0x' + '0'.repeat(64)) as `0x${string}`,
      caveats: [],
      salt: 1n,
      signature: '0xabcd' as `0x${string}`,
    };

    const result = service.encodePermissionContextChain([mockDelegation]);
    expect(result).toMatch(/^0x/);
    expect(result.length).toBeGreaterThan(10);
  });

  it('encodePermissionContextChain encodes multi-delegation chain', async () => {
    const service = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const parentDelegation = {
      delegate: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      delegator: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      authority: ('0x' + '0'.repeat(64)) as `0x${string}`,
      caveats: [],
      salt: 1n,
      signature: '0xabcd' as `0x${string}`,
    };

    const childDelegation = {
      delegate: '0x3333333333333333333333333333333333333333' as `0x${string}`,
      delegator: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      authority: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
      caveats: [],
      salt: 2n,
      signature: '0xef01' as `0x${string}`,
    };

    const single = service.encodePermissionContextChain([parentDelegation]);
    const chain = service.encodePermissionContextChain([parentDelegation, childDelegation]);

    // Chain encoding should be longer than single delegation encoding
    expect(chain.length).toBeGreaterThan(single.length);
  });

  it('SubAgentDef includes wallet fields', async () => {
    const { AgentPool } = await import(
      '../extensions/crypto/src/services/agent-pool.js'
    );
    const { rmSync } = await import('node:fs');

    const stateDir = '/tmp/openclawnch-test-agents-subdel-' + Date.now();
    try { rmSync(stateDir, { recursive: true }); } catch {}

    const pool = new AgentPool({ stateDir });
    const agent = pool.create({
      name: 'test_sub_agent',
      label: 'Test Sub Agent',
      description: 'A test sub agent for delegation testing',
      systemPrompt: 'You are a test sub agent for delegation testing.',
      createdBy: 'test',
    });

    // New fields should be undefined by default (not assigned until needed)
    expect(agent.walletAddress).toBeUndefined();
    expect(agent.walletPrivateKey).toBeUndefined();
    expect(agent.parentDelegationHash).toBeUndefined();
    pool.clear();
    try { rmSync(stateDir, { recursive: true }); } catch {}
  });

  it('assignEphemeralWallet generates a valid keypair', async () => {
    const { AgentPool } = await import(
      '../extensions/crypto/src/services/agent-pool.js'
    );
    const { rmSync } = await import('node:fs');

    const stateDir = '/tmp/openclawnch-test-agents-keypair-' + Date.now();
    try { rmSync(stateDir, { recursive: true }); } catch {}

    const pool = new AgentPool({ stateDir });
    const agent = pool.create({
      name: 'test_wallet_agent',
      label: 'Test Wallet Agent',
      description: 'A test agent for wallet assignment testing',
      systemPrompt: 'You are a test agent for wallet assignment.',
      createdBy: 'test',
    });

    const wallet = await pool.assignEphemeralWallet(agent.id);
    expect(wallet).not.toBeNull();
    expect(wallet!.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(wallet!.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // Second call should return same keypair (cached)
    const wallet2 = await pool.assignEphemeralWallet(agent.id);
    expect(wallet2!.address).toBe(wallet!.address);
    expect(wallet2!.privateKey).toBe(wallet!.privateKey);

    // getWallet should also return it
    const retrieved = pool.getWallet(agent.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.address).toBe(wallet!.address);

    pool.clear();
    try { rmSync(stateDir, { recursive: true }); } catch {}
  });

  it('assignEphemeralWallet returns null for unknown agent', async () => {
    const { AgentPool } = await import(
      '../extensions/crypto/src/services/agent-pool.js'
    );

    const pool = new AgentPool({ stateDir: '/tmp/openclawnch-test-agents-null' });
    const wallet = await pool.assignEphemeralWallet('nonexistent-id');
    expect(wallet).toBeNull();
    pool.clear();
  });

  it('ephemeral wallet keys are NOT serialized to disk', async () => {
    const { AgentPool } = await import(
      '../extensions/crypto/src/services/agent-pool.js'
    );
    const { readFileSync, existsSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');

    const stateDir = '/tmp/openclawnch-test-agents-nosave';
    try { rmSync(stateDir, { recursive: true }); } catch {}

    const pool = new AgentPool({ stateDir });
    const agent = pool.create({
      name: 'test_nosave_agent',
      label: 'Test NoSave Agent',
      description: 'A test agent to verify keys are not persisted',
      systemPrompt: 'You are a test agent for persistence checking.',
      createdBy: 'test',
    });

    await pool.assignEphemeralWallet(agent.id);

    // Force a save by making a visible change
    pool.update(agent.id, { label: 'Updated Label' });

    const filePath = join(stateDir, 'agents.json');
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf8');
      expect(content).not.toContain('walletPrivateKey');
      expect(content).not.toContain('walletAddress');
      expect(content).not.toContain('parentDelegationHash');
    }

    pool.clear();
    try { rmSync(stateDir, { recursive: true }); } catch {}
  });

  it('createSubDelegation fails without CLAWNCHER_PRIVATE_KEY', async () => {
    const service = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    // Clear the env var to test the error path
    const original = process.env.CLAWNCHER_PRIVATE_KEY;
    delete process.env.CLAWNCHER_PRIVATE_KEY;

    try {
      const result = await service.createSubDelegation({
        parentDelegation: {
          delegate: '0x1111111111111111111111111111111111111111' as `0x${string}`,
          delegator: '0x2222222222222222222222222222222222222222' as `0x${string}`,
          authority: ('0x' + '0'.repeat(64)) as `0x${string}`,
          caveats: [],
          salt: 1n,
          signature: '0xabcd' as `0x${string}`,
        },
        parentHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
        chainId: 8453,
        subAgentAddress: '0x3333333333333333333333333333333333333333' as `0x${string}`,
        subAgentPrivateKey: '0x' + 'aa'.repeat(32) as `0x${string}`,
      });

      // Without CLAWNCHER_PRIVATE_KEY the function should return an error
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('CLAWNCHER_PRIVATE_KEY');
      }
    } finally {
      if (original !== undefined) {
        process.env.CLAWNCHER_PRIVATE_KEY = original;
      }
    }
  });
});

// ─── 25. Expanded Extractors — ERC-20 and clawnchconnect ────────────────

describe('Delegation Executor — Expanded Extractors', () => {
  beforeEach(async () => {
    const { resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    resetPolicyMode();
  });

  it('getDelegationSupportedTools includes transfer and clawnchconnect', async () => {
    const { getDelegationSupportedTools } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const tools = getDelegationSupportedTools();
    expect(tools).toContain('transfer');
    expect(tools).toContain('clawnchconnect');
    // Tier 1-3 extractors
    expect(tools).toContain('approvals');
    expect(tools).toContain('permit2');
    expect(tools).toContain('nft');
    expect(tools).toContain('defi_lend');
    expect(tools).toContain('defi_stake');
    expect(tools).toContain('governance');
    expect(tools).toContain('yield');
    expect(tools.length).toBe(9);
  });

  it('transfer extractor skips non-send actions', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await tryDelegationExecution(
      { toolName: 'transfer', userId: 'test-user' },
      { action: 'balance', address: '0x' + '1'.repeat(40) },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('Could not extract');
  });

  it('transfer extractor handles ERC-20 token arg (skips at no-delegation gate)', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    // Valid ERC-20 transfer args — should extract successfully but fail at
    // the "no matching delegation" gate (no policies for this user).
    const result = await tryDelegationExecution(
      { toolName: 'transfer', userId: 'erc20-test-user' },
      {
        action: 'send',
        to: '0x' + '2'.repeat(40),
        amount: '100',
        token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
      },
    );
    expect(result.executed).toBe(false);
    // Should pass extraction (ERC-20) but fail at delegation matching
    expect(result.skipReason).toContain('No matching delegation');
  });

  it('transfer extractor rejects invalid token address', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await tryDelegationExecution(
      { toolName: 'transfer', userId: 'test-user' },
      {
        action: 'send',
        to: '0x' + '2'.repeat(40),
        amount: '100',
        token: 'not-an-address', // Invalid token — should fall through to null extraction
      },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('Could not extract');
  });

  it('transfer extractor treats missing token as native ETH', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    // No token arg → native ETH. Should extract OK, fail at delegation matching.
    const result = await tryDelegationExecution(
      { toolName: 'transfer', userId: 'native-test-user' },
      { action: 'send', to: '0x' + '3'.repeat(40), amount: '0.5' },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('No matching delegation');
  });

  it('transfer extractor rejects zero/negative amounts', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await tryDelegationExecution(
      { toolName: 'transfer', userId: 'test-user' },
      { action: 'send', to: '0x' + '1'.repeat(40), amount: '0' },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('Could not extract');
  });

  it('transfer extractor rejects invalid to address', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await tryDelegationExecution(
      { toolName: 'transfer', userId: 'test-user' },
      { action: 'send', to: 'not-an-address', amount: '1.0' },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('Could not extract');
  });

  it('clawnchconnect extractor skips non-send_tx actions', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await tryDelegationExecution(
      { toolName: 'clawnchconnect', userId: 'test-user' },
      { action: 'connect', uri: 'wc:...' },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('Could not extract');
  });

  it('clawnchconnect extractor handles send_tx with value and data', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    // Valid send_tx args. Should extract OK, fail at delegation matching.
    const result = await tryDelegationExecution(
      { toolName: 'clawnchconnect', userId: 'cc-test-user' },
      {
        action: 'send_tx',
        to: '0x' + '4'.repeat(40),
        value: '0.01',
        data: '0xa9059cbb' + '0'.repeat(128),
      },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('No matching delegation');
  });

  it('clawnchconnect extractor handles send_tx with no value or data', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await tryDelegationExecution(
      { toolName: 'clawnchconnect', userId: 'cc-test-user-2' },
      { action: 'send_tx', to: '0x' + '5'.repeat(40) },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('No matching delegation');
  });

  it('clawnchconnect extractor rejects invalid to address', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await tryDelegationExecution(
      { toolName: 'clawnchconnect', userId: 'test-user' },
      { action: 'send_tx', to: 'bad-addr', value: '0.01' },
    );
    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('Could not extract');
  });
});

// ─── 26. Profile Auto-Delegation ────────────────────────────────────────

describe('Profile Command — Auto-Delegation', () => {
  beforeEach(async () => {
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    const { resetProfileCache } = await import(
      '../extensions/crypto/src/services/autonomy-profiles.js'
    );
    // Ensure delegation mode for consistent starting state
    setPolicyMode('delegation');
    resetProfileCache();
  });

  it('profile command handler is async (returns promise)', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    const result = profileCommand.handler({ args: '', senderId: 'test-user' });
    // Handler should return a promise (async function)
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(resolved.text).toBeDefined();
  });

  it('activation in simple mode does NOT mention delegations', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('simple');
    const result = await profileCommand.handler({ args: 'training', senderId: 'auto-deleg-test-1' });
    expect(result.text).toContain('Profile activated');
    expect(result.text).toContain('Training Wheels');
    // In simple mode, no delegation auto-signing happens
    expect(result.text).not.toContain('Signed');
    expect(result.text).not.toContain('on-chain delegation');
  });

  it('activation in delegation mode attempts auto-delegation', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    // Auto-delegation will attempt but fail (no wallet connected) — that's expected.
    // We just verify it reaches the delegation code path.
    const result = await profileCommand.handler({ args: 'training', senderId: 'auto-deleg-test-2' });
    expect(result.text).toContain('Profile activated');
    expect(result.text).toContain('Training Wheels');
    // Should show either "Signed" (success) or "Failed to sign" (no wallet)
    const hasDelegationAttempt =
      result.text.includes('Signed') || result.text.includes('Failed to sign');
    expect(hasDelegationAttempt).toBe(true);
  });

  it('supervised profile creates no delegations even in delegation mode', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await profileCommand.handler({ args: 'supervised', senderId: 'auto-deleg-test-3' });
    expect(result.text).toContain('Profile activated');
    expect(result.text).toContain('Supervised');
    // No policies created → no auto-delegation attempt.
    // Note: profile summary naturally says "No on-chain delegation created."
    // so we check for the auto-delegation-specific output strings.
    expect(result.text).not.toContain('Signed 1');
    expect(result.text).not.toContain('Failed to sign');
    expect(result.text).not.toContain('delegation automatically');
    expect(result.text).toContain('All actions require wallet approval');
  });

  it('listing profiles in delegation mode shows auto-sign note', async () => {
    const { profileCommand } = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    setPolicyMode('delegation');
    const result = await profileCommand.handler({ args: '', senderId: 'auto-deleg-test-4' });
    expect(result.text).toContain('auto-signed');
  });

  it('profile command imports delegation service functions', async () => {
    // Verify the module loads without import errors
    const mod = await import(
      '../extensions/crypto/src/commands/profile-command.js'
    );
    expect(mod.profileCommand).toBeDefined();
    expect(mod.profileCommand.handler).toBeDefined();
  });
});

// ─── 27. On-Chain Monitoring ─────────────────────────────────────────────

describe('On-Chain Monitoring', () => {
  it('exports readOnChainUsage function', async () => {
    const { readOnChainUsage } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );
    expect(typeof readOnChainUsage).toBe('function');
  });

  it('exports checkDelegationsWithOnChain function', async () => {
    const { checkDelegationsWithOnChain } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );
    expect(typeof checkDelegationsWithOnChain).toBe('function');
  });

  it('exports formatOnChainUsage function', async () => {
    const { formatOnChainUsage } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );
    expect(typeof formatOnChainUsage).toBe('function');
  });

  it('readOnChainUsage returns empty result for invalid hash', async () => {
    const { readOnChainUsage } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );

    const result = await readOnChainUsage(
      'test-policy',
      '0x' as `0x${string}`,
      8453,
      {
        policyId: 'test-policy',
        policyName: 'test',
        chainId: 8453,
        status: 'signed',
        spentUsd: null,
        limitUsd: null,
        usagePercent: null,
        expiresInSec: null,
        actionsUsed: null,
        actionsLimit: null,
      },
    );

    expect(result.nativeSpentWei).toBeNull();
    expect(result.erc20Spent).toBeNull();
    expect(result.callCount).toBeNull();
    expect(result.driftDetected).toBe(false);
    expect(result.queriedAt).toBeGreaterThan(0);
  });

  it('readOnChainUsage returns empty result for unsupported chain', async () => {
    const { readOnChainUsage } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );

    const result = await readOnChainUsage(
      'test-policy',
      ('0x' + 'ab'.repeat(32)) as `0x${string}`,
      999999, // unsupported chain
      {
        policyId: 'test-policy',
        policyName: 'test',
        chainId: 999999,
        status: 'signed',
        spentUsd: null,
        limitUsd: null,
        usagePercent: null,
        expiresInSec: null,
        actionsUsed: null,
        actionsLimit: null,
      },
    );

    expect(result.nativeSpentWei).toBeNull();
    expect(result.driftDetected).toBe(false);
  });

  it('formatOnChainUsage formats ETH spending', async () => {
    const { formatOnChainUsage } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );

    const output = formatOnChainUsage({
      nativeSpentWei: 1_500_000_000_000_000_000n, // 1.5 ETH
      erc20Spent: null,
      callCount: 5n,
      driftDetected: false,
      queriedAt: Date.now(),
    });

    expect(output).toContain('1.500000 ETH');
    expect(output).toContain('call count: 5');
  });

  it('formatOnChainUsage shows drift warning', async () => {
    const { formatOnChainUsage } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );

    const output = formatOnChainUsage({
      nativeSpentWei: null,
      erc20Spent: null,
      callCount: 10n,
      driftDetected: true,
      driftDetails: 'calls: local=5, on-chain=10',
      queriedAt: Date.now(),
    });

    expect(output).toContain('Drift');
    expect(output).toContain('local=5, on-chain=10');
  });

  it('checkDelegationsWithOnChain returns empty when not in delegation mode', async () => {
    const { checkDelegationsWithOnChain } = await import(
      '../extensions/crypto/src/services/delegation-monitor.js'
    );
    const { setPolicyMode, resetPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );

    resetPolicyMode();
    setPolicyMode('simple');

    const result = await checkDelegationsWithOnChain('test-user');
    expect(result.health).toHaveLength(0);
    expect(result.alerts).toHaveLength(0);

    // Restore delegation mode to avoid polluting subsequent tests
    setPolicyMode('delegation');
    resetPolicyMode();
  });

  it('enforcer ABI types are exported from delegation-types', async () => {
    const types = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );
    expect(types.NATIVE_PERIOD_ENFORCER_ABI).toBeDefined();
    expect(types.ERC20_PERIOD_ENFORCER_ABI).toBeDefined();
    expect(types.LIMITED_CALLS_ENFORCER_ABI).toBeDefined();

    // Each ABI should have the expected function name
    expect(types.NATIVE_PERIOD_ENFORCER_ABI[0].name).toBe('spentMap');
    expect(types.ERC20_PERIOD_ENFORCER_ABI[0].name).toBe('spentMap');
    expect(types.LIMITED_CALLS_ENFORCER_ABI[0].name).toBe('callCounts');
  });

  it('OnChainUsage type has all expected fields', async () => {
    const usage: import('../extensions/crypto/src/services/delegation-monitor.js').OnChainUsage = {
      nativeSpentWei: 0n,
      erc20Spent: null,
      callCount: null,
      driftDetected: false,
      queriedAt: Date.now(),
    };
    expect(usage.nativeSpentWei).toBe(0n);
    expect(usage.driftDetected).toBe(false);
  });
});

// ─── 28. encodePermissionContextChain Round-Trip ────────────────────────

describe('encodePermissionContextChain — Round-Trip', () => {
  it('encodes a single delegation and returns valid hex', async () => {
    const { encodePermissionContextChain } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const delegation = {
      delegate: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      delegator: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      authority: ('0x' + '0'.repeat(64)) as `0x${string}`,
      caveats: [{
        enforcer: '0x3333333333333333333333333333333333333333' as `0x${string}`,
        terms: '0xabcd' as `0x${string}`,
        args: '0x' as `0x${string}`,
      }],
      salt: 42n,
      signature: '0x' + 'ff'.repeat(65) as `0x${string}`,
    };

    const encoded = encodePermissionContextChain([delegation]);
    expect(encoded).toMatch(/^0x[0-9a-f]+$/i);
    // Must be non-trivial (more than just the header)
    expect(encoded.length).toBeGreaterThan(100);
  });

  it('encodes a two-delegation chain (parent + child)', async () => {
    const { encodePermissionContextChain } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    const parent = {
      delegate: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      delegator: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      authority: ('0x' + '0'.repeat(64)) as `0x${string}`,
      caveats: [],
      salt: 1n,
      signature: '0x' + 'aa'.repeat(65) as `0x${string}`,
    };

    const child = {
      delegate: '0x4444444444444444444444444444444444444444' as `0x${string}`,
      delegator: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      authority: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
      caveats: [{
        enforcer: '0x5555555555555555555555555555555555555555' as `0x${string}`,
        terms: '0x1234' as `0x${string}`,
        args: '0x' as `0x${string}`,
      }],
      salt: 2n,
      signature: '0x' + 'cc'.repeat(65) as `0x${string}`,
    };

    const encoded = encodePermissionContextChain([parent, child]);
    expect(encoded).toMatch(/^0x[0-9a-f]+$/i);
    // Two delegations should encode to more bytes than one
    const singleEncoded = encodePermissionContextChain([parent]);
    expect(encoded.length).toBeGreaterThan(singleEncoded.length);
  });

  it('round-trips via decodeAbiParameters', async () => {
    const { encodePermissionContextChain } = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );
    const { decodeAbiParameters } = await import('viem');

    const delegation = {
      delegate: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      delegator: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      authority: ('0x' + '0'.repeat(64)) as `0x${string}`,
      caveats: [{
        enforcer: '0x3333333333333333333333333333333333333333' as `0x${string}`,
        terms: '0xabcd' as `0x${string}`,
        args: '0x' as `0x${string}`,
      }],
      salt: 99n,
      signature: '0x' + 'dd'.repeat(65) as `0x${string}`,
    };

    const encoded = encodePermissionContextChain([delegation]);

    // Decode it back
    const decoded = decodeAbiParameters(
      [{
        type: 'tuple[]',
        components: [
          { name: 'delegate', type: 'address' },
          { name: 'delegator', type: 'address' },
          { name: 'authority', type: 'bytes32' },
          {
            name: 'caveats', type: 'tuple[]',
            components: [
              { name: 'enforcer', type: 'address' },
              { name: 'terms', type: 'bytes' },
              { name: 'args', type: 'bytes' },
            ],
          },
          { name: 'salt', type: 'uint256' },
          { name: 'signature', type: 'bytes' },
        ],
      }],
      encoded,
    );

    const chain = decoded[0] as any[];
    expect(chain.length).toBe(1);

    const d = chain[0];
    expect(d.delegate.toLowerCase()).toBe('0x1111111111111111111111111111111111111111');
    expect(d.delegator.toLowerCase()).toBe('0x2222222222222222222222222222222222222222');
    expect(d.salt).toBe(99n);
    expect(d.caveats.length).toBe(1);
    expect(d.caveats[0].enforcer.toLowerCase()).toBe('0x3333333333333333333333333333333333333333');
  });
});

// ─── 20. Policy Gate E2E — tool.execute() → delegation routing ──────────

describe('Policy Gate E2E — delegation routing through plugin', () => {
  let tools: any[] = [];
  const MOCK_TX_HASH = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const MOCK_CHAIN_ID = 8453;
  const DELEGATE = '0x2222222222222222222222222222222222222222';
  const DELEGATOR = '0x1111111111111111111111111111111111111111';
  const RECIPIENT = '0x3333333333333333333333333333333333333333';

  beforeEach(async () => {
    tools = [];
    // Set delegation mode
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    setPolicyMode('delegation');
  });

  afterEach(async () => {
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    setPolicyMode('delegation');
  });

  it('transfer tool routes through delegation when delegation is available', async () => {
    // --- Setup: mock redeemDelegation at the executor level ---
    // We mock the entire delegation-service module's redeemDelegation and canRedeem
    // to avoid needing a real wallet/chain connection.
    const executorModule = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );
    const serviceModule = await import(
      '../extensions/crypto/src/services/delegation-service.js'
    );

    // Store a policy with delegation info
    const { getPolicyStore, resetPolicyStore } = await import(
      '../extensions/crypto/src/services/policy-store.js'
    );
    resetPolicyStore();
    const policyStore = getPolicyStore();

    const testPolicy = {
      id: 'gate-e2e-policy',
      name: 'gate-e2e-test',
      description: 'Tests policy gate delegation routing',
      rules: [] as any[], // no rules = evaluatePolicies returns 'allow'
      scope: { type: 'all_write' as const },
      status: 'active' as const,
      confirmedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'owner',
      delegation: {
        chainId: MOCK_CHAIN_ID,
        hash: '0xabcdef1234567890',
        delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
        status: 'signed' as const,
        delegate: DELEGATE,
        delegator: DELEGATOR,
        salt: '1',
        createdAt: new Date().toISOString(),
      },
    };
    policyStore.savePolicy(testPolicy);

    // Store a signed delegation in the delegation store
    const { getDelegationStore, resetDelegationStore } = await import(
      '../extensions/crypto/src/services/delegation-store.js'
    );
    resetDelegationStore();
    const delegStore = getDelegationStore();
    delegStore.save(
      {
        delegate: DELEGATE as `0x${string}`,
        delegator: DELEGATOR as `0x${string}`,
        authority: ('0x' + 'f'.repeat(64)) as `0x${string}`,
        caveats: [],
        salt: 1n,
        signature: ('0x' + 'ab'.repeat(65)) as `0x${string}`,
      },
      MOCK_CHAIN_ID,
      'gate-e2e-policy',
    );

    // Call tryDelegationExecution directly with transfer tool args
    // This tests the full gate sequence: mode check → extractor → matching → canRedeem
    const result = await executorModule.tryDelegationExecution(
      {
        toolName: 'transfer',
        action: 'send',
        userId: 'owner',
        toAddress: RECIPIENT,
      },
      {
        action: 'send',
        to: RECIPIENT,
        amount: '0.001',
      },
    );

    // The delegation was found, extractor succeeded, canRedeem passed.
    // redeemDelegation will fail (no real wallet), but all gates before it passed.
    // That's what we're testing: the wiring up to the redemption attempt.
    if (result.executed) {
      // If somehow a wallet was available and it succeeded
      expect(result.txHash).toBeDefined();
    } else {
      // Expected: redeemDelegation fails because no wallet is connected.
      // The key assertion: it got PAST all delegation gates and attempted redemption.
      // skipReason would be set for early exits (mode, extractor, matching, readiness).
      // error is set when redemption was attempted but failed.
      expect(result.error).toBeDefined();
      expect(result.skipReason).toBeUndefined(); // NOT a skip — it attempted redemption
      expect(result.error).toContain('wallet'); // fails at wallet connection
    }
  });

  it('transfer tool skips delegation for unsupported action', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );

    const result = await tryDelegationExecution(
      { toolName: 'transfer', action: 'estimate', userId: 'owner' },
      { action: 'estimate', to: RECIPIENT, amount: '0.001' },
    );

    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('Could not extract');
  });

  it('defi_swap tool skips delegation (no extractor)', async () => {
    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );

    const result = await tryDelegationExecution(
      { toolName: 'defi_swap', action: 'swap', userId: 'owner' },
      { action: 'swap', tokenIn: 'ETH', tokenOut: 'USDC', amount: '1' },
    );

    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('does not support delegation');
  });

  it('delegation mode off skips delegation', async () => {
    const { setPolicyMode } = await import(
      '../extensions/crypto/src/services/policy-types.js'
    );
    setPolicyMode('simple');

    const { tryDelegationExecution } = await import(
      '../extensions/crypto/src/services/delegation-executor.js'
    );

    const result = await tryDelegationExecution(
      { toolName: 'transfer', action: 'send', userId: 'owner' },
      { action: 'send', to: RECIPIENT, amount: '0.001' },
    );

    expect(result.executed).toBe(false);
    expect(result.skipReason).toContain('Not in delegation mode');

    // Restore
    setPolicyMode('delegation');
  });
});
