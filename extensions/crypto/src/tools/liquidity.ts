/**
 * Liquidity Tool — Uniswap V4/V3 liquidity position management.
 *
 * Actions:
 *   - positions: List all V3 positions for the connected wallet
 *   - v4_position: Read a specific V4 position by token ID
 *   - v4_pool: Read V4 pool state (price, liquidity, tick)
 *   - v3_mint: Mint a new V3 liquidity position
 *   - v4_mint: Mint a new V4 liquidity position
 *   - v3_add: Add liquidity to an existing V3 position
 *   - v3_remove: Remove liquidity from a V3 position
 *   - v3_collect: Collect accumulated fees from a V3 position
 *
 * Uses ClawnchLiquidity from @clawnch/clawncher-sdk.
 * Write operations go through ClawnchConnect for approval.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { checkBalance } from '../services/safety-service.js';

const ACTIONS = [
  'positions', 'v4_position', 'v4_pool',
  'v3_mint', 'v4_mint', 'v3_add', 'v3_remove', 'v3_collect',
] as const;

const LiquiditySchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'positions: list V3 positions. v4_position: read V4 position. v4_pool: read pool state. ' +
      'v3_mint/v4_mint: open new position. v3_add: add to existing. v3_remove: withdraw. v3_collect: claim fees.',
  }),
  token_id: Type.Optional(Type.String({
    description: 'Position NFT token ID (for v4_position, v3_add, v3_remove, v3_collect).',
  })),
  token0: Type.Optional(Type.String({
    description: 'Token 0 address — must be the lower address (for mint and v4_pool).',
  })),
  token1: Type.Optional(Type.String({
    description: 'Token 1 address — must be the higher address (for mint and v4_pool).',
  })),
  fee: Type.Optional(Type.Number({
    description: 'Fee tier in hundredths of bps (e.g. 3000 = 0.3%). Default: 3000.',
  })),
  tick_spacing: Type.Optional(Type.Number({
    description: 'Tick spacing for V4 pool. Default: 60.',
  })),
  hook_address: Type.Optional(Type.String({
    description: 'V4 hook contract address. Default: zero address (no hook).',
  })),
  tick_lower: Type.Optional(Type.Number({
    description: 'Lower tick boundary for new positions.',
  })),
  tick_upper: Type.Optional(Type.Number({
    description: 'Upper tick boundary for new positions.',
  })),
  amount0: Type.Optional(Type.String({
    description: 'Amount of token0 in human-readable units (for mint/add).',
  })),
  amount1: Type.Optional(Type.String({
    description: 'Amount of token1 in human-readable units (for mint/add).',
  })),
  percentage: Type.Optional(Type.Number({
    description: 'Percentage of liquidity to remove (0-100). Default: 100. For v3_remove.',
  })),
  slippage_bps: Type.Optional(Type.Number({
    description: 'Slippage tolerance in basis points (e.g. 50 = 0.5%). Default: 50.',
  })),
});

export function createLiquidityTool() {
  return {
    name: 'liquidity',
    label: 'Liquidity',
    ownerOnly: true,
    description:
      'Manage Uniswap V4 and V3 liquidity positions on Base. ' +
      'List positions, read pool state, mint/add/remove liquidity, and collect fees. ' +
      'Write operations go through ClawnchConnect for approval.',
    parameters: LiquiditySchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      const state = getWalletState();
      if (!state.connected) {
        return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
      }

      try {
        const { ClawnchLiquidity } = await import('@clawnch/clawncher-sdk');
        const wallet = requireWalletClient();
        const publicClient = requirePublicClient();

        const liquidity = new ClawnchLiquidity({
          wallet: wallet as any,
          publicClient: publicClient as any,
          network: 'mainnet',
        });

        switch (action) {
          case 'positions':
            return handlePositions(liquidity);
          case 'v4_position':
            return handleV4Position(liquidity, params);
          case 'v4_pool':
            return handleV4Pool(liquidity, params);
          case 'v3_mint':
            return handleV3Mint(liquidity, params);
          case 'v4_mint':
            return handleV4Mint(liquidity, params);
          case 'v3_add':
            return handleV3Add(liquidity, params);
          case 'v3_remove':
            return handleV3Remove(liquidity, params);
          case 'v3_collect':
            return handleV3Collect(liquidity, params);
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(`Liquidity operation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ─── Read Operations ──────────────────────────────────────────────────────

async function handlePositions(liquidity: any) {
  const positions = await liquidity.v3GetPositionsForWallet();

  if (positions.length === 0) {
    return jsonResult({
      count: 0,
      message: 'No V3 liquidity positions found for this wallet.',
    });
  }

  const formatted = positions.map((p: any, i: number) => ({
    index: i + 1,
    tokenId: p.tokenId.toString(),
    version: p.version,
    token0: p.token0,
    token1: p.token1,
    feeTier: `${p.fee / 10000}%`,
    tickRange: `${p.tickLower} → ${p.tickUpper}`,
    liquidity: p.liquidity.toString(),
    isActive: p.liquidity > 0n,
    unclaimedFees: {
      token0: p.unclaimedFees.token0.toString(),
      token1: p.unclaimedFees.token1.toString(),
    },
  }));

  return jsonResult({ count: positions.length, positions: formatted });
}

async function handleV4Position(liquidity: any, params: Record<string, unknown>) {
  const tokenId = readStringParam(params, 'token_id');
  if (!tokenId) return errorResult('token_id is required for v4_position.');

  const pos = await liquidity.v4GetPosition(BigInt(tokenId));

  return jsonResult({
    tokenId: pos.tokenId.toString(),
    token0: pos.token0,
    token1: pos.token1,
    feeTier: `${pos.fee / 10000}%`,
    tickRange: `${pos.tickLower} → ${pos.tickUpper}`,
    liquidity: pos.liquidity.toString(),
    unclaimedFees: {
      token0: pos.unclaimedFees.token0.toString(),
      token1: pos.unclaimedFees.token1.toString(),
    },
  });
}

async function handleV4Pool(liquidity: any, params: Record<string, unknown>) {
  const token0 = readStringParam(params, 'token0', { required: true })!;
  const token1 = readStringParam(params, 'token1', { required: true })!;
  const fee = readNumberParam(params, 'fee') ?? 3000;
  const tickSpacing = readNumberParam(params, 'tick_spacing') ?? 60;
  const hookAddress = readStringParam(params, 'hook_address') ?? '0x0000000000000000000000000000000000000000';

  const poolKey = {
    currency0: token0 as `0x${string}`,
    currency1: token1 as `0x${string}`,
    fee,
    tickSpacing,
    hooks: hookAddress as `0x${string}`,
  };

  const state = await liquidity.v4GetPoolState(poolKey);

  // Convert sqrtPriceX96 to human-readable price
  const sqrtPrice = Number(state.sqrtPriceX96) / Number(2n ** 96n);
  const price = sqrtPrice * sqrtPrice;

  return jsonResult({
    poolId: state.poolId,
    sqrtPriceX96: state.sqrtPriceX96.toString(),
    price_token1_per_token0: price,
    tick: state.tick,
    liquidity: state.liquidity.toString(),
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Read on-chain decimals for a token, with well-known fallbacks. */
async function getTokenDecimals(tokenAddress: string): Promise<number> {
  // Well-known tokens on Base
  const KNOWN_DECIMALS: Record<string, number> = {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6,  // USDC
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 6,  // USDT
  };
  const known = KNOWN_DECIMALS[tokenAddress.toLowerCase()];
  if (known !== undefined) return known;
  // Native ETH sentinel
  if (tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return 18;
  try {
    const publicClient = requirePublicClient();
    const { erc20Abi } = await import('viem');
    const dec = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'decimals',
    }) as number;
    return dec;
  } catch {
    return 18; // fallback
  }
}

