/**
 * Lending Service — Aave V3 lending protocol integration on Base.
 *
 * Supports supply, borrow, repay, withdraw operations on Base via direct
 * contract calls (no SDK dependency — just ABI + contract addresses).
 *
 * Protocols supported:
 * - Aave V3 on Base (Pool contract)
 *
 * Health factor monitoring via heartbeat integration.
 */

import type { Address } from 'viem';
import { AAVE, MORPHO, CBETH, TOKENS } from '../lib/contract-registry.js';

// ── Contract Addresses (Base Mainnet) — sourced from contract-registry ───

export const LENDING_CONTRACTS = {
  aave: {
    pool: AAVE.pool,
    poolDataProvider: AAVE.poolDataProvider,
    oracle: AAVE.oracle,
    chain: 8453,
    name: 'Aave V3 Base',
  },
  morpho: {
    core: MORPHO.core,
    chain: 8453,
    name: 'Morpho Base',
  },
} as const;

// ── Supported Assets ─────────────────────────────────────────────────────

export interface LendingAsset {
  symbol: string;
  address: Address;
  decimals: number;
  /** Aave aToken address (interest-bearing) */
  aToken?: Address;
  /** Aave variable debt token address */
  variableDebtToken?: Address;
}

export const LENDING_ASSETS: Record<string, LendingAsset> = {
  ETH: {
    symbol: 'ETH',
    address: TOKENS.base.WETH,
    decimals: 18,
    aToken: AAVE.aTokens.WETH.aToken,
    variableDebtToken: AAVE.aTokens.WETH.debtToken,
  },
  USDC: {
    symbol: 'USDC',
    address: TOKENS.base.USDC,
    decimals: 6,
    aToken: AAVE.aTokens.USDC.aToken,
    variableDebtToken: AAVE.aTokens.USDC.debtToken,
  },
  cbETH: {
    symbol: 'cbETH',
    address: CBETH.base,
    decimals: 18,
    aToken: AAVE.aTokens.cbETH.aToken,
    variableDebtToken: AAVE.aTokens.cbETH.debtToken,
  },
  USDbC: {
    symbol: 'USDbC',
    address: TOKENS.base.USDbC,
    decimals: 6,
    aToken: AAVE.aTokens.USDbC.aToken,
    variableDebtToken: AAVE.aTokens.USDbC.debtToken,
  },
};

// ── ABIs (minimal — only the functions we call) ──────────────────────────

