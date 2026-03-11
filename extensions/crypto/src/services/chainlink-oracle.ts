/**
 * Chainlink Oracle Feed Service — on-chain price verification.
 *
 * Reads Chainlink price feed aggregator contracts to get decentralized,
 * tamper-resistant price data directly from the blockchain. Used as a
 * verification layer before large swaps to detect price manipulation.
 *
 * Supported feeds:
 * - ETH/USD, BTC/USD, LINK/USD, UNI/USD, AAVE/USD, etc.
 * - Available on Ethereum, Base, Arbitrum, Optimism, Polygon
 *
 * Architecture:
 * - Reads `latestRoundData()` from Chainlink AggregatorV3Interface
 * - Validates staleness (rejects if older than maxStalenessSeconds)
 * - Cross-references with DEX prices to detect discrepancies
 */

import { getRpcManager } from './rpc-provider.js';
import { CHAINLINK_FEEDS } from '../lib/contract-registry.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ChainlinkPriceResult {
  pair: string;
  priceUsd: number;
  decimals: number;
  roundId: string;
  updatedAt: number;  // unix timestamp
  answeredInRound: string;
  staleness: number;  // seconds since last update
  isStale: boolean;
  chain: string;
  feedAddress: string;
}

export interface ChainlinkOracleConfig {
  /** Max staleness in seconds. Default: 3600 (1 hour). */
  maxStalenessSeconds?: number;
  /** Price divergence threshold in % to flag discrepancy. Default: 2. */
  divergenceThresholdPercent?: number;
}

// ── Chainlink AggregatorV3Interface ABI (minimal) ───────────────────────────

const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
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
  {
    inputs: [],
    name: 'description',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── Feed Registry ───────────────────────────────────────────────────────────

/**
 * Chainlink price feed addresses per chain.
 * Source: contract-registry.ts (single source of truth)
 * Original: https://docs.chain.link/data-feeds/price-feeds/addresses
 */
const FEED_ADDRESSES: Record<number, Record<string, string>> = CHAINLINK_FEEDS;

// ── Chain Name Resolution ───────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon',
};

// ── Service ─────────────────────────────────────────────────────────────────

export class ChainlinkOracle {
  private config: Required<ChainlinkOracleConfig>;

  constructor(userConfig: ChainlinkOracleConfig = {}) {
    this.config = {
      maxStalenessSeconds: userConfig.maxStalenessSeconds ?? 3600,
      divergenceThresholdPercent: userConfig.divergenceThresholdPercent ?? 2,
    };
  }

  /**
   * Get a Chainlink price for a trading pair (e.g., "ETH/USD").
   * Reads directly from the on-chain aggregator contract.
   */
  async getPrice(pair: string, chainId = 8453): Promise<ChainlinkPriceResult> {
    const normalizedPair = pair.toUpperCase().replace(/\s/g, '');
    const feeds = FEED_ADDRESSES[chainId];
    if (!feeds) {
      throw new ChainlinkError(`Chainlink feeds not available for chain ${chainId}`);
    }

    const feedAddress = feeds[normalizedPair];
    if (!feedAddress) {
      const available = Object.keys(feeds).join(', ');
      throw new ChainlinkError(
        `No Chainlink feed for ${normalizedPair} on ${CHAIN_NAMES[chainId] ?? chainId}. Available: ${available}`,
      );
    }

    const rpcManager = getRpcManager();
    const client = await rpcManager.getClient(chainId);

    // Read decimals + latestRoundData in parallel
    const [decimals, roundData] = await Promise.all([
      client.readContract({
        address: feedAddress as `0x${string}`,
        abi: AGGREGATOR_V3_ABI,
        functionName: 'decimals',
      }),
      client.readContract({
        address: feedAddress as `0x${string}`,
        abi: AGGREGATOR_V3_ABI,
        functionName: 'latestRoundData',
      }),
    ]);

    const [roundId, answer, , updatedAt, answeredInRound] = roundData as [bigint, bigint, bigint, bigint, bigint];
    const dec = Number(decimals);
    const priceUsd = Number(answer) / 10 ** dec;
    const updatedAtSec = Number(updatedAt);
    const staleness = Math.floor(Date.now() / 1000) - updatedAtSec;

    return {
      pair: normalizedPair,
      priceUsd,
      decimals: dec,
      roundId: roundId.toString(),
      updatedAt: updatedAtSec,
      answeredInRound: answeredInRound.toString(),
      staleness,
      isStale: staleness > this.config.maxStalenessSeconds,
      chain: CHAIN_NAMES[chainId] ?? String(chainId),
      feedAddress,
    };
  }

