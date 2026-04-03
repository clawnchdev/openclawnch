/**
 * DeFi Lending Tool — supply, borrow, repay, withdraw on Aave V3 (Base).
 *
 * Actions:
 * - supply: Deposit assets as collateral to earn interest
 * - borrow: Borrow assets against your collateral
 * - repay: Repay borrowed assets
 * - withdraw: Withdraw supplied assets
 * - health_factor: Check your health factor and liquidation risk
 * - positions: View all active supply/borrow positions
 * - rates: View current supply/borrow APYs
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { getLendingService } from '../services/lending-service.js';
import { resolveAddressOrEns, isEnsName } from '../lib/ens-resolver.js';

const ACTIONS = ['supply', 'borrow', 'repay', 'withdraw', 'health_factor', 'positions', 'rates'] as const;

const DefiLendSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'supply: deposit assets as collateral. borrow: borrow against collateral. ' +
      'repay: repay borrowed assets. withdraw: withdraw supplied assets. ' +
      'health_factor: check liquidation risk. positions: view active positions. ' +
      'rates: view current APYs.',
  }),
  asset: Type.Optional(Type.String({
    description: 'Asset symbol (ETH, USDC, cbETH, USDbC) or contract address. Required for supply/borrow/repay/withdraw.',
  })),
  amount: Type.Optional(Type.String({
    description: 'Amount in human-readable units (e.g. "100" for 100 USDC, "0.5" for 0.5 ETH). Use "max" to repay/withdraw entire balance.',
  })),
  protocol: Type.Optional(Type.String({
    description: 'Lending protocol. Currently only "aave" (Aave V3 on Base) is supported.',
  })),
  address: Type.Optional(Type.String({
    description: 'Wallet address or ENS name to check positions/health for. Defaults to connected wallet.',
  })),
});

export function createDefiLendTool() {
  return {
    name: 'defi_lend',
    label: 'DeFi Lending',
    ownerOnly: true,
    description:
      'Supply, borrow, repay, and withdraw on Aave V3 on Base. ' +
      'Check health factor to monitor liquidation risk. View positions and current APYs. ' +
      'All write operations go through ClawnchConnect for approval.',
    parameters: DefiLendSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      // Protocol validation — only Aave V3 is currently supported
      const protocol = readStringParam(params, 'protocol');
      if (protocol && protocol.toLowerCase() !== 'aave') {
        return errorResult(`Protocol "${protocol}" is not yet supported. Currently only Aave V3 on Base is available.`);
      }

      switch (action) {
        case 'supply':
          return handleSupply(params);
        case 'borrow':
          return handleBorrow(params);
        case 'repay':
          return handleRepay(params);
        case 'withdraw':
          return handleWithdraw(params);
        case 'health_factor':
          return handleHealthFactor(params);
        case 'positions':
          return handlePositions(params);
        case 'rates':
          return handleRates();
        default:
          return errorResult(`Unknown action: ${action}. Use: supply, borrow, repay, withdraw, health_factor, positions, rates`);
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function parseAmount(amount: string, decimals: number): bigint {
  // Input validation
  const trimmed = amount.trim();
  if (!trimmed) {
    throw new Error('Amount cannot be empty.');
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount "${trimmed}". Must be a positive number (e.g. "100", "0.5").`);
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
  if (result === 0n) {
    throw new Error('Amount must be greater than zero.');
  }
  return result;
}

async function resolveAddress(params: Record<string, unknown>): Promise<string> {
  const addressInput = readStringParam(params, 'address');
  if (!addressInput) {
    const state = getWalletState();
    if (!state.connected || !state.address) {
      throw new Error('No wallet connected and no address provided.');
    }
    return state.address;
  }
  if (isEnsName(addressInput)) {
    const publicClient = requirePublicClient();
    const resolved = await resolveAddressOrEns(addressInput, publicClient);
    return resolved.address;
  }
  return addressInput;
}

/**
 * Check if the user is trying to use native ETH where WETH is needed.
 * Aave works with WETH (ERC-20), not native ETH. Return a clear error message.
 */
function checkNativeEthWarning(assetInput: string, asset: { symbol: string }): string | null {
  if (asset.symbol === 'ETH' && assetInput.toUpperCase() === 'ETH') {
    return (
      'Note: Aave uses WETH (wrapped ETH), not native ETH. ' +
      'If you have native ETH, wrap it first using a swap (swap 0 ETH for WETH) ' +
      'or use the "Wrap ETH" option. If you already have WETH, this will work as expected.'
    );
  }
  return null;
}

