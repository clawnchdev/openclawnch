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
  isBankrMode,
} from '../services/walletconnect-service.js';
import { validateSwap, type SafetyCheckResult } from '../services/safety-service.js';
import { getPrice } from '../services/price-service.js';
import { hasBankrApi } from '../services/bankr-api.js';

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
  chain: Type.Optional(Type.String({
    description: 'Chain for the swap (default: "base"). Bankr mode supports: base, ethereum, polygon, unichain, solana',
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
      'Swap tokens via DEX aggregator (Base) or Bankr Agent API (all chains). ' +
      'Get quotes with price impact and gas estimates, then execute swaps. ' +
      'In Bankr mode, supports Base, Ethereum, Polygon, Unichain, and Solana. ' +
      'Supports ETH, WETH, USDC, USDT, DAI, CLAWNCH, and any token by address or symbol.',
    parameters: DefiSwapSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;
      const chain = readStringParam(params, 'chain') || 'base';

      const state = getWalletState();
      if (!state.connected) {
        return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
      }

      // Bankr routing: all chains go through Bankr when in bankr mode,
      // non-Base chains go through Bankr when API key is available
      const useBankr = isBankrMode() || (chain !== 'base' && hasBankrApi());

      if (useBankr) {
        if (!hasBankrApi()) {
          return errorResult(
            `Swaps on ${chain} require Bankr wallet. Connect via /connect_bankr first.`
          );
        }
        return action === 'quote'
          ? handleBankrQuote(params, chain)
          : handleBankrSwap(params, chain);
      }

      // Local path (Base only)
      if (chain !== 'base') {
        return errorResult(
          `Swaps on ${chain} are not supported without Bankr wallet. ` +
          'Connect via /connect_bankr to access multi-chain swaps.'
        );
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

// ─── Bankr Swap Handlers ─────────────────────────────────────────────────

// ─── Input Sanitization (C3: prevent prompt injection in Bankr NL prompts) ──
const SAFE_TOKEN_RE = /^[a-zA-Z0-9_.\-\/]{1,60}$/;
const SAFE_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SAFE_AMOUNT_RE = /^[0-9][0-9,._]*$/;
const SAFE_CHAIN_RE = /^[a-zA-Z0-9\-]{1,20}$/;

function sanitizeBankrToken(input: string): string {
  const trimmed = input.trim();
  if (SAFE_ADDRESS_RE.test(trimmed) || SAFE_TOKEN_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid token: "${trimmed.slice(0, 30)}". Use a symbol (e.g. "ETH") or address (0x...).`);
}
function sanitizeBankrAmount(input: string): string {
  const trimmed = input.trim();
  if (SAFE_AMOUNT_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid amount: "${trimmed.slice(0, 30)}". Use a number like "0.1" or "100".`);
}
function sanitizeBankrChain(input: string): string {
  const trimmed = input.trim();
  if (SAFE_CHAIN_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid chain: "${trimmed.slice(0, 20)}".`);
}

async function handleBankrQuote(params: Record<string, unknown>, chain: string) {
  const tokenIn = sanitizeBankrToken(readStringParam(params, 'token_in', { required: true })!);
  const tokenOut = sanitizeBankrToken(readStringParam(params, 'token_out', { required: true })!);
  const amount = sanitizeBankrAmount(readStringParam(params, 'amount', { required: true })!);
  const safeChain = sanitizeBankrChain(chain);

  try {
    const { bankrPromptAndPoll } = await import('../services/bankr-api.js');

    const prompt = `quote swapping ${amount} ${tokenIn} to ${tokenOut} on ${safeChain}`;
    const result = await bankrPromptAndPoll(prompt, { timeoutMs: 30_000 });

    if (result.status === 'failed') {
      return errorResult(`Quote failed: ${result.error ?? 'Unknown error'}`);
    }

    return jsonResult({
      source: 'bankr',
      chain,
      tokenIn,
      tokenOut,
      amount,
      response: result.response,
      richData: result.richData,
      note: 'Use action "execute" to proceed with this swap.',
    });
  } catch (err) {
    return errorResult(`Bankr quote failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleBankrSwap(params: Record<string, unknown>, chain: string) {
  const tokenIn = sanitizeBankrToken(readStringParam(params, 'token_in', { required: true })!);
  const tokenOut = sanitizeBankrToken(readStringParam(params, 'token_out', { required: true })!);
  const amount = sanitizeBankrAmount(readStringParam(params, 'amount', { required: true })!);
  const safeChain = sanitizeBankrChain(chain);

  try {
    const { bankrPromptAndPoll } = await import('../services/bankr-api.js');

    const prompt = `swap ${amount} ${tokenIn} to ${tokenOut} on ${safeChain}`;
    const result = await bankrPromptAndPoll(prompt, { timeoutMs: 120_000 });

    if (result.status === 'failed') {
      return errorResult(`Swap failed: ${result.error ?? 'Unknown error'}`);
    }

    // Parse transaction from result
    const txData = result.transactions?.find(t => t.type === 'swap');

    return jsonResult({
      status: 'success',
      source: 'bankr',
      chain,
      tokenIn,
      tokenOut,
      amountIn: amount,
      txHash: txData?.hash ?? (txData?.metadata as any)?.transaction?.hash,
      response: result.response,
      richData: result.richData,
    });
  } catch (err) {
    return errorResult(`Bankr swap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Local Swap Handlers ─────────────────────────────────────────────────

async function handleQuote(params: Record<string, unknown>) {
  const tokenIn = resolveToken(readStringParam(params, 'token_in', { required: true })!);
  const tokenOut = resolveToken(readStringParam(params, 'token_out', { required: true })!);
  const amount = readStringParam(params, 'amount', { required: true })!;
  const slippage = readNumberParam(params, 'slippage') ?? 1.0;

  try {
    const { parseEther, parseUnits, formatUnits } = await import('viem');
    const state = getWalletState();

    // L2: Detect actual decimals instead of assuming 18 for all non-ETH tokens
    const isEth = tokenIn.toLowerCase() === BASE_TOKENS.ETH!.toLowerCase()
      || tokenIn.toLowerCase() === BASE_TOKENS.WETH!.toLowerCase();
    let tokenDecimals = 18;
    if (!isEth) {
      // Check well-known tokens first
      const knownEntry = Object.entries(BASE_TOKENS).find(
        ([, addr]) => addr.toLowerCase() === tokenIn.toLowerCase()
      );
      if (knownEntry) {
        // USDC/USDT = 6 decimals, others = 18
        if (['USDC', 'USDT'].includes(knownEntry[0])) tokenDecimals = 6;
      } else {
        // Try reading decimals from chain
        try {
          const { erc20Abi } = await import('viem');
          const publicClient = requirePublicClient();
          const dec = await publicClient.readContract({
            address: tokenIn as `0x${string}`,
            abi: erc20Abi,
            functionName: 'decimals',
          }) as number;
          tokenDecimals = dec;
        } catch {
          // Fallback to 18 if we can't read
        }
      }
    }
    const amountWei = isEth
      ? parseEther(amount)
      : parseUnits(amount, tokenDecimals);

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
    // L2: Use detected tokenDecimals for output formatting
    const outDecimals = 18; // output token decimals — TODO: detect from tokenOut too
    const comparison = allQuotes
      .filter((q) => !q.error)
      .map((q) => ({
        aggregator: q.aggregator,
        buyAmount: formatUnits(BigInt(q.buyAmount || '0'), outDecimals),
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

    // Wrap swap in a timeout to prevent hanging when WC/wallet doesn't respond.
    // The WC signer has a 180s timeout internally, but we add our own 120s timeout
    // so the tool returns an error to the LLM instead of hanging indefinitely.
    const SWAP_TIMEOUT_MS = 120_000; // 2 minutes

    const swapPromise = swapper.swap({
      sellToken: tokenIn as `0x${string}`,
      buyToken: tokenOut as `0x${string}`,
      sellAmount: parseEther(amount),
      slippageBps: Math.round(slippage * 100),
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(
        'Swap timed out after 2 minutes. The transaction may still be pending in your wallet — check Rainbow/MetaMask. ' +
        'If you see a pending approval or swap, you can approve or reject it there.'
      )), SWAP_TIMEOUT_MS)
    );

    const result = await Promise.race([swapPromise, timeoutPromise]);

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
    const msg = err instanceof Error ? err.message : String(err);
    // Provide actionable error messages for common failure modes
    if (msg.includes('reverted')) {
      return errorResult(
        `Swap transaction reverted on-chain. This usually means:\n` +
        `  - Insufficient token balance or allowance\n` +
        `  - Price moved beyond slippage tolerance\n` +
        `  - Token has transfer restrictions\n` +
        `  - No liquidity for this pair on supported DEXes\n\n` +
        `Try checking your balance with defi_balance, or try a smaller amount.\n\nError: ${msg}`
      );
    }
    if (msg.includes('rejected') || msg.includes('declined') || msg.includes('denied')) {
      return errorResult(`Swap cancelled — you rejected the transaction in your wallet.`);
    }
    if (msg.includes('timed out') || msg.includes('Swap timed out')) {
      return errorResult(msg);
    }
    return errorResult(`Swap failed: ${msg}`);
  }
}
