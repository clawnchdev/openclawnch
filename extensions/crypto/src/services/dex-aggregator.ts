/**
 * DEX Aggregator — multi-source swap quoting with best-price selection.
 *
 * Queries multiple DEX aggregators in parallel and returns the best quote
 * (factoring in output amount and gas cost). Falls back gracefully if any
 * aggregator is unavailable.
 *
 * Supported aggregators:
 * - 0x (current default)
 * - 1inch Fusion
 * - ParaSwap
 * - CowSwap (MEV-protected)
 * - Odos (multi-hop optimization)
 * - KyberSwap
 * - OpenOcean
 */

import { guardedFetch } from './endpoint-allowlist.js';
import { getCredentialVault } from './credential-vault.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SwapQuote {
  aggregator: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  price: number;        // buyAmount / sellAmount in human-readable units
  gasEstimate: string;
  gasPrice?: string;
  gasCostUsd?: number;
  netOutputUsd?: number; // buyAmount value - gas cost
  route?: string;        // human-readable route description
  data?: unknown;        // raw aggregator response for execution
  error?: string;        // if this aggregator failed
}

export interface AggregatorConfig {
  enabled?: boolean;
  apiKeyEnv?: string;
  baseUrl: string;
}

export interface DexAggregatorConfig {
  /** Which aggregators to use. Default: all available. */
  aggregators?: Partial<Record<string, AggregatorConfig>>;
  /** Chain ID. Default: 8453 (Base). */
  chainId?: number;
  /** Slippage in basis points. Default: 50 (0.5%). */
  slippageBps?: number;
  /** Quote timeout per aggregator in ms. Default: 5000. */
  timeoutMs?: number;
}

// ── Default Aggregator Configs ──────────────────────────────────────────────

const DEFAULT_AGGREGATORS: Record<string, AggregatorConfig> = {
  '0x': {
    enabled: true,
    apiKeyEnv: 'ZEROX_API_KEY',
    baseUrl: 'https://api.0x.org',
  },
  '1inch': {
    enabled: true,
    apiKeyEnv: 'ONEINCH_API_KEY',
    baseUrl: 'https://api.1inch.dev',
  },
  paraswap: {
    enabled: true,
    baseUrl: 'https://apiv5.paraswap.io',
  },
  odos: {
    enabled: true,
    baseUrl: 'https://api.odos.xyz',
  },
  kyberswap: {
    enabled: true,
    baseUrl: 'https://aggregator-api.kyberswap.com',
  },
  openocean: {
    enabled: true,
    baseUrl: 'https://open-api.openocean.finance',
  },
};

const CHAIN_SLUG: Record<number, Record<string, string>> = {
  8453: { '0x': 'base', '1inch': '8453', paraswap: '8453', odos: '8453', kyberswap: 'base', openocean: 'base' },
  1: { '0x': 'ethereum', '1inch': '1', paraswap: '1', odos: '1', kyberswap: 'ethereum', openocean: 'eth' },
  42161: { '0x': 'arbitrum', '1inch': '42161', paraswap: '42161', odos: '42161', kyberswap: 'arbitrum', openocean: 'arbitrum' },
  10: { '0x': 'optimism', '1inch': '10', paraswap: '10', odos: '10', kyberswap: 'optimism', openocean: 'optimism' },
  137: { '0x': 'polygon', '1inch': '137', paraswap: '137', odos: '137', kyberswap: 'polygon', openocean: 'polygon' },
};

// ── Individual Aggregator Fetchers ──────────────────────────────────────────