export const AAVE_POOL_ABI = [
  {
    name: 'supply',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    name: 'borrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'referralCode', type: 'uint16' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'repay',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getUserAccountData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
] as const;

export const ERC20_APPROVE_ABI = [
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

// ── Types ────────────────────────────────────────────────────────────────

export interface UserAccountData {
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  liquidationThreshold: number;
  ltv: number;
  healthFactor: number;
}

export interface LendingPosition {
  protocol: 'aave' | 'morpho';
  asset: string;
  type: 'supply' | 'borrow';
  amount: string;
  amountUsd?: number;
  apy?: number;
}

export type LendingProtocol = 'aave' | 'morpho';

// ── Service ──────────────────────────────────────────────────────────────

export class LendingService {
  /**
   * Resolve asset symbol to lending asset info.
   */
  resolveAsset(symbolOrAddress: string): LendingAsset | null {
    // Try by symbol first
    const upper = symbolOrAddress.toUpperCase();
    if (LENDING_ASSETS[upper]) return LENDING_ASSETS[upper]!;

    // Try by address
    const lower = symbolOrAddress.toLowerCase();
    for (const asset of Object.values(LENDING_ASSETS)) {
      if (asset.address.toLowerCase() === lower) return asset;
    }

    return null;
  }

  /**
   * Get user account data from Aave V3 (health factor, collateral, debt).
   */
  async getUserAccountData(
    userAddress: Address,
    publicClient: any,
  ): Promise<UserAccountData> {
    const result = await publicClient.readContract({
      address: LENDING_CONTRACTS.aave.pool,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [userAddress],
    });

    // Aave returns values in BASE_CURRENCY (USD with 8 decimals)
    const [totalCollateral, totalDebt, availableBorrows, liqThreshold, ltv, healthFactor] =
      result as [bigint, bigint, bigint, bigint, bigint, bigint];

    return {
      totalCollateralUsd: Number(totalCollateral) / 1e8,
      totalDebtUsd: Number(totalDebt) / 1e8,
      availableBorrowsUsd: Number(availableBorrows) / 1e8,
      liquidationThreshold: Number(liqThreshold) / 100, // basis points → percentage
      ltv: Number(ltv) / 100,
      // Health factor has 18 decimals; max uint256 means no debt
      healthFactor: healthFactor >= BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
        ? Infinity
        : Number(healthFactor) / 1e18,
    };
  }

  /**
   * Supply an asset to Aave V3.
   * Returns the confirmed transaction hash.
   */
  async supply(
    asset: LendingAsset,
    amount: bigint,
    userAddress: Address,
    walletClient: any,
    publicClient: any,
  ): Promise<{ hash: string; action: 'supply'; asset: string; amount: string }> {
    // Check and set approval if needed (waits for confirmation internally)
    await this.ensureApproval(
      asset.address, LENDING_CONTRACTS.aave.pool, amount, userAddress, walletClient, publicClient,
    );

    const hash = await walletClient.writeContract({
      address: LENDING_CONTRACTS.aave.pool,
      abi: AAVE_POOL_ABI,
      functionName: 'supply',
      args: [asset.address, amount, userAddress, 0],
    });

    // Wait for on-chain confirmation
    await publicClient.waitForTransactionReceipt({ hash });

    return { hash, action: 'supply', asset: asset.symbol, amount: amount.toString() };
  }

  /**
   * Borrow an asset from Aave V3 (variable rate).
   */
  async borrow(
    asset: LendingAsset,
    amount: bigint,
    userAddress: Address,
    walletClient: any,
    publicClient?: any,
  ): Promise<{ hash: string; action: 'borrow'; asset: string; amount: string }> {
    const hash = await walletClient.writeContract({
      address: LENDING_CONTRACTS.aave.pool,
      abi: AAVE_POOL_ABI,
      functionName: 'borrow',
      args: [asset.address, amount, BigInt(2), 0, userAddress], // 2 = variable rate
    });

    // Wait for on-chain confirmation if publicClient available
    if (publicClient) {
      await publicClient.waitForTransactionReceipt({ hash });
    }

    return { hash, action: 'borrow', asset: asset.symbol, amount: amount.toString() };
  }

  /**
   * Repay a borrowed asset on Aave V3.
   * Use amount = MaxUint256 to repay entire debt.
   *
   * When skipApproval is true, the caller has already handled approval
   * (e.g. for max repay with bounded approval instead of MaxUint256).
   */
  async repay(
    asset: LendingAsset,
    amount: bigint,
    userAddress: Address,
    walletClient: any,
    publicClient: any,
    skipApproval = false,
  ): Promise<{ hash: string; action: 'repay'; asset: string; amount: string }> {
    if (!skipApproval) {
      await this.ensureApproval(
        asset.address, LENDING_CONTRACTS.aave.pool, amount, userAddress, walletClient, publicClient,
      );
    }

    const hash = await walletClient.writeContract({
      address: LENDING_CONTRACTS.aave.pool,
      abi: AAVE_POOL_ABI,
      functionName: 'repay',
      args: [asset.address, amount, BigInt(2), userAddress],
    });

    // Wait for on-chain confirmation
    await publicClient.waitForTransactionReceipt({ hash });

    return { hash, action: 'repay', asset: asset.symbol, amount: amount.toString() };
  }

  /**
   * Withdraw a supplied asset from Aave V3.
   * Use amount = MaxUint256 to withdraw entire balance.
   */
  async withdraw(
    asset: LendingAsset,
    amount: bigint,
    userAddress: Address,
    walletClient: any,
    publicClient?: any,
  ): Promise<{ hash: string; action: 'withdraw'; asset: string; amount: string }> {
    const hash = await walletClient.writeContract({
      address: LENDING_CONTRACTS.aave.pool,
      abi: AAVE_POOL_ABI,
      functionName: 'withdraw',
      args: [asset.address, amount, userAddress],
    });

    // Wait for on-chain confirmation if publicClient available
    if (publicClient) {
      await publicClient.waitForTransactionReceipt({ hash });
    }

    return { hash, action: 'withdraw', asset: asset.symbol, amount: amount.toString() };
  }

  /**
   * Get list of supported lending assets.
   */
  getSupportedAssets(): LendingAsset[] {
    return Object.values(LENDING_ASSETS);
  }

  /**
   * Get supported protocols.
   * Note: Morpho contract address is defined in LENDING_CONTRACTS for future use,
   * but is not yet implemented. Only Aave V3 is currently supported.
   */
  getSupportedProtocols(): Array<{ id: LendingProtocol; name: string; chain: number }> {
    return [
      { id: 'aave', name: LENDING_CONTRACTS.aave.name, chain: LENDING_CONTRACTS.aave.chain },
    ];
  }

  /**
   * Get the current variable debt balance for an asset.
   * Useful for calculating exact repay amounts instead of MaxUint256 approvals.
   */
  async getDebtBalance(
    asset: LendingAsset,
    userAddress: Address,
    publicClient: any,
  ): Promise<bigint> {
    if (!asset.variableDebtToken) return 0n;

    const { erc20Abi } = await import('viem');
    const balance = await publicClient.readContract({
      address: asset.variableDebtToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [userAddress],
    }) as bigint;

    return balance;
  }

  /**
   * Public wrapper for ensureApproval — used when the caller needs to
   * control the approval amount separately (e.g. max repay with bounded approval).
   */
  async ensureApprovalPublic(
    tokenAddress: Address,
    amount: bigint,
    owner: Address,
    walletClient: any,
    publicClient: any,
  ): Promise<void> {
    await this.ensureApproval(
      tokenAddress, LENDING_CONTRACTS.aave.pool, amount, owner, walletClient, publicClient,
    );
  }

  // ── Internal ──────────────────────────────────────────────────────────

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
      // Wait for approval to be mined before proceeding — prevents race condition
      // where the next tx is sent before the approval is confirmed on-chain.
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: LendingService | null = null;

export function getLendingService(): LendingService {
  if (!_instance) {
    _instance = new LendingService();
  }
  return _instance;
}

export function resetLendingService(): void {
  _instance = null;
}
