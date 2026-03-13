/**
 * Policy Engine Tests — Sprint 13
 *
 * Tests the complete policy engine: types, store, evaluator, tool, command,
 * enforcement gate, and prompt builder integration.
 *
 * Covers:
 *   1.  Type helpers: describeRule, describeScope, periodToMs, TOOL_CATEGORIES
 *   2.  PolicyStore: CRUD, usage tracking, spend/call window queries
 *   3.  PolicyEvaluator: all 7 rule types, scope matching, most-restrictive-wins
 *   4.  PolicyEvaluator: unknown amounts → confirm (not guess)
 *   5.  policy_manage tool: propose/confirm draft flow, list, evaluate, categories
 *   6.  /policies command: list, view, enable, disable, delete
 *   7.  extractActionContext: field extraction from tool args
 *   8.  renderPolicyDisplay: both NL description and structured rules shown
 *   9.  Plugin registers 45 tools and 109 commands (V6: +1 tool, +1 command)
 *   10. Tool config has 39 entries (V6: +1 policy_manage)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ─── Test directory for policy persistence ──────────────────────────────

const TEST_HOME = join(process.env.HOME ?? '/tmp', '.openclawnch-policy-test-' + Date.now());

// ─── Type Helpers ───────────────────────────────────────────────────────

describe('Policy Types', () => {
  it('describeRule renders spending_limit', async () => {
    const { describeRule } = await import('../extensions/crypto/src/services/policy-types.js');
    const desc = describeRule({ type: 'spending_limit', maxAmountUsd: 500, period: 'daily' });
    expect(desc).toContain('$500');
    expect(desc).toContain('daily');
  });

  it('describeRule renders max_amount', async () => {
    const { describeRule } = await import('../extensions/crypto/src/services/policy-types.js');
    const desc = describeRule({ type: 'max_amount', maxAmountUsd: 1000 });
    expect(desc).toContain('$1000');
    expect(desc).toContain('block');
  });

  it('describeRule renders approval_threshold', async () => {
    const { describeRule } = await import('../extensions/crypto/src/services/policy-types.js');
    const desc = describeRule({ type: 'approval_threshold', amountUsd: 100 });
    expect(desc).toContain('$100');
    expect(desc).toContain('confirmation');
  });

  it('describeRule renders allowlist', async () => {
    const { describeRule } = await import('../extensions/crypto/src/services/policy-types.js');
    const desc = describeRule({ type: 'allowlist', field: 'tokens', values: ['ETH', 'USDC'] });
    expect(desc).toContain('ETH');
    expect(desc).toContain('USDC');
    expect(desc).toContain('only');
  });

  it('describeRule renders blocklist', async () => {
    const { describeRule } = await import('../extensions/crypto/src/services/policy-types.js');
    const desc = describeRule({ type: 'blocklist', field: 'tokens', values: ['SHIB'] });
    expect(desc).toContain('SHIB');
    expect(desc).toContain('never');
  });

  it('describeRule renders time_window', async () => {
    const { describeRule } = await import('../extensions/crypto/src/services/policy-types.js');
    const desc = describeRule({
      type: 'time_window',
      allowedHours: { start: 9, end: 17 },
      allowedDays: [1, 2, 3, 4, 5],
    });
    expect(desc).toContain('9:00');
    expect(desc).toContain('17:00');
    expect(desc).toContain('Mon');
  });

  it('describeRule renders rate_limit', async () => {
    const { describeRule } = await import('../extensions/crypto/src/services/policy-types.js');
    const desc = describeRule({ type: 'rate_limit', maxCalls: 10, periodMs: 86_400_000 });
    expect(desc).toContain('10');
    expect(desc).toContain('day');
  });

  it('describeScope renders all_write', async () => {
    const { describeScope } = await import('../extensions/crypto/src/services/policy-types.js');
    const desc = describeScope({ type: 'all_write' });
    expect(desc).toContain('All write');
  });

  it('describeScope renders categories', async () => {
    const { describeScope } = await import('../extensions/crypto/src/services/policy-types.js');
    const desc = describeScope({ type: 'categories', categories: ['defi', 'transfer'] });
    expect(desc).toContain('DeFi');
    expect(desc).toContain('Transfer');
  });

  it('periodToMs returns correct values', async () => {
    const { periodToMs } = await import('../extensions/crypto/src/services/policy-types.js');
    expect(periodToMs('hourly')).toBe(3_600_000);
    expect(periodToMs('daily')).toBe(86_400_000);
    expect(periodToMs('weekly')).toBe(604_800_000);
  });

  it('TOOL_CATEGORIES covers all 31 write tools', async () => {
    const { TOOL_TO_CATEGORY } = await import('../extensions/crypto/src/services/policy-types.js');
    const writeTools = [
      'defi_swap', 'transfer', 'bridge', 'permit2', 'clawnch_launch',
      'clawnch_fees', 'liquidity', 'compound_action', 'manage_orders',
      'bankr_launch', 'bankr_automate', 'bankr_polymarket', 'bankr_leverage',
      'clawnchconnect', 'molten', 'hummingbot', 'clawnx',
      'defi_lend', 'approvals', 'defi_stake', 'nft', 'privacy', 'yield', 'browser',
      'governance', 'farcaster', 'safe', 'airdrop', 'fiat_payment',
      'wayfinder', 'clawnch_info', 'crypto_workflow',
    ];
    for (const tool of writeTools) {
      expect(TOOL_TO_CATEGORY[tool], `Missing category for ${tool}`).toBeDefined();
    }
  });
});

// ─── Policy Store ───────────────────────────────────────────────────────

describe('PolicyStore', () => {
  let store: any;

  beforeEach(async () => {
    // Override HOME for test isolation
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore, getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
    store = getPolicyStore();
  });

  afterEach(() => {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
    process.env.HOME = join(TEST_HOME, '..');  // Restore parent
  });

  it('starts with empty list', () => {
    expect(store.listPolicies('user1')).toEqual([]);
  });

  it('saves and retrieves a policy', () => {
    const policy = {
      id: 'p1', name: 'test', description: 'test policy',
      rules: [{ type: 'max_amount', maxAmountUsd: 500 }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    };
    store.savePolicy(policy);
    const result = store.getPolicy('user1', 'p1');
    expect(result).toBeDefined();
    expect(result.name).toBe('test');
  });

  it('gets policy by name (case-insensitive)', () => {
    const policy = {
      id: 'p2', name: 'Daily Limit', description: 'test',
      rules: [], scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    };
    store.savePolicy(policy);
    expect(store.getPolicyByName('user1', 'daily limit')).toBeDefined();
    expect(store.getPolicyByName('user1', 'DAILY LIMIT')).toBeDefined();
  });

  it('filters active policies only', () => {
    store.savePolicy({
      id: 'p1', name: 'active', description: 'test',
      rules: [], scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    store.savePolicy({
      id: 'p2', name: 'draft', description: 'test',
      rules: [], scope: { type: 'all_write' },
      status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    expect(store.getActivePolicies('user1')).toHaveLength(1);
    expect(store.getActivePolicies('user1')[0].name).toBe('active');
  });

  it('deletes a policy', () => {
    store.savePolicy({
      id: 'p1', name: 'test', description: 'test',
      rules: [], scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    expect(store.deletePolicy('user1', 'p1')).toBe(true);
    expect(store.listPolicies('user1')).toHaveLength(0);
  });

  it('records and queries usage', () => {
    store.recordUsage('user1', 'p1', {
      timestamp: Date.now(), toolName: 'defi_swap', amountUsd: 100,
    });
    store.recordUsage('user1', 'p1', {
      timestamp: Date.now(), toolName: 'transfer', amountUsd: 50,
    });
    expect(store.getSpendInWindow('user1', 'p1', 86_400_000)).toBe(150);
    expect(store.getCallsInWindow('user1', 'p1', 86_400_000)).toBe(2);
  });

  it('getSpendInWindow ignores old entries', () => {
    store.recordUsage('user1', 'p1', {
      timestamp: Date.now() - 100_000_000, // ~1.15 days ago
      toolName: 'defi_swap', amountUsd: 999,
    });
    store.recordUsage('user1', 'p1', {
      timestamp: Date.now(), toolName: 'transfer', amountUsd: 50,
    });
    expect(store.getSpendInWindow('user1', 'p1', 86_400_000)).toBe(50);
  });
});

// ─── Policy Evaluator ───────────────────────────────────────────────────

describe('PolicyEvaluator', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore, getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
  });

  afterEach(() => {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  it('allows everything when no policies exist', async () => {
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const decision = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', amountUsd: 10000 });
    expect(decision.action).toBe('allow');
  });

  it('blocks when max_amount exceeded', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'max500', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 500 }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    const decision = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', amountUsd: 600 });
    expect(decision.action).toBe('block');
    expect(decision.reason).toContain('$600');
    expect(decision.reason).toContain('$500');
  });

  it('allows when max_amount not exceeded', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'max500', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 500 }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    const decision = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', amountUsd: 200 });
    expect(decision.action).toBe('allow');
  });

  it('returns confirm when amount is unknown and rule needs it', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'max500', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 500 }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    // amountUsd is undefined — evaluator should require confirmation, not guess
    const decision = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1' });
    expect(decision.action).toBe('confirm');
    expect(decision.reason).toContain('unknown');
  });

  it('blocks when spending_limit exceeded', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'daily500', description: 'test',
      rules: [{ type: 'spending_limit', maxAmountUsd: 500, period: 'daily' }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    // Record $400 already spent
    store.recordUsage('user1', 'p1', { timestamp: Date.now(), toolName: 'defi_swap', amountUsd: 400 });
    // Try to spend $200 more — should be blocked (400 + 200 > 500)
    const decision = evaluatePolicies({ toolName: 'transfer', userId: 'user1', amountUsd: 200 });
    expect(decision.action).toBe('block');
    expect(decision.reason).toContain('remaining');
  });

  it('blocks when rate_limit exceeded', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'rate3', description: 'test',
      rules: [{ type: 'rate_limit', maxCalls: 3, periodMs: 86_400_000 }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    store.recordUsage('user1', 'p1', { timestamp: Date.now(), toolName: 'a' });
    store.recordUsage('user1', 'p1', { timestamp: Date.now(), toolName: 'b' });
    store.recordUsage('user1', 'p1', { timestamp: Date.now(), toolName: 'c' });
    const decision = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1' });
    expect(decision.action).toBe('block');
    expect(decision.reason).toContain('rate limit');
  });

  it('blocks when token is on blocklist', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'no-shib', description: 'test',
      rules: [{ type: 'blocklist', field: 'tokens', values: ['shib', 'doge'] }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    const blocked = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', token: 'SHIB' });
    expect(blocked.action).toBe('block');
    const allowed = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', token: 'ETH' });
    expect(allowed.action).toBe('allow');
  });

  it('blocks when token is not on allowlist', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'only-blue-chips', description: 'test',
      rules: [{ type: 'allowlist', field: 'tokens', values: ['eth', 'usdc', 'wbtc'] }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    const blocked = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', token: 'SHIB' });
    expect(blocked.action).toBe('block');
    const allowed = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', token: 'ETH' });
    expect(allowed.action).toBe('allow');
  });

  it('requires confirmation above approval_threshold', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'confirm100', description: 'test',
      rules: [{ type: 'approval_threshold', amountUsd: 100 }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    const confirm = evaluatePolicies({ toolName: 'transfer', userId: 'user1', amountUsd: 200 });
    expect(confirm.action).toBe('confirm');
    const allow = evaluatePolicies({ toolName: 'transfer', userId: 'user1', amountUsd: 50 });
    expect(allow.action).toBe('allow');
  });

  it('scope categories limits enforcement to matching tools', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'defi-only', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 100 }],
      scope: { type: 'categories', categories: ['defi'] },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    // defi_swap is in 'defi' category → blocked
    const blocked = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', amountUsd: 200 });
    expect(blocked.action).toBe('block');
    // transfer is in 'transfer' category → not affected
    const allowed = evaluatePolicies({ toolName: 'transfer', userId: 'user1', amountUsd: 200 });
    expect(allowed.action).toBe('allow');
  });

  it('most restrictive rule wins (block > confirm > allow)', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'mixed', description: 'test',
      rules: [
        { type: 'approval_threshold', amountUsd: 50 },  // → confirm
        { type: 'max_amount', maxAmountUsd: 100 },       // → block
      ],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    // $200 exceeds both threshold (confirm) and max (block) → block wins
    const decision = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', amountUsd: 200 });
    expect(decision.action).toBe('block');
  });

  it('disabled policies are not evaluated', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'disabled', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 1 }],
      scope: { type: 'all_write' },
      status: 'disabled', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    // Would block if active, but disabled → allow
    const decision = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', amountUsd: 1000 });
    expect(decision.action).toBe('allow');
  });
});

// ─── Context Extraction ─────────────────────────────────────────────────

describe('extractActionContext', () => {
  it('extracts fields from swap-like args', async () => {
    const { extractActionContext } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const ctx = extractActionContext('defi_swap', {
      action: 'swap', tokenIn: 'ETH', amount: '1.5', chain: 8453,
    }, 'user1');
    expect(ctx.toolName).toBe('defi_swap');
    expect(ctx.action).toBe('swap');
    expect(ctx.token).toBe('ETH');
    expect(ctx.chain).toBe(8453);
  });

  it('extracts amountUsd for fiat_payment', async () => {
    const { extractActionContext } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const ctx = extractActionContext('fiat_payment', { amount: '500', action: 'off_ramp' }, 'user1');
    expect(ctx.amountUsd).toBe(500);
  });

  it('does not set amountUsd for non-fiat tools', async () => {
    const { extractActionContext } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const ctx = extractActionContext('defi_swap', { amount: '1.5' }, 'user1');
    // Amount is in token units, not USD — should be undefined
    expect(ctx.amountUsd).toBeUndefined();
  });
});

// ─── Policy Display ─────────────────────────────────────────────────────

describe('Policy Display', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
  });

  afterEach(() => {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  it('renderPolicyDisplay shows both NL description and structured rules', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const { buildPolicyDisplay, renderPolicyDisplay } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'daily limit', description: "don't let me spend more than $500 a day",
      rules: [{ type: 'spending_limit', maxAmountUsd: 500, period: 'daily' }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    const display = buildPolicyDisplay(store.getPolicy('user1', 'p1')!, 'user1');
    const rendered = renderPolicyDisplay(display);
    // Must show original NL
    expect(rendered).toContain("don't let me spend more than $500 a day");
    // Must show structured rule
    expect(rendered).toContain('$500');
    expect(rendered).toContain('daily');
    // Must show status
    expect(rendered).toContain('ACTIVE');
  });
});

// ─── policy_manage Tool ─────────────────────────────────────────────────

describe('policy_manage tool', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
  });

  afterEach(() => {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  it('has correct tool shape', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const tool = createPolicyManageTool();
    expect(tool.name).toBe('policy_manage');
    expect(tool.ownerOnly).toBe(true);
    expect(typeof tool.execute).toBe('function');
  });

  it('propose creates a DRAFT (not active)', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const tool = createPolicyManageTool();
    const result = await tool.execute('tc1', {
      action: 'propose',
      name: 'daily limit',
      description: "don't spend more than $500 a day",
      rules: [{ type: 'spending_limit', maxAmountUsd: 500, period: 'daily' }],
      scope: { type: 'all_write' },
    }, { senderId: 'user1' });
    // Should be a draft
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('draft_created');
    expect(data.policyId).toBeDefined();
    // Policy in store should be draft
    const store = getPolicyStore();
    const policy = store.getPolicy('user1', data.policyId);
    expect(policy!.status).toBe('draft');
    // Message should tell agent to show user the rules
    expect(data.message).toContain('DRAFT');
    expect(data.message).toContain('confirm');
  });

  it('confirm activates a draft', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const tool = createPolicyManageTool();
    // Propose
    const proposeResult = await tool.execute('tc1', {
      action: 'propose',
      name: 'test',
      description: 'test policy',
      rules: [{ type: 'max_amount', maxAmountUsd: 100 }],
      scope: { type: 'all_write' },
    }, { senderId: 'user1' });
    const policyId = JSON.parse(proposeResult.content[0].text).policyId;
    // Confirm
    const confirmResult = await tool.execute('tc2', {
      action: 'confirm',
      policyId,
    }, { senderId: 'user1' });
    const data = JSON.parse(confirmResult.content[0].text);
    expect(data.status).toBe('activated');
    // Policy should now be active
    const store = getPolicyStore();
    expect(store.getPolicy('user1', policyId)!.status).toBe('active');
  });

  it('list returns empty when no policies', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const tool = createPolicyManageTool();
    const result = await tool.execute('tc1', { action: 'list' }, { senderId: 'user1' });
    const data = JSON.parse(result.content[0].text);
    expect(data.policies).toEqual([]);
  });

  it('evaluate dry-runs against active policies', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const tool = createPolicyManageTool();
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'max100', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 100 }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    const result = await tool.execute('tc1', {
      action: 'evaluate',
      toolName: 'defi_swap',
      amountUsd: 200,
    }, { senderId: 'user1' });
    const data = JSON.parse(result.content[0].text);
    expect(data.decision).toBe('block');
  });

  it('categories returns tool category list', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const tool = createPolicyManageTool();
    const result = await tool.execute('tc1', { action: 'categories' }, { senderId: 'user1' });
    const data = JSON.parse(result.content[0].text);
    expect(data.categories.length).toBeGreaterThan(5);
    expect(data.categories.find((c: any) => c.key === 'defi')).toBeDefined();
  });
});

// ─── /policies command ──────────────────────────────────────────────────

describe('/policies command', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
  });

  afterEach(() => {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  it('has correct command shape', async () => {
    const { policiesCommand } = await import('../extensions/crypto/src/commands/policies-command.js');
    expect(policiesCommand.name).toBe('policies');
    expect(policiesCommand.acceptsArgs).toBe(true);
    expect(policiesCommand.requireAuth).toBe(true);
  });

  it('shows help when no policies exist', async () => {
    const { policiesCommand } = await import('../extensions/crypto/src/commands/policies-command.js');
    const result = await policiesCommand.handler({ senderId: 'user1', args: '' });
    expect(result.text).toContain('No policies');
    expect(result.text).toContain('plain English');
  });

  it('lists active policies', async () => {
    const { policiesCommand } = await import('../extensions/crypto/src/commands/policies-command.js');
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'my limit', description: 'max $500/day',
      rules: [{ type: 'spending_limit', maxAmountUsd: 500, period: 'daily' }],
      scope: { type: 'all_write' },
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    const result = await policiesCommand.handler({ senderId: 'user1', args: '' });
    expect(result.text).toContain('my limit');
    expect(result.text).toContain('$500');
  });

  it('enable/disable changes policy status (confirmed policy)', async () => {
    const { policiesCommand } = await import('../extensions/crypto/src/commands/policies-command.js');
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'my limit', description: 'test',
      rules: [], scope: { type: 'all_write' },
      status: 'active', confirmedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    await policiesCommand.handler({ senderId: 'user1', args: 'disable my limit' });
    expect(store.getPolicy('user1', 'p1')!.status).toBe('disabled');
    await policiesCommand.handler({ senderId: 'user1', args: 'enable my limit' });
    expect(store.getPolicy('user1', 'p1')!.status).toBe('active');
  });

  it('enable rejects unconfirmed policy', async () => {
    const { policiesCommand } = await import('../extensions/crypto/src/commands/policies-command.js');
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'my limit', description: 'test',
      rules: [], scope: { type: 'all_write' },
      status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    const result = await policiesCommand.handler({ senderId: 'user1', args: 'enable my limit' });
    expect(result.text).toContain('never been confirmed');
    expect(store.getPolicy('user1', 'p1')!.status).toBe('draft');
  });
});

// ─── Production Hardening Tests ─────────────────────────────────────────

describe('P0: Allowlist/Blocklist null field → confirm', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore, getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p-allow', name: 'only-eth', description: 'test',
      rules: [{ type: 'allowlist', field: 'tokens', values: ['eth'] }],
      scope: { type: 'all_write' },
      status: 'active', confirmedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    store.savePolicy({
      id: 'p-block', name: 'no-shib', description: 'test',
      rules: [{ type: 'blocklist', field: 'tokens', values: ['shib'] }],
      scope: { type: 'all_write' },
      status: 'active', confirmedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
  });

  afterEach(() => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

  it('allowlist with unknown token → confirm (not allow)', async () => {
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    // token is undefined — should require confirmation, not silently allow
    const decision = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1' });
    expect(decision.action).toBe('confirm');
    expect(decision.reason).toContain('cannot determine');
  });

  it('blocklist with unknown token → confirm (not allow)', async () => {
    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    // Disable allowlist policy to test blocklist in isolation
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const store = getPolicyStore();
    const p = store.getPolicy('user1', 'p-allow')!;
    p.status = 'disabled';
    store.savePolicy(p);

    const decision = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1' });
    expect(decision.action).toBe('confirm');
    expect(decision.reason).toContain('cannot determine');
  });
});

describe('P0: Corrupt store → fail-closed', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
  });

  afterEach(() => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

  it('blocks all when policy file is corrupt', async () => {
    const { mkdirSync: mkd, writeFileSync: wfs } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const hashedId = createHash('sha256').update('user1').digest('hex').slice(0, 16);
    const dir = join(TEST_HOME, '.openclawnch', 'policies', hashedId);
    mkd(dir, { recursive: true });
    wfs(join(dir, 'policies.json'), '{{{CORRUPT');

    const { resetPolicyStore, getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
    const store = getPolicyStore();
    // listPolicies should trigger corruption detection
    store.listPolicies('user1');
    expect(store.isCorrupted('user1')).toBe(true);

    const { evaluatePolicies } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const decision = evaluatePolicies({ toolName: 'defi_swap', userId: 'user1', amountUsd: 1 });
    expect(decision.action).toBe('block');
    expect(decision.reason).toContain('corrupted');
  });
});

describe('P0: Confirmation nonce system', () => {
  beforeEach(async () => {
    const { resetPolicyConfirmationStore } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    resetPolicyConfirmationStore();
  });

  it('creates and consumes a valid nonce', async () => {
    const { getPolicyConfirmationStore } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyConfirmationStore();
    const nonce = store.create('user1', 'defi_swap');
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBeGreaterThan(0);
    // Consume should succeed
    expect(store.consume(nonce, 'user1', 'defi_swap')).toBe(true);
    // Second consume should fail (already consumed)
    expect(store.consume(nonce, 'user1', 'defi_swap')).toBe(false);
  });

  it('rejects nonce with wrong user', async () => {
    const { getPolicyConfirmationStore } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyConfirmationStore();
    const nonce = store.create('user1', 'defi_swap');
    expect(store.consume(nonce, 'user2', 'defi_swap')).toBe(false);
  });

  it('rejects nonce with wrong tool', async () => {
    const { getPolicyConfirmationStore } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyConfirmationStore();
    const nonce = store.create('user1', 'defi_swap');
    expect(store.consume(nonce, 'user1', 'transfer')).toBe(false);
  });

  it('rejects unknown nonce', async () => {
    const { getPolicyConfirmationStore } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    const store = getPolicyConfirmationStore();
    expect(store.consume('nonexistent-nonce', 'user1', 'defi_swap')).toBe(false);
  });
});

describe('P1: parseRule validation', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
  });

  afterEach(() => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

  it('rejects spending_limit without maxAmountUsd', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const tool = createPolicyManageTool();
    const result = await tool.execute('tc1', {
      action: 'propose', name: 'test', description: 'test',
      rules: [{ type: 'spending_limit', period: 'daily' }], // missing maxAmountUsd
      scope: { type: 'all_write' },
    }, { senderId: 'user1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('maxAmountUsd');
  });

  it('rejects spending_limit without period', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const tool = createPolicyManageTool();
    const result = await tool.execute('tc1', {
      action: 'propose', name: 'test', description: 'test',
      rules: [{ type: 'spending_limit', maxAmountUsd: 500 }], // missing period
      scope: { type: 'all_write' },
    }, { senderId: 'user1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('period');
  });

  it('rejects unknown rule type', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const tool = createPolicyManageTool();
    const result = await tool.execute('tc1', {
      action: 'propose', name: 'test', description: 'test',
      rules: [{ type: 'banana_rule' }],
      scope: { type: 'all_write' },
    }, { senderId: 'user1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown rule type');
  });

  it('rejects allowlist without values', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const tool = createPolicyManageTool();
    const result = await tool.execute('tc1', {
      action: 'propose', name: 'test', description: 'test',
      rules: [{ type: 'allowlist', field: 'tokens' }], // missing values
      scope: { type: 'all_write' },
    }, { senderId: 'user1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('values');
  });

  it('rejects time_window without hours or days', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const tool = createPolicyManageTool();
    const result = await tool.execute('tc1', {
      action: 'propose', name: 'test', description: 'test',
      rules: [{ type: 'time_window' }], // neither allowedHours nor allowedDays
      scope: { type: 'all_write' },
    }, { senderId: 'user1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('allowedHours or allowedDays');
  });

  it('rejects time_window with invalid hours', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const tool = createPolicyManageTool();
    const result = await tool.execute('tc1', {
      action: 'propose', name: 'test', description: 'test',
      rules: [{ type: 'time_window', allowedHours: { start: -1, end: 25 } }],
      scope: { type: 'all_write' },
    }, { senderId: 'user1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('0-23');
  });

  it('rejects time_window with invalid days', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const tool = createPolicyManageTool();
    const result = await tool.execute('tc1', {
      action: 'propose', name: 'test', description: 'test',
      rules: [{ type: 'time_window', allowedDays: [0, 7] }], // 7 is invalid
      scope: { type: 'all_write' },
    }, { senderId: 'user1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('0 (Sun) - 6 (Sat)');
  });
});

describe('P1: handleEnable draft guard', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
  });

  afterEach(() => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

  it('enable rejects unconfirmed policy (tool)', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const tool = createPolicyManageTool();
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'test', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 100 }],
      scope: { type: 'all_write' },
      status: 'disabled', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
      // no confirmedAt
    });
    const result = await tool.execute('tc1', {
      action: 'enable', policyId: 'p1',
    }, { senderId: 'user1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('never been confirmed');
  });

  it('confirm sets confirmedAt', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const tool = createPolicyManageTool();
    // Propose
    const proposeResult = await tool.execute('tc1', {
      action: 'propose', name: 'test', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 100 }],
      scope: { type: 'all_write' },
    }, { senderId: 'user1' });
    const policyId = JSON.parse(proposeResult.content[0].text).policyId;
    // Confirm
    await tool.execute('tc2', { action: 'confirm', policyId }, { senderId: 'user1' });
    const store = getPolicyStore();
    const policy = store.getPolicy('user1', policyId)!;
    expect(policy.confirmedAt).toBeDefined();
    expect(policy.confirmedAt).toBeGreaterThan(0);
  });
});

describe('P1: userId sanitization — collision resistance', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
  });

  afterEach(() => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

  it('user@1 and user_1 have separate policy stores', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const store = getPolicyStore();
    store.savePolicy({
      id: 'p1', name: 'policy-a', description: 'for user@1',
      rules: [{ type: 'max_amount', maxAmountUsd: 100 }],
      scope: { type: 'all_write' },
      status: 'active', confirmedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), userId: 'user@1',
    });
    store.savePolicy({
      id: 'p2', name: 'policy-b', description: 'for user_1',
      rules: [{ type: 'max_amount', maxAmountUsd: 200 }],
      scope: { type: 'all_write' },
      status: 'active', confirmedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), userId: 'user_1',
    });
    // Each user should only see their own policy
    expect(store.listPolicies('user@1')).toHaveLength(1);
    expect(store.listPolicies('user@1')[0].name).toBe('policy-a');
    expect(store.listPolicies('user_1')).toHaveLength(1);
    expect(store.listPolicies('user_1')[0].name).toBe('policy-b');
  });
});

describe('P2: Max policy count per user', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
  });

  afterEach(() => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

  it('rejects when exceeding 50 policies', async () => {
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const store = getPolicyStore();
    // Create 50 policies
    for (let i = 0; i < 50; i++) {
      store.savePolicy({
        id: `p${i}`, name: `policy-${i}`, description: 'test',
        rules: [{ type: 'max_amount', maxAmountUsd: 100 }],
        scope: { type: 'all_write' },
        status: 'active', confirmedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
      });
    }
    expect(store.listPolicies('user1')).toHaveLength(50);
    // 51st should throw
    expect(() => store.savePolicy({
      id: 'p50', name: 'policy-50', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 100 }],
      scope: { type: 'all_write' },
      status: 'active', confirmedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    })).toThrow('Maximum 50');
  });
});

describe('P2: periodToMs validation', () => {
  it('throws on unknown period', async () => {
    const { periodToMs } = await import('../extensions/crypto/src/services/policy-types.js');
    expect(() => periodToMs('biweekly')).toThrow('Unknown period');
  });

  it('accepts known periods', async () => {
    const { periodToMs } = await import('../extensions/crypto/src/services/policy-types.js');
    expect(periodToMs('hourly')).toBe(3_600_000);
    expect(periodToMs('daily')).toBe(86_400_000);
    expect(periodToMs('weekly')).toBe(604_800_000);
    expect(periodToMs('monthly')).toBe(30 * 86_400_000);
  });
});

describe('P1: handleRevise duplicate name check', () => {
  beforeEach(async () => {
    process.env.HOME = TEST_HOME;
    const { resetPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    resetPolicyStore();
  });

  afterEach(() => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

  it('rejects rename to existing policy name', async () => {
    const { createPolicyManageTool } = await import('../extensions/crypto/src/tools/policy-manage.js');
    const { getPolicyStore } = await import('../extensions/crypto/src/services/policy-store.js');
    const tool = createPolicyManageTool();
    const store = getPolicyStore();
    // Create two policies
    store.savePolicy({
      id: 'p1', name: 'policy-A', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 100 }],
      scope: { type: 'all_write' },
      status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    store.savePolicy({
      id: 'p2', name: 'policy-B', description: 'test',
      rules: [{ type: 'max_amount', maxAmountUsd: 200 }],
      scope: { type: 'all_write' },
      status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), userId: 'user1',
    });
    // Try to rename p2 to 'policy-A'
    const result = await tool.execute('tc1', {
      action: 'revise', policyId: 'p2', name: 'policy-A',
    }, { senderId: 'user1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });
});

describe('extractPolicyUserId', () => {
  it('returns senderId when available', async () => {
    const { extractPolicyUserId } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    expect(extractPolicyUserId({ senderId: 'alice' })).toBe('alice');
  });

  it('falls back to from', async () => {
    const { extractPolicyUserId } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    expect(extractPolicyUserId({ from: 'bob' })).toBe('bob');
  });

  it('falls back to metadata.senderId', async () => {
    const { extractPolicyUserId } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    expect(extractPolicyUserId({ metadata: { senderId: 'charlie' } })).toBe('charlie');
  });

  it('defaults to owner', async () => {
    const { extractPolicyUserId } = await import('../extensions/crypto/src/services/policy-evaluator.js');
    expect(extractPolicyUserId({})).toBe('owner');
    expect(extractPolicyUserId(undefined)).toBe('owner');
  });
});

// ─── Plugin Registration ────────────────────────────────────────────────

describe('V6 Plugin Registration', () => {
  it('registers 45 tools including policy_manage', { timeout: 15000 }, async () => {
    const tools: any[] = [];
    const mockApi = {
      registerTool: (t: any) => tools.push(t),
      registerCommand: () => {},
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    const { default: plugin } = await import('../extensions/crypto/index.js');
    plugin.register(mockApi as any);
    expect(tools).toHaveLength(45);
    expect(tools.find(t => t.name === 'policy_manage')).toBeDefined();
  });

  it('registers 108 commands including /policies', { timeout: 15000 }, async () => {
    const commands: any[] = [];
    const mockApi = {
      registerTool: () => {},
      registerCommand: (c: any) => commands.push(c),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    const { default: plugin } = await import('../extensions/crypto/index.js');
    plugin.register(mockApi as any);
    expect(commands).toHaveLength(108);
    expect(commands.find(c => c.name === 'policies')).toBeDefined();
  });
});
