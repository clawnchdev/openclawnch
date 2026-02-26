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
    ownerOnly: true,
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
    const { parseEther, parseUnits, formatEther, formatUnits } = await import('viem');
    const state = getWalletState();

    // Convert amount to wei (assume 18 decimals for ETH/WETH, try to detect for others)
    const isEth = tokenIn.toLowerCase() === BASE_TOKENS.ETH!.toLowerCase()
      || tokenIn.toLowerCase() === BASE_TOKENS.WETH!.toLowerCase();
    const amountWei = isEth
      ? parseEther(amount)
      : parseUnits(amount, 18); // Default to 18 decimals

    // Try Clawnch API swap quote (proxies 0x)
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

    const quote = await response.json() as any;

    return jsonResult({
      tokenIn: {
        address: tokenIn,
        amount,
        amountWei: amountWei.toString(),
      },
      tokenOut: {
        address: tokenOut,
        estimatedAmount: quote.buyAmount
          ? formatUnits(BigInt(quote.buyAmount), 18)
          : 'unknown',
      },
      price: quote.price,
      priceImpact: quote.estimatedPriceImpact,
      gas: quote.estimatedGas,
      gasPrice: quote.gasPrice,
      slippage: `${slippage}%`,
      sources: quote.sources?.filter((s: any) => s.proportion !== '0'),
      note: 'Use action "execute" to proceed with this swap.',
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
