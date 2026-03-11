/**
 * Yield Aggregation Service — find and execute yield opportunities across DeFi.
 *
 * Data source: DeFiLlama yields API (yields.llama.fi/pools).
 * Execution: Yearn V3 vaults on Base (direct contract calls, no SDK).
 *
 * Supported protocols for deposits:
 *   - Yearn V3 vaults on Base (ERC-4626 standard)
 *   - Aave V3 on Base (via defi_lend tool — this service only searches)
 *
 * No new dependencies. Uses guardedFetch for HTTP, viem for contract calls.
 */

import { formatUnits, parseUnits } from 'viem';
import type { Address } from 'viem';
import { guardedFetch } from './endpoint-allowlist.js';
import { YEARN, TOKENS } from '../lib/contract-registry.js';

// ── DeFiLlama Pool Types ─────────────────────────────────────────────────

export interface YieldPool {
  pool: string;           // DeFiLlama pool ID
  chain: string;          // "Base", "Ethereum", etc.
  project: string;        // "aave-v3", "yearn-finance", "moonwell", etc.
  symbol: string;         // "USDC", "WETH-USDC", etc.
  tvlUsd: number;
  apyBase: number | null;
  apyReward: number | null;
  apy: number;            // total APY (base + reward)
  rewardTokens: string[] | null;
  underlyingTokens: string[] | null;
  ilRisk: string | null;  // "yes" | "no" | null
  stablecoin: boolean;
  exposure: string | null; // "single" | "multi"
  poolMeta: string | null;
  /** Vault address — from DeFiLlama or resolved locally */
  vaultAddress?: string;
}

export interface YieldSearchParams {
  chain?: string;
  asset?: string;
  minTvl?: number;
  minApy?: number;
  stableOnly?: boolean;
  singleExposure?: boolean;
  limit?: number;
  project?: string;
}

export interface VaultPosition {
  vault: string;
  vaultAddress: string;
  asset: string;
  shares: string;
  assetsValue: string;
  chain: string;
  apy?: number;
}

// ── Yearn V3 Vault Addresses (Base) ──────────────────────────────────────

export const YEARN_VAULTS_BASE: Record<string, { address: Address; asset: string; decimals: number }> = {
  'yvUSDC': {
    address: YEARN.base.yvUSDC,
    asset: 'USDC',
    decimals: 6,
  },
  'yvWETH': {
    address: YEARN.base.yvWETH,
    asset: 'WETH',
    decimals: 18,
  },
  'yvDAI': {
    address: YEARN.base.yvDAI,
    asset: 'DAI',
    decimals: 18,
  },
};

// ── Underlying Token Addresses (Base) ────────────────────────────────────

const BASE_TOKENS: Record<string, Address> = {
  USDC: TOKENS.base.USDC,
  WETH: TOKENS.base.WETH,
  DAI: TOKENS.base.DAI,
};

// ── ERC-4626 Vault ABI (minimal — standard interface) ────────────────────

export const ERC4626_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'redeem',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'convertToAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'convertToShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'maxDeposit',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'receiver', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'asset',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ── Chain Name Normalization ─────────────────────────────────────────────

function normalizeChain(input: string): string {
  const lower = input.toLowerCase();
  const map: Record<string, string> = {
    base: 'Base',
    ethereum: 'Ethereum',
    eth: 'Ethereum',
    mainnet: 'Ethereum',
    arbitrum: 'Arbitrum',
    arb: 'Arbitrum',
    optimism: 'Optimism',
    op: 'Optimism',
    polygon: 'Polygon',
    matic: 'Polygon',
  };
  return map[lower] ?? input;
}

// ── Service ──────────────────────────────────────────────────────────────

export class YieldService {
  private poolsCache: YieldPool[] = [];
  private poolsCacheTimestamp = 0;
  private readonly POOLS_CACHE_TTL = 300_000; // 5 minutes

  // ── Search / Discovery ─────────────────────────────────────────────

