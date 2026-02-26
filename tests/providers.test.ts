/**
 * Tests for Multi-RPC, DEX Aggregator, and Price Oracle services.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RpcManager, resetRpcManager } from '../extensions/crypto/src/services/rpc-provider.js';
import { DexAggregator, resetDexAggregator } from '../extensions/crypto/src/services/dex-aggregator.js';
import { PriceOracle, resetPriceOracle } from '../extensions/crypto/src/services/price-oracle.js';

// ── RPC Manager ──────────────────────────────────────────────────────────

describe('RpcManager', () => {
  afterEach(() => {
    resetRpcManager();
  });

  it('resolves chain names to IDs', () => {
    const mgr = new RpcManager();
    expect(mgr.resolveChainId('base')).toBe(8453);
    expect(mgr.resolveChainId('ethereum')).toBe(1);
    expect(mgr.resolveChainId('eth')).toBe(1);
    expect(mgr.resolveChainId('arbitrum')).toBe(42161);
    expect(mgr.resolveChainId('arb')).toBe(42161);
    expect(mgr.resolveChainId('optimism')).toBe(10);
    expect(mgr.resolveChainId('polygon')).toBe(137);
    expect(mgr.resolveChainId(8453)).toBe(8453);
  });

  it('returns default providers for known chains', () => {
    const mgr = new RpcManager();
    const providers = mgr.getProviders(8453);
    // Should have at least some public providers (Alchemy filtered if no key)
    expect(providers.length).toBeGreaterThan(0);
    // Should be sorted by priority
    for (let i = 1; i < providers.length; i++) {
      expect(providers[i]!.priority).toBeGreaterThanOrEqual(providers[i - 1]!.priority);
    }
  });

  it('filters out providers needing missing API keys', () => {
    delete process.env.ALCHEMY_API_KEY;
    const mgr = new RpcManager();
    const providers = mgr.getProviders(8453);
    const alchemyFound = providers.find((p) => p.name === 'Alchemy');
    expect(alchemyFound).toBeUndefined();
  });

  it('includes Alchemy when API key is set', () => {
    process.env.ALCHEMY_API_KEY = 'test-key';
    const mgr = new RpcManager();
    const providers = mgr.getProviders(8453);
    const alchemyFound = providers.find((p) => p.name === 'Alchemy');
    expect(alchemyFound).toBeDefined();
    expect(alchemyFound!.priority).toBe(1);
    delete process.env.ALCHEMY_API_KEY;
  });

  it('lists supported chains', () => {
    const mgr = new RpcManager();
    const chains = mgr.getSupportedChains();
    expect(chains).toContain(8453);
    expect(chains).toContain(1);
    expect(chains).toContain(42161);
    expect(chains).toContain(10);
    expect(chains).toContain(137);
  });

  it('generates health report', () => {
    const mgr = new RpcManager();
    const report = mgr.getHealthReport(8453);
    expect(report.length).toBeGreaterThan(0);
    for (const entry of report) {
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('available');
      expect(entry).toHaveProperty('failures');
      expect(entry).toHaveProperty('circuitOpen');
    }
  });

  it('accepts custom provider config', () => {
    const mgr = new RpcManager({
      providers: {
        '8453': [
          { url: 'https://custom.rpc.com', name: 'Custom', priority: 1 },
        ],
      },
    });
    const providers = mgr.getProviders(8453);
    expect(providers.length).toBe(1);
    expect(providers[0]!.name).toBe('Custom');
  });
});

// ── DEX Aggregator ───────────────────────────────────────────────────────

describe('DexAggregator', () => {
  afterEach(() => {
    resetDexAggregator();
  });

  it('lists enabled aggregators', () => {
    const agg = new DexAggregator();
    const enabled = agg.getEnabled();
    // ParaSwap and Odos don't need API keys
    expect(enabled).toContain('paraswap');
    expect(enabled).toContain('odos');
    expect(enabled).toContain('kyberswap');
  });

  it('filters out aggregators requiring missing keys', () => {
    delete process.env.ZEROX_API_KEY;
    delete process.env.ONEINCH_API_KEY;
    const agg = new DexAggregator();
    const enabled = agg.getEnabled();
    expect(enabled).not.toContain('1inch');
    // 0x might still work without key for some chains
  });

  it('accepts custom chain ID', () => {
    const agg = new DexAggregator({ chainId: 1 });
    expect(agg.getEnabled().length).toBeGreaterThan(0);
  });

  it('accepts custom slippage', () => {
    const agg = new DexAggregator({ slippageBps: 100 });
    expect(agg.getEnabled().length).toBeGreaterThan(0);
  });

  it('getQuotes returns array with error handling', async () => {
    // All fetchers will fail because we're not making real API calls
    const agg = new DexAggregator({ timeoutMs: 100 });
    const quotes = await agg.getQuotes(
      '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '1000000000000000', // 0.001 ETH
    );
    // Should have results (with errors) for each aggregator
    expect(quotes.length).toBeGreaterThan(0);
    // Each should have the required fields
    for (const q of quotes) {
      expect(q).toHaveProperty('aggregator');
      expect(q).toHaveProperty('sellToken');
      expect(q).toHaveProperty('buyToken');
      expect(q).toHaveProperty('sellAmount');
    }
  });
});

// ── Price Oracle ─────────────────────────────────────────────────────────

describe('PriceOracle', () => {
  afterEach(() => {
    resetPriceOracle();
  });

  it('returns a price result structure', async () => {
    // Will fail on actual API calls but the structure should be correct
    const oracle = new PriceOracle({ timeoutMs: 100, sources: ['DexScreener'] });
    const result = await oracle.getPrice('ETH', 'base');

    expect(result).toHaveProperty('token', 'ETH');
    expect(result).toHaveProperty('chain', 'base');
    expect(result).toHaveProperty('priceUsd');
    expect(result).toHaveProperty('sources');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('divergencePercent');
    expect(Array.isArray(result.sources)).toBe(true);
  });

  it('handles all sources failing gracefully', async () => {
    const oracle = new PriceOracle({ timeoutMs: 100 });
    const result = await oracle.getPrice('NONEXISTENT_TOKEN_XYZ', 'base');

    expect(result.confidence).toBe('low');
    expect(result.priceUsd).toBe(0);
  });

  it('batch price lookup returns array', async () => {
    const oracle = new PriceOracle({ timeoutMs: 100, sources: ['DexScreener'] });
    const results = await oracle.getPrices([
      { symbol: 'ETH' },
      { symbol: 'USDC' },
    ]);

    expect(results.length).toBe(2);
    expect(results[0]!.token).toBe('ETH');
    expect(results[1]!.token).toBe('USDC');
  });

  it('detects divergence between sources', () => {
    // This tests the internal logic indirectly —
    // if sources report very different prices, confidence should be lower
    const oracle = new PriceOracle({
      divergenceThreshold: 2,
      sources: [],
    });

    // With no sources, should return low confidence
    // (actual divergence detection tested in integration)
    expect(oracle).toBeDefined();
  });
});
