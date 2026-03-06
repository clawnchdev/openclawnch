/**
 * Portfolio Snapshot Service — multi-chain balance aggregation and analysis.
 *
 * Provides:
 * - Cross-chain portfolio value (Ethereum, Base, Arbitrum, Optimism, Polygon)
 * - Token-by-token breakdown with allocation percentages
 * - Native + ERC-20 balances with USD values
 * - Historical comparison (P&L since last snapshot)
 * - Risk metrics (concentration, stablecoin ratio)
 */

import { getRpcManager } from './rpc-provider.js';
import { getPriceOracle } from './price-oracle.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface TokenBalance {
  symbol: string;
  address: string;   // '0x0' for native token
  chain: string;
  chainId: number;
  balance: string;    // raw units
  balanceHuman: number;
  decimals: number;
  priceUsd: number;
  valueUsd: number;
  allocationPercent: number;  // % of total portfolio
}

export interface ChainSummary {
  chain: string;
  chainId: number;
  valueUsd: number;
  allocationPercent: number;
  tokenCount: number;
}

export interface PortfolioSnapshot {
  owner: string;
  totalValueUsd: number;
  chains: ChainSummary[];
  tokens: TokenBalance[];
  stablecoinRatio: number;   // 0-1 (% of portfolio in stablecoins)
  topConcentration: number;  // 0-1 (% of portfolio in the single largest position)
  riskLevel: 'conservative' | 'moderate' | 'aggressive';
  timestamp: number;
}

export interface PortfolioChange {
  current: PortfolioSnapshot;
  previous: PortfolioSnapshot | null;
  changeUsd: number;
  changePercent: number;
  newPositions: string[];
  closedPositions: string[];
}

export interface PortfolioConfig {
  /** Chains to scan. Default: all supported. */
  chainIds?: number[];
  /** Minimum balance in USD to include a token. Default: 0.01 */
  minValueUsd?: number;
  /** Cache TTL for snapshots in ms. Default: 60000 (1 minute). */
  cacheTtlMs?: number;
}

// ── ERC-20 ABI (minimal) ────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── Well-Known Tokens Per Chain ─────────────────────────────────────────────

const TOKENS: Record<number, Array<{ symbol: string; address: string; decimals: number; isStablecoin: boolean }>> = {
  8453: [
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, isStablecoin: true },
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, isStablecoin: false },
    { symbol: 'DAI', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, isStablecoin: true },
    { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, isStablecoin: true },
    { symbol: 'cbETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, isStablecoin: false },
  ],
  1: [
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, isStablecoin: true },
    { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, isStablecoin: false },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, isStablecoin: true },
    { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, isStablecoin: true },
    { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, isStablecoin: false },
    { symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18, isStablecoin: false },
    { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18, isStablecoin: false },
    { symbol: 'AAVE', address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18, isStablecoin: false },
  ],
  42161: [
    { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, isStablecoin: true },
    { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, isStablecoin: false },
    { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, isStablecoin: true },
    { symbol: 'ARB', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18, isStablecoin: false },
    { symbol: 'DAI', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, isStablecoin: true },
  ],
  10: [
    { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, isStablecoin: true },
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, isStablecoin: false },
    { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6, isStablecoin: true },
    { symbol: 'OP', address: '0x4200000000000000000000000000000000000042', decimals: 18, isStablecoin: false },
    { symbol: 'DAI', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, isStablecoin: true },
  ],
  137: [
    { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, isStablecoin: true },
    { symbol: 'WETH', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18, isStablecoin: false },
    { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, isStablecoin: true },
    { symbol: 'WMATIC', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18, isStablecoin: false },
    { symbol: 'DAI', address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18, isStablecoin: true },
  ],
};

const CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon',
};

const NATIVE_SYMBOL: Record<number, string> = {
  1: 'ETH', 8453: 'ETH', 42161: 'ETH', 10: 'ETH', 137: 'MATIC',
};

// ── Service ─────────────────────────────────────────────────────────────────

export class PortfolioSnapshotService {
  private config: Required<PortfolioConfig>;
  private cache: Map<string, { snapshot: PortfolioSnapshot; expiresAt: number }> = new Map();
  private previousSnapshots: Map<string, PortfolioSnapshot> = new Map();