  /**
   * Get the Chainlink ETH/USD price on a specific chain.
   */
  async getEthPrice(chainId = 8453): Promise<ChainlinkPriceResult> {
    return this.getPrice('ETH/USD', chainId);
  }

  /**
   * Verify a DEX price against Chainlink oracle.
   * Returns a divergence report.
   */
  async verifyPrice(
    token: string,
    dexPriceUsd: number,
    chainId = 8453,
  ): Promise<{
    chainlinkPrice: number;
    dexPrice: number;
    divergencePercent: number;
    isAcceptable: boolean;
    warning?: string;
  }> {
    const pair = `${token.toUpperCase()}/USD`;
    try {
      const result = await this.getPrice(pair, chainId);

      if (result.isStale) {
        return {
          chainlinkPrice: result.priceUsd,
          dexPrice: dexPriceUsd,
          divergencePercent: 0,
          isAcceptable: true, // Can't reject based on stale oracle — fall through
          warning: `Chainlink ${pair} data is stale (${Math.round(result.staleness / 60)}m old). Skipping oracle verification.`,
        };
      }

      const divergence = Math.abs(result.priceUsd - dexPriceUsd) / result.priceUsd * 100;
      const isAcceptable = divergence < this.config.divergenceThresholdPercent;

      return {
        chainlinkPrice: result.priceUsd,
        dexPrice: dexPriceUsd,
        divergencePercent: Math.round(divergence * 100) / 100,
        isAcceptable,
        warning: isAcceptable
          ? undefined
          : `Price divergence ${divergence.toFixed(1)}% between DEX ($${dexPriceUsd.toFixed(4)}) and Chainlink ($${result.priceUsd.toFixed(4)}). Possible manipulation or stale DEX data.`,
      };
    } catch (err) {
      // If Chainlink feed doesn't exist for this token, skip verification
      if (err instanceof ChainlinkError) {
        return {
          chainlinkPrice: 0,
          dexPrice: dexPriceUsd,
          divergencePercent: 0,
          isAcceptable: true,
          warning: `No Chainlink feed for ${pair}. Oracle verification skipped.`,
        };
      }
      throw err;
    }
  }

  /**
   * Get all available feed pairs for a chain.
   */
  getAvailableFeeds(chainId = 8453): string[] {
    return Object.keys(FEED_ADDRESSES[chainId] ?? {});
  }

  /**
   * Get all supported chain IDs.
   */
  getSupportedChains(): number[] {
    return Object.keys(FEED_ADDRESSES).map(Number);
  }

  /**
   * Batch price lookup: get Chainlink prices for multiple pairs.
   */
  async getPrices(
    pairs: Array<{ pair: string; chainId?: number }>,
  ): Promise<ChainlinkPriceResult[]> {
    return Promise.all(
      pairs.map((p) =>
        this.getPrice(p.pair, p.chainId ?? 8453).catch((err): ChainlinkPriceResult => ({
          pair: p.pair,
          priceUsd: 0,
          decimals: 0,
          roundId: '0',
          updatedAt: 0,
          answeredInRound: '0',
          staleness: 0,
          isStale: true,
          chain: CHAIN_NAMES[p.chainId ?? 8453] ?? String(p.chainId ?? 8453),
          feedAddress: '',
        })),
      ),
    );
  }
}

// ── Error Class ─────────────────────────────────────────────────────────────

export class ChainlinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainlinkError';
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: ChainlinkOracle | null = null;

export function getChainlinkOracle(config?: ChainlinkOracleConfig): ChainlinkOracle {
  if (!_instance) {
    _instance = new ChainlinkOracle(config);
  }
  return _instance;
}

export function resetChainlinkOracle(): void {
  _instance = null;
}