  /**
   * Search DeFiLlama yield pools with optional filters.
   * Returns top results sorted by APY descending.
   */
  async searchPools(params: YieldSearchParams = {}): Promise<YieldPool[]> {
    const pools = await this.fetchPools();

    let filtered = pools;

    // Chain filter
    if (params.chain) {
      const normalizedChain = normalizeChain(params.chain);
      filtered = filtered.filter(p => p.chain === normalizedChain);
    }

    // Asset filter (match in symbol)
    if (params.asset) {
      const upper = params.asset.toUpperCase();
      filtered = filtered.filter(p => p.symbol.toUpperCase().includes(upper));
    }

    // Project filter
    if (params.project) {
      const lower = params.project.toLowerCase();
      filtered = filtered.filter(p => p.project.toLowerCase().includes(lower));
    }

    // Min TVL filter (default: $100K to exclude dust pools)
    const minTvl = params.minTvl ?? 100_000;
    filtered = filtered.filter(p => p.tvlUsd >= minTvl);

    // Min APY filter
    if (params.minApy !== undefined) {
      filtered = filtered.filter(p => p.apy >= params.minApy!);
    }

    // Stablecoin filter
    if (params.stableOnly) {
      filtered = filtered.filter(p => p.stablecoin);
    }

    // Single exposure filter (no IL risk)
    if (params.singleExposure) {
      filtered = filtered.filter(p => p.exposure === 'single' || p.ilRisk === 'no');
    }

    // Sort by APY descending
    filtered.sort((a, b) => b.apy - a.apy);

    // Limit results
    const limit = params.limit ?? 20;
    return filtered.slice(0, limit);
  }

  /**
   * Get top yields for a specific asset on a specific chain.
   */
  async topYieldsForAsset(
    asset: string,
    chain = 'Base',
    limit = 10,
  ): Promise<YieldPool[]> {
    return this.searchPools({
      chain,
      asset,
      limit,
      minTvl: 50_000,
    });
  }

  // ── Vault Operations (Yearn V3 on Base) ────────────────────────────

  /**
   * Resolve a vault name or address to a known Yearn V3 vault.
   */
  resolveVault(input: string): { name: string; address: Address; asset: string; decimals: number } | null {
    // Try by vault name
    const upper = input.toUpperCase();
    for (const [name, vault] of Object.entries(YEARN_VAULTS_BASE)) {
      if (name.toUpperCase() === upper || vault.asset.toUpperCase() === upper) {
        return { name, ...vault };
      }
    }

    // Try by address
    const lower = input.toLowerCase();
    for (const [name, vault] of Object.entries(YEARN_VAULTS_BASE)) {
      if (vault.address.toLowerCase() === lower) {
        return { name, ...vault };
      }
    }

    return null;
  }

  /**
   * Get all known Yearn V3 vaults.
   */
  getAvailableVaults() {
    return Object.entries(YEARN_VAULTS_BASE).map(([name, v]) => ({
      name,
      address: v.address,
      asset: v.asset,
      decimals: v.decimals,
    }));
  }

