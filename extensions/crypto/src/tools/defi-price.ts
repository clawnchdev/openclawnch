/**
 * DeFi Price Tool — token price lookup via DexScreener, CoinGecko, and on-chain
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import type { TokenPrice } from '../lib/types.js';

const ACTIONS = ['lookup', 'search', 'trending'] as const;

const DefiPriceSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'lookup: get price for a specific token. search: find tokens by name/symbol. trending: top trending tokens.',
  }),
  token: Type.Optional(Type.String({
    description: 'Token symbol (e.g. "ETH", "USDC"), name, or contract address (0x...)',
  })),
  chain: Type.Optional(Type.String({
    description: 'Chain to query (default: "base"). Options: base, ethereum, arbitrum, optimism, polygon',
  })),
});

export function createDefiPriceTool() {
  return {
    name: 'defi_price',
    label: 'DeFi Price',
    ownerOnly: false,
    description:
      'Look up token prices, search for tokens, and see trending tokens. ' +
      'Uses DexScreener (free, no key) with CoinGecko fallback. ' +
      'Supports any ERC-20 token on Base, Ethereum, Arbitrum, Optimism, Polygon.',
    parameters: DefiPriceSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'lookup':
          return handleLookup(params);
        case 'search':
          return handleSearch(params);
        case 'trending':
          return handleTrending(params);
        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}

// ─── DexScreener API ─────────────────────────────────────────────────────

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

const CHAIN_MAP: Record<string, string> = {
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

async function fetchDexScreener(path: string): Promise<any> {
  const response = await fetch(`${DEXSCREENER_BASE}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`DexScreener API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function handleLookup(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token', { required: true })!;
  const chainInput = readStringParam(params, 'chain') || 'base';
  const chain = CHAIN_MAP[chainInput.toLowerCase()] || chainInput;

  try {
    let data: any;

    // If it looks like an address, search by address
    if (token.startsWith('0x') && token.length === 42) {
      data = await fetchDexScreener(`/tokens/v1/${chain}/${token}`);
    } else {
      // Search by symbol/name
      data = await fetchDexScreener(`/latest/dex/search?q=${encodeURIComponent(token)}`);
    }

    const pairs = data?.pairs || data || [];
    if (!pairs.length) {
      return jsonResult({
        found: false,
        query: token,
        chain,
        message: `No results found for "${token}" on ${chain}. Try a contract address or different chain.`,
      });
    }

    // Filter to requested chain and sort by liquidity
    const filtered = (Array.isArray(pairs) ? pairs : [pairs])
      .filter((p: any) => !chain || p.chainId === chain)
      .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    const top = filtered[0];
    if (!top) {
      return jsonResult({
        found: false,
        query: token,
        chain,
        message: `Found matches but none on ${chain}.`,
      });
    }

    const result: TokenPrice = {
      address: top.baseToken?.address ?? token,
      symbol: top.baseToken?.symbol ?? token,
      name: top.baseToken?.name ?? '',
      priceUsd: parseFloat(top.priceUsd ?? '0'),
      change24h: top.priceChange?.h24 ?? 0,
      volume24h: top.volume?.h24 ?? 0,
      liquidity: top.liquidity?.usd ?? 0,
      marketCap: top.marketCap ?? top.fdv,
      source: 'dexscreener',
    };

    return jsonResult({
      found: true,
      ...result,
      pairAddress: top.pairAddress,
      dexId: top.dexId,
      url: top.url,
    });
  } catch (err) {
    // Fallback to CoinGecko
    try {
      return await handleCoinGeckoLookup(token);
    } catch {
      return errorResult(`Price lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function handleCoinGeckoLookup(token: string) {
  const apiKey = process.env.COINGECKO_API_KEY;
  const baseUrl = apiKey
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  const response = await fetch(
    `${baseUrl}/search?query=${encodeURIComponent(token)}`,
    { headers },
  );

  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status}`);
  }

  const data = await response.json() as any;
  const coin = data.coins?.[0];
  if (!coin) {
    return jsonResult({ found: false, query: token, source: 'coingecko' });
  }

  // Get detailed price data
  const priceResponse = await fetch(
    `${baseUrl}/simple/price?ids=${coin.id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`,
    { headers },
  );

  if (!priceResponse.ok) {
    return jsonResult({
      found: true,
      symbol: coin.symbol,
      name: coin.name,
      source: 'coingecko',
      note: 'Price data unavailable (rate limited)',
    });
  }

  const priceData = await priceResponse.json() as any;
  const prices = priceData[coin.id];

  return jsonResult({
    found: true,
    symbol: coin.symbol?.toUpperCase(),
    name: coin.name,
    priceUsd: prices?.usd ?? 0,
    change24h: prices?.usd_24h_change ?? 0,
    volume24h: prices?.usd_24h_vol ?? 0,
    marketCap: prices?.usd_market_cap ?? 0,
    source: 'coingecko',
    coingeckoId: coin.id,
  });
}

async function handleSearch(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token', { required: true })!;

  try {
    const data = await fetchDexScreener(`/latest/dex/search?q=${encodeURIComponent(token)}`);
    const pairs = data?.pairs ?? [];

    // Deduplicate by base token address, keep highest liquidity
    const seen = new Map<string, any>();
    for (const pair of pairs) {
      const addr = pair.baseToken?.address;
      if (!addr) continue;
      const existing = seen.get(addr);
      if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
        seen.set(addr, pair);
      }
    }

    const results = Array.from(seen.values())
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
      .slice(0, 10)
      .map((p: any) => ({
        symbol: p.baseToken?.symbol,
        name: p.baseToken?.name,
        address: p.baseToken?.address,
        chain: p.chainId,
        priceUsd: parseFloat(p.priceUsd ?? '0'),
        liquidity: p.liquidity?.usd ?? 0,
        volume24h: p.volume?.h24 ?? 0,
        url: p.url,
      }));

    return jsonResult({ query: token, results, count: results.length });
  } catch (err) {
    return errorResult(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleTrending(params: Record<string, unknown>) {
  const chainInput = readStringParam(params, 'chain') || 'base';
  const chain = CHAIN_MAP[chainInput.toLowerCase()] || chainInput;

  try {
    // DexScreener doesn't have a direct trending endpoint, but we can
    // use the token boosts or search for high-volume pairs
    const data = await fetchDexScreener(`/token-boosts/top/v1`);
    
    const results = (data ?? [])
      .filter((t: any) => !chain || t.chainId === chain)
      .slice(0, 20)
      .map((t: any) => ({
        symbol: t.tokenAddress ? undefined : t.description,
        address: t.tokenAddress,
        chain: t.chainId,
        url: t.url,
        boostAmount: t.totalAmount,
      }));

    return jsonResult({
      chain,
      trending: results,
      count: results.length,
      note: 'Trending tokens by DexScreener boost amount',
    });
  } catch (err) {
    return errorResult(`Trending lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