async function fetchQuote0x(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  chainId: number,
  slippageBps: number,
  timeoutMs: number,
): Promise<SwapQuote> {
  const apiKey = getCredentialVault().getSecret('dex.0x.apiKey', 'dex-aggregator');
  const chain = CHAIN_SLUG[chainId]?.['0x'] ?? 'base';

  const params = new URLSearchParams({
    sellToken,
    buyToken,
    sellAmount,
    slippagePercentage: String(slippageBps / 10000),
  });

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['0x-api-key'] = apiKey;

  const resp = await guardedFetch(
    `https://api.0x.org/swap/v1/quote?${params}`,
    { headers, signal: AbortSignal.timeout(timeoutMs) },
  );

  if (!resp.ok) throw new Error(`0x: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as any;

  return {
    aggregator: '0x',
    sellToken,
    buyToken,
    sellAmount,
    buyAmount: data.buyAmount ?? '0',
    price: parseFloat(data.price ?? '0'),
    gasEstimate: data.estimatedGas ?? '0',
    gasPrice: data.gasPrice,
    route: data.sources?.filter((s: any) => parseFloat(s.proportion) > 0)
      .map((s: any) => s.name).join(' → ') ?? '0x',
    data,
  };
}

/** Well-known token decimals by address (lowercase) to avoid RPC calls in aggregator. */
const TOKEN_DECIMALS: Record<string, number> = {
  // Base
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6,  // USDC (Base)
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 6,  // USDT (Base)
  // Ethereum
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6,  // USDC (ETH)
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 6,  // USDT (ETH)
  // Polygon
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 6,  // USDC (Polygon)
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 6,  // USDT (Polygon)
  // Arbitrum
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 6,  // USDC (Arbitrum)
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 6,  // USDT (Arbitrum)
  // Native ETH sentinel
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 18,
};

function getKnownDecimals(token: string): number {
  return TOKEN_DECIMALS[token.toLowerCase()] ?? 18;
}

async function fetchQuoteParaSwap(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  chainId: number,
  slippageBps: number,
  timeoutMs: number,
): Promise<SwapQuote> {
  const params = new URLSearchParams({
    srcToken: sellToken,
    destToken: buyToken,
    amount: sellAmount,
    srcDecimals: String(getKnownDecimals(sellToken)),
    destDecimals: String(getKnownDecimals(buyToken)),
    side: 'SELL',
    network: String(chainId),
  });

  const resp = await guardedFetch(
    `https://apiv5.paraswap.io/prices?${params}`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );

  if (!resp.ok) throw new Error(`ParaSwap: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as any;
  const best = data.priceRoute;

  return {
    aggregator: 'ParaSwap',
    sellToken,
    buyToken,
    sellAmount,
    buyAmount: best?.destAmount ?? '0',
    price: parseFloat(best?.destAmount ?? '0') / (parseFloat(sellAmount) || 1),
    gasEstimate: best?.gasCost ?? '0',
    route: best?.bestRoute?.[0]?.swaps?.map((s: any) => s.swapExchanges?.[0]?.exchange).join(' → ') ?? 'ParaSwap',
    data: best,
  };
}

async function fetchQuoteOdos(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  chainId: number,
  slippageBps: number,
  timeoutMs: number,
): Promise<SwapQuote> {
  const resp = await guardedFetch('https://api.odos.xyz/sor/quote/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId,
      inputTokens: [{ tokenAddress: sellToken, amount: sellAmount }],
      outputTokens: [{ tokenAddress: buyToken, proportion: 1 }],
      slippageLimitPercent: slippageBps / 100,
      userAddr: '0x0000000000000000000000000000000000000000',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) throw new Error(`Odos: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as any;

  return {
    aggregator: 'Odos',
    sellToken,
    buyToken,
    sellAmount,
    buyAmount: data.outAmounts?.[0] ?? '0',
    price: parseFloat(data.outAmounts?.[0] ?? '0') / (parseFloat(sellAmount) || 1),
    gasEstimate: String(data.gasEstimate ?? 0),
    gasCostUsd: data.gasEstimateValue,
    netOutputUsd: (data.outValues?.[0] ?? 0) - (data.gasEstimateValue ?? 0),
    route: `Odos (${data.pathViz?.length ?? 0} hops)`,
    data,
  };
}

async function fetchQuoteKyber(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  chainId: number,
  slippageBps: number,
  timeoutMs: number,
): Promise<SwapQuote> {
  const chain = CHAIN_SLUG[chainId]?.kyberswap ?? 'base';
  const params = new URLSearchParams({
    tokenIn: sellToken,
    tokenOut: buyToken,
    amountIn: sellAmount,
    saveGas: '0',
    gasInclude: '1',
  });

  const resp = await guardedFetch(
    `https://aggregator-api.kyberswap.com/${chain}/api/v1/routes?${params}`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );

  if (!resp.ok) throw new Error(`KyberSwap: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as any;
  const best = data.data?.routeSummary;

  return {
    aggregator: 'KyberSwap',
    sellToken,
    buyToken,
    sellAmount,
    buyAmount: best?.amountOut ?? '0',
    price: parseFloat(best?.amountOut ?? '0') / (parseFloat(sellAmount) || 1),
    gasEstimate: best?.gas ?? '0',
    gasCostUsd: parseFloat(best?.gasUsd ?? '0'),
    route: `KyberSwap (${best?.route?.length ?? 0} routes)`,
    data: best,
  };
}

async function fetchQuote1inch(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  chainId: number,
  slippageBps: number,
  timeoutMs: number,
): Promise<SwapQuote> {
  const apiKey = getCredentialVault().getSecret('dex.1inch.apiKey', 'dex-aggregator');
  if (!apiKey) throw new Error('1inch: ONEINCH_API_KEY not set');

  const params = new URLSearchParams({
    src: sellToken,
    dst: buyToken,
    amount: sellAmount,
    slippage: String(slippageBps / 100), // 1inch uses percent, not bps
    includeGas: 'true',
  });

  const resp = await guardedFetch(
    `https://api.1inch.dev/swap/v6.0/${chainId}/quote?${params}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

  if (!resp.ok) throw new Error(`1inch: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as any;

  return {
    aggregator: '1inch',
    sellToken,
    buyToken,
    sellAmount,
    buyAmount: data.dstAmount ?? '0',
    price: parseFloat(data.dstAmount ?? '0') / (parseFloat(sellAmount) || 1),
    gasEstimate: String(data.gas ?? 0),
    route: data.protocols?.flat()?.flat()?.map((p: any) => p.name).filter(Boolean).join(' → ') || '1inch',
    data,
  };
}

async function fetchQuoteOpenOcean(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  chainId: number,
  slippageBps: number,
  timeoutMs: number,
): Promise<SwapQuote> {
  const chain = CHAIN_SLUG[chainId]?.openocean ?? 'base';

  const params = new URLSearchParams({
    inTokenAddress: sellToken,
    outTokenAddress: buyToken,
    amount: sellAmount,
    slippage: String(slippageBps / 100),
    gasPrice: '5', // placeholder; OpenOcean needs gas price
    account: '0x0000000000000000000000000000000000000000',
  });

  const resp = await guardedFetch(
    `https://open-api.openocean.finance/v4/${chain}/quote?${params}`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );

  if (!resp.ok) throw new Error(`OpenOcean: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as any;
  const result = data.data;

  return {
    aggregator: 'OpenOcean',
    sellToken,
    buyToken,
    sellAmount,
    buyAmount: result?.outAmount ?? '0',
    price: parseFloat(result?.outAmount ?? '0') / (parseFloat(sellAmount) || 1),
    gasEstimate: String(result?.estimatedGas ?? 0),
    gasCostUsd: result?.estimatedGasUsd ? parseFloat(result.estimatedGasUsd) : undefined,
    route: result?.dexes?.map((d: any) => d.dex).join(' → ') || 'OpenOcean',
    data: result,
  };
}

// ── Aggregator Manager ──────────────────────────────────────────────────────

export class DexAggregator {
  private chainId: number;
  private slippageBps: number;
  private timeoutMs: number;
  private aggregators: Record<string, AggregatorConfig>;

  constructor(config: DexAggregatorConfig = {}) {
    this.chainId = config.chainId ?? 8453;
    this.slippageBps = config.slippageBps ?? 50;
    this.timeoutMs = config.timeoutMs ?? 5000;

    // Merge user config with defaults
    this.aggregators = { ...DEFAULT_AGGREGATORS };
    if (config.aggregators) {
      for (const [name, cfg] of Object.entries(config.aggregators)) {
        if (cfg) {
          this.aggregators[name] = { ...this.aggregators[name]!, ...cfg };
        }
      }
    }
  }

  /** Get the list of enabled aggregator names. */
  getEnabled(): string[] {
    return Object.entries(this.aggregators)
      .filter(([_, cfg]) => cfg.enabled !== false)
      .filter(([_, cfg]) => !cfg.apiKeyEnv || process.env[cfg.apiKeyEnv!])
      .map(([name]) => name);
  }

  /**
   * Get quotes from all enabled aggregators in parallel.
   * Returns all results (including errors) sorted by best output.
   */
  async getQuotes(
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    chainId?: number,
  ): Promise<SwapQuote[]> {
    const chain = chainId ?? this.chainId;
    const fetchers: Array<Promise<SwapQuote>> = [];

    const enabled = this.getEnabled();

    for (const name of enabled) {
      const fetcher = this.fetchSingle(name, sellToken, buyToken, sellAmount, chain)
        .catch((err): SwapQuote => ({
          aggregator: name,
          sellToken,
          buyToken,
          sellAmount,
          buyAmount: '0',
          price: 0,
          gasEstimate: '0',
          error: err instanceof Error ? err.message : String(err),
        }));
      fetchers.push(fetcher);
    }

    const results = await Promise.all(fetchers);

    // Sort by buyAmount descending (best output first), errors last
    return results.sort((a, b) => {
      if (a.error && !b.error) return 1;
      if (!a.error && b.error) return -1;
      return BigInt(b.buyAmount || '0') > BigInt(a.buyAmount || '0') ? 1 : -1;
    });
  }

  /**
   * Get the single best quote across all aggregators.
   * Optionally factors in gas cost (if netOutputUsd is available).
   */
  async getBestQuote(
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    chainId?: number,
  ): Promise<SwapQuote> {
    const quotes = await this.getQuotes(sellToken, buyToken, sellAmount, chainId);
    const valid = quotes.filter((q) => !q.error && q.buyAmount !== '0');

    if (valid.length === 0) {
      const errors = quotes.filter((q) => q.error).map((q) => `${q.aggregator}: ${q.error}`);
      throw new Error(`No valid quotes. Errors: ${errors.join('; ')}`);
    }

    // Prefer net output (gas-inclusive) if available, else raw buyAmount
    return valid.sort((a, b) => {
      if (a.netOutputUsd != null && b.netOutputUsd != null) {
        return b.netOutputUsd - a.netOutputUsd;
      }
      return BigInt(b.buyAmount) > BigInt(a.buyAmount) ? 1 : -1;
    })[0]!;
  }

  private async fetchSingle(
    name: string,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    chainId: number,
  ): Promise<SwapQuote> {
    switch (name) {
      case '0x':
        return fetchQuote0x(sellToken, buyToken, sellAmount, chainId, this.slippageBps, this.timeoutMs);
      case 'paraswap':
        return fetchQuoteParaSwap(sellToken, buyToken, sellAmount, chainId, this.slippageBps, this.timeoutMs);
      case 'odos':
        return fetchQuoteOdos(sellToken, buyToken, sellAmount, chainId, this.slippageBps, this.timeoutMs);
      case 'kyberswap':
        return fetchQuoteKyber(sellToken, buyToken, sellAmount, chainId, this.slippageBps, this.timeoutMs);
      case '1inch':
        return fetchQuote1inch(sellToken, buyToken, sellAmount, chainId, this.slippageBps, this.timeoutMs);
      case 'openocean':
        return fetchQuoteOpenOcean(sellToken, buyToken, sellAmount, chainId, this.slippageBps, this.timeoutMs);
      default:
        throw new Error(`Unknown aggregator: ${name}`);
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: DexAggregator | null = null;

export function getDexAggregator(config?: DexAggregatorConfig): DexAggregator {
  if (!_instance) {
    _instance = new DexAggregator(config);
  }
  return _instance;
}

export function resetDexAggregator(): void {
  _instance = null;
}