  /**
   * Deposit into a Yearn V3 vault (ERC-4626).
   */
  async deposit(
    vaultAddress: Address,
    assetAddress: Address,
    amount: bigint,
    userAddress: Address,
    walletClient: any,
    publicClient: any,
  ): Promise<{ hash: string; shares: string }> {
    // Ensure approval for vault to spend tokens
    await this.ensureApproval(assetAddress, vaultAddress, amount, userAddress, walletClient, publicClient);

    const hash = await walletClient.writeContract({
      address: vaultAddress,
      abi: ERC4626_ABI,
      functionName: 'deposit',
      args: [amount, userAddress],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    // Try to read shares from receipt logs or vault balance
    let shares = '0';
    try {
      const sharesBalance = await publicClient.readContract({
        address: vaultAddress,
        abi: ERC4626_ABI,
        functionName: 'balanceOf',
        args: [userAddress],
      }) as bigint;
      shares = sharesBalance.toString();
    } catch {
      // Non-critical — just can't report shares
    }

    return { hash, shares };
  }

  /**
   * Withdraw from a Yearn V3 vault (ERC-4626).
   * If isMax, redeems all shares. Otherwise withdraws specific asset amount.
   */
  async withdraw(
    vaultAddress: Address,
    amount: bigint,
    userAddress: Address,
    walletClient: any,
    publicClient: any,
    isMax: boolean,
    decimals: number,
  ): Promise<{ hash: string; assetsReturned: string }> {
    let hash: string;

    if (isMax) {
      // Redeem all shares
      const sharesBalance = await publicClient.readContract({
        address: vaultAddress,
        abi: ERC4626_ABI,
        functionName: 'balanceOf',
        args: [userAddress],
      }) as bigint;

      if (sharesBalance === 0n) {
        throw new Error('No shares to redeem in this vault.');
      }

      hash = await walletClient.writeContract({
        address: vaultAddress,
        abi: ERC4626_ABI,
        functionName: 'redeem',
        args: [sharesBalance, userAddress, userAddress],
      });
    } else {
      // Withdraw specific amount of underlying assets
      hash = await walletClient.writeContract({
        address: vaultAddress,
        abi: ERC4626_ABI,
        functionName: 'withdraw',
        args: [amount, userAddress, userAddress],
      });
    }

    await publicClient.waitForTransactionReceipt({ hash });

    return { hash, assetsReturned: isMax ? 'all' : formatUnits(amount, decimals) };
  }

  /**
   * Get vault positions for a user across all known vaults.
   */
  async getPositions(
    userAddress: Address,
    publicClient: any,
  ): Promise<VaultPosition[]> {
    const positions: VaultPosition[] = [];

    for (const [name, vault] of Object.entries(YEARN_VAULTS_BASE)) {
      try {
        const sharesBalance = await publicClient.readContract({
          address: vault.address,
          abi: ERC4626_ABI,
          functionName: 'balanceOf',
          args: [userAddress],
        }) as bigint;

        if (sharesBalance === 0n) continue;

        // Convert shares to underlying asset value
        let assetsValue: bigint;
        try {
          assetsValue = await publicClient.readContract({
            address: vault.address,
            abi: ERC4626_ABI,
            functionName: 'convertToAssets',
            args: [sharesBalance],
          }) as bigint;
        } catch {
          assetsValue = sharesBalance; // fallback: 1:1
        }

        positions.push({
          vault: name,
          vaultAddress: vault.address,
          asset: vault.asset,
          shares: formatUnits(sharesBalance, vault.decimals),
          assetsValue: formatUnits(assetsValue, vault.decimals),
          chain: 'base',
        });
      } catch {
        // Skip vault if contract call fails
      }
    }

    // Enrich with APY from DeFiLlama
    await this.enrichPositionsWithApy(positions);

    return positions;
  }

  /**
   * Get the underlying token address for a vault's asset.
   */
  getTokenAddress(asset: string): Address | null {
    return BASE_TOKENS[asset.toUpperCase()] ?? null;
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async fetchPools(): Promise<YieldPool[]> {
    if (this.poolsCache.length > 0 && Date.now() - this.poolsCacheTimestamp < this.POOLS_CACHE_TTL) {
      return this.poolsCache;
    }

    try {
      const response = await guardedFetch('https://yields.llama.fi/pools', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return this.poolsCache;
      }

      const data: any = await response.json();
      const rawPools: any[] = data.data ?? [];

      this.poolsCache = rawPools.map((p: any) => ({
        pool: p.pool ?? '',
        chain: p.chain ?? '',
        project: p.project ?? '',
        symbol: p.symbol ?? '',
        tvlUsd: p.tvlUsd ?? 0,
        apyBase: p.apyBase ?? null,
        apyReward: p.apyReward ?? null,
        apy: p.apy ?? p.apyBase ?? 0,
        rewardTokens: p.rewardTokens ?? null,
        underlyingTokens: p.underlyingTokens ?? null,
        ilRisk: p.ilRisk ?? null,
        stablecoin: p.stablecoin ?? false,
        exposure: p.exposure ?? null,
        poolMeta: p.poolMeta ?? null,
      }));

      this.poolsCacheTimestamp = Date.now();
      return this.poolsCache;
    } catch {
      return this.poolsCache;
    }
  }

  private async enrichPositionsWithApy(positions: VaultPosition[]): Promise<void> {
    if (positions.length === 0) return;

    const pools = await this.fetchPools();

    for (const pos of positions) {
      // Find matching DeFiLlama pool for this vault
      const match = pools.find(
        p =>
          p.chain === 'Base' &&
          p.project.includes('yearn') &&
          p.symbol.toUpperCase().includes(pos.asset.toUpperCase()),
      );
      if (match) {
        pos.apy = match.apy;
      }
    }
  }

  private async ensureApproval(
    tokenAddress: Address,
    spender: Address,
    amount: bigint,
    owner: Address,
    walletClient: any,
    publicClient: any,
  ): Promise<void> {
    const currentAllowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_APPROVE_ABI,
      functionName: 'allowance',
      args: [owner, spender],
    }) as bigint;

    if (currentAllowance < amount) {
      const approveHash = await walletClient.writeContract({
        address: tokenAddress,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [spender, amount],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: YieldService | null = null;

export function getYieldService(): YieldService {
  if (!_instance) {
    _instance = new YieldService();
  }
  return _instance;
}

export function resetYieldService(): void {
  _instance = null;
}
