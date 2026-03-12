/**
 * Clawnch Fees Tool — check and claim LP trading fees
 * 
 * Clawnch-launched tokens earn 1% LP fees on every swap.
 * 80% goes to the deployer, 20% to the platform.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { validateClaim } from '../services/safety-service.js';

const ACTIONS = ['check', 'claim', 'claim_all'] as const;

const ClawnchFeesSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'check: see unclaimed fees. claim: claim fees for a specific token. claim_all: claim all available fees.',
  }),
  token: Type.Optional(Type.String({
    description: 'Token contract address (required for "claim" action)',
  })),
});

export function createClawnchFeesTool() {
  return {
    name: 'clawnch_fees',
    label: 'Clawnch Fees',
    ownerOnly: true,
    description:
      'Check and claim trading fee revenue from Clawnch-launched tokens. ' +
      'Every swap pays 1% LP fees — 80% goes to you as the deployer. ' +
      'Fees accumulate in WETH and can be claimed anytime.',
    parameters: ClawnchFeesSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      const state = getWalletState();
      if (!state.connected) {
        return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
      }

      switch (action) {
        case 'check':
          return handleCheck(state.address!);
        case 'claim':
          return handleClaim(params, state.address!);
        case 'claim_all':
          return handleClaimAll(state.address!);
        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}

async function handleCheck(address: string) {
  try {
    const { ClawnchClient } = await import('@clawnch/clawncher-sdk');
    const client = new ClawnchClient({
      baseUrl: process.env.CLAWNCHER_API_URL || 'https://clawn.ch',
    });

    const fees = await client.getAvailableFees(address);

    return jsonResult({
      address,
      ...fees,
      note: fees.tokens?.length
        ? 'Use action "claim" with a token address to claim fees, or "claim_all" to claim everything.'
        : 'No unclaimed fees found. Deploy tokens to start earning.',
    });
  } catch (err) {
    return errorResult(`Fee check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleClaim(params: Record<string, unknown>, address: string) {
  const token = readStringParam(params, 'token', { required: true })!;

  // Pre-flight: check gas balance
  try {
    const safety = await validateClaim();
    if (!safety.safe) {
      return errorResult(
        `Claim blocked:\n` + safety.blockers.map(b => `  ✗ ${b}`).join('\n')
      );
    }
  } catch {
    // Don't block on safety infra failure
  }

  try {
    const { ClawncherClaimer } = await import('@clawnch/clawncher-sdk');
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const claimer = new ClawncherClaimer({
      wallet,
      publicClient,
      network: (process.env.CLAWNCHER_NETWORK as 'mainnet' | 'sepolia') || 'mainnet',
    });

    const result = await claimer.claimAll(
      token as `0x${string}`,
      address as `0x${string}`,
    );

    return jsonResult({
      status: 'success',
      token,
      collectTx: result.collectRewards?.txHash,
      claimWethTx: result.claimFeesWeth?.txHash,
      claimTokenTx: result.claimFeesToken?.txHash,
    });
  } catch (err) {
    return errorResult(`Fee claim failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleClaimAll(address: string) {
  try {
    // First check what's available
    const { ClawnchClient, ClawncherClaimer } = await import('@clawnch/clawncher-sdk');
    const client = new ClawnchClient({
      baseUrl: process.env.CLAWNCHER_API_URL || 'https://clawn.ch',
    });

    const fees = await client.getAvailableFees(address);
    const claimableTokens = fees.tokens?.filter((t: any) =>
      parseFloat(t.wethFees || '0') > 0 || parseFloat(t.tokenFees || '0') > 0,
    ) ?? [];

    if (claimableTokens.length === 0) {
      return jsonResult({
        status: 'nothing_to_claim',
        address,
        message: 'No unclaimed fees found.',
      });
    }

    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();
    const claimer = new ClawncherClaimer({
      wallet,
      publicClient,
      network: (process.env.CLAWNCHER_NETWORK as 'mainnet' | 'sepolia') || 'mainnet',
    });

    const tokens = claimableTokens.map((t: any) => t.address as `0x${string}`);
    const batchResult = await claimer.claimBatch(tokens, address as `0x${string}`);

    const results = batchResult.results.map((r: any) => ({
      token: r.token,
      status: r.success ? 'claimed' : 'failed',
      collectTx: r.collectRewards?.txHash,
      claimWethTx: r.claimFeesWeth?.txHash,
      claimTokenTx: r.claimFeesToken?.txHash,
      error: r.error?.message,
    }));

    return jsonResult({
      status: 'complete',
      tokensProcessed: batchResult.results.length,
      successCount: batchResult.successCount,
      failureCount: batchResult.failureCount,
      results,
    });
  } catch (err) {
    return errorResult(`Claim all failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
