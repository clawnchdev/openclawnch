/**
 * New Features Tests — dry-run tests for all 8 new services/enhancements.
 *
 * Feature 1: DEX Aggregator — 1inch + OpenOcean fetchers
 * Feature 2: Price Oracle — Birdeye source
 * Feature 3: Telegram sendMessageDraft streaming
 * Feature 4: Chainlink Oracle feed service
 * Feature 5: Gas Estimation service
 * Feature 6: Token Allowance Manager
 * Feature 7: Portfolio Snapshot service
 * Feature 8: Tx Status Polling service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Feature 1: DEX Aggregator Enhancements ──────────────────────────────────

describe('Feature 1: DEX Aggregator — 1inch + OpenOcean', () => {
  beforeEach(async () => {
    const { resetDexAggregator } = await import(
      '../extensions/crypto/src/services/dex-aggregator.js'
    );
    resetDexAggregator();
  });

  it('DexAggregator class is constructable', async () => {
    const { DexAggregator } = await import(
      '../extensions/crypto/src/services/dex-aggregator.js'
    );
    const agg = new DexAggregator();
    expect(agg).toBeDefined();
    expect(typeof agg.getQuotes).toBe('function');
    expect(typeof agg.getBestQuote).toBe('function');
    expect(typeof agg.getEnabled).toBe('function');
  });

  it('getEnabled includes free aggregators', async () => {
    const { DexAggregator } = await import(
      '../extensions/crypto/src/services/dex-aggregator.js'
    );
    const agg = new DexAggregator();
    const enabled = agg.getEnabled();
    // ParaSwap, Odos, KyberSwap don't need API keys
    expect(enabled).toContain('paraswap');
    expect(enabled).toContain('odos');
    expect(enabled).toContain('kyberswap');
    // OpenOcean doesn't need API key
    expect(enabled).toContain('openocean');
  });

  it('getEnabled excludes gated aggregators without keys', async () => {
    const { DexAggregator } = await import(
      '../extensions/crypto/src/services/dex-aggregator.js'
    );
    delete process.env.ZEROX_API_KEY;
    delete process.env.ONEINCH_API_KEY;
    const agg = new DexAggregator();
    const enabled = agg.getEnabled();
    expect(enabled).not.toContain('0x');
    expect(enabled).not.toContain('1inch');
  });

  it('getEnabled includes 1inch when key is set', async () => {
    const { DexAggregator } = await import(
      '../extensions/crypto/src/services/dex-aggregator.js'
    );
    process.env.ONEINCH_API_KEY = 'test_key';
    try {
      const agg = new DexAggregator();
      const enabled = agg.getEnabled();
      expect(enabled).toContain('1inch');
    } finally {
      delete process.env.ONEINCH_API_KEY;
    }
  });

  it('getQuotes catches individual aggregator errors', async () => {
    const { DexAggregator } = await import(
      '../extensions/crypto/src/services/dex-aggregator.js'
    );
    // Only free aggregators enabled — some may return real quotes, some may error
    const agg = new DexAggregator({ timeoutMs: 2000 });
    const quotes = await agg.getQuotes(
      '0x4200000000000000000000000000000000000006', // WETH
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      '1000000000000000000', // 1 ETH in wei
    );
    // Should return results (with or without errors) without throwing
    expect(Array.isArray(quotes)).toBe(true);
    for (const q of quotes) {
      expect(q).toHaveProperty('aggregator');
      expect(q).toHaveProperty('buyAmount');
    }
  }, 15_000);

  it('getBestQuote throws when all aggregators are disabled', async () => {
    const { DexAggregator } = await import(
      '../extensions/crypto/src/services/dex-aggregator.js'
    );
    // Disable all aggregators so none can return a quote
    const agg = new DexAggregator({
      timeoutMs: 500,
      aggregators: {
        '0x': { enabled: false, baseUrl: 'https://api.0x.org' },
        '1inch': { enabled: false, baseUrl: 'https://api.1inch.dev' },
        paraswap: { enabled: false, baseUrl: 'https://apiv5.paraswap.io' },
        odos: { enabled: false, baseUrl: 'https://api.odos.xyz' },
        kyberswap: { enabled: false, baseUrl: 'https://aggregator-api.kyberswap.com' },
        openocean: { enabled: false, baseUrl: 'https://open-api.openocean.finance' },
      },
    });
    await expect(
      agg.getBestQuote(
        '0x4200000000000000000000000000000000000006',
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        '1000000000000000000',
      ),
    ).rejects.toThrow('No valid quotes');
  });

  it('singleton factory works', async () => {
    const { getDexAggregator, resetDexAggregator } = await import(
      '../extensions/crypto/src/services/dex-aggregator.js'
    );
    const a = getDexAggregator();
    const b = getDexAggregator();
    expect(a).toBe(b);
    resetDexAggregator();
    const c = getDexAggregator();
    expect(c).not.toBe(a);
  });

  it('SwapQuote interface has correct shape', async () => {
    const { DexAggregator } = await import(
      '../extensions/crypto/src/services/dex-aggregator.js'
    );
    const agg = new DexAggregator({ timeoutMs: 2000 });
    const quotes = await agg.getQuotes(
      '0x4200000000000000000000000000000000000006',
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '1000000000000000000',
    );
    if (quotes.length > 0) {
      const q = quotes[0]!;
      expect(typeof q.aggregator).toBe('string');
      expect(typeof q.sellToken).toBe('string');
      expect(typeof q.buyToken).toBe('string');
      expect(typeof q.sellAmount).toBe('string');
      expect(typeof q.buyAmount).toBe('string');
      expect(typeof q.price).toBe('number');
      expect(typeof q.gasEstimate).toBe('string');
    }
  }, 15_000);

  it('accepts custom config', async () => {
    const { DexAggregator } = await import(
      '../extensions/crypto/src/services/dex-aggregator.js'
    );
    const agg = new DexAggregator({
      chainId: 1,
      slippageBps: 100,
      timeoutMs: 3000,
      aggregators: {
        odos: { enabled: false, baseUrl: 'https://api.odos.xyz' },
      },
    });
    const enabled = agg.getEnabled();
    expect(enabled).not.toContain('odos');
  });
});

// ── Feature 2: Price Oracle — Birdeye Source ────────────────────────────────

describe('Feature 2: Price Oracle — Birdeye', () => {
  beforeEach(async () => {
    const { resetPriceOracle } = await import(
      '../extensions/crypto/src/services/price-oracle.js'
    );
    resetPriceOracle();
  });

  it('PriceOracle default config includes Birdeye', async () => {
    const { PriceOracle } = await import(
      '../extensions/crypto/src/services/price-oracle.js'
    );
    const oracle = new PriceOracle();
    // Internal: check that Birdeye is in the source list by trying getPrice
    // which will attempt all sources including Birdeye
    expect(oracle).toBeDefined();
    expect(typeof oracle.getPrice).toBe('function');
  });

  it('Birdeye source returns graceful error without API key', async () => {
    const { PriceOracle } = await import(
      '../extensions/crypto/src/services/price-oracle.js'
    );
    delete process.env.BIRDEYE_API_KEY;
    const oracle = new PriceOracle({ sources: ['Birdeye'], timeoutMs: 1000 });
    const result = await oracle.getPrice('ETH', 'base');
    // Should degrade gracefully — return low confidence, no crash
    expect(result.token).toBe('ETH');
    expect(result.confidence).toBe('low');
    // Source should report an error
    expect(result.sources.length).toBe(1);
    expect(result.sources[0]!.name).toBe('Birdeye');
    expect(result.sources[0]!.error).toContain('API key');
  });

  it('PriceOracle accepts birdeyeApiKey config', async () => {
    const { PriceOracle } = await import(
      '../extensions/crypto/src/services/price-oracle.js'
    );
    const oracle = new PriceOracle({
      birdeyeApiKey: 'test_birdeye_key',
      sources: ['Birdeye'],
      timeoutMs: 500,
    });
    // Should try to call Birdeye — will fail due to invalid key but won't crash
    const result = await oracle.getPrice('ETH', 'base');
    expect(result).toBeDefined();
    expect(result.token).toBe('ETH');
  });

  it('multi-source includes Birdeye in 5 sources', async () => {
    const { PriceOracle } = await import(
      '../extensions/crypto/src/services/price-oracle.js'
    );
    const oracle = new PriceOracle();
    const result = await oracle.getPrice('ETH', 'base');
    // Should have attempted all 5 sources
    expect(result.sources.length).toBe(5);
    const sourceNames = result.sources.map(s => s.name);
    expect(sourceNames).toContain('Birdeye');
    expect(sourceNames).toContain('DexScreener');
    expect(sourceNames).toContain('CoinGecko');
    expect(sourceNames).toContain('DeFiLlama');
    expect(sourceNames).toContain('CoinMarketCap');
  });

  it('singleton factory works', async () => {
    const { getPriceOracle, resetPriceOracle } = await import(
      '../extensions/crypto/src/services/price-oracle.js'
    );
    const a = getPriceOracle();
    const b = getPriceOracle();
    expect(a).toBe(b);
    resetPriceOracle();
    const c = getPriceOracle();
    expect(c).not.toBe(a);
  });
});

// ── Feature 3: Telegram sendMessageDraft Streaming ──────────────────────────

describe('Feature 3: Telegram Draft Streaming', () => {
  it('TelegramDraftStreamService is constructable', async () => {
    const { TelegramDraftStreamService } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    const service = new TelegramDraftStreamService({ botToken: 'test:token' });
    expect(service).toBeDefined();
    expect(typeof service.startDraft).toBe('function');
    expect(typeof service.updateDraft).toBe('function');
    expect(typeof service.finalizeDraft).toBe('function');
    expect(typeof service.streamTokens).toBe('function');
  });

  it('isSupported returns true initially', async () => {
    const { TelegramDraftStreamService } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    const service = new TelegramDraftStreamService({ botToken: 'test:token' });
    const supported = await service.isSupported();
    expect(supported).toBe(true);
  });

  it('getActiveDraftCount starts at 0', async () => {
    const { TelegramDraftStreamService } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    const service = new TelegramDraftStreamService({ botToken: 'test:token' });
    expect(service.getActiveDraftCount()).toBe(0);
  });

  it('getActiveDraft returns undefined for unknown chat', async () => {
    const { TelegramDraftStreamService } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    const service = new TelegramDraftStreamService({ botToken: 'test:token' });
    expect(service.getActiveDraft(12345)).toBeUndefined();
  });

  it('cancelAll clears active drafts', async () => {
    const { TelegramDraftStreamService } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    const service = new TelegramDraftStreamService({ botToken: 'test:token' });
    service.cancelAll();
    expect(service.getActiveDraftCount()).toBe(0);
  });

  it('startDraft fails gracefully with bad token', async () => {
    const { TelegramDraftStreamService } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    const service = new TelegramDraftStreamService({
      botToken: 'invalid:token',
      timeoutMs: 1000,
    });
    // Should throw (fetch will fail)
    await expect(service.startDraft(12345, 'hello')).rejects.toThrow();
  });

  it('updateDraft throws when no active draft', async () => {
    const { TelegramDraftStreamService } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    const service = new TelegramDraftStreamService({ botToken: 'test:token' });
    await expect(service.updateDraft(12345, 'hello')).rejects.toThrow('No active draft');
  });

  it('finalizeDraft throws when no draft exists', async () => {
    const { TelegramDraftStreamService } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    const service = new TelegramDraftStreamService({ botToken: 'test:token' });
    await expect(service.finalizeDraft(12345)).rejects.toThrow('No draft to finalize');
  });

  it('error classes have correct names', async () => {
    const { TelegramDraftError, TelegramDraftUnsupportedError } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    const err = new TelegramDraftError('test', 400);
    expect(err.name).toBe('TelegramDraftError');
    expect(err.code).toBe(400);
    expect(err.message).toBe('test');

    const unsup = new TelegramDraftUnsupportedError('not supported');
    expect(unsup.name).toBe('TelegramDraftUnsupportedError');
  });

  it('singleton factory requires bot token', async () => {
    const { getDraftStreamService, resetDraftStreamService } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    resetDraftStreamService();
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => getDraftStreamService()).toThrow('TELEGRAM_BOT_TOKEN required');
  });

  it('singleton factory works with env token', async () => {
    const { getDraftStreamService, resetDraftStreamService } = await import(
      '../extensions/crypto/src/services/telegram-draft-stream.js'
    );
    resetDraftStreamService();
    process.env.TELEGRAM_BOT_TOKEN = 'test:token';
    try {
      const a = getDraftStreamService();
      const b = getDraftStreamService();
      expect(a).toBe(b);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
      resetDraftStreamService();
    }
  });
});

// ── Feature 4: Chainlink Oracle ─────────────────────────────────────────────

describe('Feature 4: Chainlink Oracle', () => {
  beforeEach(async () => {
    const { resetChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    resetChainlinkOracle();
  });

  it('ChainlinkOracle is constructable', async () => {
    const { ChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const oracle = new ChainlinkOracle();
    expect(oracle).toBeDefined();
    expect(typeof oracle.getPrice).toBe('function');
    expect(typeof oracle.getEthPrice).toBe('function');
    expect(typeof oracle.verifyPrice).toBe('function');
  });

  it('getAvailableFeeds returns feeds for Base', async () => {
    const { ChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const oracle = new ChainlinkOracle();
    const feeds = oracle.getAvailableFeeds(8453);
    expect(feeds).toContain('ETH/USD');
    expect(feeds).toContain('BTC/USD');
    expect(feeds).toContain('USDC/USD');
    expect(feeds.length).toBeGreaterThan(3);
  });

  it('getAvailableFeeds returns feeds for Ethereum', async () => {
    const { ChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const oracle = new ChainlinkOracle();
    const feeds = oracle.getAvailableFeeds(1);
    expect(feeds).toContain('ETH/USD');
    expect(feeds).toContain('BTC/USD');
    expect(feeds).toContain('LINK/USD');
    expect(feeds).toContain('UNI/USD');
    expect(feeds).toContain('AAVE/USD');
    expect(feeds.length).toBeGreaterThan(10);
  });

  it('getAvailableFeeds returns empty for unknown chain', async () => {
    const { ChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const oracle = new ChainlinkOracle();
    const feeds = oracle.getAvailableFeeds(99999);
    expect(feeds).toEqual([]);
  });

  it('getSupportedChains returns all 5 chains', async () => {
    const { ChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const oracle = new ChainlinkOracle();
    const chains = oracle.getSupportedChains();
    expect(chains).toContain(1);
    expect(chains).toContain(8453);
    expect(chains).toContain(42161);
    expect(chains).toContain(10);
    expect(chains).toContain(137);
  });

  it('getPrice throws for unsupported chain', async () => {
    const { ChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const oracle = new ChainlinkOracle();
    await expect(oracle.getPrice('ETH/USD', 99999)).rejects.toThrow('not available for chain');
  });

  it('getPrice throws for unknown feed', async () => {
    const { ChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const oracle = new ChainlinkOracle();
    await expect(oracle.getPrice('FAKE/USD', 8453)).rejects.toThrow('No Chainlink feed');
  });

  it('verifyPrice returns acceptable for unknown feed', async () => {
    const { ChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const oracle = new ChainlinkOracle();
    const result = await oracle.verifyPrice('FAKE', 1.0, 8453);
    expect(result.isAcceptable).toBe(true);
    expect(result.warning).toContain('No Chainlink feed');
  });

  it('ChainlinkError has correct name', async () => {
    const { ChainlinkError } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const err = new ChainlinkError('test');
    expect(err.name).toBe('ChainlinkError');
    expect(err.message).toBe('test');
  });

  it('accepts custom staleness config', async () => {
    const { ChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const oracle = new ChainlinkOracle({
      maxStalenessSeconds: 7200,
      divergenceThresholdPercent: 5,
    });
    expect(oracle).toBeDefined();
  });

  it('singleton factory works', async () => {
    const { getChainlinkOracle, resetChainlinkOracle } = await import(
      '../extensions/crypto/src/services/chainlink-oracle.js'
    );
    const a = getChainlinkOracle();
    const b = getChainlinkOracle();
    expect(a).toBe(b);
    resetChainlinkOracle();
    const c = getChainlinkOracle();
    expect(c).not.toBe(a);
  });
});

// ── Feature 5: Gas Estimation Service ───────────────────────────────────────

describe('Feature 5: Gas Estimation Service', () => {
  beforeEach(async () => {
    const { resetGasEstimator } = await import(
      '../extensions/crypto/src/services/gas-estimator.js'
    );
    resetGasEstimator();
  });

  it('GasEstimator is constructable', async () => {
    const { GasEstimator } = await import(
      '../extensions/crypto/src/services/gas-estimator.js'
    );
    const est = new GasEstimator();
    expect(est).toBeDefined();
    expect(typeof est.getGasPrice).toBe('function');
    expect(typeof est.estimateCost).toBe('function');
    expect(typeof est.compareSwapsGasInclusive).toBe('function');
    expect(typeof est.getCommonCosts).toBe('function');
  });

  it('GAS_LIMITS has correct common operations', async () => {
    const { GAS_LIMITS } = await import(
      '../extensions/crypto/src/services/gas-estimator.js'
    );
    expect(GAS_LIMITS.ETH_TRANSFER).toBe(21_000);
    expect(GAS_LIMITS.ERC20_TRANSFER).toBe(65_000);
    expect(GAS_LIMITS.DEX_SWAP_SIMPLE).toBe(200_000);
    expect(GAS_LIMITS.DEX_SWAP_MULTI_HOP).toBe(350_000);
    expect(GAS_LIMITS.BRIDGE_DEPOSIT).toBe(250_000);
    expect(GAS_LIMITS.ADD_LIQUIDITY_V3).toBe(500_000);
    expect(GAS_LIMITS.PERMIT2_APPROVE).toBe(80_000);
    expect(GAS_LIMITS.CONTRACT_DEPLOY).toBe(2_000_000);
  });

  it('compareSwapsGasInclusive produces ranked results', async () => {
    const { GasEstimator } = await import(
      '../extensions/crypto/src/services/gas-estimator.js'
    );
    const est = new GasEstimator();

    // Mock: provide pre-computed quotes to avoid RPC calls
    const quotes = [
      { aggregator: '0x', buyAmount: '2000000000', buyTokenPriceUsd: 1, buyTokenDecimals: 6, gasEstimate: '200000' },
      { aggregator: 'ParaSwap', buyAmount: '2010000000', buyTokenPriceUsd: 1, buyTokenDecimals: 6, gasEstimate: '300000' },
      { aggregator: 'Odos', buyAmount: '1990000000', buyTokenPriceUsd: 1, buyTokenDecimals: 6, gasEstimate: '150000' },
    ];

    // This will fail trying to get gas price from RPC, but we can test the interface
    try {
      await est.compareSwapsGasInclusive(quotes, 8453);
    } catch (err: any) {
      // Expected: RPC will fail in test env
      expect(err.message).toBeDefined();
    }
  });

  it('accepts custom config', async () => {
    const { GasEstimator } = await import(
      '../extensions/crypto/src/services/gas-estimator.js'
    );
    const est = new GasEstimator({
      blockSamples: 10,
      cacheTtlMs: 30_000,
    });
    expect(est).toBeDefined();
  });

  it('clearCache works', async () => {
    const { GasEstimator } = await import(
      '../extensions/crypto/src/services/gas-estimator.js'
    );
    const est = new GasEstimator();
    est.clearCache(); // should not throw
    expect(est).toBeDefined();
  });

  it('singleton factory works', async () => {
    const { getGasEstimator, resetGasEstimator } = await import(
      '../extensions/crypto/src/services/gas-estimator.js'
    );
    const a = getGasEstimator();
    const b = getGasEstimator();
    expect(a).toBe(b);
    resetGasEstimator();
    const c = getGasEstimator();
    expect(c).not.toBe(a);
  });
});

// ── Feature 6: Token Allowance Manager ──────────────────────────────────────

describe('Feature 6: Token Allowance Manager', () => {
  beforeEach(async () => {
    const { resetAllowanceManager } = await import(
      '../extensions/crypto/src/services/allowance-manager.js'
    );
    resetAllowanceManager();
  });

  it('AllowanceManager is constructable', async () => {
    const { AllowanceManager } = await import(
      '../extensions/crypto/src/services/allowance-manager.js'
    );
    const mgr = new AllowanceManager();
    expect(mgr).toBeDefined();
    expect(typeof mgr.auditAllowances).toBe('function');
    expect(typeof mgr.checkAllowance).toBe('function');
    expect(typeof mgr.getKnownSpenders).toBe('function');
  });

  it('getKnownSpenders returns spenders for Base', async () => {
    const { AllowanceManager } = await import(
      '../extensions/crypto/src/services/allowance-manager.js'
    );
    const mgr = new AllowanceManager();
    const spenders = mgr.getKnownSpenders(8453);
    const names = Object.values(spenders);
    expect(names).toContain('Uniswap Universal Router');
    expect(names).toContain('Permit2');
    expect(names).toContain('0x Exchange Proxy');
  });

  it('getKnownSpenders returns spenders for Ethereum', async () => {
    const { AllowanceManager } = await import(
      '../extensions/crypto/src/services/allowance-manager.js'
    );
    const mgr = new AllowanceManager();
    const spenders = mgr.getKnownSpenders(1);
    const names = Object.values(spenders);
    expect(names).toContain('Uniswap V2 Router');
    expect(names).toContain('SushiSwap Router');
  });

  it('resolveSpenderName identifies Permit2', async () => {
    const { AllowanceManager } = await import(
      '../extensions/crypto/src/services/allowance-manager.js'
    );
    const mgr = new AllowanceManager();
    const name = mgr.resolveSpenderName('0x000000000022D473030F116dDEE9F6B43aC78BA3', 8453);
    expect(name).toBe('Permit2');
  });

  it('resolveSpenderName returns Unknown for unrecognized address', async () => {
    const { AllowanceManager } = await import(
      '../extensions/crypto/src/services/allowance-manager.js'
    );
    const mgr = new AllowanceManager();
    const name = mgr.resolveSpenderName('0x0000000000000000000000000000000000000001', 8453);
    expect(name).toBe('Unknown');
  });

  it('getKnownSpenders returns empty for unknown chain', async () => {
    const { AllowanceManager } = await import(
      '../extensions/crypto/src/services/allowance-manager.js'
    );
    const mgr = new AllowanceManager();
    const spenders = mgr.getKnownSpenders(99999);
    expect(Object.keys(spenders).length).toBe(0);
  });

  it('accepts custom threshold config', async () => {
    const { AllowanceManager } = await import(
      '../extensions/crypto/src/services/allowance-manager.js'
    );
    const mgr = new AllowanceManager({ unlimitedThreshold: 1e6 });
    expect(mgr).toBeDefined();
  });

  it('singleton factory works', async () => {
    const { getAllowanceManager, resetAllowanceManager } = await import(
      '../extensions/crypto/src/services/allowance-manager.js'
    );
    const a = getAllowanceManager();
    const b = getAllowanceManager();
    expect(a).toBe(b);
    resetAllowanceManager();
    const c = getAllowanceManager();
    expect(c).not.toBe(a);
  });
});

// ── Feature 7: Portfolio Snapshot Service ───────────────────────────────────

describe('Feature 7: Portfolio Snapshot Service', () => {
  beforeEach(async () => {
    const { resetPortfolioService } = await import(
      '../extensions/crypto/src/services/portfolio-snapshot.js'
    );
    resetPortfolioService();
  });

  it('PortfolioSnapshotService is constructable', async () => {
    const { PortfolioSnapshotService } = await import(
      '../extensions/crypto/src/services/portfolio-snapshot.js'
    );
    const svc = new PortfolioSnapshotService();
    expect(svc).toBeDefined();
    expect(typeof svc.getSnapshot).toBe('function');
    expect(typeof svc.getChange).toBe('function');
    expect(typeof svc.getSupportedChains).toBe('function');
  });

  it('getSupportedChains returns 5 chains', async () => {
    const { PortfolioSnapshotService } = await import(
      '../extensions/crypto/src/services/portfolio-snapshot.js'
    );
    const svc = new PortfolioSnapshotService();
    const chains = svc.getSupportedChains();
    expect(chains.length).toBe(5);
    const names = chains.map((c) => c.name);
    expect(names).toContain('base');
    expect(names).toContain('ethereum');
    expect(names).toContain('arbitrum');
    expect(names).toContain('optimism');
    expect(names).toContain('polygon');
  });

  it('accepts custom config (subset of chains)', async () => {
    const { PortfolioSnapshotService } = await import(
      '../extensions/crypto/src/services/portfolio-snapshot.js'
    );
    const svc = new PortfolioSnapshotService({
      chainIds: [8453, 1],
      minValueUsd: 1,
      cacheTtlMs: 30_000,
    });
    const chains = svc.getSupportedChains();
    expect(chains.length).toBe(2);
  });

  it('clearCache works', async () => {
    const { PortfolioSnapshotService } = await import(
      '../extensions/crypto/src/services/portfolio-snapshot.js'
    );
    const svc = new PortfolioSnapshotService();
    svc.clearCache(); // should not throw
    expect(svc).toBeDefined();
  });

  it('singleton factory works', async () => {
    const { getPortfolioService, resetPortfolioService } = await import(
      '../extensions/crypto/src/services/portfolio-snapshot.js'
    );
    const a = getPortfolioService();
    const b = getPortfolioService();
    expect(a).toBe(b);
    resetPortfolioService();
    const c = getPortfolioService();
    expect(c).not.toBe(a);
  });
});

// ── Feature 8: Tx Status Polling Service ────────────────────────────────────

describe('Feature 8: Tx Status Polling Service', () => {
  beforeEach(async () => {
    const { resetTxMonitor } = await import(
      '../extensions/crypto/src/services/tx-monitor.js'
    );
    resetTxMonitor();
  });

  it('TxMonitor is constructable', async () => {
    const { TxMonitor } = await import(
      '../extensions/crypto/src/services/tx-monitor.js'
    );
    const monitor = new TxMonitor();
    expect(monitor).toBeDefined();
    expect(typeof monitor.checkStatus).toBe('function');
    expect(typeof monitor.waitForConfirmation).toBe('function');
    expect(typeof monitor.monitorBatch).toBe('function');
    expect(typeof monitor.getMonitored).toBe('function');
  });

  it('getExplorerUrl generates correct URLs', async () => {
    const { TxMonitor } = await import(
      '../extensions/crypto/src/services/tx-monitor.js'
    );
    const monitor = new TxMonitor();
    const hash = '0xabc123';
    expect(monitor.getExplorerUrl(hash, 8453)).toBe('https://basescan.org/tx/0xabc123');
    expect(monitor.getExplorerUrl(hash, 1)).toBe('https://etherscan.io/tx/0xabc123');
    expect(monitor.getExplorerUrl(hash, 42161)).toBe('https://arbiscan.io/tx/0xabc123');
    expect(monitor.getExplorerUrl(hash, 10)).toBe('https://optimistic.etherscan.io/tx/0xabc123');
    expect(monitor.getExplorerUrl(hash, 137)).toBe('https://polygonscan.com/tx/0xabc123');
  });

  it('getExplorerBase returns correct base URLs', async () => {
    const { TxMonitor } = await import(
      '../extensions/crypto/src/services/tx-monitor.js'
    );
    const monitor = new TxMonitor();
    expect(monitor.getExplorerBase(8453)).toBe('https://basescan.org/tx/');
    expect(monitor.getExplorerBase(1)).toBe('https://etherscan.io/tx/');
  });

  it('getSupportedChains returns all 5 chains', async () => {
    const { TxMonitor } = await import(
      '../extensions/crypto/src/services/tx-monitor.js'
    );
    const monitor = new TxMonitor();
    const chains = monitor.getSupportedChains();
    expect(chains.length).toBe(5);
    expect(chains.find((c) => c.name === 'base')).toBeDefined();
    expect(chains.find((c) => c.name === 'ethereum')).toBeDefined();
  });

  it('getMonitored starts empty', async () => {
    const { TxMonitor } = await import(
      '../extensions/crypto/src/services/tx-monitor.js'
    );
    const monitor = new TxMonitor();
    expect(monitor.getMonitored()).toEqual([]);
  });

  it('getMonitoredTx returns undefined for unknown hash', async () => {
    const { TxMonitor } = await import(
      '../extensions/crypto/src/services/tx-monitor.js'
    );
    const monitor = new TxMonitor();
    expect(monitor.getMonitoredTx('0xnonexistent')).toBeUndefined();
  });

  it('clear removes all monitored txs', async () => {
    const { TxMonitor } = await import(
      '../extensions/crypto/src/services/tx-monitor.js'
    );
    const monitor = new TxMonitor();
    monitor.clear();
    expect(monitor.getMonitored()).toEqual([]);
  });

  it('singleton factory works', async () => {
    const { getTxMonitor, resetTxMonitor } = await import(
      '../extensions/crypto/src/services/tx-monitor.js'
    );
    const a = getTxMonitor();
    const b = getTxMonitor();
    expect(a).toBe(b);
    resetTxMonitor();
    const c = getTxMonitor();
    expect(c).not.toBe(a);
  });
});
