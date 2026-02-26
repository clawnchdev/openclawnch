/**
 * Market Intel Tool — market data, trending analysis, whale watching
 * 
 * Inspired by Lemon's MarketIntel. Ingests data from DexScreener,
 * CoinGecko, and on-chain events to surface market movements.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';

const ACTIONS = ['trending', 'new_pairs', 'whale_watch', 'analysis', 'leaderboard'] as const;

const MarketIntelSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'trending: hot tokens. new_pairs: recently created pools. whale_watch: large trades. analysis: token deep-dive. leaderboard: top Clawnch agents.',
  }),
  token: Type.Optional(Type.String({
    description: 'Token address or symbol (for analysis action)',
  })),
  chain: Type.Optional(Type.String({
    description: 'Chain to query (default: base)',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Number of results to return (default: 10)',
  })),
});

export function createMarketIntelTool() {
  return {
    name: 'market_intel',
    label: 'Market Intel',
    ownerOnly: false,
    description:
      'Real-time market intelligence — trending tokens, new pairs, whale movements, ' +
      'token analysis, and Clawnch agent leaderboard. ' +
      'Uses DexScreener, CoinGecko, and Clawnch platform data.',
    parameters: MarketIntelSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'trending':
          return handleTrending(params);
        case 'new_pairs':
          return handleNewPairs(params);
        case 'whale_watch':
          return handleWhaleWatch(params);
        case 'analysis':
          return handleAnalysis(params);
        case 'leaderboard':
          return handleLeaderboard(params);
        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}

// ─── DexScreener Helpers ─────────────────────────────────────────────────

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

async function fetchDexScreener(path: string): Promise<any> {
  const response = await fetch(`${DEXSCREENER_BASE}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`DexScreener ${response.status}`);
  return response.json();
}

// ─── Action Handlers ─────────────────────────────────────────────────────

async function handleTrending(params: Record<string, unknown>) {
  const chain = readStringParam(params, 'chain') || 'base';
  const limit = readNumberParam(params, 'limit') ?? 10;

  try {
    // Get top boosted tokens (proxy for trending)
    const boosts = await fetchDexScreener('/token-boosts/top/v1');
    
    const trending = (boosts ?? [])
      .filter((t: any) => t.chainId === chain)
      .slice(0, limit)
      .map((t: any, i: number) => ({
        rank: i + 1,
        address: t.tokenAddress,
        chain: t.chainId,
        url: t.url,
        boostAmount: t.totalAmount,
      }));

    // Also get token profiles for more detail
    const addresses = trending.map((t: any) => t.address).filter(Boolean);
    let profiles: any[] = [];
    if (addresses.length > 0) {
      try {
        const profileData = await fetchDexScreener(
          `/tokens/v1/${chain}/${addresses.slice(0, 5).join(',')}`,
        );
        profiles = Array.isArray(profileData) ? profileData : profileData?.pairs ?? [];
      } catch {
        // Non-fatal
      }
    }

    return jsonResult({
      chain,
      trending,
      count: trending.length,
      profiles: profiles.slice(0, 5).map((p: any) => ({
        symbol: p.baseToken?.symbol,
        name: p.baseToken?.name,
        priceUsd: p.priceUsd,
        change24h: p.priceChange?.h24,
        volume24h: p.volume?.h24,
        liquidity: p.liquidity?.usd,
      })),
    });
  } catch (err) {
    return errorResult(`Trending lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleNewPairs(params: Record<string, unknown>) {
  const chain = readStringParam(params, 'chain') || 'base';
  const limit = readNumberParam(params, 'limit') ?? 10;

  try {
    const data = await fetchDexScreener(`/latest/dex/pairs/${chain}`);
    const pairs = (data?.pairs ?? []).slice(0, limit);

    return jsonResult({
      chain,
      newPairs: pairs.map((p: any) => ({
        pairAddress: p.pairAddress,
        baseToken: {
          symbol: p.baseToken?.symbol,
          name: p.baseToken?.name,
          address: p.baseToken?.address,
        },
        quoteToken: p.quoteToken?.symbol,
        dexId: p.dexId,
        priceUsd: p.priceUsd,
        liquidity: p.liquidity?.usd,
        volume24h: p.volume?.h24,
        pairCreatedAt: p.pairCreatedAt,
        url: p.url,
      })),
      count: pairs.length,
    });
  } catch (err) {
    return errorResult(`New pairs lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleWhaleWatch(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token');
  const chain = readStringParam(params, 'chain') || 'base';

  // DexScreener doesn't expose whale trades directly.
  // We'll report what we can from available APIs.
  try {
    if (token) {
      // Get token data with volume spikes as a proxy for whale activity
      const data = await fetchDexScreener(
        token.startsWith('0x')
          ? `/tokens/v1/${chain}/${token}`
          : `/latest/dex/search?q=${encodeURIComponent(token)}`,
      );

      const pairs = data?.pairs ?? (Array.isArray(data) ? data : []);
      const topPair = pairs.find((p: any) => p.chainId === chain) ?? pairs[0];

      if (!topPair) {
        return jsonResult({ found: false, token, chain });
      }

      return jsonResult({
        token: topPair.baseToken?.symbol,
        address: topPair.baseToken?.address,
        chain,
        volume: {
          h1: topPair.volume?.h1,
          h6: topPair.volume?.h6,
          h24: topPair.volume?.h24,
        },
        txns: {
          h1: topPair.txns?.h1,
          h6: topPair.txns?.h6,
          h24: topPair.txns?.h24,
        },
        priceChange: {
          h1: topPair.priceChange?.h1,
          h6: topPair.priceChange?.h6,
          h24: topPair.priceChange?.h24,
        },
        note: 'Volume spikes and transaction counts can indicate whale activity. ' +
          'For detailed on-chain whale tracking, integrate with Herd Intelligence.',
      });
    }

    return jsonResult({
      chain,
      note: 'Provide a token address or symbol for whale activity analysis. ' +
        'General whale watching requires on-chain event streaming (future feature).',
    });
  } catch (err) {
    return errorResult(`Whale watch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleAnalysis(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token', { required: true })!;
  const chain = readStringParam(params, 'chain') || 'base';

  try {
    // Get DexScreener data
    const dexData = await fetchDexScreener(
      token.startsWith('0x')
        ? `/tokens/v1/${chain}/${token}`
        : `/latest/dex/search?q=${encodeURIComponent(token)}`,
    );

    const pairs = dexData?.pairs ?? (Array.isArray(dexData) ? dexData : []);
    const mainPair = pairs.find((p: any) => p.chainId === chain) ?? pairs[0];

    if (!mainPair) {
      return jsonResult({ found: false, token, chain });
    }

    // Try to get Clawnch analytics if it's a Clawnch token
    let clawnchData: any = null;
    try {
      const { ClawnchClient } = await import('@clawnch/clawncher-sdk');
      const client = new ClawnchClient({
        baseUrl: process.env.CLAWNCHER_API_URL || 'https://clawn.ch',
      });
      clawnchData = await client.getTokenAnalytics(mainPair.baseToken?.address);
    } catch {
      // Not a Clawnch token or API unavailable
    }

    return jsonResult({
      token: {
        symbol: mainPair.baseToken?.symbol,
        name: mainPair.baseToken?.name,
        address: mainPair.baseToken?.address,
      },
      chain: mainPair.chainId,
      price: {
        usd: mainPair.priceUsd,
        native: mainPair.priceNative,
      },
      change: {
        m5: mainPair.priceChange?.m5,
        h1: mainPair.priceChange?.h1,
        h6: mainPair.priceChange?.h6,
        h24: mainPair.priceChange?.h24,
      },
      volume: {
        h1: mainPair.volume?.h1,
        h6: mainPair.volume?.h6,
        h24: mainPair.volume?.h24,
      },
      transactions: mainPair.txns?.h24,
      liquidity: mainPair.liquidity?.usd,
      marketCap: mainPair.marketCap ?? mainPair.fdv,
      dex: mainPair.dexId,
      pairCreated: mainPair.pairCreatedAt,
      url: mainPair.url,
      clawnch: clawnchData ?? undefined,
    });
  } catch (err) {
    return errorResult(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleLeaderboard(params: Record<string, unknown>) {
  const limit = readNumberParam(params, 'limit') ?? 20;

  try {
    const { ClawnchClient } = await import('@clawnch/clawncher-sdk');
    const client = new ClawnchClient({
      baseUrl: process.env.CLAWNCHER_API_URL || 'https://clawn.ch',
    });

    const leaderboard = await client.getLeaderboard('market_cap', limit);

    return jsonResult({
      leaderboard,
      note: 'Ranked by total market cap of all tokens launched by each agent.',
    });
  } catch (err) {
    // Fallback: get stats
    try {
      const { ClawnchClient } = await import('@clawnch/clawncher-sdk');
      const client = new ClawnchClient({
        baseUrl: process.env.CLAWNCHER_API_URL || 'https://clawn.ch',
      });
      const stats = await client.getStats();
      return jsonResult({
        stats,
        note: 'Full leaderboard unavailable. Showing platform stats instead.',
      });
    } catch (err2) {
      return errorResult(`Leaderboard failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
