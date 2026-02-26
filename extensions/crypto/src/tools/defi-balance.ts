/**
 * DeFi Balance Tool — wallet balance and token holdings
 *
 * Uses RpcManager for fault-tolerant multi-chain RPC access and
 * PriceOracle for cross-validated ETH price.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { getWalletState, getPublicClient } from '../services/walletconnect-service.js';
import { getRpcManager } from '../services/rpc-provider.js';
import { getPriceOracle } from '../services/price-oracle.js';
import type { PortfolioSummary } from '../lib/types.js';

const ACTIONS = ['overview', 'tokens', 'eth'] as const;

const DefiBalanceSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'overview: full portfolio summary. tokens: ERC-20 token list. eth: just ETH balance.',
  }),
  address: Type.Optional(Type.String({
    description: 'Wallet address to check (defaults to connected wallet)',
  })),
  chain: Type.Optional(Type.String({
    description: 'Chain to check (default: "base"). Options: base, ethereum, arbitrum, optimism, polygon',
  })),
});

export function createDefiBalanceTool() {
  return {
    name: 'defi_balance',
    label: 'DeFi Balance',
    ownerOnly: false,
    description:
      'Check wallet balances — ETH, ERC-20 tokens, and total portfolio value. ' +
      'Defaults to the connected ClawnchConnect wallet on Base. ' +
      'Supports Base, Ethereum, Arbitrum, Optimism, Polygon via multi-RPC failover. ' +
      'Can also check any address.',
    parameters: DefiBalanceSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;
      const chain = readStringParam(params, 'chain') || 'base';

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
          return handleOverview(address as `0x${string}`, chain);
        case 'tokens':
          return handleTokens(address as `0x${string}`, chain);
        case 'eth':
          return handleEthBalance(address as `0x${string}`, chain);
        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}

/**
 * Get a public client for the requested chain.
 * Tries RpcManager first (multi-provider failover), falls back to
 * the WalletConnect service's single client for backward compatibility.
 */
async function getClientForChain(chain: string) {
  try {
    const rpcManager = getRpcManager();
    return await rpcManager.getClient(chain);
  } catch {
    // Fallback to walletconnect-service's public client (Base only)
    const wc = getPublicClient();
    if (wc) return wc;
    throw new Error(
      'No RPC available. Set ALCHEMY_API_KEY or configure RPC providers.'
    );
  }
}

async function handleEthBalance(address: `0x${string}`, chain: string) {
  try {
    const publicClient = await getClientForChain(chain);
    const { formatEther } = await import('viem');

    const balance = await (publicClient as any).getBalance({ address });
    const ethBalance = formatEther(balance);

    // Get ETH price via cross-validated oracle
    let ethPriceUsd = 0;
    let priceConfidence: string | undefined;
    try {
      const oracle = getPriceOracle();
      const ethPrice = await oracle.getEthPrice();
      ethPriceUsd = ethPrice.priceUsd;
      priceConfidence = ethPrice.confidence;
    } catch {
      // Non-fatal — price is informational
    }

    return jsonResult({
      address,
      chain,
      ethBalance,
      ethBalanceWei: balance.toString(),
      ethPriceUsd: ethPriceUsd || undefined,
      ethValueUsd: ethPriceUsd ? parseFloat(ethBalance) * ethPriceUsd : undefined,
      priceConfidence,
    });
  } catch (err) {
    return errorResult(`Balance check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleTokens(address: `0x${string}`, chain: string) {
  try {
    const publicClient = await getClientForChain(chain);
    const rpcManager = getRpcManager();
    const chainId = rpcManager.resolveChainId(chain);

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
          chain,
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
      chain,
      chainId,
      note: 'For detailed ERC-20 balances, set up an Alchemy/Infura RPC or use Clawnch API. ' +
        'ETH balance is available via action "eth". ' +
        'Use defi_price tool to check individual token prices.',
    });
  } catch (err) {
    return errorResult(`Token balance check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleOverview(address: `0x${string}`, chain: string) {
  try {
    // Get ETH balance
    const ethResult = await handleEthBalance(address, chain);
    const ethData = JSON.parse(ethResult.content[0]!.text);

    // Get token balances  
    const tokenResult = await handleTokens(address, chain);
    const tokenData = JSON.parse(tokenResult.content[0]!.text);

    return jsonResult({
      address,
      chain,
      eth: {
        balance: ethData.ethBalance,
        priceUsd: ethData.ethPriceUsd,
        valueUsd: ethData.ethValueUsd,
        priceConfidence: ethData.priceConfidence,
      },
      tokens: tokenData,
      totalValueUsd: ethData.ethValueUsd ?? 'ETH price unavailable',
    });
  } catch (err) {
    return errorResult(`Portfolio overview failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
