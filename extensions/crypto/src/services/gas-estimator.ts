/**
 * Gas Estimation Service — real-time gas prices, cost estimation, and
 * gas-inclusive swap comparison.
 *
 * Provides:
 * - Multi-chain gas price tracking (fast/standard/slow)
 * - Transaction cost estimation in USD
 * - Gas-inclusive swap comparison (net output = output - gas cost)
 * - EIP-1559 priority fee estimation
 * - Historical gas trend tracking
 *
 * Uses on-chain RPC calls for accurate data, not third-party gas APIs.
 */

import { getRpcManager } from './rpc-provider.js';
import { getTokenPriceUsd } from './dexscreener-service.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface GasPrice {
  /** Base fee in gwei. */
  baseFee: number;
  /** Slow priority fee in gwei (10th percentile). */
  slow: number;
  /** Standard priority fee in gwei (50th percentile). */
  standard: number;
  /** Fast priority fee in gwei (90th percentile). */
  fast: number;
  /** Total gas price for slow/standard/fast (baseFee + priority). */
  totalSlow: number;
  totalStandard: number;
  totalFast: number;
  /** Chain native token price in USD. */
  nativeTokenPriceUsd: number;
  chain: string;
  chainId: number;
  timestamp: number;
}

export interface GasCostEstimate {
  /** Gas units for this operation. */
  gasUnits: number;
  /** Cost at slow speed in USD. */
  costSlowUsd: number;
  /** Cost at standard speed in USD. */
  costStandardUsd: number;
  /** Cost at fast speed in USD. */
  costFastUsd: number;
  /** Cost in native token (standard speed). */
  costNativeToken: number;
  operation: string;
}

export interface SwapComparison {
  aggregator: string;
  outputAmount: string;
  outputValueUsd: number;
  gasCostUsd: number;
  netOutputUsd: number;
  rank: number;
}

export interface GasEstimatorConfig {
  /** Number of recent blocks to sample for priority fees. Default: 5. */
  blockSamples?: number;
  /** Cache TTL for gas prices in ms. Default: 12000 (12s, ~1 block). */
  cacheTtlMs?: number;
}

// ── Common Gas Limits ───────────────────────────────────────────────────────

/** Typical gas limits for common EVM operations. */
export const GAS_LIMITS: Record<string, number> = {
  ETH_TRANSFER: 21_000,
  ERC20_TRANSFER: 65_000,
  ERC20_APPROVE: 46_000,
  UNISWAP_V2_SWAP: 150_000,
  UNISWAP_V3_SWAP: 184_000,
  UNISWAP_V4_SWAP: 170_000,
  DEX_SWAP_SIMPLE: 200_000,
  DEX_SWAP_MULTI_HOP: 350_000,
  ADD_LIQUIDITY_V3: 500_000,
  REMOVE_LIQUIDITY_V3: 300_000,
  BRIDGE_DEPOSIT: 250_000,
  PERMIT2_APPROVE: 80_000,
  CONTRACT_DEPLOY: 2_000_000,
  NFT_MINT: 120_000,
};

// ── Chain Native Tokens ─────────────────────────────────────────────────────

const NATIVE_TOKEN: Record<number, string> = {
  1: 'ETH', 8453: 'ETH', 42161: 'ETH', 10: 'ETH', 137: 'MATIC',
};

const CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon',
};

// ── Service ─────────────────────────────────────────────────────────────────

export class GasEstimator {
  private config: Required<GasEstimatorConfig>;
  private cache: Map<number, { gasPrice: GasPrice; expiresAt: number }> = new Map();

  constructor(config: GasEstimatorConfig = {}) {
    this.config = {
      blockSamples: config.blockSamples ?? 5,
      cacheTtlMs: config.cacheTtlMs ?? 12_000,
    };
  }

  /**
   * Get current gas prices for a chain (with caching).
   * Uses EIP-1559 fee history for accurate priority fee estimation.
   */
  async getGasPrice(chainId = 8453): Promise<GasPrice> {
    // Check cache
    const cached = this.cache.get(chainId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.gasPrice;
    }

    const rpcManager = getRpcManager();
    const client = await rpcManager.getClient(chainId);

    // Get fee history (EIP-1559 chains) and native token price in parallel
    const [feeHistory, nativePrice] = await Promise.all([
      client.getFeeHistory({
        blockCount: this.config.blockSamples,
        rewardPercentiles: [10, 50, 90],
      }).catch(() => null),
      this.getNativeTokenPrice(chainId),
    ]);

    let baseFee: number;
    let slow: number;
    let standard: number;
    let fast: number;

    if (feeHistory?.baseFeePerGas?.length) {
      // EIP-1559 chain: use fee history
      const latestBaseFee = feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1]!;
      baseFee = Number(latestBaseFee) / 1e9; // wei → gwei

      // Average the reward percentiles across recent blocks
      const rewards = feeHistory.reward ?? [];
      if (rewards.length > 0) {
        slow = this.averageReward(rewards, 0);
        standard = this.averageReward(rewards, 1);
        fast = this.averageReward(rewards, 2);
      } else {
        slow = 0.01;
        standard = 0.05;
        fast = 0.1;
      }
    } else {
      // Legacy chain or fee history unavailable: use gasPrice
      const gasPrice = await client.getGasPrice();
      baseFee = Number(gasPrice) / 1e9;
      slow = 0;
      standard = 0;
      fast = baseFee * 0.1; // estimate 10% tip
    }

