/**
 * Yield Aggregation Tool — find and execute yield opportunities across DeFi.
 *
 * Actions:
 *   search         — Search DeFiLlama for yield opportunities (filter by chain, asset, APY)
 *   top_yields     — Top yields for a specific asset on a chain
 *   deposit        — Deposit into a Yearn V3 vault (ERC-4626) on Base
 *   withdraw       — Withdraw from a Yearn V3 vault
 *   positions      — View vault positions and earned yield
 *   vaults         — List available vaults for direct deposit
 *
 * Data from DeFiLlama yields API. Execution via Yearn V3 vaults on Base.
 */

import { Type } from '@sinclair/typebox';
import { formatUnits } from 'viem';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { getYieldService } from '../services/yield-service.js';

const ACTIONS = ['search', 'top_yields', 'deposit', 'withdraw', 'positions', 'vaults'] as const;

const YieldSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'search: find yield pools across DeFi. top_yields: best yields for an asset. ' +
      'deposit: deposit into Yearn V3 vault. withdraw: exit vault position. ' +
      'positions: view vault positions. vaults: list available vaults.',
  }),
  asset: Type.Optional(Type.String({
    description: 'Asset symbol (USDC, WETH, ETH, DAI). Used for search/top_yields/deposit/withdraw.',
  })),
  chain: Type.Optional(Type.String({
    description: 'Chain name: "base" (default), "ethereum", "arbitrum", "optimism", "polygon".',
  })),
  amount: Type.Optional(Type.String({
    description: 'Amount in human-readable units (e.g. "100" USDC, "0.5" ETH). Use "max" for withdraw. Required for deposit/withdraw.',
  })),
  vault: Type.Optional(Type.String({
    description: 'Vault name (yvUSDC, yvWETH, yvDAI) or address. Required for deposit/withdraw.',
  })),
  min_tvl: Type.Optional(Type.Number({
    description: 'Minimum TVL in USD for search results. Default: 100000.',
  })),
  min_apy: Type.Optional(Type.Number({
    description: 'Minimum APY % for search results.',
  })),
  stable_only: Type.Optional(Type.Boolean({
    description: 'Only show stablecoin pools. Default: false.',
  })),
  project: Type.Optional(Type.String({
    description: 'Filter by protocol name (e.g. "aave", "yearn", "moonwell", "morpho").',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Max results for search. Default: 20.',
  })),
});

export function createYieldTool() {
  return {
    name: 'yield',
    label: 'Yield',
    ownerOnly: true,
    description:
      'Find and execute yield opportunities across DeFi. Search DeFiLlama for best APYs, ' +
      'deposit into Yearn V3 vaults on Base (ERC-4626), or view your vault positions. ' +
      'Covers 400+ protocols across all EVM chains.',
    parameters: YieldSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'search':
          return handleSearch(params);
        case 'top_yields':
          return handleTopYields(params);
        case 'deposit':
          return handleDeposit(params);
        case 'withdraw':
          return handleWithdraw(params);
        case 'positions':
          return handlePositions();
        case 'vaults':
          return handleVaults();
        default:
          return errorResult(`Unknown action: ${action}. Use: search, top_yields, deposit, withdraw, positions, vaults`);
      }
    },
  };
}

// ── Action Handlers ─────────────────────────────────────────────────────

