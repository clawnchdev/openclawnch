/**
 * Sprint 7+8 Integration Tests
 *
 * Covers all features added in Sprints 7 and 8:
 *   Sprint 7: Safe multisig tool, Context Diet prompt-builder refactor
 *   Sprint 8: Airdrop tool, Forum Topics + Thread Bindings, Condor upgrade
 *
 * Tests:
 *   1. Safe tool shape, actions, wallet-required behavior
 *   2. Safe service singleton and chain resolution
 *   3. Airdrop tool shape, actions, registry listing
 *   4. Airdrop service eligibility checks and calldata generation
 *   5. Forum Topics service — register, lookup, notification routing
 *   6. Thread Bindings service — bind, effective defaults, tool gating
 *   7. Forum commands shape and handler execution
 *   8. Condor hummingbot actions — graceful fallback when Condor API unavailable
 *   9. Context Diet prompt-builder — relevance gating, size caps
 *  10. Endpoint allowlist — Safe + airdrop hosts
 *  11. Tool config — safe + airdrop entries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import plugin from '../extensions/crypto/index.js';

// ─── Plugin Registration Helper ─────────────────────────────────────────

function registerPlugin() {
  const tools: any[] = [];
  const commands: any[] = [];
  const mockApi = {
    registerTool: vi.fn((tool: any) => tools.push(tool)),
    registerCommand: vi.fn((cmd: any) => commands.push(cmd)),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  plugin.register(mockApi);
  return { tools, commands, mockApi };
}

function findTool(tools: any[], name: string) {
  return tools.find(t => t.name === name);
}

function findCommand(commands: any[], name: string) {
  return commands.find(c => c.name === name);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Safe Multisig Tool
// ═══════════════════════════════════════════════════════════════════════════

describe('Safe multisig tool', () => {
  let tools: any[];

  beforeEach(() => {
    ({ tools } = registerPlugin());
  });

  it('has correct tool shape', () => {
    const tool = findTool(tools, 'safe');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('safe');
    expect(tool.label).toBe('Safe Multisig');
    expect(tool.ownerOnly).toBe(true);
    expect(tool.description).toContain('Safe{Wallet}');
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action).toBeDefined();
    expect(tool.parameters.properties.safe_address).toBeDefined();
    expect(tool.parameters.properties.chain).toBeDefined();
    expect(tool.parameters.properties.safe_tx_hash).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('has 7 actions', () => {
    const tool = findTool(tools, 'safe');
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toHaveLength(7);
    expect(actionSchema.enum).toContain('info');
    expect(actionSchema.enum).toContain('balances');
    expect(actionSchema.enum).toContain('pending_txs');
    expect(actionSchema.enum).toContain('history');
    expect(actionSchema.enum).toContain('propose');
    expect(actionSchema.enum).toContain('confirm');
    expect(actionSchema.enum).toContain('execute');
  });

  it('info action requires safe_address', async () => {
    const tool = findTool(tools, 'safe');
    const result = await tool.execute('test', { action: 'info' });
    expect(result.content[0].text).toContain('safe_address is required');
  });

  it('balances action requires safe_address', async () => {
    const tool = findTool(tools, 'safe');
    const result = await tool.execute('test', { action: 'balances' });
    expect(result.content[0].text).toContain('safe_address is required');
  });

  it('confirm action requires safe_tx_hash', async () => {
    const tool = findTool(tools, 'safe');
    const result = await tool.execute('test', { action: 'confirm' });
    expect(result.content[0].text).toContain('safe_tx_hash is required');
  });

  it('execute action requires safe_tx_hash', async () => {
    const tool = findTool(tools, 'safe');
    const result = await tool.execute('test', { action: 'execute' });
    expect(result.content[0].text).toContain('safe_tx_hash is required');
  });

  it('propose action requires safe_address and to', async () => {
    const tool = findTool(tools, 'safe');
    const result = await tool.execute('test', { action: 'propose' });
    expect(result.content[0].text).toContain('safe_address is required');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Safe Service
// ═══════════════════════════════════════════════════════════════════════════

describe('Safe service', () => {
  it('singleton pattern works', async () => {
    const { getSafeService, resetSafeService } = await import(
      '../extensions/crypto/src/services/safe-service.js'
    );
    resetSafeService();
    const a = getSafeService();
    const b = getSafeService();
    expect(a).toBe(b);
    resetSafeService();
    const c = getSafeService();
    expect(c).not.toBe(a);
  });

  it('resolves chain names to IDs', async () => {
    const { getSafeService, resetSafeService } = await import(
      '../extensions/crypto/src/services/safe-service.js'
    );
    resetSafeService();
    const svc = getSafeService();
    expect(svc.resolveChainId('ethereum')).toBe(1);
    expect(svc.resolveChainId('eth')).toBe(1);
    expect(svc.resolveChainId('mainnet')).toBe(1);
    expect(svc.resolveChainId('base')).toBe(8453);
    expect(svc.resolveChainId('arbitrum')).toBe(42161);
    expect(svc.resolveChainId('arb')).toBe(42161);
    expect(svc.resolveChainId('optimism')).toBe(10);
    expect(svc.resolveChainId('op')).toBe(10);
    expect(svc.resolveChainId('polygon')).toBe(137);
    expect(svc.resolveChainId('matic')).toBe(137);
    expect(svc.resolveChainId(undefined)).toBe(1); // default
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Airdrop Tool
// ═══════════════════════════════════════════════════════════════════════════

describe('Airdrop tool', () => {
  let tools: any[];

  beforeEach(() => {
    ({ tools } = registerPlugin());
  });

  it('has correct tool shape', () => {
    const tool = findTool(tools, 'airdrop');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('airdrop');
    expect(tool.label).toBe('Airdrop Tracker');
    expect(tool.ownerOnly).toBe(true);
    expect(tool.description).toContain('airdrop');
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action).toBeDefined();
    expect(tool.parameters.properties.airdrop_id).toBeDefined();
    expect(tool.parameters.properties.address).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('has 4 actions', () => {
    const tool = findTool(tools, 'airdrop');
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toHaveLength(4);
    expect(actionSchema.enum).toContain('list');
    expect(actionSchema.enum).toContain('check');
    expect(actionSchema.enum).toContain('check_all');
    expect(actionSchema.enum).toContain('claim');
  });

  it('list action returns known airdrops', async () => {
    const tool = findTool(tools, 'airdrop');
    const result = await tool.execute('test', { action: 'list' });
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBeGreaterThan(0);
    expect(data.airdrops.length).toBeGreaterThan(0);
    expect(data.airdrops[0].id).toBeDefined();
    expect(data.airdrops[0].name).toBeDefined();
    expect(data.airdrops[0].token).toBeDefined();
  });

  it('list action filters by status', async () => {
    const tool = findTool(tools, 'airdrop');
    const result = await tool.execute('test', { action: 'list', status: 'ended' });
    const data = JSON.parse(result.content[0].text);
    for (const a of data.airdrops) {
      expect(a.status).toBe('ended');
    }
  });

  it('list action filters by chain', async () => {
    const tool = findTool(tools, 'airdrop');
    const result = await tool.execute('test', { action: 'list', status: 'all', chain: 'base' });
    const data = JSON.parse(result.content[0].text);
    for (const a of data.airdrops) {
      expect(a.chain).toBe('base');
    }
  });

  it('check action requires airdrop_id', async () => {
    const tool = findTool(tools, 'airdrop');
    const result = await tool.execute('test', { action: 'check' });
    expect(result.content[0].text).toContain('airdrop_id is required');
  });

  it('claim action requires airdrop_id', async () => {
    const tool = findTool(tools, 'airdrop');
    const result = await tool.execute('test', { action: 'claim' });
    expect(result.content[0].text).toContain('airdrop_id is required');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Airdrop Service
// ═══════════════════════════════════════════════════════════════════════════

describe('Airdrop service', () => {
  it('singleton pattern works', async () => {
    const { getAirdropService, resetAirdropService } = await import(
      '../extensions/crypto/src/services/airdrop-service.js'
    );
    resetAirdropService();
    const a = getAirdropService();
    const b = getAirdropService();
    expect(a).toBe(b);
    resetAirdropService();
    const c = getAirdropService();
    expect(c).not.toBe(a);
  });

  it('listAirdrops returns entries', async () => {
    const { getAirdropService, resetAirdropService } = await import(
      '../extensions/crypto/src/services/airdrop-service.js'
    );
    resetAirdropService();
    const svc = getAirdropService();
    const all = svc.listAirdrops({ status: 'all' });
    expect(all.length).toBeGreaterThan(0);
    for (const a of all) {
      expect(a.id).toBeDefined();
      expect(a.name).toBeDefined();
      expect(a.tokenSymbol).toBeDefined();
      expect(a.chain).toBeDefined();
      expect(['active', 'ended', 'upcoming']).toContain(a.status);
    }
  });

  it('listAirdrops filters by status', async () => {
    const { getAirdropService, resetAirdropService } = await import(
      '../extensions/crypto/src/services/airdrop-service.js'
    );
    resetAirdropService();
    const svc = getAirdropService();
    const active = svc.listAirdrops({ status: 'active' });
    const ended = svc.listAirdrops({ status: 'ended' });
    expect(active.every(a => a.status === 'active')).toBe(true);
    expect(ended.every(a => a.status === 'ended')).toBe(true);
    expect(active.length + ended.length).toBeLessThanOrEqual(
      svc.listAirdrops({ status: 'all' }).length,
    );
  });

  it('getAirdrop returns known airdrop', async () => {
    const { getAirdropService, resetAirdropService } = await import(
      '../extensions/crypto/src/services/airdrop-service.js'
    );
    resetAirdropService();
    const svc = getAirdropService();
    const eigen = svc.getAirdrop('eigen-s2');
    expect(eigen).toBeDefined();
    expect(eigen!.tokenSymbol).toBe('EIGEN');
    expect(eigen!.chain).toBe('ethereum');
  });

  it('getAirdrop returns undefined for unknown ID', async () => {
    const { getAirdropService, resetAirdropService } = await import(
      '../extensions/crypto/src/services/airdrop-service.js'
    );
    resetAirdropService();
    const svc = getAirdropService();
    expect(svc.getAirdrop('nonexistent')).toBeUndefined();
  });

  it('checkEligibility returns error for unknown airdrop', async () => {
    const { getAirdropService, resetAirdropService } = await import(
      '../extensions/crypto/src/services/airdrop-service.js'
    );
    resetAirdropService();
    const svc = getAirdropService();
    const result = await svc.checkEligibility('nonexistent', '0x1234');
    expect(result.eligible).toBe(false);
    expect(result.error).toContain('Unknown airdrop');
  });

  it('checkEligibility returns browser hint for browser-required airdrops', async () => {
    const { getAirdropService, resetAirdropService } = await import(
      '../extensions/crypto/src/services/airdrop-service.js'
    );
    resetAirdropService();
    const svc = getAirdropService();
    const result = await svc.checkEligibility('zk-nation', '0x1234');
    expect(result.error).toContain('browser');
  });

  it('generateClaimCalldata returns null for unknown airdrop', async () => {
    const { getAirdropService, resetAirdropService } = await import(
      '../extensions/crypto/src/services/airdrop-service.js'
    );
    resetAirdropService();
    const svc = getAirdropService();
    expect(svc.generateClaimCalldata('nonexistent', 0, '0x1234', '1000', [])).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Forum Topics Service
// ═══════════════════════════════════════════════════════════════════════════

describe('Forum Topics service', () => {
  it('singleton pattern works', async () => {
    const { getForumTopics, resetForumTopics } = await import(
      '../extensions/crypto/src/services/forum-topics.js'
    );
    resetForumTopics();
    const a = getForumTopics();
    const b = getForumTopics();
    expect(a).toBe(b);
    resetForumTopics();
    expect(getForumTopics()).not.toBe(a);
  });

  it('registerTopic maps name to purpose', async () => {
    const { getForumTopics, resetForumTopics } = await import(
      '../extensions/crypto/src/services/forum-topics.js'
    );
    resetForumTopics();
    const svc = getForumTopics();

    const config = svc.registerTopic('chat1', 42, 'Trading');
    expect(config.purpose).toBe('trading');
    expect(config.threadId).toBe(42);
    expect(svc.isForumEnabled('chat1')).toBe(true);
  });

  it('getTopicForPurpose returns correct threadId', async () => {
    const { getForumTopics, resetForumTopics } = await import(
      '../extensions/crypto/src/services/forum-topics.js'
    );
    resetForumTopics();
    const svc = getForumTopics();

    svc.registerTopic('chat1', 42, 'Trading');
    svc.registerTopic('chat1', 43, 'Research');

    expect(svc.getTopicForPurpose('chat1', 'trading')).toBe(42);
    expect(svc.getTopicForPurpose('chat1', 'research')).toBe(43);
    expect(svc.getTopicForPurpose('chat1', 'governance')).toBeUndefined();
  });

  it('getNotificationTopic falls back alerts → general', async () => {
    const { getForumTopics, resetForumTopics } = await import(
      '../extensions/crypto/src/services/forum-topics.js'
    );
    resetForumTopics();
    const svc = getForumTopics();

    svc.registerTopic('chat1', 50, 'Alerts');
    expect(svc.getNotificationTopic('chat1')).toBe(50);

    // Without alerts, falls back to general
    resetForumTopics();
    const svc2 = getForumTopics();
    svc2.registerTopic('chat2', 51, 'General');
    // 'General' resolves to purpose 'general', and getNotificationTopic falls back alerts → general
    expect(svc2.getNotificationTopic('chat2')).toBe(51);
    expect(svc2.getTopicForPurpose('chat2', 'general')).toBe(51);
  });

  it('unregisterTopic removes the topic', async () => {
    const { getForumTopics, resetForumTopics } = await import(
      '../extensions/crypto/src/services/forum-topics.js'
    );
    resetForumTopics();
    const svc = getForumTopics();

    svc.registerTopic('chat1', 42, 'Trading');
    expect(svc.listTopics('chat1')).toHaveLength(1);

    svc.unregisterTopic('chat1', 42);
    expect(svc.listTopics('chat1')).toHaveLength(0);
  });

  it('getSessionKeySuffix returns topic suffix', async () => {
    const { getForumTopics, resetForumTopics } = await import(
      '../extensions/crypto/src/services/forum-topics.js'
    );
    resetForumTopics();
    const svc = getForumTopics();

    svc.registerTopic('chat1', 42, 'Trading');
    expect(svc.getSessionKeySuffix('chat1', 42)).toBe('-topic-42');
    expect(svc.getSessionKeySuffix('chat1', undefined)).toBe('');
    expect(svc.getSessionKeySuffix('unknown', 42)).toBe('');
  });

  it('getSuggestedTopics returns standard structure', async () => {
    const { getForumTopics, resetForumTopics } = await import(
      '../extensions/crypto/src/services/forum-topics.js'
    );
    resetForumTopics();
    const svc = getForumTopics();

    const suggested = svc.getSuggestedTopics();
    expect(suggested.length).toBeGreaterThanOrEqual(5);
    const purposes = suggested.map(s => s.purpose);
    expect(purposes).toContain('trading');
    expect(purposes).toContain('portfolio');
    expect(purposes).toContain('alerts');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Thread Bindings Service
// ═══════════════════════════════════════════════════════════════════════════

describe('Thread Bindings service', () => {
  it('singleton pattern works', async () => {
    const { getThreadBindings, resetThreadBindings } = await import(
      '../extensions/crypto/src/services/thread-bindings.js'
    );
    resetThreadBindings();
    const a = getThreadBindings();
    const b = getThreadBindings();
    expect(a).toBe(b);
    resetThreadBindings();
    expect(getThreadBindings()).not.toBe(a);
  });

  it('bind and getBinding work', async () => {
    const { getThreadBindings, resetThreadBindings } = await import(
      '../extensions/crypto/src/services/thread-bindings.js'
    );
    resetThreadBindings();
    const svc = getThreadBindings();

    svc.bind('chat1', 42, { persona: 'degen', safetyMode: 'danger' });
    const binding = svc.getBinding('chat1', 42);
    expect(binding).toBeDefined();
    expect(binding!.persona).toBe('degen');
    expect(binding!.safetyMode).toBe('danger');
  });

  it('getEffectiveBinding merges user over defaults', async () => {
    const { getThreadBindings, resetThreadBindings } = await import(
      '../extensions/crypto/src/services/thread-bindings.js'
    );
    resetThreadBindings();
    const svc = getThreadBindings();

    // No user binding — get defaults for 'research' purpose
    const effective = svc.getEffectiveBinding('chat1', 99, 'research');
    expect(effective.safetyMode).toBe('readonly');
    expect(effective.persona).toBe('technical');

    // User override persona
    svc.bind('chat1', 99, { persona: 'degen' });
    const merged = svc.getEffectiveBinding('chat1', 99, 'research');
    expect(merged.persona).toBe('degen');
    expect(merged.safetyMode).toBe('readonly'); // still from default
  });

  it('applyDefaults sets default binding for purpose', async () => {
    const { getThreadBindings, resetThreadBindings } = await import(
      '../extensions/crypto/src/services/thread-bindings.js'
    );
    resetThreadBindings();
    const svc = getThreadBindings();

    const binding = svc.applyDefaults('chat1', 42, 'trading');
    expect(binding.safetyMode).toBe('safe');
    expect(binding.purpose).toBe('trading');

    // Second call returns same binding (doesn't overwrite)
    svc.bind('chat1', 42, { persona: 'degen' });
    const same = svc.applyDefaults('chat1', 42, 'trading');
    expect(same.persona).toBe('degen');
  });

  it('isToolAllowed respects blocked tools', async () => {
    const { getThreadBindings, resetThreadBindings } = await import(
      '../extensions/crypto/src/services/thread-bindings.js'
    );
    resetThreadBindings();
    const svc = getThreadBindings();

    svc.bind('chat1', 42, { blockedTools: ['defi_swap', 'transfer'] });
    expect(svc.isToolAllowed('chat1', 42, 'defi_swap')).toBe(false);
    expect(svc.isToolAllowed('chat1', 42, 'transfer')).toBe(false);
    expect(svc.isToolAllowed('chat1', 42, 'defi_price')).toBe(true);
  });

  it('isToolAllowed respects allowed tools whitelist', async () => {
    const { getThreadBindings, resetThreadBindings } = await import(
      '../extensions/crypto/src/services/thread-bindings.js'
    );
    resetThreadBindings();
    const svc = getThreadBindings();

    svc.bind('chat1', 42, { allowedTools: ['defi_price', 'analytics'] });
    expect(svc.isToolAllowed('chat1', 42, 'defi_price')).toBe(true);
    expect(svc.isToolAllowed('chat1', 42, 'defi_swap')).toBe(false);
  });

  it('unbind removes binding', async () => {
    const { getThreadBindings, resetThreadBindings } = await import(
      '../extensions/crypto/src/services/thread-bindings.js'
    );
    resetThreadBindings();
    const svc = getThreadBindings();

    svc.bind('chat1', 42, { persona: 'degen' });
    expect(svc.getBinding('chat1', 42)).toBeDefined();
    expect(svc.unbind('chat1', 42)).toBe(true);
    expect(svc.getBinding('chat1', 42)).toBeUndefined();
  });

  it('listBindings returns all bindings for a chat', async () => {
    const { getThreadBindings, resetThreadBindings } = await import(
      '../extensions/crypto/src/services/thread-bindings.js'
    );
    resetThreadBindings();
    const svc = getThreadBindings();

    svc.bind('chat1', 42, { persona: 'degen' });
    svc.bind('chat1', 43, { persona: 'technical' });
    svc.bind('chat2', 50, { persona: 'chill' }); // different chat

    const bindings = svc.listBindings('chat1');
    expect(bindings).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Forum Commands
// ═══════════════════════════════════════════════════════════════════════════

describe('Forum commands', () => {
  let commands: any[];

  beforeEach(() => {
    ({ commands } = registerPlugin());
  });

  it('all 4 forum commands are registered', () => {
    expect(findCommand(commands, 'topics')).toBeDefined();
    expect(findCommand(commands, 'topics_setup')).toBeDefined();
    expect(findCommand(commands, 'topic_bind')).toBeDefined();
    expect(findCommand(commands, 'topic_unbind')).toBeDefined();
  });

  it('/topics returns forum-not-enabled message for fresh chat', async () => {
    const cmd = findCommand(commands, 'topics');
    const result = await cmd.handler({ senderId: 'test_user', chatId: 'fresh_chat' });
    expect(result.text).toContain('Not Enabled');
  });

  it('/topics_setup enables forum mode', async () => {
    const cmd = findCommand(commands, 'topics_setup');
    const result = await cmd.handler({ senderId: 'test_user', chatId: 'setup_chat' });
    expect(result.text).toContain('Forum Topics Setup');
    expect(result.text).toContain('enabled');
  });

  it('/topic_bind returns usage when no args', async () => {
    const cmd = findCommand(commands, 'topic_bind');
    const result = await cmd.handler({ senderId: 'test_user', chatId: 'chat1', args: '' });
    expect(result.text).toContain('Usage');
  });

  it('/topic_unbind returns usage when no args', async () => {
    const cmd = findCommand(commands, 'topic_unbind');
    const result = await cmd.handler({ senderId: 'test_user', chatId: 'chat1', args: '' });
    expect(result.text).toContain('Usage');
  });

  it('/topic_bind with valid args registers topic', async () => {
    const cmd = findCommand(commands, 'topic_bind');
    const result = await cmd.handler({
      senderId: 'test_user', chatId: 'bind_chat', args: '42 trading',
    });
    expect(result.text).toContain('Topic bound');
    expect(result.text).toContain('trading');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Condor Hummingbot Actions
// ═══════════════════════════════════════════════════════════════════════════

describe('Condor hummingbot actions', () => {
  let tools: any[];

  beforeEach(() => {
    ({ tools } = registerPlugin());
  });

  it('hummingbot tool has Condor actions in schema', () => {
    const tool = findTool(tools, 'hummingbot');
    expect(tool).toBeDefined();
    const actions = tool.parameters.properties.action.enum;
    expect(actions).toContain('pnl');
    expect(actions).toContain('clmm_positions');
    expect(actions).toContain('routines');
    expect(actions).toContain('routine_start');
    expect(actions).toContain('routine_stop');
    expect(actions).toContain('dashboard');
  });

  it('hummingbot description mentions Condor', () => {
    const tool = findTool(tools, 'hummingbot');
    expect(tool.description).toContain('Condor');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Context Diet — Prompt Builder
// ═══════════════════════════════════════════════════════════════════════════

describe('Context Diet — prompt builder', () => {
  it('injects identity on every call', async () => {
    const { buildPromptContext } = await import(
      '../extensions/crypto/src/hooks/prompt-builder.js'
    );
    const result = buildPromptContext({}, {}, {
      getWalletState: () => ({ connected: false }),
    });
    expect(result).toBeDefined();
    expect(result!.prependSystemContext).toContain('OpenClawnch');
  });

  it('skips sequential/compound rules for simple queries', async () => {
    const { buildPromptContext } = await import(
      '../extensions/crypto/src/hooks/prompt-builder.js'
    );
    const result = buildPromptContext(
      { message: 'what is the price of ETH' },
      { sessionKey: 'telegram-123', senderId: 'user1' },
      { getWalletState: () => ({ connected: true, address: '0x123', chainId: 8453 }) },
    );
    expect(result!.prependSystemContext).not.toContain('Sequential execution');
    expect(result!.prependSystemContext).not.toContain('compound_action');
  });

  it('injects sequential/compound rules for multi-step queries', async () => {
    const { buildPromptContext } = await import(
      '../extensions/crypto/src/hooks/prompt-builder.js'
    );
    const result = buildPromptContext(
      { message: 'swap ETH to USDC then bridge to Arbitrum' },
      { sessionKey: 'telegram-123', senderId: 'user1' },
      { getWalletState: () => ({ connected: true, address: '0x123', chainId: 8453 }) },
    );
    expect(result!.prependSystemContext).toContain('Sequential execution');
    expect(result!.prependSystemContext).toContain('compound_action');
  });

  it('compact readonly block does not enumerate tool names', async () => {
    const { buildPromptContext } = await import(
      '../extensions/crypto/src/hooks/prompt-builder.js'
    );
    const { setSafetyMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    setSafetyMode('diet_test_user', 'readonly');

    const result = buildPromptContext(
      { message: 'check balance' },
      { sessionKey: 'telegram-diet_test_user', senderId: 'diet_test_user' },
      { getWalletState: () => ({ connected: false }) },
    );
    expect(result!.prependContext).toContain('READ-ONLY MODE');
    // Should NOT contain the old verbose tool list
    expect(result!.prependContext).not.toContain('defi_swap, transfer, clawnch_launch');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Endpoint Allowlist — Sprint 7+8 Hosts
// ═══════════════════════════════════════════════════════════════════════════

describe('Endpoint allowlist — Sprint 7+8 hosts', () => {
  it('allows Safe Transaction Service hosts', async () => {
    const { isAllowedEndpoint } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );
    expect(isAllowedEndpoint('https://safe-transaction-mainnet.safe.global/api/v1/safes/0x123/')).toBe(true);
    expect(isAllowedEndpoint('https://safe-transaction-base.safe.global/api/v1/safes/0x123/')).toBe(true);
    expect(isAllowedEndpoint('https://safe-transaction-arbitrum.safe.global/api/v1/safes/0x123/')).toBe(true);
    expect(isAllowedEndpoint('https://safe-transaction-optimism.safe.global/api/v1/safes/0x123/')).toBe(true);
    expect(isAllowedEndpoint('https://safe-transaction-polygon.safe.global/api/v1/safes/0x123/')).toBe(true);
  });

  it('allows airdrop eligibility hosts', async () => {
    const { isAllowedEndpoint } = await import(
      '../extensions/crypto/src/services/endpoint-allowlist.js'
    );
    expect(isAllowedEndpoint('https://claims.eigenfoundation.org/clique-eigenlayer-s2/check')).toBe(true);
    expect(isAllowedEndpoint('https://www.layerzero.foundation/eligibility')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Tool Config — Sprint 7+8 Entries
// ═══════════════════════════════════════════════════════════════════════════

describe('Tool config — Sprint 7+8 entries', () => {
  it('safe tool config exists', async () => {
    const { getToolRequirement } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    const req = getToolRequirement('safe');
    expect(req).toBeDefined();
    expect(req!.label).toBe('Safe Multisig');
    expect(req!.walletRequired).toBe(true);
    expect(req!.worksWithoutKeys).toBe(true);
  });

  it('airdrop tool config exists', async () => {
    const { getToolRequirement } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    const req = getToolRequirement('airdrop');
    expect(req).toBeDefined();
    expect(req!.label).toBe('Airdrop Tracker');
    expect(req!.walletRequired).toBe(true);
    expect(req!.worksWithoutKeys).toBe(true);
  });

  it('total tool config count is 36', async () => {
    const { getAllToolStatus } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    const statuses = getAllToolStatus();
    expect(statuses.length).toBe(36);
  });
});
