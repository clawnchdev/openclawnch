/**
 * DeFi Price Tool — token price lookup via multi-source PriceOracle.
 *
 * For well-known tokens: uses PriceOracle (DexScreener + CoinGecko +
 * DeFiLlama + CoinMarketCap) with cross-validation and confidence scoring.
 * For contract addresses / unknown tokens: falls back to DexScreener only.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { fetchDexScreener, resolveChain, getTrending as dexGetTrending } from '../services/dexscreener-service.js';
import { getPriceOracle } from '../services/price-oracle.js';
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
      'Uses cross-validated multi-source oracle (DexScreener, CoinGecko, DeFiLlama, CoinMarketCap) ' +
      'with confidence scoring and divergence detection. ' +
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

async function handleLookup(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token', { required: true })!;
  const chainInput = readStringParam(params, 'chain') || 'base';
  const chain = resolveChain(chainInput);

  // For contract addresses, use DexScreener directly (oracle doesn't support addresses well)
  const isAddress = token.startsWith('0x') && token.length === 42;

  if (!isAddress) {
    // Try PriceOracle first for symbol lookups — cross-validated, multi-source
    try {
      const oracle = getPriceOracle();
      const result = await oracle.getPrice(token, chain);

      if (result.priceUsd > 0) {
        // Also get DexScreener data for additional fields (liquidity, volume, pair info)
        let dexData: any = null;
        try {
          const data = await fetchDexScreener(`/latest/dex/search?q=${encodeURIComponent(token)}`);
          const pairs = data?.pairs ?? [];
          dexData = pairs
            .filter((p: any) => !chain || p.chainId === chain)
            .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        } catch {
          // DexScreener data is supplementary, not required
        }

        return jsonResult({
          found: true,
          symbol: token.toUpperCase(),
          name: dexData?.baseToken?.name ?? token,
          address: dexData?.baseToken?.address,
          priceUsd: result.priceUsd,
          confidence: result.confidence,
          sources: result.sources
            .filter((s) => !s.error)
            .map((s) => ({ name: s.name, price: s.priceUsd })),
          divergencePercent: result.divergencePercent,
          warning: result.warning,
          change24h: dexData?.priceChange?.h24 ?? undefined,
          volume24h: dexData?.volume?.h24 ?? undefined,
          liquidity: dexData?.liquidity?.usd ?? undefined,
          marketCap: dexData?.marketCap ?? dexData?.fdv ?? undefined,
          pairAddress: dexData?.pairAddress,
          dexId: dexData?.dexId,
          url: dexData?.url,
        });
      }
    } catch {
      // Oracle failed entirely, fall through to DexScreener-only path
    }
  }

  // Fallback: DexScreener-only lookup (for addresses or oracle failures)
  try {
    let data: any;

    if (isAddress) {
      data = await fetchDexScreener(`/tokens/v1/${chain}/${token}`);
    } else {
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
      confidence: 'single-source',
      pairAddress: top.pairAddress,
      dexId: top.dexId,
      url: top.url,
    });
  } catch (err) {
    return errorResult(`Price lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  const chain = resolveChain(chainInput);

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
