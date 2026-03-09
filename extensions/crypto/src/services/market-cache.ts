/**
 * MarketIntel Cache Layer — TTL-based caching for market data API calls.
 *
 * Wraps DexScreener, CoinGecko, and other price/market data APIs with
 * a configurable TTL cache. Benefits:
 *
 * 1. Reduces API calls — avoids redundant fetches within the TTL window
 * 2. Avoids rate limits — DexScreener (300/min), CoinGecko (30/min free)
 * 3. Faster responses — cached data returns instantly
 * 4. Resilience — stale data served when API is down (with warning)
 *
 * Cache is in-memory (resets on restart). Entries are keyed by
 * normalized request parameters.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface CacheConfig {
  /** Default TTL for cached entries in ms. Default: 30_000 (30s). */
  defaultTtlMs?: number;
  /** TTL overrides per data category. */
  ttlOverrides?: Partial<Record<CacheCategory, number>>;
  /** Max number of cache entries. Default: 500. */
  maxEntries?: number;
  /** Whether to serve stale data when the upstream fetch fails. Default: true. */
  serveStaleOnError?: boolean;
}

export type CacheCategory =
  | 'trending'
  | 'new_pairs'
  | 'token_price'
  | 'token_search'
  | 'token_profile'
  | 'whale_data'
  | 'leaderboard'
  | 'gas_price';

export interface CacheEntry<T = unknown> {
  key: string;
  category: CacheCategory;
  data: T;
  cachedAt: number;
  expiresAt: number;
  hitCount: number;
  stale: boolean;
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  staleServes: number;
  evictions: number;
  hitRate: number;
  byCategory: Record<string, { entries: number; hits: number }>;
}

// ─── Default TTLs per category ──────────────────────────────────────────

const DEFAULT_TTLS: Record<CacheCategory, number> = {
  trending: 60_000,       // 1 minute — changes frequently
  new_pairs: 30_000,      // 30s — new pairs appear often
  token_price: 15_000,    // 15s — prices move fast
  token_search: 60_000,   // 1 minute — search results stable
  token_profile: 120_000, // 2 minutes — profiles rarely change
  whale_data: 60_000,     // 1 minute
  leaderboard: 300_000,   // 5 minutes — rankings stable
  gas_price: 10_000,      // 10s — gas changes rapidly
};

// ─── Market Cache ───────────────────────────────────────────────────────

class MarketCache {
  private cache = new Map<string, CacheEntry>();
  private config: Required<CacheConfig>;
  private stats = { hits: 0, misses: 0, staleServes: 0, evictions: 0 };

  constructor(config: CacheConfig = {}) {
    this.config = {
      defaultTtlMs: config.defaultTtlMs ?? 30_000,
      ttlOverrides: config.ttlOverrides ?? {},
      maxEntries: config.maxEntries ?? 500,
      serveStaleOnError: config.serveStaleOnError ?? true,
    };
  }

  /**
   * Get a cached value, or fetch it using the provided function.
   * This is the primary interface — wraps any async fetch with caching.
   */
  async getOrFetch<T>(
    category: CacheCategory,
    key: string,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const cacheKey = this.buildKey(category, key);
    const existing = this.cache.get(cacheKey);

    // Cache hit (not expired)
    if (existing && Date.now() < existing.expiresAt) {
      this.stats.hits++;
      existing.hitCount++;
      return existing.data as T;
    }

    // Cache miss or expired — fetch fresh data
    try {
      const data = await fetcher();
      this.set(category, key, data);
      this.stats.misses++;
      return data;
    } catch (err) {
      // If we have stale data and serveStaleOnError is enabled, return it
      if (existing && this.config.serveStaleOnError) {
        this.stats.staleServes++;
        existing.stale = true;
        return existing.data as T;
      }
      throw err;
    }
  }

  /**
   * Manually set a cache entry.
   */
  set<T>(category: CacheCategory, key: string, data: T): void {
    const cacheKey = this.buildKey(category, key);
    const ttl = this.getTtl(category);

    // Evict if at capacity
    if (this.cache.size >= this.config.maxEntries && !this.cache.has(cacheKey)) {
      this.evictOldest();
    }

    this.cache.set(cacheKey, {
      key: cacheKey,
      category,
      data,
      cachedAt: Date.now(),
      expiresAt: Date.now() + ttl,
      hitCount: 0,
      stale: false,
    });
  }

  /**
   * Get a cached value (without fetching). Returns null if not cached or expired.
   */
  get<T>(category: CacheCategory, key: string): T | null {
    const cacheKey = this.buildKey(category, key);
    const entry = this.cache.get(cacheKey);

    if (!entry) return null;

    if (Date.now() >= entry.expiresAt) {
      // Expired but still in cache — mark as stale
      entry.stale = true;
      return null;
    }

    this.stats.hits++;
    entry.hitCount++;
    return entry.data as T;
  }

  /**
   * Invalidate a specific cache entry.
   */
  invalidate(category: CacheCategory, key: string): boolean {
    const cacheKey = this.buildKey(category, key);
    return this.cache.delete(cacheKey);
  }

  /**
   * Invalidate all entries in a category.
   */
  invalidateCategory(category: CacheCategory): number {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (entry.category === category) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    const byCategory: Record<string, { entries: number; hits: number }> = {};

    for (const entry of this.cache.values()) {
      if (!byCategory[entry.category]) {
        byCategory[entry.category] = { entries: 0, hits: 0 };
      }
      byCategory[entry.category]!.entries++;
      byCategory[entry.category]!.hits += entry.hitCount;
    }

    const totalRequests = this.stats.hits + this.stats.misses;
    return {
      entries: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      staleServes: this.stats.staleServes,
      evictions: this.stats.evictions,
      hitRate: totalRequests > 0 ? Math.round((this.stats.hits / totalRequests) * 10000) / 100 : 0,
      byCategory,
    };
  }

  /**
   * Get all entries for diagnostics (without data payloads).
   */
  getEntryMetadata(): Array<{
    key: string;
    category: CacheCategory;
    cachedAt: number;
    expiresAt: number;
    hitCount: number;
    stale: boolean;
    ageMs: number;
    ttlRemainingMs: number;
  }> {
    const now = Date.now();
    return Array.from(this.cache.values()).map(e => ({
      key: e.key,
      category: e.category,
      cachedAt: e.cachedAt,
      expiresAt: e.expiresAt,
      hitCount: e.hitCount,
      stale: e.stale || now >= e.expiresAt,
      ageMs: now - e.cachedAt,
      ttlRemainingMs: Math.max(0, e.expiresAt - now),
    }));
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private buildKey(category: CacheCategory, key: string): string {
    return `${category}:${key}`;
  }

  private getTtl(category: CacheCategory): number {
    return this.config.ttlOverrides?.[category]
      ?? DEFAULT_TTLS[category]
      ?? this.config.defaultTtlMs;
  }

  private evictOldest(): void {
    // Evict the entry with the oldest cachedAt that is either expired or least-hit
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    // First pass: try to evict an expired entry
    for (const [key, entry] of this.cache) {
      if (Date.now() >= entry.expiresAt) {
        this.cache.delete(key);
        this.stats.evictions++;
        return;
      }
    }

    // Second pass: evict the oldest entry
    for (const [key, entry] of this.cache) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _instance: MarketCache | null = null;

export function getMarketCache(config?: CacheConfig): MarketCache {
  if (!_instance) {
    _instance = new MarketCache(config);
  }
  return _instance;
}

export function resetMarketCache(): void {
  _instance = null;
}
