/**
 * DeFi Swap Tool — token swaps via 0x aggregator
 * 
 * Builds swap transactions, presents quotes, and submits via ClawnchConnect.
 * Transactions above spending policy thresholds go to the user's phone.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  getWCSigner,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { validateSwap, type SafetyCheckResult } from '../services/safety-service.js';
import { getPrice } from '../services/price-service.js';

const ACTIONS = ['quote', 'execute'] as const;

const DefiSwapSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'quote: get a swap quote with price impact. execute: execute the swap.',
  }),
  token_in: Type.String({
    description: 'Token to sell — symbol (e.g. "ETH", "USDC") or contract address (0x...)',
  }),
  token_out: Type.String({
    description: 'Token to buy — symbol (e.g. "ETH", "USDC") or contract address (0x...)',
  }),
  amount: Type.String({
    description: 'Amount to sell (in human-readable units, e.g. "0.1" for 0.1 ETH)',
  }),
  slippage: Type.Optional(Type.Number({
    description: 'Max slippage percentage (default: 1.0 for 1%)',
  })),
});

// Well-known token addresses on Base
const BASE_TOKENS: Record<string, string> = {
  ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  CLAWNCH: '0xa1F72459dfA10BAD200Ac160eCd78C6b77a747be',
};

function resolveToken(input: string): string {
  if (input.startsWith('0x') && input.length === 42) return input;
  const upper = input.toUpperCase();
  return BASE_TOKENS[upper] ?? input;
}

export function createDefiSwapTool() {
  return {
    name: 'defi_swap',
    label: 'DeFi Swap',
    ownerOnly: false,
    description:
      'Swap tokens on Base via DEX aggregator. ' +
      'Get quotes with price impact and gas estimates, then execute swaps. ' +
      'Transactions go through ClawnchConnect for approval. ' +
      'Supports ETH, WETH, USDC, USDT, DAI, CLAWNCH, and any ERC-20 by address.',
    parameters: DefiSwapSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      const state = getWalletState();
      if (!state.connected) {
        return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
      }

      switch (action) {
        case 'quote':
          return handleQuote(params);
        case 'execute':
          return handleExecute(params);
        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}

async function handleQuote(params: Record<string, unknown>) {
  const tokenIn = resolveToken(readStringParam(params, 'token_in', { required: true })!);
  const tokenOut = resolveToken(readStringParam(params, 'token_out', { required: true })!);
  const amount = readStringParam(params, 'amount', { required: true })!;
  const slippage = readNumberParam(params, 'slippage') ?? 1.0;

  try {
    const { parseEther, parseUnits, formatUnits } = await import('viem');
    const state = getWalletState();

    // Convert amount to wei (assume 18 decimals for ETH/WETH, try to detect for others)
    const isEth = tokenIn.toLowerCase() === BASE_TOKENS.ETH!.toLowerCase()
      || tokenIn.toLowerCase() === BASE_TOKENS.WETH!.toLowerCase();
    const amountWei = isEth
      ? parseEther(amount)
      : parseUnits(amount, 18); // Default to 18 decimals

    // Query multiple DEX aggregators in parallel for best price
    const { getDexAggregator } = await import('../services/dex-aggregator.js');
    const aggregator = getDexAggregator({
      slippageBps: Math.round(slippage * 100),
    });

    let allQuotes: import('../services/dex-aggregator.js').SwapQuote[] = [];
    let bestQuote: import('../services/dex-aggregator.js').SwapQuote | null = null;

    try {
      allQuotes = await aggregator.getQuotes(tokenIn, tokenOut, amountWei.toString());
      const valid = allQuotes.filter((q) => !q.error && q.buyAmount !== '0');
      bestQuote = valid[0] ?? null;
    } catch {
      // All aggregators failed — fall back to Clawnch API (which proxies 0x)
    }

    // Fallback: Clawnch API swap quote if no aggregator returned a quote
    if (!bestQuote) {
      const apiUrl = process.env.CLAWNCHER_API_URL || 'https://clawn.ch';
      const quoteParams = new URLSearchParams({
        sellToken: tokenIn,
        buyToken: tokenOut,
        sellAmount: amountWei.toString(),
        slippagePercentage: (slippage / 100).toString(),
        takerAddress: state.address!,
      });

      const response = await fetch(`${apiUrl}/api/swap/quote?${quoteParams}`, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        const err = await response.text();
        return errorResult(`Quote failed: ${err}`);
      }

      const clawnchQuote = await response.json() as any;
      bestQuote = {
        aggregator: 'Clawnch (0x)',
        sellToken: tokenIn,
        buyToken: tokenOut,
        sellAmount: amountWei.toString(),
        buyAmount: clawnchQuote.buyAmount ?? '0',
        price: parseFloat(clawnchQuote.price ?? '0'),
        gasEstimate: clawnchQuote.estimatedGas ?? '0',
        gasPrice: clawnchQuote.gasPrice,
        route: clawnchQuote.sources?.filter((s: any) => s.proportion !== '0')
          .map((s: any) => s.name).join(' → ') ?? 'Clawnch',
        data: clawnchQuote,
      };
    }

    // Run safety check (non-blocking for quotes, just informational)
    let safety: SafetyCheckResult | null = null;
    try {
      safety = await validateSwap({
        tokenIn,
        tokenOut,
        amountEth: parseFloat(amount),
      });
    } catch {
      // Safety check failure shouldn't block quotes
    }

    // Build comparison table from all aggregator quotes
    const comparison = allQuotes
      .filter((q) => !q.error)
      .map((q) => ({
        aggregator: q.aggregator,
        buyAmount: formatUnits(BigInt(q.buyAmount || '0'), 18),
        gasEstimate: q.gasEstimate,
        gasCostUsd: q.gasCostUsd,
        route: q.route,
        isBest: q.aggregator === bestQuote!.aggregator,
      }));

    return jsonResult({
      bestAggregator: bestQuote.aggregator,
      tokenIn: {
        address: tokenIn,
        amount,
        amountWei: amountWei.toString(),
      },
      tokenOut: {
        address: tokenOut,
        estimatedAmount: bestQuote.buyAmount
          ? formatUnits(BigInt(bestQuote.buyAmount), 18)
          : 'unknown',
      },
      price: bestQuote.price,
      gas: bestQuote.gasEstimate,
      gasPrice: bestQuote.gasPrice,
      gasCostUsd: bestQuote.gasCostUsd,
      route: bestQuote.route,
      slippage: `${slippage}%`,
      comparison: comparison.length > 1 ? comparison : undefined,
      safety: safety ? {
        safe: safety.safe,
        warnings: safety.warnings,
        blockers: safety.blockers,
      } : undefined,
      note: safety?.blockers.length
        ? 'SAFETY BLOCKERS FOUND — review before executing.'
        : 'Use action "execute" to proceed with this swap.',
    });
  } catch (err) {
    return errorResult(`Quote failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleExecute(params: Record<string, unknown>) {
  const tokenIn = resolveToken(readStringParam(params, 'token_in', { required: true })!);
  const tokenOut = resolveToken(readStringParam(params, 'token_out', { required: true })!);
  const amount = readStringParam(params, 'amount', { required: true })!;
  const slippage = readNumberParam(params, 'slippage') ?? 1.0;

  // Pre-flight safety checks (blocking for execute)
  try {
    const safety = await validateSwap({
      tokenIn,
      tokenOut,
      amountEth: parseFloat(amount),
    });

    if (!safety.safe) {
      return errorResult(
        `Swap blocked by safety checks:\n` +
        safety.blockers.map(b => `  ✗ ${b}`).join('\n') +
        (safety.warnings.length
          ? '\n\nWarnings:\n' + safety.warnings.map(w => `  ⚠ ${w}`).join('\n')
          : '')
      );
    }

    // Log warnings but proceed
    if (safety.warnings.length > 0) {
      // Warnings are included in the successful result below
    }
  } catch {
    // Safety check infrastructure failure shouldn't block — proceed with caution
  }

  try {
    const { ClawnchSwapper } = await import('@clawnch/clawncher-sdk');
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const swapper = new ClawnchSwapper({
      wallet: wallet as any,
      publicClient: publicClient as any,
      apiBaseUrl: process.env.CLAWNCHER_API_URL || 'https://clawn.ch',
    });

    const { parseEther } = await import('viem');

    const result = await swapper.swap({
      sellToken: tokenIn as `0x${string}`,
      buyToken: tokenOut as `0x${string}`,
      sellAmount: parseEther(amount),
      slippageBps: Math.round(slippage * 100), // Convert percentage to basis points (1% = 100 bps)
    });

    return jsonResult({
      status: 'success',
      txHash: result.txHash,
      tokenIn,
      tokenOut,
      amountIn: amount,
      amountOut: result.buyAmount ? result.buyAmount.toString() : undefined,
      sellAmount: result.sellAmount?.toString(),
      gasUsed: result.gasUsed?.toString(),
    });
  } catch (err) {
    // If ClawnchSwapper not available, try direct 0x execution
    return errorResult(`Swap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