async function handleSearch(params: Record<string, unknown>) {
  try {
    const service = getYieldService();
    const pools = await service.searchPools({
      chain: readStringParam(params, 'chain') ?? undefined,
      asset: readStringParam(params, 'asset') ?? undefined,
      project: readStringParam(params, 'project') ?? undefined,
      minTvl: readNumberParam(params, 'min_tvl') ?? undefined,
      minApy: readNumberParam(params, 'min_apy') ?? undefined,
      stableOnly: params.stable_only === true,
      singleExposure: params.single_exposure === true,
      limit: readNumberParam(params, 'limit') ?? 20,
    });

    if (pools.length === 0) {
      return jsonResult({
        results: [],
        message: 'No pools found matching your criteria. Try broadening your search filters.',
      });
    }

    return jsonResult({
      count: pools.length,
      pools: pools.map(p => ({
        protocol: p.project,
        chain: p.chain,
        symbol: p.symbol,
        apy: `${p.apy.toFixed(2)}%`,
        apyBase: p.apyBase !== null ? `${p.apyBase.toFixed(2)}%` : null,
        apyReward: p.apyReward !== null ? `${p.apyReward.toFixed(2)}%` : null,
        tvl: formatTvl(p.tvlUsd),
        stablecoin: p.stablecoin,
        ilRisk: p.ilRisk,
        exposure: p.exposure,
      })),
      tip: 'Use action=deposit with a vault name to deposit directly, or action=top_yields for asset-specific results.',
    });
  } catch (err) {
    return errorResult(`Yield search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleTopYields(params: Record<string, unknown>) {
  const asset = readStringParam(params, 'asset');
  if (!asset) {
    return errorResult('asset is required for top_yields (e.g. "USDC", "WETH", "ETH").');
  }

  const chain = readStringParam(params, 'chain') ?? 'base';
  const limit = readNumberParam(params, 'limit') ?? 10;

  try {
    const service = getYieldService();
    const pools = await service.topYieldsForAsset(asset, chain, limit);

    if (pools.length === 0) {
      return jsonResult({
        asset,
        chain,
        results: [],
        message: `No yield pools found for ${asset} on ${chain}.`,
      });
    }

    return jsonResult({
      asset,
      chain,
      count: pools.length,
      pools: pools.map(p => ({
        protocol: p.project,
        symbol: p.symbol,
        apy: `${p.apy.toFixed(2)}%`,
        tvl: formatTvl(p.tvlUsd),
        stablecoin: p.stablecoin,
        meta: p.poolMeta,
      })),
    });
  } catch (err) {
    return errorResult(`Top yields failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleDeposit(params: Record<string, unknown>) {
  const vaultInput = readStringParam(params, 'vault') ?? readStringParam(params, 'asset');
  const amountInput = readStringParam(params, 'amount');
  if (!vaultInput || !amountInput) {
    return errorResult('Both vault (or asset) and amount are required for deposit.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const service = getYieldService();
  const vault = service.resolveVault(vaultInput);
  if (!vault) {
    const available = service.getAvailableVaults().map(v => `${v.name} (${v.asset})`).join(', ');
    return errorResult(`Unknown vault: "${vaultInput}". Available: ${available}`);
  }

  try {
    const amount = parseAmount(amountInput, vault.decimals);
    const tokenAddress = service.getTokenAddress(vault.asset);
    if (!tokenAddress) {
      return errorResult(`Cannot resolve token address for ${vault.asset}.`);
    }

    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const result = await service.deposit(
      vault.address,
      tokenAddress,
      amount,
      state.address as `0x${string}`,
      wallet,
      publicClient,
    );

    return jsonResult({
      status: 'success',
      action: 'deposit',
      vault: vault.name,
      vaultAddress: vault.address,
      asset: vault.asset,
      amount: formatUnits(amount, vault.decimals),
      txHash: result.hash,
      chain: 'base',
      note: `Deposited into ${vault.name} vault. Yield accrues automatically.`,
    });
  } catch (err) {
    return errorResult(`Deposit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleWithdraw(params: Record<string, unknown>) {
  const vaultInput = readStringParam(params, 'vault') ?? readStringParam(params, 'asset');
  const amountInput = readStringParam(params, 'amount');
  if (!vaultInput || !amountInput) {
    return errorResult('Both vault (or asset) and amount are required for withdraw. Use "max" for full withdrawal.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const service = getYieldService();
  const vault = service.resolveVault(vaultInput);
  if (!vault) {
    const available = service.getAvailableVaults().map(v => `${v.name} (${v.asset})`).join(', ');
    return errorResult(`Unknown vault: "${vaultInput}". Available: ${available}`);
  }

  try {
    const isMax = amountInput.toLowerCase() === 'max';
    const amount = isMax ? 0n : parseAmount(amountInput, vault.decimals);

    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const result = await service.withdraw(
      vault.address,
      amount,
      state.address as `0x${string}`,
      wallet,
      publicClient,
      isMax,
      vault.decimals,
    );

    return jsonResult({
      status: 'success',
      action: 'withdraw',
      vault: vault.name,
      vaultAddress: vault.address,
      asset: vault.asset,
      amount: result.assetsReturned,
      txHash: result.hash,
      chain: 'base',
    });
  } catch (err) {
    return errorResult(`Withdraw failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handlePositions() {
  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  try {
    const publicClient = requirePublicClient();
    const service = getYieldService();
    const positions = await service.getPositions(
      state.address as `0x${string}`,
      publicClient,
    );

    if (positions.length === 0) {
      return jsonResult({
        positions: [],
        message: 'No vault positions found. Use action=vaults to see available vaults, or action=search to find yield opportunities.',
      });
    }

    return jsonResult({
      chain: 'base',
      address: state.address,
      positions: positions.map(p => ({
        vault: p.vault,
        asset: p.asset,
        shares: p.shares,
        value: `${p.assetsValue} ${p.asset}`,
        apy: p.apy !== undefined ? `${p.apy.toFixed(2)}%` : 'unknown',
      })),
    });
  } catch (err) {
    return errorResult(`Positions check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleVaults() {
  const service = getYieldService();
  const vaults = service.getAvailableVaults();

  return jsonResult({
    chain: 'base',
    protocol: 'Yearn V3',
    standard: 'ERC-4626',
    vaults: vaults.map(v => ({
      name: v.name,
      asset: v.asset,
      address: v.address,
    })),
    note: 'Use action=deposit with vault name and amount to deposit. Use action=search to discover more yield options across all protocols.',
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

function parseAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed) throw new Error('Amount cannot be empty.');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount "${trimmed}". Must be a positive number.`);
  }

  const parts = trimmed.split('.');
  const whole = parts[0] ?? '0';
  let fraction = parts[1] ?? '';
  if (fraction.length > decimals) {
    fraction = fraction.slice(0, decimals);
  } else {
    fraction = fraction.padEnd(decimals, '0');
  }
  const result = BigInt(whole + fraction);
  if (result === 0n) throw new Error('Amount must be greater than zero.');
  return result;
}

function formatTvl(tvl: number): string {
  if (tvl >= 1_000_000_000) return `$${(tvl / 1_000_000_000).toFixed(2)}B`;
  if (tvl >= 1_000_000) return `$${(tvl / 1_000_000).toFixed(2)}M`;
  if (tvl >= 1_000) return `$${(tvl / 1_000).toFixed(1)}K`;
  return `$${tvl.toFixed(0)}`;
}