  constructor(config: PortfolioConfig = {}) {
    this.config = {
      chainIds: config.chainIds ?? [8453, 1, 42161, 10, 137],
      minValueUsd: config.minValueUsd ?? 0.01,
      cacheTtlMs: config.cacheTtlMs ?? 60_000,
    };
  }

  /**
   * Take a full portfolio snapshot across all configured chains.
   */
  async getSnapshot(ownerAddress: string): Promise<PortfolioSnapshot> {
    // Check cache
    const cached = this.cache.get(ownerAddress);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.snapshot;
    }

    const rpcManager = getRpcManager();
    const oracle = getPriceOracle();
    const allTokens: TokenBalance[] = [];

    // Scan each chain in parallel
    const chainResults = await Promise.all(
      this.config.chainIds.map(async (chainId) => {
        try {
          const client = await rpcManager.getClient(chainId);
          const chain = CHAIN_NAMES[chainId] ?? String(chainId);
          const nativeSymbol = NATIVE_SYMBOL[chainId] ?? 'ETH';

          // Get native balance
          const nativeBalance = await client.getBalance({ address: ownerAddress as `0x${string}` });
          const nativeHuman = Number(nativeBalance) / 1e18;

          // Get native token price
          const nativePrice = await oracle.getPrice(nativeSymbol, chain).catch(() => ({ priceUsd: 0 }));

          const tokens: TokenBalance[] = [];

          if (nativeHuman > 0) {
            tokens.push({
              symbol: nativeSymbol,
              address: '0x0000000000000000000000000000000000000000',
              chain,
              chainId,
              balance: nativeBalance.toString(),
              balanceHuman: nativeHuman,
              decimals: 18,
              priceUsd: nativePrice.priceUsd,
              valueUsd: nativeHuman * nativePrice.priceUsd,
              allocationPercent: 0, // computed later
            });
          }

          // Get ERC-20 balances for well-known tokens
          const chainTokens = TOKENS[chainId] ?? [];
          const tokenResults = await Promise.all(
            chainTokens.map(async (tok) => {
              try {
                const balance = await client.readContract({
                  address: tok.address as `0x${string}`,
                  abi: ERC20_ABI,
                  functionName: 'balanceOf',
                  args: [ownerAddress as `0x${string}`],
                });
                const raw = balance as bigint;
                if (raw === 0n) return null;

                const human = Number(raw) / 10 ** tok.decimals;
                const price = tok.isStablecoin
                  ? { priceUsd: 1 } // skip price lookup for stablecoins
                  : await oracle.getPrice(tok.symbol, chain).catch(() => ({ priceUsd: 0 }));

                return {
                  symbol: tok.symbol,
                  address: tok.address,
                  chain,
                  chainId,
                  balance: raw.toString(),
                  balanceHuman: human,
                  decimals: tok.decimals,
                  priceUsd: price.priceUsd,
                  valueUsd: human * price.priceUsd,
                  allocationPercent: 0,
                  _isStablecoin: tok.isStablecoin,
                } as TokenBalance & { _isStablecoin: boolean };
              } catch {
                return null;
              }
            }),
          );

          tokens.push(...tokenResults.filter((t): t is TokenBalance => t !== null && t.valueUsd >= this.config.minValueUsd));
          return tokens;
        } catch {
          return [];
        }
      }),
    );

    // Flatten all chain results
    for (const tokens of chainResults) {
      allTokens.push(...tokens);
    }

    // Compute total value
    const totalValueUsd = allTokens.reduce((sum, t) => sum + t.valueUsd, 0);

    // Compute allocation percentages
    for (const token of allTokens) {
      token.allocationPercent = totalValueUsd > 0
        ? Math.round((token.valueUsd / totalValueUsd) * 10000) / 100
        : 0;
    }

    // Sort by value descending
    allTokens.sort((a, b) => b.valueUsd - a.valueUsd);

