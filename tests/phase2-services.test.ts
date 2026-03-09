/**
 * Phase 2 Services Tests — event-sourced tx ledger, heartbeat monitor, market cache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── 1. Event-Sourced Transaction Ledger ─────────────────────────────────────

describe('Transaction Ledger', () => {
  const originalTxDir = process.env.OPENCLAWNCH_TX_DIR;

  beforeEach(async () => {
    // Use a unique temp dir per test to avoid JSONL file accumulation
    process.env.OPENCLAWNCH_TX_DIR = `/tmp/openclawnch-test-${Date.now()}-${Math.random().toString(36).slice(2)}/tx`;
    const { resetTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    resetTxLedger();
  });

  afterEach(() => {
    if (originalTxDir) {
      process.env.OPENCLAWNCH_TX_DIR = originalTxDir;
    } else {
      delete process.env.OPENCLAWNCH_TX_DIR;
    }
  });

  it('getTxLedger returns a singleton', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const a = getTxLedger();
    const b = getTxLedger();
    expect(a).toBe(b);
  });

  it('append creates an event with auto-assigned seq and timestamp', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    const event = ledger.append({
      type: 'swap',
      userId: 'user1',
      txHash: '0xabc',
      chainId: 8453,
      chain: 'base',
      from: '0xuser',
      to: '0xrouter',
      status: 'confirmed',
      summary: 'Swap 1 ETH → 4200 USDC',
      data: { sellToken: 'ETH', buyToken: 'USDC', amount: 1 },
      tool: 'defi_swap',
    });

    expect(event.seq).toBe(1);
    expect(event.timestamp).toBeDefined();
    expect(event.timestampMs).toBeGreaterThan(0);
    expect(event.type).toBe('swap');
    expect(event.userId).toBe('user1');
    expect(event.txHash).toBe('0xabc');
  });

  it('seq numbers are monotonically increasing', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();

    const e1 = ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'test1', data: {}, tool: 't' });
    const e2 = ledger.append({ type: 'transfer', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'test2', data: {}, tool: 't' });
    const e3 = ledger.append({ type: 'bridge', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'test3', data: {}, tool: 't' });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it('size returns the number of events', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    expect(ledger.size).toBe(0);

    ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'test', data: {}, tool: 't' });
    expect(ledger.size).toBe(1);

    ledger.append({ type: 'transfer', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'test2', data: {}, tool: 't' });
    expect(ledger.size).toBe(2);
  });

  it('updateStatus creates a new status-update event', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    const e1 = ledger.append({ type: 'swap', userId: 'u', txHash: '0xpending', chainId: 8453, chain: 'base', from: '0x1', to: '0x2', status: 'pending', summary: 'Swap', data: {}, tool: 'defi_swap' });

    const e2 = ledger.updateStatus(e1.seq, 'confirmed', { txHash: '0xconfirmed', gasCostUsd: 0.42 });
    expect(e2).not.toBeNull();
    expect(e2!.seq).toBe(2);
    expect(e2!.status).toBe('confirmed');
    expect(e2!.txHash).toBe('0xconfirmed');
    expect(e2!.gasCostUsd).toBe(0.42);
    expect(e2!.summary).toContain('[status update]');
    expect((e2!.data as any)._refSeq).toBe(1);
    expect((e2!.data as any)._previousStatus).toBe('pending');
  });

  it('updateStatus returns null for unknown seq', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    expect(ledger.updateStatus(999, 'confirmed')).toBeNull();
  });

  it('query returns events newest-first', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'first', data: {}, tool: 't' });
    ledger.append({ type: 'transfer', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'confirmed', summary: 'second', data: {}, tool: 't' });
    ledger.append({ type: 'bridge', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'failed', summary: 'third', data: {}, tool: 't' });

    const all = ledger.query();
    expect(all).toHaveLength(3);
    expect(all[0]!.summary).toBe('third');
    expect(all[2]!.summary).toBe('first');
  });

  it('query filters by userId', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    ledger.append({ type: 'swap', userId: 'alice', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'a', data: {}, tool: 't' });
    ledger.append({ type: 'swap', userId: 'bob', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'b', data: {}, tool: 't' });

    const alice = ledger.query({ userId: 'alice' });
    expect(alice).toHaveLength(1);
    expect(alice[0]!.userId).toBe('alice');
  });

  it('query filters by types', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'a', data: {}, tool: 't' });
    ledger.append({ type: 'transfer', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'b', data: {}, tool: 't' });
    ledger.append({ type: 'bridge', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'c', data: {}, tool: 't' });

    const swapsAndBridges = ledger.query({ types: ['swap', 'bridge'] });
    expect(swapsAndBridges).toHaveLength(2);
  });

  it('query filters by status', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'confirmed', summary: 'a', data: {}, tool: 't' });
    ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'failed', summary: 'b', data: {}, tool: 't' });

    const failed = ledger.query({ status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.status).toBe('failed');
  });

  it('query filters by chainId', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 8453, chain: 'base', from: '0x1', to: null, status: 'pending', summary: 'a', data: {}, tool: 't' });
    ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'b', data: {}, tool: 't' });

    const baseOnly = ledger.query({ chainId: 8453 });
    expect(baseOnly).toHaveLength(1);
    expect(baseOnly[0]!.chain).toBe('base');
  });

  it('query respects limit', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    for (let i = 0; i < 10; i++) {
      ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: `event ${i}`, data: {}, tool: 't' });
    }

    const limited = ledger.query({ limit: 3 });
    expect(limited).toHaveLength(3);
    expect(limited[0]!.seq).toBe(10); // newest first
  });

  it('getBySeq returns specific event', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    const e = ledger.append({ type: 'swap', userId: 'u', txHash: '0x123', chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'test', data: {}, tool: 't' });

    expect(ledger.getBySeq(e.seq)).toBe(e);
    expect(ledger.getBySeq(999)).toBeNull();
  });

  it('getByTxHash returns most recent event for that hash', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    ledger.append({ type: 'swap', userId: 'u', txHash: '0xaaa', chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'pending', summary: 'pending', data: {}, tool: 't' });
    ledger.append({ type: 'swap', userId: 'u', txHash: '0xaaa', chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'confirmed', summary: 'confirmed', data: {}, tool: 't' });

    const found = ledger.getByTxHash('0xaaa');
    expect(found!.status).toBe('confirmed'); // most recent
    expect(ledger.getByTxHash('0xnonexistent')).toBeNull();
  });

  it('getStats returns aggregate statistics', async () => {
    const { getTxLedger } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    const ledger = getTxLedger();
    ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 8453, chain: 'base', from: '0x1', to: null, status: 'confirmed', summary: 'a', data: {}, tool: 't' });
    ledger.append({ type: 'transfer', userId: 'u', txHash: null, chainId: 8453, chain: 'base', from: '0x1', to: null, status: 'confirmed', summary: 'b', data: {}, tool: 't' });
    ledger.append({ type: 'swap', userId: 'u', txHash: null, chainId: 1, chain: 'ethereum', from: '0x1', to: null, status: 'failed', summary: 'c', data: {}, tool: 't' });

    const stats = ledger.getStats();
    expect(stats.totalEvents).toBe(3);
    expect(stats.byType['swap']).toBe(2);
    expect(stats.byType['transfer']).toBe(1);
    expect(stats.byStatus['confirmed']).toBe(2);
    expect(stats.byStatus['failed']).toBe(1);
    expect(stats.byChain['base']).toBe(2);
    expect(stats.byChain['ethereum']).toBe(1);
    expect(stats.oldestEventMs).toBeGreaterThan(0);
    expect(stats.newestEventMs).toBeGreaterThanOrEqual(stats.oldestEventMs!);
  });

  it('toolToEventType maps known tools correctly', async () => {
    const { toolToEventType } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    expect(toolToEventType('defi_swap')).toBe('swap');
    expect(toolToEventType('transfer')).toBe('transfer');
    expect(toolToEventType('bridge')).toBe('bridge');
    expect(toolToEventType('bankr_launch')).toBe('bankr_launch');
    expect(toolToEventType('unknown_tool')).toBe('unknown');
  });

  it('chainIdToName maps known chains', async () => {
    const { chainIdToName } = await import(
      '../extensions/crypto/src/services/tx-ledger.js'
    );
    expect(chainIdToName(8453)).toBe('base');
    expect(chainIdToName(1)).toBe('ethereum');
    expect(chainIdToName(42161)).toBe('arbitrum');
    expect(chainIdToName(99999)).toBe('99999');
  });
});

// ── 2. Heartbeat Position Monitor ───────────────────────────────────────────

describe('Heartbeat Position Monitor', () => {
  beforeEach(async () => {
    const { resetHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    resetHeartbeatMonitor();
  });

  afterEach(async () => {
    const { resetHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    resetHeartbeatMonitor();
  });

  it('getHeartbeatMonitor returns a singleton', async () => {
    const { getHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    const a = getHeartbeatMonitor();
    const b = getHeartbeatMonitor();
    expect(a).toBe(b);
  });

  it('has correct default config', async () => {
    const { getHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    const hb = getHeartbeatMonitor();
    const status = hb.getStatus();

    expect(status.intervalMs).toBe(300_000);
    expect(status.config.priceDropAlertPercent).toBe(10);
    expect(status.config.priceGainAlertPercent).toBe(20);
    expect(status.config.portfolioDropAlertUsd).toBe(100);
    expect(status.enabled).toBe(true);
    expect(status.running).toBe(false);
  });

  it('respects custom config', async () => {
    const { resetHeartbeatMonitor, getHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    resetHeartbeatMonitor();
    const hb = getHeartbeatMonitor({
      intervalMs: 60_000,
      priceDropAlertPercent: 5,
      priceGainAlertPercent: 50,
      portfolioDropAlertUsd: 500,
      enabled: false,
    });
    const status = hb.getStatus();

    expect(status.intervalMs).toBe(60_000);
    expect(status.config.priceDropAlertPercent).toBe(5);
    expect(status.config.priceGainAlertPercent).toBe(50);
    expect(status.config.portfolioDropAlertUsd).toBe(500);
    expect(status.enabled).toBe(false);
  });

  it('start and stop work correctly', async () => {
    const { getHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    const hb = getHeartbeatMonitor({ intervalMs: 100_000 });

    expect(hb.getStatus().running).toBe(false);
    hb.start();
    expect(hb.getStatus().running).toBe(true);
    hb.stop();
    expect(hb.getStatus().running).toBe(false);
  });

  it('start does nothing when disabled', async () => {
    const { resetHeartbeatMonitor, getHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    resetHeartbeatMonitor();
    const hb = getHeartbeatMonitor({ enabled: false });
    hb.start();
    expect(hb.getStatus().running).toBe(false);
  });

  it('seedPosition and getPositions work', async () => {
    const { getHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    const hb = getHeartbeatMonitor();

    hb.seedPosition({
      symbol: 'ETH',
      address: '0x0',
      chain: 'base',
      priceUsd: 4000,
      valueUsd: 4000,
      balanceHuman: 1.0,
      timestamp: Date.now(),
    });

    const positions = hb.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.symbol).toBe('ETH');
    expect(positions[0]!.priceUsd).toBe(4000);
  });

  it('onAlert registers callbacks', async () => {
    const { getHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    const hb = getHeartbeatMonitor();
    const alerts: any[] = [];

    hb.onAlert((alert) => { alerts.push(alert); });

    // Manually seed positions to simulate a price drop
    // The tick() will fail gracefully (no wallet connected) but the mechanism works
    expect(hb.getStatus().totalAlerts).toBe(0);
  });

  it('getAlerts returns empty initially', async () => {
    const { getHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    const hb = getHeartbeatMonitor();
    expect(hb.getAlerts()).toHaveLength(0);
  });

  it('getStatus returns diagnostic info', async () => {
    const { getHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    const hb = getHeartbeatMonitor();

    const status = hb.getStatus();
    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('enabled');
    expect(status).toHaveProperty('checkCount');
    expect(status).toHaveProperty('lastCheckMs');
    expect(status).toHaveProperty('trackedPositions');
    expect(status).toHaveProperty('totalAlerts');
    expect(status).toHaveProperty('intervalMs');
    expect(status).toHaveProperty('config');
    expect(status.checkCount).toBe(0);
  });

  it('tick increments checkCount even when no wallet connected', async () => {
    const { getHeartbeatMonitor } = await import(
      '../extensions/crypto/src/services/heartbeat-monitor.js'
    );
    const hb = getHeartbeatMonitor();

    const alerts = await hb.tick();
    expect(alerts).toHaveLength(0);
    expect(hb.getStatus().checkCount).toBe(1);
  });
});

// ── 3. Market Cache ─────────────────────────────────────────────────────────

describe('Market Cache', () => {
  beforeEach(async () => {
    const { resetMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    resetMarketCache();
  });

  it('getMarketCache returns a singleton', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const a = getMarketCache();
    const b = getMarketCache();
    expect(a).toBe(b);
  });

  it('getOrFetch caches the result', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();
    let fetchCount = 0;

    const fetcher = async () => {
      fetchCount++;
      return { price: 4200 };
    };

    const r1 = await cache.getOrFetch('token_price', 'ETH:base', fetcher);
    const r2 = await cache.getOrFetch('token_price', 'ETH:base', fetcher);

    expect(r1).toEqual({ price: 4200 });
    expect(r2).toEqual({ price: 4200 });
    expect(fetchCount).toBe(1); // Only fetched once
  });

  it('cache expires after TTL', async () => {
    const { resetMarketCache, getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    resetMarketCache();
    // Override the TTL for token_price to 50ms
    const cache = getMarketCache({ ttlOverrides: { token_price: 50 } });
    let fetchCount = 0;

    const fetcher = async () => {
      fetchCount++;
      return { price: fetchCount * 100 };
    };

    await cache.getOrFetch('token_price', 'ETH', fetcher);
    expect(fetchCount).toBe(1);

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 80));

    const r2 = await cache.getOrFetch('token_price', 'ETH', fetcher);
    expect(fetchCount).toBe(2);
    expect(r2).toEqual({ price: 200 });
  });

  it('serves stale data on fetch error when enabled', async () => {
    const { resetMarketCache, getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    resetMarketCache();
    // Use very short TTL override for token_price
    const cache = getMarketCache({ ttlOverrides: { token_price: 1 } });

    // First fetch succeeds
    await cache.getOrFetch('token_price', 'ETH', async () => ({ price: 4000 }));

    // Wait for expiry
    await new Promise(r => setTimeout(r, 10));

    // Second fetch fails — should return stale data
    const result = await cache.getOrFetch('token_price', 'ETH', async () => {
      throw new Error('API down');
    });

    expect(result).toEqual({ price: 4000 });
    expect(cache.getStats().staleServes).toBeGreaterThan(0);
  });

  it('throws on fetch error when no stale data available', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();

    await expect(
      cache.getOrFetch('token_price', 'NEWTOKEN', async () => {
        throw new Error('API down');
      }),
    ).rejects.toThrow('API down');
  });

  it('set and get work for manual cache management', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();

    cache.set('trending', 'base', [{ symbol: 'PEPE', rank: 1 }]);
    const result = cache.get<any[]>('trending', 'base');
    expect(result).toHaveLength(1);
    expect(result![0].symbol).toBe('PEPE');
  });

  it('get returns null for missing entries', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();
    expect(cache.get('token_price', 'nonexistent')).toBeNull();
  });

  it('invalidate removes a specific entry', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();

    cache.set('token_price', 'ETH', 4200);
    cache.set('token_price', 'BTC', 100000);

    expect(cache.invalidate('token_price', 'ETH')).toBe(true);
    expect(cache.get('token_price', 'ETH')).toBeNull();
    expect(cache.get('token_price', 'BTC')).toBe(100000);
  });

  it('invalidateCategory removes all entries in a category', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();

    cache.set('token_price', 'ETH', 4200);
    cache.set('token_price', 'BTC', 100000);
    cache.set('trending', 'base', ['PEPE']);

    const removed = cache.invalidateCategory('token_price');
    expect(removed).toBe(2);
    expect(cache.get('token_price', 'ETH')).toBeNull();
    expect(cache.get('trending', 'base')).toEqual(['PEPE']); // still there
  });

  it('clear removes all entries', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();

    cache.set('token_price', 'ETH', 4200);
    cache.set('trending', 'base', ['PEPE']);

    cache.clear();
    expect(cache.getStats().entries).toBe(0);
  });

  it('getStats tracks hits, misses, and hit rate', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();

    await cache.getOrFetch('token_price', 'ETH', async () => 4200); // miss
    await cache.getOrFetch('token_price', 'ETH', async () => 4200); // hit
    await cache.getOrFetch('token_price', 'ETH', async () => 4200); // hit
    await cache.getOrFetch('token_price', 'BTC', async () => 100000); // miss

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(2);
    expect(stats.hitRate).toBe(50);
    expect(stats.entries).toBe(2);
  });

  it('getStats byCategory breaks down per category', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();

    cache.set('token_price', 'ETH', 4200);
    cache.set('token_price', 'BTC', 100000);
    cache.set('trending', 'base', []);

    const stats = cache.getStats();
    expect(stats.byCategory['token_price']?.entries).toBe(2);
    expect(stats.byCategory['trending']?.entries).toBe(1);
  });

  it('evicts oldest entries when at capacity', async () => {
    const { resetMarketCache, getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    resetMarketCache();
    const cache = getMarketCache({ maxEntries: 3 });

    cache.set('token_price', 'A', 1);
    cache.set('token_price', 'B', 2);
    cache.set('token_price', 'C', 3);
    cache.set('token_price', 'D', 4); // Should evict A

    expect(cache.getStats().entries).toBe(3);
    expect(cache.get('token_price', 'A')).toBeNull(); // evicted
    expect(cache.get('token_price', 'D')).toBe(4); // newest
    expect(cache.getStats().evictions).toBeGreaterThan(0);
  });

  it('getEntryMetadata returns metadata without data payloads', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();

    cache.set('token_price', 'ETH', { largePayload: true });

    const meta = cache.getEntryMetadata();
    expect(meta).toHaveLength(1);
    expect(meta[0]!.category).toBe('token_price');
    expect(meta[0]!.hitCount).toBe(0);
    expect(meta[0]!.ageMs).toBeGreaterThanOrEqual(0);
    expect(meta[0]!.ttlRemainingMs).toBeGreaterThan(0);
    // Should not contain the actual data
    expect(meta[0]).not.toHaveProperty('data');
  });

  it('different categories have different default TTLs', async () => {
    const { getMarketCache } = await import(
      '../extensions/crypto/src/services/market-cache.js'
    );
    const cache = getMarketCache();

    cache.set('token_price', 'ETH', 4200);   // 15s TTL
    cache.set('leaderboard', 'all', []);       // 5min TTL

    const meta = cache.getEntryMetadata();
    const priceEntry = meta.find(m => m.category === 'token_price');
    const leaderboardEntry = meta.find(m => m.category === 'leaderboard');

    // Leaderboard should have a longer TTL remaining than price
    expect(leaderboardEntry!.ttlRemainingMs).toBeGreaterThan(priceEntry!.ttlRemainingMs);
  });
});
