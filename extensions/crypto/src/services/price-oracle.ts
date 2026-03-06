/**
 * Multi-Source Price Oracle — cross-validated price feeds.
 *
 * Queries multiple price sources in parallel:
 * - DexScreener (current primary)
 * - CoinGecko
 * - CoinMarketCap
 * - DeFiLlama
 *
 * Cross-validates: flags if sources disagree by >2% (possible stale data
 * or manipulation). Returns the median price for robustness.
 */

import { getTokenPriceUsd, getEthPriceUsd, type DexPairData } from './dexscreener-service.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface PriceResult {
  token: string;
  chain: string;
  priceUsd: number;
  sources: PriceSource[];
  confidence: 'high' | 'medium' | 'low';
  divergencePercent: number; // max % difference between sources
  warning?: string;
}

export interface PriceSource {
  name: string;
  priceUsd: number;
  timestamp: number;
  error?: string;
}

export interface PriceOracleConfig {
  /** Sources to use. Default: all available. */
  sources?: string[];
  /** Divergence threshold in %. Flag if sources differ by more. Default: 2. */
  divergenceThreshold?: number;
  /** Per-source timeout in ms. Default: 3000. */
  timeoutMs?: number;
  /** CoinGecko API key (optional, increases rate limit). */
  coingeckoApiKey?: string;
  /** CoinMarketCap API key (required for CMC). */
  cmcApiKey?: string;
  /** Birdeye API key (required for Birdeye). */
  birdeyeApiKey?: string;
}

// ── Token ID Mappings ───────────────────────────────────────────────────────

// Well-known tokens → CoinGecko IDs
const COINGECKO_IDS: Record<string, string> = {
  ETH: 'ethereum', WETH: 'ethereum',
  BTC: 'bitcoin', WBTC: 'bitcoin',
  USDC: 'usd-coin', USDT: 'tether', DAI: 'dai',
  LINK: 'chainlink', UNI: 'uniswap', AAVE: 'aave',
  ARB: 'arbitrum', OP: 'optimism', MATIC: 'matic-network',
  CRV: 'curve-dao-token', MKR: 'maker', SNX: 'synthetix-network-token',
  COMP: 'compound-governance-token', LDO: 'lido-dao', RPL: 'rocket-pool',
  PEPE: 'pepe', SHIB: 'shiba-inu', DOGE: 'dogecoin',
};