    const gasPrice: GasPrice = {
      baseFee: Math.round(baseFee * 1000) / 1000,
      slow: Math.round(slow * 1000) / 1000,
      standard: Math.round(standard * 1000) / 1000,
      fast: Math.round(fast * 1000) / 1000,
      totalSlow: Math.round((baseFee + slow) * 1000) / 1000,
      totalStandard: Math.round((baseFee + standard) * 1000) / 1000,
      totalFast: Math.round((baseFee + fast) * 1000) / 1000,
      nativeTokenPriceUsd: nativePrice,
      chain: CHAIN_NAMES[chainId] ?? String(chainId),
      chainId,
      timestamp: Date.now(),
    };

    // Cache the result
    this.cache.set(chainId, { gasPrice, expiresAt: Date.now() + this.config.cacheTtlMs });
    return gasPrice;
  }

  /**
   * Estimate the gas cost for a specific operation in USD.
   */
  async estimateCost(
    operation: keyof typeof GAS_LIMITS | number,
    chainId = 8453,
  ): Promise<GasCostEstimate> {
    const gasUnits = typeof operation === 'number' ? operation : GAS_LIMITS[operation] ?? 200_000;
    const opName = typeof operation === 'string' ? operation : `custom (${operation} gas)`;
    const gas = await this.getGasPrice(chainId);

    const costSlowNative = (gas.totalSlow * gasUnits) / 1e9;
    const costStdNative = (gas.totalStandard * gasUnits) / 1e9;
    const costFastNative = (gas.totalFast * gasUnits) / 1e9;

    return {
      gasUnits,
      costSlowUsd: Math.round(costSlowNative * gas.nativeTokenPriceUsd * 10000) / 10000,
      costStandardUsd: Math.round(costStdNative * gas.nativeTokenPriceUsd * 10000) / 10000,
      costFastUsd: Math.round(costFastNative * gas.nativeTokenPriceUsd * 10000) / 10000,
      costNativeToken: Math.round(costStdNative * 1e8) / 1e8,
      operation: opName,
    };
  }

  /**
   * Compare swap quotes with gas costs factored in.
   * Takes raw aggregator quotes and produces a gas-inclusive ranking.
   */
  async compareSwapsGasInclusive(
    quotes: Array<{
      aggregator: string;
      buyAmount: string;
      buyTokenPriceUsd: number;
      buyTokenDecimals: number;
      gasEstimate?: string;
    }>,
    chainId = 8453,
  ): Promise<SwapComparison[]> {
    const gas = await this.getGasPrice(chainId);

    const comparisons: SwapComparison[] = quotes.map((q) => {
      const outputHuman = Number(q.buyAmount) / 10 ** q.buyTokenDecimals;
      const outputValueUsd = outputHuman * q.buyTokenPriceUsd;

      const gasUnits = parseInt(q.gasEstimate ?? '200000', 10);
      const gasCostNative = (gas.totalStandard * gasUnits) / 1e9;
      const gasCostUsd = gasCostNative * gas.nativeTokenPriceUsd;

      return {
        aggregator: q.aggregator,
        outputAmount: q.buyAmount,
        outputValueUsd: Math.round(outputValueUsd * 100) / 100,
        gasCostUsd: Math.round(gasCostUsd * 10000) / 10000,
        netOutputUsd: Math.round((outputValueUsd - gasCostUsd) * 100) / 100,
        rank: 0, // computed after sorting
      };
    });

    // Sort by net output descending
    comparisons.sort((a, b) => b.netOutputUsd - a.netOutputUsd);
    comparisons.forEach((c, i) => { c.rank = i + 1; });

    return comparisons;
  }

  /**
   * Get gas cost estimates for common operations on a chain.
   * Useful for the `/gas` command or a setup screen.
   */
  async getCommonCosts(chainId = 8453): Promise<{
    gasPrice: GasPrice;
    costs: GasCostEstimate[];
  }> {
    const gasPrice = await this.getGasPrice(chainId);
    const ops: Array<keyof typeof GAS_LIMITS> = [
      'ETH_TRANSFER', 'ERC20_TRANSFER', 'DEX_SWAP_SIMPLE',
      'DEX_SWAP_MULTI_HOP', 'BRIDGE_DEPOSIT', 'ADD_LIQUIDITY_V3',
    ];

    const costs = await Promise.all(ops.map((op) => this.estimateCost(op, chainId)));
    return { gasPrice, costs };
  }

  /** Clear the gas price cache. */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private averageReward(rewards: bigint[][], index: number): number {
    const values = rewards.map((r) => Number(r[index] ?? 0n) / 1e9);
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private async getNativeTokenPrice(chainId: number): Promise<number> {
    const token = NATIVE_TOKEN[chainId] ?? 'ETH';
    try {
      const { priceUsd } = await getTokenPriceUsd(token, CHAIN_NAMES[chainId] ?? 'base');
      return priceUsd;
    } catch {
      return 0;
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: GasEstimator | null = null;

export function getGasEstimator(config?: GasEstimatorConfig): GasEstimator {
  if (!_instance) {
    _instance = new GasEstimator(config);
  }
  return _instance;
}

export function resetGasEstimator(): void {
  _instance = null;
}