    // Compute chain summaries
    const chainMap = new Map<number, ChainSummary>();
    for (const token of allTokens) {
      const existing = chainMap.get(token.chainId);
      if (existing) {
        existing.valueUsd += token.valueUsd;
        existing.tokenCount++;
      } else {
        chainMap.set(token.chainId, {
          chain: token.chain,
          chainId: token.chainId,
          valueUsd: token.valueUsd,
          allocationPercent: 0,
          tokenCount: 1,
        });
      }
    }
    const chains = Array.from(chainMap.values()).sort((a, b) => b.valueUsd - a.valueUsd);
    for (const chain of chains) {
      chain.allocationPercent = totalValueUsd > 0
        ? Math.round((chain.valueUsd / totalValueUsd) * 10000) / 100
        : 0;
    }

    // Risk metrics
    const stablecoinValue = allTokens
      .filter((t) => this.isStablecoin(t.symbol))
      .reduce((sum, t) => sum + t.valueUsd, 0);
    const stablecoinRatio = totalValueUsd > 0 ? stablecoinValue / totalValueUsd : 0;
    const topConcentration = allTokens.length > 0 && totalValueUsd > 0
      ? allTokens[0]!.valueUsd / totalValueUsd
      : 0;

    let riskLevel: 'conservative' | 'moderate' | 'aggressive';
    if (stablecoinRatio > 0.6) riskLevel = 'conservative';
    else if (stablecoinRatio > 0.3 && topConcentration < 0.5) riskLevel = 'moderate';
    else riskLevel = 'aggressive';

    const snapshot: PortfolioSnapshot = {
      owner: ownerAddress,
      totalValueUsd: Math.round(totalValueUsd * 100) / 100,
      chains,
      tokens: allTokens,
      stablecoinRatio: Math.round(stablecoinRatio * 1000) / 1000,
      topConcentration: Math.round(topConcentration * 1000) / 1000,
      riskLevel,
      timestamp: Date.now(),
    };

    // Cache
    this.cache.set(ownerAddress, { snapshot, expiresAt: Date.now() + this.config.cacheTtlMs });

    return snapshot;
  }

  /**
   * Get portfolio change since last snapshot.
   */
  async getChange(ownerAddress: string): Promise<PortfolioChange> {
    const previous = this.previousSnapshots.get(ownerAddress) ?? null;
    const current = await this.getSnapshot(ownerAddress);

    // Save current as previous for next comparison
    this.previousSnapshots.set(ownerAddress, current);

    const changeUsd = previous ? current.totalValueUsd - previous.totalValueUsd : 0;
    const changePercent = previous && previous.totalValueUsd > 0
      ? (changeUsd / previous.totalValueUsd) * 100
      : 0;

    const currentSymbols = new Set(current.tokens.map((t) => `${t.symbol}:${t.chain}`));
    const previousSymbols = new Set(previous?.tokens.map((t) => `${t.symbol}:${t.chain}`) ?? []);

    const newPositions = [...currentSymbols].filter((s) => !previousSymbols.has(s));
    const closedPositions = [...previousSymbols].filter((s) => !currentSymbols.has(s));

    return {
      current,
      previous,
      changeUsd: Math.round(changeUsd * 100) / 100,
      changePercent: Math.round(changePercent * 100) / 100,
      newPositions,
      closedPositions,
    };
  }

  /**
   * Get supported chains.
   */
  getSupportedChains(): Array<{ chainId: number; name: string }> {
    return this.config.chainIds.map((id) => ({
      chainId: id,
      name: CHAIN_NAMES[id] ?? String(id),
    }));
  }

  /** Clear the snapshot cache. */
  clearCache(): void {
    this.cache.clear();
  }

  private isStablecoin(symbol: string): boolean {
    const stables = ['USDC', 'USDT', 'DAI', 'BUSD', 'FRAX', 'LUSD', 'USDbC', 'TUSD'];
    return stables.includes(symbol.toUpperCase());
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: PortfolioSnapshotService | null = null;

export function getPortfolioService(config?: PortfolioConfig): PortfolioSnapshotService {
  if (!_instance) {
    _instance = new PortfolioSnapshotService(config);
  }
  return _instance;
}

export function resetPortfolioService(): void {
  _instance = null;
}