// Well-known tokens → Birdeye chain-specific addresses (Base and Ethereum)
const BIRDEYE_ADDRESSES: Record<string, Record<string, string>> = {
  ETH: { base: 'So11111111111111111111111111111111111111112', ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  WETH: { base: '0x4200000000000000000000000000000000000006', ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  USDC: { base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  USDT: { base: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', ethereum: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  DAI: { ethereum: '0x6B175474E89094C44Da98b954EedeAC495271d0F' },
};

const BIRDEYE_CHAIN_MAP: Record<string, string> = {
  base: 'base', ethereum: 'ethereum', arbitrum: 'arbitrum',
  optimism: 'optimism', polygon: 'polygon',
};

// ── Individual Source Fetchers ───────────────────────────────────────────────

async function fetchCoinGecko(
  token: string,
  timeoutMs: number,
  apiKey?: string,
): Promise<PriceSource> {
  const cgId = COINGECKO_IDS[token.toUpperCase()];
  if (!cgId) {
    return { name: 'CoinGecko', priceUsd: 0, timestamp: Date.now(), error: 'Unknown token' };
  }

  try {
    const baseUrl = apiKey
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';
    const headers: Record<string, string> = {};
    if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

    const resp = await fetch(
      `${baseUrl}/simple/price?ids=${cgId}&vs_currencies=usd`,
      { headers, signal: AbortSignal.timeout(timeoutMs) },
    );

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as Record<string, { usd?: number }>;
    const price = data[cgId]?.usd ?? 0;

    return { name: 'CoinGecko', priceUsd: price, timestamp: Date.now() };
  } catch (err) {
    return { name: 'CoinGecko', priceUsd: 0, timestamp: Date.now(), error: (err as Error).message };
  }
}

async function fetchDeFiLlama(
  token: string,
  chain: string,
  tokenAddress: string | undefined,
  timeoutMs: number,
): Promise<PriceSource> {
  try {
    // DeFiLlama uses {chain}:{address} format
    let query: string;
    if (tokenAddress) {
      const llChain = chain === 'base' ? 'base' : chain === 'ethereum' ? 'ethereum' : chain;
      query = `${llChain}:${tokenAddress}`;
    } else {
      // Fallback: use coingecko ID
      const cgId = COINGECKO_IDS[token.toUpperCase()];
      if (!cgId) {
        return { name: 'DeFiLlama', priceUsd: 0, timestamp: Date.now(), error: 'Unknown token' };
      }
      query = `coingecko:${cgId}`;
    }

    const resp = await fetch(
      `https://coins.llama.fi/prices/current/${query}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { coins: Record<string, { price?: number; confidence?: number }> };
    const coin = Object.values(data.coins)[0];

    return {
      name: 'DeFiLlama',
      priceUsd: coin?.price ?? 0,
      timestamp: Date.now(),
    };
  } catch (err) {
    return { name: 'DeFiLlama', priceUsd: 0, timestamp: Date.now(), error: (err as Error).message };
  }
}

async function fetchCoinMarketCap(
  token: string,
  timeoutMs: number,
  apiKey?: string,
): Promise<PriceSource> {
  if (!apiKey) {
    return { name: 'CoinMarketCap', priceUsd: 0, timestamp: Date.now(), error: 'No API key' };
  }

  try {
    const resp = await fetch(
      `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${token.toUpperCase()}`,
      {
        headers: {
          'X-CMC_PRO_API_KEY': apiKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as any;
    const entry = Object.values(data.data ?? {})[0] as any;
    const price = entry?.quote?.USD?.price ?? 0;

    return { name: 'CoinMarketCap', priceUsd: price, timestamp: Date.now() };
  } catch (err) {
    return { name: 'CoinMarketCap', priceUsd: 0, timestamp: Date.now(), error: (err as Error).message };
  }
}

async function fetchBirdeye(
  token: string,
  chain: string,
  tokenAddress: string | undefined,
  timeoutMs: number,
  apiKey?: string,
): Promise<PriceSource> {
  if (!apiKey) {
    return { name: 'Birdeye', priceUsd: 0, timestamp: Date.now(), error: 'No API key (BIRDEYE_API_KEY)' };
  }

  try {
    // Resolve address: use provided address, or look up from well-known table
    const address = tokenAddress ?? BIRDEYE_ADDRESSES[token.toUpperCase()]?.[chain];
    if (!address) {
      return { name: 'Birdeye', priceUsd: 0, timestamp: Date.now(), error: 'Unknown token address for Birdeye' };
    }

    const birdeyeChain = BIRDEYE_CHAIN_MAP[chain] ?? 'base';
    const resp = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${address}`,
      {
        headers: {
          'X-API-KEY': apiKey,
          'x-chain': birdeyeChain,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as any;
    const price = data.data?.value ?? 0;

    return { name: 'Birdeye', priceUsd: price, timestamp: Date.now() };
  } catch (err) {
    return { name: 'Birdeye', priceUsd: 0, timestamp: Date.now(), error: (err as Error).message };
  }
}

async function fetchDexScreenerPrice(
  token: string,
  chain: string,
  timeoutMs: number,
): Promise<PriceSource> {
  try {
    const { priceUsd } = await getTokenPriceUsd(token, chain);
    return { name: 'DexScreener', priceUsd, timestamp: Date.now() };
  } catch (err) {
    return { name: 'DexScreener', priceUsd: 0, timestamp: Date.now(), error: (err as Error).message };
  }
}

// ── Price Oracle ────────────────────────────────────────────────────────────

export class PriceOracle {
  private config: Required<PriceOracleConfig>;

  constructor(userConfig: PriceOracleConfig = {}) {
    this.config = {
      sources: userConfig.sources ?? ['DexScreener', 'CoinGecko', 'DeFiLlama', 'CoinMarketCap', 'Birdeye'],
      divergenceThreshold: userConfig.divergenceThreshold ?? 2,
      timeoutMs: userConfig.timeoutMs ?? 3000,
      coingeckoApiKey: userConfig.coingeckoApiKey ?? process.env.COINGECKO_API_KEY ?? '',
      cmcApiKey: userConfig.cmcApiKey ?? process.env.CMC_API_KEY ?? '',
      birdeyeApiKey: userConfig.birdeyeApiKey ?? process.env.BIRDEYE_API_KEY ?? '',
    };
  }

  /**
   * Get a cross-validated price for a token.
   * Queries all enabled sources in parallel, computes median, checks divergence.
   */
  async getPrice(
    token: string,
    chain = 'base',
    tokenAddress?: string,
  ): Promise<PriceResult> {
    const fetchers: Array<Promise<PriceSource>> = [];
    const enabled = this.config.sources;

    if (enabled.includes('DexScreener')) {
      fetchers.push(fetchDexScreenerPrice(token, chain, this.config.timeoutMs));
    }
    if (enabled.includes('CoinGecko')) {
      fetchers.push(fetchCoinGecko(token, this.config.timeoutMs, this.config.coingeckoApiKey || undefined));
    }
    if (enabled.includes('DeFiLlama')) {
      fetchers.push(fetchDeFiLlama(token, chain, tokenAddress, this.config.timeoutMs));
    }
    if (enabled.includes('CoinMarketCap')) {
      fetchers.push(fetchCoinMarketCap(token, this.config.timeoutMs, this.config.cmcApiKey || undefined));
    }
    if (enabled.includes('Birdeye')) {
      fetchers.push(fetchBirdeye(token, chain, tokenAddress, this.config.timeoutMs, this.config.birdeyeApiKey || undefined));
    }

    const sources = await Promise.all(fetchers);
    const valid = sources.filter((s) => !s.error && s.priceUsd > 0);

    if (valid.length === 0) {
      return {
        token,
        chain,
        priceUsd: 0,
        sources,
        confidence: 'low',
        divergencePercent: 0,
        warning: 'No sources returned a valid price.',
      };
    }

    // Calculate median price
    const prices = valid.map((s) => s.priceUsd).sort((a, b) => a - b);
    const median = prices.length % 2 === 0
      ? (prices[prices.length / 2 - 1]! + prices[prices.length / 2]!) / 2
      : prices[Math.floor(prices.length / 2)]!;

    // Calculate max divergence from median
    const maxDivergence = valid.reduce((max, s) => {
      const div = Math.abs(s.priceUsd - median) / median * 100;
      return Math.max(max, div);
    }, 0);

    // Determine confidence
    let confidence: 'high' | 'medium' | 'low';
    let warning: string | undefined;

    if (valid.length >= 3 && maxDivergence < this.config.divergenceThreshold) {
      confidence = 'high';
    } else if (valid.length >= 2 && maxDivergence < this.config.divergenceThreshold * 2) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    if (maxDivergence >= this.config.divergenceThreshold) {
      const divergentSources = valid
        .filter((s) => Math.abs(s.priceUsd - median) / median * 100 >= this.config.divergenceThreshold)
        .map((s) => `${s.name}: $${s.priceUsd.toFixed(4)}`);
      warning = `Price sources disagree by ${maxDivergence.toFixed(1)}%: ${divergentSources.join(', ')}. ` +
        `Using median: $${median.toFixed(4)}. Possible stale data or manipulation.`;
    }

    return {
      token,
      chain,
      priceUsd: median,
      sources,
      confidence,
      divergencePercent: Math.round(maxDivergence * 100) / 100,
      warning,
    };
  }

  /**
   * Get ETH price from multiple sources.
   */
  async getEthPrice(): Promise<PriceResult> {
    return this.getPrice('ETH', 'base');
  }

  /**
   * Batch price lookup for multiple tokens.
   */
  async getPrices(
    tokens: Array<{ symbol: string; chain?: string; address?: string }>,
  ): Promise<PriceResult[]> {
    return Promise.all(
      tokens.map((t) => this.getPrice(t.symbol, t.chain ?? 'base', t.address)),
    );
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: PriceOracle | null = null;

export function getPriceOracle(config?: PriceOracleConfig): PriceOracle {
  if (!_instance) {
    _instance = new PriceOracle(config);
  }
  return _instance;
}

export function resetPriceOracle(): void {
  _instance = null;
}
