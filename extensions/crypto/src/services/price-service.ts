/**
 * Price Service — unified price feed shared across tools.
 *
 * Used by manage-orders (trigger checks), defi-swap (pre-swap display),
 * defi-balance (ETH valuation), and the workflow orchestrator.
 *
 * Sources: DexScreener (primary), CoinGecko (fallback).
 * Includes a TTL cache to avoid hammering APIs during multi-tool workflows.
 */

import { getTokenPriceUsd, getEthPriceUsd, searchToken, type DexPairData } from './dexscreener-service.js';

// ─── Price Cache (30s TTL) ───────────────────────────────────────────────

interface CacheEntry {
  priceUsd: number;
  pair: DexPairData | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000;
const _cache = new Map<string, CacheEntry>();

function cacheKey(token: string, chain: string): string {
  return `${chain}:${token.toLowerCase()}`;
}

function getCached(token: string, chain: string): CacheEntry | null {
  const entry = _cache.get(cacheKey(token, chain));
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    _cache.delete(cacheKey(token, chain));
    return null;
  }
  return entry;
}

function setCache(token: string, chain: string, entry: Omit<CacheEntry, 'fetchedAt'>): void {
  _cache.set(cacheKey(token, chain), { ...entry, fetchedAt: Date.now() });
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface PriceResult {
  priceUsd: number;
  priceEth: number;
  symbol: string;
  name: string;
  address?: string;
  change24h?: number;
  volume24h?: number;
  liquidity?: number;
  source: 'dexscreener' | 'coingecko' | 'cache';
}

/**
 * Get current price for any token. Cached for 30s.
 */
export async function getPrice(token: string, chain = 'base'): Promise<PriceResult> {
  // Check cache first
  const cached = getCached(token, chain);
  if (cached) {
    const ethPrice = await getEthPrice();
    return {
      priceUsd: cached.priceUsd,
      priceEth: ethPrice > 0 ? cached.priceUsd / ethPrice : 0,
      symbol: cached.pair?.baseToken?.symbol ?? token,
      name: cached.pair?.baseToken?.name ?? '',
      address: cached.pair?.baseToken?.address,
      change24h: cached.pair?.priceChange?.h24,
      volume24h: cached.pair?.volume?.h24,
      liquidity: cached.pair?.liquidity?.usd,
      source: 'cache',
    };
  }

  // Fresh fetch
  const { priceUsd, pair } = await getTokenPriceUsd(token, chain);
  setCache(token, chain, { priceUsd, pair });

  const ethPrice = await getEthPrice();

  return {
    priceUsd,
    priceEth: ethPrice > 0 ? priceUsd / ethPrice : 0,
    symbol: pair?.baseToken?.symbol ?? token,
    name: pair?.baseToken?.name ?? '',
    address: pair?.baseToken?.address,
    change24h: pair?.priceChange?.h24,
    volume24h: pair?.volume?.h24,
    liquidity: pair?.liquidity?.usd,
    source: 'dexscreener',
  };
}

/**
 * Get ETH price in USD. Cached.
 */
let _ethPriceCache: { price: number; at: number } | null = null;

export async function getEthPrice(): Promise<number> {
  if (_ethPriceCache && Date.now() - _ethPriceCache.at < CACHE_TTL_MS) {
    return _ethPriceCache.price;
  }
  const price = await getEthPriceUsd();
  _ethPriceCache = { price, at: Date.now() };
  return price;
}

/**
 * Get prices for multiple tokens at once (batched, cached).
 */
export async function getPrices(
  tokens: Array<{ token: string; chain?: string }>,
): Promise<Map<string, PriceResult>> {
  const results = new Map<string, PriceResult>();
  await Promise.all(
    tokens.map(async ({ token, chain }) => {
      try {
        const price = await getPrice(token, chain ?? 'base');
        results.set(token, price);
      } catch {
        // Skip failures
      }
    }),
  );
  return results;
}

/**
 * Clear the price cache. Useful for testing.
 */
export function clearPriceCache(): void {
  _cache.clear();
  _ethPriceCache = null;
}