/** Convert a human-readable amount string to BigInt wei using actual token decimals. */
async function toTokenWei(amount: string, tokenAddress: string): Promise<bigint> {
  const decimals = await getTokenDecimals(tokenAddress);
  const { parseUnits } = await import('viem');
  return parseUnits(amount, decimals);
}

// ─── Write Operations ─────────────────────────────────────────────────────

async function handleV3Mint(liquidity: any, params: Record<string, unknown>) {
  const token0 = readStringParam(params, 'token0', { required: true })!;
  const token1 = readStringParam(params, 'token1', { required: true })!;
  const tickLower = readNumberParam(params, 'tick_lower', { required: true })!;
  const tickUpper = readNumberParam(params, 'tick_upper', { required: true })!;
  const amount0 = readStringParam(params, 'amount0', { required: true })!;
  const amount1 = readStringParam(params, 'amount1', { required: true })!;
  const fee = readNumberParam(params, 'fee') ?? 3000;

  // Pre-flight gas check
  const safety = await checkBalance({ requiredEth: 0 });
  if (!safety.safe) {
    return errorResult(`Insufficient gas: ${safety.blockers.join('; ')}`);
  }

  const amount0Wei = await toTokenWei(amount0, token0);
  const amount1Wei = await toTokenWei(amount1, token1);

  const result = await liquidity.v3MintPosition({
    token0: token0 as `0x${string}`,
    token1: token1 as `0x${string}`,
    fee,
    tickLower,
    tickUpper,
    amount0Desired: amount0Wei,
    amount1Desired: amount1Wei,
    deadline: 1200,
  });

  return jsonResult({
    status: 'success',
    action: 'v3_mint',
    tokenId: result.tokenId.toString(),
    liquidity: result.liquidity.toString(),
    amount0: result.amount0.toString(),
    amount1: result.amount1.toString(),
    txHash: result.txHash,
  });
}

