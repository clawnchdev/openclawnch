/**
 * DeFi Staking Tool — liquid staking operations.
 *
 * Actions:
 *   stake     — Stake ETH to receive a liquid staking token (stETH, rETH)
 *   unstake   — Burn/redeem liquid staking token back to ETH
 *   wrap      — Wrap stETH → wstETH (Lido)
 *   unwrap    — Unwrap wstETH → stETH (Lido)
 *   positions — View current staking positions and APYs
 *
 * Protocols: Lido (stETH/wstETH), Rocket Pool (rETH), Coinbase (cbETH)
 * Chain: Ethereum mainnet (positions also shown on Base for bridged LSTs)
 */

import { Type } from '@sinclair/typebox';
import { parseEther } from 'viem';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { getStakingService } from '../services/staking-service.js';
import { getRpcManager } from '../services/rpc-provider.js';

const ACTIONS = ['stake', 'unstake', 'wrap', 'unwrap', 'positions'] as const;

const DefiStakeSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'stake: send ETH to receive stETH/rETH. unstake: burn LST for ETH. ' +
      'wrap: stETH → wstETH. unwrap: wstETH → stETH. ' +
      'positions: view staking positions and APYs.',
  }),
  protocol: Type.Optional(Type.String({
    description: 'Protocol: "lido" (stETH/wstETH), "rocket_pool" (rETH), "coinbase" (cbETH). Required for stake/unstake/wrap/unwrap.',
  })),
  amount: Type.Optional(Type.String({
    description: 'Amount in ETH (for stake) or LST units (for unstake/wrap/unwrap). E.g. "1.5" for 1.5 ETH.',
  })),
  chain: Type.Optional(Type.String({
    description: 'Chain for positions: "ethereum" (default) or "base". Staking always targets Ethereum mainnet.',
  })),
  address: Type.Optional(Type.String({
    description: 'Wallet address to check positions for. Defaults to connected wallet.',
  })),
});

