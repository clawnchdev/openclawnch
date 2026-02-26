/**
 * DeFi Balance Tool — wallet balance and token holdings
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { getWalletState, requirePublicClient } from '../services/walletconnect-service.js';
import type { PortfolioSummary } from '../lib/types.js';

const ACTIONS = ['overview', 'tokens', 'eth'] as const;

const DefiBalanceSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'overview: full portfolio summary. tokens: ERC-20 token list. eth: just ETH balance.',
  }),
  address: Type.Optional(Type.String({
    description: 'Wallet address to check (defaults to connected wallet)',
  })),
});

export function createDefiBalanceTool() {
  return {
    name: 'defi_balance',
    label: 'DeFi Balance',
    ownerOnly: false,
    description:
      'Check wallet balances — ETH, ERC-20 tokens, and total portfolio value. ' +
      'Defaults to the connected ClawnchConnect wallet. ' +
      'Can also check any address.',
    parameters: DefiBalanceSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      // Resolve address
      let address = readStringParam(params, 'address');
      if (!address) {
        const state = getWalletState();
        if (!state.connected || !state.address) {
          return errorResult(
            'No wallet connected and no address provided. ' +
            'Connect a wallet first or pass an address parameter.'
          );
        }
        address = state.address;
      }

      switch (action) {
        case 'overview':
          return handleOverview(address as `0x${string}`);
        case 'tokens':
          return handleTokens(address as `0x${string}`);
        case 'eth':
          return handleEthBalance(address as `0x${string}`);
        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}

async function handleEthBalance(address: `0x${string}`) {
  try {
    const publicClient = requirePublicClient();
    const { formatEther } = await import('viem');

    const balance = await publicClient.getBalance({ address });
    const ethBalance = formatEther(balance);

    // Get ETH price from DexScreener (WETH on Base)
    let ethPriceUsd = 0;
    try {
      const response = await fetch(
        'https://api.dexscreener.com/latest/dex/search?q=WETH%20USDC',
        { headers: { Accept: 'application/json' } },
      );
      if (response.ok) {
        const data = await response.json() as any;
        const basePair = data.pairs?.find(
          (p: any) => p.chainId === 'base' && p.baseToken?.symbol === 'WETH',
        );
        if (basePair) {
          ethPriceUsd = parseFloat(basePair.priceUsd ?? '0');
        }
      }
    } catch {
      // Non-fatal
    }

    return jsonResult({
      address,
      ethBalance,
      ethBalanceWei: balance.toString(),
      ethPriceUsd: ethPriceUsd || undefined,
      ethValueUsd: ethPriceUsd ? parseFloat(ethBalance) * ethPriceUsd : undefined,
    });
  } catch (err) {
    return errorResult(`Balance check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleTokens(address: `0x${string}`) {
  try {
    const publicClient = requirePublicClient();
    const chainId = (publicClient as any).chain?.id;

    // Use Clawnch API to get portfolio if available
    try {
      const { ClawnchClient } = await import('@clawnch/clawncher-sdk');
      const client = new ClawnchClient({
        baseUrl: process.env.CLAWNCHER_API_URL || 'https://clawn.ch',
      });

      const fees = await client.getAvailableFees(address);
      if (fees) {
        return jsonResult({
          address,
          source: 'clawnch-api',
          ...fees,
        });
      }
    } catch {
      // Fallback: try basic ERC-20 balance check via public APIs
    }

    // Fallback: report that detailed token scanning requires an indexer
    return jsonResult({
      address,
      chainId,
      note: 'For detailed ERC-20 balances, set up an Alchemy/Infura RPC or use Clawnch API. ' +
        'ETH balance is available via action "eth". ' +
        'Use defi_price tool to check individual token prices.',
    });
  } catch (err) {
    return errorResult(`Token balance check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleOverview(address: `0x${string}`) {
  try {
    // Get ETH balance
    const ethResult = await handleEthBalance(address);
    const ethData = JSON.parse(ethResult.content[0]!.text);

    // Get token balances  
    const tokenResult = await handleTokens(address);
    const tokenData = JSON.parse(tokenResult.content[0]!.text);

    return jsonResult({
      address,
      eth: {
        balance: ethData.ethBalance,
        priceUsd: ethData.ethPriceUsd,
        valueUsd: ethData.ethValueUsd,
      },
      tokens: tokenData,
      totalValueUsd: ethData.ethValueUsd ?? 'ETH price unavailable',
    });
  } catch (err) {
    return errorResult(`Portfolio overview failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