async function handleV4Mint(liquidity: any, params: Record<string, unknown>) {
  const token0 = readStringParam(params, 'token0', { required: true })!;
  const token1 = readStringParam(params, 'token1', { required: true })!;
  const tickLower = readNumberParam(params, 'tick_lower', { required: true })!;
  const tickUpper = readNumberParam(params, 'tick_upper', { required: true })!;
  const amount0 = readStringParam(params, 'amount0', { required: true })!;
  const amount1 = readStringParam(params, 'amount1', { required: true })!;
  const fee = readNumberParam(params, 'fee') ?? 3000;
  const tickSpacing = readNumberParam(params, 'tick_spacing') ?? 60;
  const hookAddress = readStringParam(params, 'hook_address');
  const slippageBps = readNumberParam(params, 'slippage_bps') ?? 50;

  // Pre-flight gas check
  const safety = await checkBalance({ requiredEth: 0 });
  if (!safety.safe) {
    return errorResult(`Insufficient gas: ${safety.blockers.join('; ')}`);
  }

  const amount0Wei = await toTokenWei(amount0, token0);
  const amount1Wei = await toTokenWei(amount1, token1);

  const result = await liquidity.v4MintPosition({
    token0: token0 as `0x${string}`,
    token1: token1 as `0x${string}`,
    fee,
    tickSpacing,
    hookAddress: hookAddress as `0x${string}` | undefined,
    tickLower,
    tickUpper,
    amount0Desired: amount0Wei,
    amount1Desired: amount1Wei,
    slippageBps,
    deadline: 1200,
  });

  return jsonResult({
    status: 'success',
    action: 'v4_mint',
    tokenId: result.tokenId.toString(),
    liquidity: result.liquidity.toString(),
    amount0: result.amount0.toString(),
    amount1: result.amount1.toString(),
    txHash: result.txHash,
  });
}

async function handleV3Add(liquidity: any, params: Record<string, unknown>) {
  const tokenId = readStringParam(params, 'token_id', { required: true })!;
  const amount0 = readStringParam(params, 'amount0', { required: true })!;
  const amount1 = readStringParam(params, 'amount1', { required: true })!;
  const token0 = readStringParam(params, 'token0');
  const token1 = readStringParam(params, 'token1');

  const safety = await checkBalance({ requiredEth: 0 });
  if (!safety.safe) {
    return errorResult(`Insufficient gas: ${safety.blockers.join('; ')}`);
  }

  // Use actual token decimals when addresses are provided, otherwise fall back to 18
  const amount0Wei = token0 ? await toTokenWei(amount0, token0) : BigInt(Math.round(parseFloat(amount0) * 1e18));
  const amount1Wei = token1 ? await toTokenWei(amount1, token1) : BigInt(Math.round(parseFloat(amount1) * 1e18));

  const result = await liquidity.v3AddLiquidity(BigInt(tokenId), {
    amount0Desired: amount0Wei,
    amount1Desired: amount1Wei,
    deadline: 1200,
  });

  return jsonResult({
    status: 'success',
    action: 'v3_add',
    tokenId,
    amount0: result.amount0.toString(),
    amount1: result.amount1.toString(),
    txHash: result.txHash,
  });
}

async function handleV3Remove(liquidity: any, params: Record<string, unknown>) {
  const tokenId = readStringParam(params, 'token_id', { required: true })!;
  const percentage = readNumberParam(params, 'percentage') ?? 100;

  const safety = await checkBalance({ requiredEth: 0 });
  if (!safety.safe) {
    return errorResult(`Insufficient gas: ${safety.blockers.join('; ')}`);
  }

  const pct = percentage / 100;
  const result = await liquidity.v3RemoveLiquidity(BigInt(tokenId), {
    percentageToRemove: pct,
    burnToken: pct === 1,
    deadline: 1200,
  });

  return jsonResult({
    status: 'success',
    action: 'v3_remove',
    tokenId,
    percentage,
    amount0: result.amount0.toString(),
    amount1: result.amount1.toString(),
    txHash: result.txHash,
  });
}

async function handleV3Collect(liquidity: any, params: Record<string, unknown>) {
  const tokenId = readStringParam(params, 'token_id', { required: true })!;

  const safety = await checkBalance({ requiredEth: 0 });
  if (!safety.safe) {
    return errorResult(`Insufficient gas: ${safety.blockers.join('; ')}`);
  }

  const result = await liquidity.v3CollectFees(BigInt(tokenId));

  return jsonResult({
    status: 'success',
    action: 'v3_collect',
    tokenId,
    feesCollected: {
      token0: result.amount0.toString(),
      token1: result.amount1.toString(),
    },
    txHash: result.txHash,
  });
}