export function createDefiStakeTool() {
  return {
    name: 'defi_stake',
    label: 'DeFi Staking',
    ownerOnly: true,
    description:
      'Liquid staking operations. Stake ETH via Lido (stETH) or Rocket Pool (rETH). ' +
      'Wrap stETH to wstETH for DeFi composability. View staking positions with live APYs. ' +
      'Staking operations target Ethereum mainnet.',
    parameters: DefiStakeSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'stake':
          return handleStake(params);
        case 'unstake':
          return handleUnstake(params);
        case 'wrap':
          return handleWrap(params);
        case 'unwrap':
          return handleUnwrap(params);
        case 'positions':
          return handlePositions(params);
        default:
          return errorResult(`Unknown action: ${action}. Use: stake, unstake, wrap, unwrap, positions`);
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireConnectedWallet() {
  const state = getWalletState();
  if (!state.connected || !state.address) {
    throw new Error('No wallet connected. Connect a wallet first.');
  }
  return state.address as `0x${string}`;
}

function resolveChainId(chain?: string): number {
  if (!chain) return 1; // Default to Ethereum for staking
  switch (chain.toLowerCase()) {
    case 'base': return 8453;
    case 'ethereum': case 'eth': case 'mainnet': default: return 1;
  }
}

/**
 * Validate and parse an ETH amount string.
 * Rejects empty, non-numeric, negative, and zero amounts with clear errors.
 */
function validateAndParseEther(amountInput: string): bigint {
  const trimmed = amountInput.trim();
  if (!trimmed) {
    throw new Error('Amount cannot be empty.');
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount "${trimmed}". Must be a positive number (e.g. "1.5", "0.01").`);
  }
  const parsed = parseFloat(trimmed);
  if (parsed === 0) {
    throw new Error('Amount must be greater than zero.');
  }
  return parseEther(trimmed);
}

// ── Action Handlers ─────────────────────────────────────────────────────────

async function handleStake(params: Record<string, unknown>) {
  const protocolInput = readStringParam(params, 'protocol', { required: true });
  const amountInput = readStringParam(params, 'amount', { required: true });
  if (!protocolInput || !amountInput) {
    return errorResult('Both protocol and amount are required for stake.');
  }

  try {
    const userAddress = requireConnectedWallet();
    const service = getStakingService();
    const protocol = service.resolveProtocol(protocolInput);
    if (!protocol) {
      return errorResult(
        `Unknown protocol: "${protocolInput}". Supported: lido (stETH), rocket_pool (rETH), coinbase (cbETH).`,
      );
    }

    const amount = validateAndParseEther(amountInput);
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const result = await service.stakeEth(protocol, amount, userAddress, wallet, publicClient);

    return jsonResult({
      status: 'success',
      action: 'stake',
      protocol: result.protocol,
      received: result.asset,
      ethStaked: result.amount,
      txHash: result.hash,
      note: protocol === 'lido'
        ? 'Received stETH. Use action=wrap to convert to wstETH for DeFi use.'
        : undefined,
    });
  } catch (err) {
    return errorResult(`Stake failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleUnstake(params: Record<string, unknown>) {
  const protocolInput = readStringParam(params, 'protocol', { required: true });
  const amountInput = readStringParam(params, 'amount', { required: true });
  if (!protocolInput || !amountInput) {
    return errorResult('Both protocol and amount are required for unstake.');
  }

  try {
    const userAddress = requireConnectedWallet();
    const service = getStakingService();
    const protocol = service.resolveProtocol(protocolInput);
    if (!protocol) {
      return errorResult(
        `Unknown protocol: "${protocolInput}". Supported: lido, rocket_pool, coinbase.`,
      );
    }

    const amount = validateAndParseEther(amountInput);
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const result = await service.unstake(protocol, amount, userAddress, wallet, publicClient);

    return jsonResult({
      status: 'success',
      action: 'unstake',
      protocol: result.protocol,
      burned: result.asset,
      amount: result.amount,
      txHash: result.hash,
    });
  } catch (err) {
    return errorResult(`Unstake failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleWrap(params: Record<string, unknown>) {
  const amountInput = readStringParam(params, 'amount', { required: true });
  if (!amountInput) {
    return errorResult('Amount of stETH to wrap is required.');
  }

  try {
    const userAddress = requireConnectedWallet();
    const service = getStakingService();
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const amount = validateAndParseEther(amountInput);
    const result = await service.wrap(amount, userAddress, wallet, publicClient);

    return jsonResult({
      status: 'success',
      action: 'wrap',
      protocol: 'lido',
      from: 'stETH',
      to: 'wstETH',
      stEthAmount: result.amount,
      txHash: result.hash,
      note: 'wstETH is the composable form — accepted by Aave, DeFi vaults, and L2 bridges.',
    });
  } catch (err) {
    return errorResult(`Wrap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleUnwrap(params: Record<string, unknown>) {
  const amountInput = readStringParam(params, 'amount', { required: true });
  if (!amountInput) {
    return errorResult('Amount of wstETH to unwrap is required.');
  }

  try {
    const userAddress = requireConnectedWallet();
    const service = getStakingService();
    const wallet = requireWalletClient();

    const amount = validateAndParseEther(amountInput);
    const publicClient = requirePublicClient();
    const result = await service.unwrap(amount, userAddress, wallet, publicClient);

    return jsonResult({
      status: 'success',
      action: 'unwrap',
      protocol: 'lido',
      from: 'wstETH',
      to: 'stETH',
      wstEthAmount: result.amount,
      txHash: result.hash,
    });
  } catch (err) {
    return errorResult(`Unwrap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handlePositions(params: Record<string, unknown>) {
  try {
    const state = getWalletState();
    const addressInput = readStringParam(params, 'address') ?? state.address;
    if (!addressInput) {
      return errorResult('No wallet connected and no address provided.');
    }

    const chainId = resolveChainId(readStringParam(params, 'chain'));
    const service = getStakingService();

    // Get appropriate client for the chain
    const rpcManager = getRpcManager();
    const publicClient = await rpcManager.getClient(chainId);

    const positions = await service.getPositions(
      addressInput as `0x${string}`,
      chainId,
      publicClient,
    );

    // Fetch APY data
    const apys = await service.getApys();

    if (positions.length === 0) {
      return jsonResult({
        chain: chainId === 1 ? 'ethereum' : 'base',
        address: addressInput,
        positions: [],
        message: 'No staking positions found on this chain.',
        tip: chainId === 8453
          ? 'LSTs on Base are bridged tokens. Staking is done on Ethereum mainnet.'
          : 'Use action=stake protocol=lido amount=1.0 to stake ETH.',
      });
    }

    const totalEth = positions.reduce(
      (sum, p) => sum + parseFloat(p.balanceEth || p.balance),
      0,
    );

    return jsonResult({
      chain: chainId === 1 ? 'ethereum' : 'base',
      address: addressInput,
      totalEthEquivalent: totalEth.toFixed(6),
      positions: positions.map(p => ({
        protocol: p.protocol,
        asset: p.asset,
        balance: p.balance,
        ethEquivalent: p.balanceEth,
        apy: p.apy ?? 'unavailable',
        chain: p.chain,
      })),
      apyRates: apys.length > 0
        ? apys.map(a => ({
            protocol: a.protocol,
            symbol: a.symbol,
            apy: `${a.apy.toFixed(2)}%`,
            tvl: a.tvl > 1_000_000_000
              ? `$${(a.tvl / 1_000_000_000).toFixed(1)}B`
              : `$${(a.tvl / 1_000_000).toFixed(0)}M`,
          }))
        : undefined,
    });
  } catch (err) {
    return errorResult(`Positions check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