// ── Action Handlers ──────────────────────────────────────────────────────

async function handleSupply(params: Record<string, unknown>) {
  const assetInput = readStringParam(params, 'asset', { required: true });
  const amountInput = readStringParam(params, 'amount', { required: true });
  if (!assetInput || !amountInput) {
    return errorResult('Both asset and amount are required for supply.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const service = getLendingService();
  const asset = service.resolveAsset(assetInput);
  if (!asset) {
    const supported = service.getSupportedAssets().map(a => a.symbol).join(', ');
    return errorResult(`Unknown asset: "${assetInput}". Supported: ${supported}`);
  }

  try {
    const amount = parseAmount(amountInput, asset.decimals);
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const result = await service.supply(
      asset, amount, state.address as `0x${string}`, wallet, publicClient,
    );

    // Get updated health factor
    const accountData = await service.getUserAccountData(
      state.address as `0x${string}`, publicClient,
    );

    const { formatUnits } = await import('viem');

    return jsonResult({
      status: 'success',
      action: 'supply',
      protocol: 'aave',
      asset: asset.symbol,
      amount: formatUnits(amount, asset.decimals),
      txHash: result.hash,
      healthFactor: accountData.healthFactor === Infinity ? 'safe (no debt)' : accountData.healthFactor.toFixed(4),
      totalCollateralUsd: accountData.totalCollateralUsd.toFixed(2),
    });
  } catch (err) {
    const ethNote = checkNativeEthWarning(assetInput, asset);
    const errMsg = `Supply failed: ${err instanceof Error ? err.message : String(err)}`;
    return errorResult(ethNote ? `${errMsg}\n\n${ethNote}` : errMsg);
  }
}

async function handleBorrow(params: Record<string, unknown>) {
  const assetInput = readStringParam(params, 'asset', { required: true });
  const amountInput = readStringParam(params, 'amount', { required: true });
  if (!assetInput || !amountInput) {
    return errorResult('Both asset and amount are required for borrow.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const service = getLendingService();
  const asset = service.resolveAsset(assetInput);
  if (!asset) {
    const supported = service.getSupportedAssets().map(a => a.symbol).join(', ');
    return errorResult(`Unknown asset: "${assetInput}". Supported: ${supported}`);
  }

  try {
    // Pre-flight: check health factor
    const publicClient = requirePublicClient();
    const preCheck = await service.getUserAccountData(
      state.address as `0x${string}`, publicClient,
    );

    if (preCheck.totalCollateralUsd === 0) {
      return errorResult('No collateral supplied. Supply assets first before borrowing.');
    }

    const amount = parseAmount(amountInput, asset.decimals);
        const wallet = requireWalletClient();

        const result = await service.borrow(
          asset, amount, state.address as `0x${string}`, wallet, publicClient,
        );

    // Get updated health factor
    const postCheck = await service.getUserAccountData(
      state.address as `0x${string}`, publicClient,
    );

    const { formatUnits } = await import('viem');
    const healthWarning = postCheck.healthFactor < 1.5
      ? ' ⚠️ Health factor is low — risk of liquidation!'
      : '';

    return jsonResult({
      status: 'success',
      action: 'borrow',
      protocol: 'aave',
      asset: asset.symbol,
      amount: formatUnits(amount, asset.decimals),
      txHash: result.hash,
      healthFactor: postCheck.healthFactor.toFixed(4),
      healthWarning: healthWarning || undefined,
      totalDebtUsd: postCheck.totalDebtUsd.toFixed(2),
    });
  } catch (err) {
    return errorResult(`Borrow failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleRepay(params: Record<string, unknown>) {
  const assetInput = readStringParam(params, 'asset', { required: true });
  const amountInput = readStringParam(params, 'amount', { required: true });
  if (!assetInput || !amountInput) {
    return errorResult('Both asset and amount are required for repay.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const service = getLendingService();
  const asset = service.resolveAsset(assetInput);
  if (!asset) {
    const supported = service.getSupportedAssets().map(a => a.symbol).join(', ');
    return errorResult(`Unknown asset: "${assetInput}". Supported: ${supported}`);
  }

  try {
    const isMax = amountInput.toLowerCase() === 'max';
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    let amount: bigint;
    if (isMax) {
      // Query actual debt balance instead of using MaxUint256 for approval.
      // Aave's repay() accepts MaxUint256 to mean "repay all", but we only
      // approve the actual debt + 0.5% buffer (for interest accruing between
      // the approval and repay txs). This avoids granting unlimited approval.
      const debtBalance = await service.getDebtBalance(
        asset, state.address as `0x${string}`, publicClient,
      );
      if (debtBalance === 0n) {
        return errorResult(`No outstanding ${asset.symbol} debt to repay.`);
      }
      // Approve debt + 0.5% buffer; pass MaxUint256 to Aave's repay() itself
      // (Aave contract interprets MaxUint256 as "repay full balance")
      const approvalAmount = debtBalance + (debtBalance / 200n); // +0.5%
      await service.ensureApprovalPublic(
        asset.address, approvalAmount, state.address as `0x${string}`, wallet, publicClient,
      );
      amount = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    } else {
      amount = parseAmount(amountInput, asset.decimals);
    }

    const result = await service.repay(
      asset, amount, state.address as `0x${string}`, wallet, publicClient, isMax,
    );

    const postCheck = await service.getUserAccountData(
      state.address as `0x${string}`, publicClient,
    );

    return jsonResult({
      status: 'success',
      action: 'repay',
      protocol: 'aave',
      asset: asset.symbol,
      amount: isMax ? 'max (entire debt)' : amountInput,
      txHash: result.hash,
      healthFactor: postCheck.healthFactor === Infinity ? 'safe (no debt)' : postCheck.healthFactor.toFixed(4),
      remainingDebtUsd: postCheck.totalDebtUsd.toFixed(2),
    });
  } catch (err) {
    const ethNote = checkNativeEthWarning(assetInput, asset);
    const errMsg = `Repay failed: ${err instanceof Error ? err.message : String(err)}`;
    return errorResult(ethNote ? `${errMsg}\n\n${ethNote}` : errMsg);
  }
}

async function handleWithdraw(params: Record<string, unknown>) {
  const assetInput = readStringParam(params, 'asset', { required: true });
  const amountInput = readStringParam(params, 'amount', { required: true });
  if (!assetInput || !amountInput) {
    return errorResult('Both asset and amount are required for withdraw.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const service = getLendingService();
  const asset = service.resolveAsset(assetInput);
  if (!asset) {
    const supported = service.getSupportedAssets().map(a => a.symbol).join(', ');
    return errorResult(`Unknown asset: "${assetInput}". Supported: ${supported}`);
  }

  try {
    const isMax = amountInput.toLowerCase() === 'max';
    const amount = isMax
      ? BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
      : parseAmount(amountInput, asset.decimals);

    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const result = await service.withdraw(
      asset, amount, state.address as `0x${string}`, wallet, publicClient,
    );
    const postCheck = await service.getUserAccountData(
      state.address as `0x${string}`, publicClient,
    );

    const healthWarning = postCheck.healthFactor !== Infinity && postCheck.healthFactor < 1.5
      ? ' ⚠️ Health factor dropped — monitor closely!'
      : '';

    return jsonResult({
      status: 'success',
      action: 'withdraw',
      protocol: 'aave',
      asset: asset.symbol,
      amount: isMax ? 'max (entire balance)' : amountInput,
      txHash: result.hash,
      healthFactor: postCheck.healthFactor === Infinity ? 'safe (no debt)' : postCheck.healthFactor.toFixed(4),
      healthWarning: healthWarning || undefined,
    });
  } catch (err) {
    return errorResult(`Withdraw failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleHealthFactor(params: Record<string, unknown>) {
  try {
    const address = await resolveAddress(params);
    const publicClient = requirePublicClient();
    const service = getLendingService();

    const data = await service.getUserAccountData(address as `0x${string}`, publicClient);

    let status: string;
    if (data.healthFactor === Infinity) {
      status = 'safe — no outstanding debt';
    } else if (data.healthFactor > 2.0) {
      status = 'healthy';
    } else if (data.healthFactor > 1.5) {
      status = 'moderate — consider adding collateral or repaying debt';
    } else if (data.healthFactor > 1.1) {
      status = 'WARNING — approaching liquidation zone';
    } else {
      status = 'DANGER — immediate liquidation risk!';
    }

    return jsonResult({
      protocol: 'aave',
      address,
      healthFactor: data.healthFactor === Infinity ? 'Infinity (no debt)' : data.healthFactor.toFixed(4),
      status,
      totalCollateralUsd: data.totalCollateralUsd.toFixed(2),
      totalDebtUsd: data.totalDebtUsd.toFixed(2),
      availableBorrowsUsd: data.availableBorrowsUsd.toFixed(2),
      ltvPercent: data.ltv.toFixed(1),
      liquidationThresholdPercent: data.liquidationThreshold.toFixed(1),
    });
  } catch (err) {
    return errorResult(`Health factor check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handlePositions(params: Record<string, unknown>) {
  try {
    const address = await resolveAddress(params);
    const publicClient = requirePublicClient();
    const service = getLendingService();
    const { formatUnits, erc20Abi } = await import('viem');

    const accountData = await service.getUserAccountData(address as `0x${string}`, publicClient);
    const assets = service.getSupportedAssets();

    // Check aToken balances (supply positions) and debt token balances (borrow positions)
    const positions: Array<{
      asset: string;
      type: 'supply' | 'borrow';
      balance: string;
    }> = [];

    for (const asset of assets) {
      // Check supply (aToken balance)
      if (asset.aToken) {
        try {
          const balance = await publicClient.readContract({
            address: asset.aToken,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address as `0x${string}`],
          }) as bigint;
          if (balance > 0n) {
            positions.push({
              asset: asset.symbol,
              type: 'supply',
              balance: formatUnits(balance, asset.decimals),
            });
          }
        } catch { /* skip if contract call fails */ }
      }

      // Check borrow (variable debt token balance)
      if (asset.variableDebtToken) {
        try {
          const balance = await publicClient.readContract({
            address: asset.variableDebtToken,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address as `0x${string}`],
          }) as bigint;
          if (balance > 0n) {
            positions.push({
              asset: asset.symbol,
              type: 'borrow',
              balance: formatUnits(balance, asset.decimals),
            });
          }
        } catch { /* skip if contract call fails */ }
      }
    }

    return jsonResult({
      protocol: 'aave',
      address,
      positions,
      summary: {
        totalCollateralUsd: accountData.totalCollateralUsd.toFixed(2),
        totalDebtUsd: accountData.totalDebtUsd.toFixed(2),
        healthFactor: accountData.healthFactor === Infinity ? 'safe (no debt)' : accountData.healthFactor.toFixed(4),
        netPositionUsd: (accountData.totalCollateralUsd - accountData.totalDebtUsd).toFixed(2),
      },
    });
  } catch (err) {
    return errorResult(`Positions check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleRates() {
  const service = getLendingService();
  const assets = service.getSupportedAssets();
  const protocols = service.getSupportedProtocols();

  // Try to fetch live APY data from DeFiLlama
  let liveRates: Array<{ symbol: string; supplyApy: number; borrowApy: number; tvl: number }> = [];
  try {
    const res = await fetch('https://yields.llama.fi/pools');
    if (res.ok) {
      const data = (await res.json()) as { data: Array<{ project: string; chain: string; symbol: string; apy: number; apyBorrow: number; tvlUsd: number }> };
      liveRates = data.data
        .filter(p => p.project === 'aave-v3' && p.chain === 'Base')
        .map(p => ({
          symbol: p.symbol,
          supplyApy: Math.round(p.apy * 100) / 100,
          borrowApy: Math.round((p.apyBorrow ?? 0) * 100) / 100,
          tvl: Math.round(p.tvlUsd),
        }));
    }
  } catch {
    // Fall back to static list
  }

  if (liveRates.length > 0) {
    return jsonResult({
      source: 'DeFiLlama (live)',
      protocol: 'Aave V3',
      chain: 'Base',
      rates: liveRates,
    });
  }

  return jsonResult({
    notice: 'Could not fetch live APY data. Showing supported assets and protocols.',
    protocols: protocols.map(p => ({ id: p.id, name: p.name, chain: p.chain })),
    supportedAssets: assets.map(a => ({
      symbol: a.symbol,
      address: a.address,
    })),
    tip: 'Try again later for live rates, or ask me to check DeFiLlama yields for Aave V3 on Base.',
  });
}
