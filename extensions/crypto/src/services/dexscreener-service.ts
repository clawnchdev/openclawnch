/**
 * DexScreener Service — shared API client for token data.
 *
 * Centralizes all DexScreener calls. Previously duplicated across
 * defi-price.ts, defi-balance.ts, and market-intel.ts.
 */

const BASE_URL = 'https://api.dexscreener.com';

const CHAIN_ALIASES: Record<string, string> = {
  base: 'base',
  ethereum: 'ethereum',
  eth: 'ethereum',
  arbitrum: 'arbitrum',
  arb: 'arbitrum',
  optimism: 'optimism',
  op: 'optimism',
  polygon: 'polygon',
  matic: 'polygon',
};

export function resolveChain(input: string): string {
  return CHAIN_ALIASES[input.toLowerCase()] || input;
}

export async function fetchDexScreener(path: string): Promise<any> {
  // H10: Add request timeout to prevent hanging
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`DexScreener API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ─── Common Queries ──────────────────────────────────────────────────────

export interface DexPairData {
  pairAddress?: string;
  chainId?: string;
  dexId?: string;
  url?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  priceNative?: string;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume?: { h1?: number; h6?: number; h24?: number };
  txns?: { h1?: any; h6?: any; h24?: any };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
}

/**
 * Search for a token by symbol, name, or address.
 * Returns pairs sorted by liquidity (highest first).
 */
export async function searchToken(
  query: string,
  chain?: string,
): Promise<DexPairData[]> {
  let data: any;

  if (query.startsWith('0x') && query.length === 42 && chain) {
    data = await fetchDexScreener(`/tokens/v1/${resolveChain(chain)}/${query}`);
  } else {
    data = await fetchDexScreener(`/latest/dex/search?q=${encodeURIComponent(query)}`);
  }

  const pairs: DexPairData[] = data?.pairs ?? (Array.isArray(data) ? data : []);

  return pairs
    .filter((p) => !chain || p.chainId === resolveChain(chain))
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
}

/**
 * Get the USD price for a token. Returns 0 if not found.
 */
export async function getTokenPriceUsd(
  query: string,
  chain = 'base',
): Promise<{ priceUsd: number; pair: DexPairData | null }> {
  try {
    const pairs = await searchToken(query, chain);
    const top = pairs[0];
    if (!top) return { priceUsd: 0, pair: null };
    return { priceUsd: parseFloat(top.priceUsd ?? '0'), pair: top };
  } catch {
    return { priceUsd: 0, pair: null };
  }
}

/**
 * Get ETH price in USD (via WETH/USDC pair on Base).
 */
export async function getEthPriceUsd(): Promise<number> {
  try {
    const data = await fetchDexScreener('/latest/dex/search?q=WETH%20USDC');
    const basePair = data.pairs?.find(
      (p: any) => p.chainId === 'base' && p.baseToken?.symbol === 'WETH',
    );
    return basePair ? parseFloat(basePair.priceUsd ?? '0') : 0;
  } catch {
    return 0;
  }
}

/**
 * Get top boosted (trending) tokens.
 */
export async function getTrending(chain?: string, limit = 20): Promise<any[]> {
  const data = await fetchDexScreener('/token-boosts/top/v1');
  return (data ?? [])
    .filter((t: any) => !chain || t.chainId === resolveChain(chain))
    .slice(0, limit);
}

/**
 * Get latest pairs on a chain.
 */
export async function getNewPairs(chain = 'base', limit = 10): Promise<DexPairData[]> {
  const data = await fetchDexScreener(`/latest/dex/pairs/${resolveChain(chain)}`);
  return (data?.pairs ?? []).slice(0, limit);
}
