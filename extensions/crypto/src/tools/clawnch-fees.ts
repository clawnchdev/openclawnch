/**
 * Clawnch Fees Tool — check and claim LP trading fees
 *
 * Clawnch-launched tokens earn 1% LP fees on every swap.
 * 80% goes to the deployer, 20% to the platform.
 *
 * Base (default): ClawncherClaimer against Clanker pools.
 * Robinhood Chain (chain: "robinhood"): Bags.fm fee shares — fees accrue in
 * WETH inside the token's BagsFeeShare and the claimer claims them itself
 * (native ETH). Reads + the unsigned claim transaction come from
 * GET/POST /api/robinhood/claim.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { validateClaim } from '../services/safety-service.js';
import { getCredentialVault } from '../services/credential-vault.js';
import { resolveClawnchChainKey, explorerTxUrl, type ClawnchChainKey } from '../lib/contract-registry.js';
import * as rh from '../lib/robinhood-api.js';
import { formatEther } from 'viem';

const CLAWNCH_API_URL = process.env.CLAWNCHER_API_URL || 'https://clawn.ch';
const ACTIONS = ['check', 'claim', 'claim_all'] as const;
const CHAINS = ['base', 'robinhood'] as const;

const ClawnchFeesSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'check: see unclaimed fees. claim: claim fees for a specific token. claim_all: claim all available fees.',
  }),
  token: Type.Optional(Type.String({
    description: 'Token contract address (required for "claim" action)',
  })),
  chain: Type.Optional(stringEnum(CHAINS, {
    description:
      'Chain to operate on: "base" (default, Clanker pools) or "robinhood" (Robinhood Chain Bags.fm fee shares).',
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
      'On Base fees accumulate in WETH in the Clanker pool; on Robinhood Chain (chain: "robinhood") ' +
      'they accumulate in the token BagsFeeShare and are claimed as native ETH by your own wallet.',
    parameters: ClawnchFeesSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      const state = getWalletState();
      if (!state.connected) {
        return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
      }

      const requested = readStringParam(params, 'chain');
      const chain: ClawnchChainKey | null = requested
        ? resolveClawnchChainKey(requested) ?? null
        : 'base';
      if (!chain) {
        return errorResult(`Unknown chain "${requested}". Supported fee chains: ${CHAINS.join(', ')}.`);
      }

      if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
        return errorResult(`Unknown action: ${action}`);
      }

      if (chain === 'robinhood') {
        return handleRobinhoodFees(action, params, state.address!);
      }

      try {
        switch (action) {
          case 'check':
            return await handleCheck(state.address!);
          case 'claim':
            return await handleClaim(params, state.address!);
          case 'claim_all':
            return await handleClaimAll(state.address!);
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(`Fee request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ─── Base path (Clanker — unchanged behavior) ─────────────────────────────

async function handleCheck(address: string) {
  try {
    const { ClawnchClient } = await import('@clawnch/clawncher-sdk');
    const client = new ClawnchClient({
      baseUrl: CLAWNCH_API_URL,
    });

    const fees = await client.getAvailableFees(address);

    return jsonResult({
      chain: 'base',
      chainId: 8453,
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
      chain: 'base',
      chainId: 8453,
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
      baseUrl: CLAWNCH_API_URL,
    });

    const fees = await client.getAvailableFees(address);
    const claimableTokens = fees.tokens?.filter((t: any) =>
      parseFloat(t.wethFees || '0') > 0 || parseFloat(t.tokenFees || '0') > 0,
    ) ?? [];

    if (claimableTokens.length === 0) {
      return jsonResult({
        status: 'nothing_to_claim',
        chain: 'base',
        chainId: 8453,
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
      chain: 'base',
      chainId: 8453,
      tokensProcessed: batchResult.results.length,
      successCount: batchResult.successCount,
      failureCount: batchResult.failureCount,
      results,
    });
  } catch (err) {
    return errorResult(`Claim all failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Robinhood Chain path (Bags.fm fee shares) ────────────────────────────

async function handleRobinhoodFees(
  action: string,
  params: Record<string, unknown>,
  address: string,
) {
  try {
    if (action === 'claim') {
      const token = readStringParam(params, 'token', { required: true })!;
      return await rhClaimOne(token, address);
    }

    // check / claim_all both start from the agent's known launch tokens.
    const explicitToken = readStringParam(params, 'token');
    const tokens = await rhAgentTokens(explicitToken, address);
    if (tokens.length === 0) {
      return jsonResult({
        chain: 'robinhood',
        chainId: rh.RH_CHAIN_ID,
        address,
        tokens: [],
        message: 'No Robinhood Chain launches found for this wallet — nothing to claim.',
      });
    }

    // An explicitly requested token surfaces API errors directly; the whole-launch
    // sweep reports per-token errors so one bad token can't hide the rest.
    const states = await readRhClaimStates(tokens, address, { throwOnError: Boolean(explicitToken) });

    if (action === 'check') {
      return jsonResult({
        chain: 'robinhood',
        chainId: rh.RH_CHAIN_ID,
        address,
        tokenCount: states.length,
        claimableCount: states.filter(s => s.claimableWei !== '0').length,
        totalClaimableWei: states.reduce((acc, s) => acc + BigInt(s.claimableWei), 0n).toString(),
        totalClaimableEth: formatEther(states.reduce((acc, s) => acc + BigInt(s.claimableWei), 0n)),
        tokens: states.map(s => ({
          token: s.token,
          feeShare: s.feeShare,
          isClaimer: s.isClaimer,
          creatorFeeBps: s.bps,
          claimableWei: s.claimableWei,
          claimableEth: formatEther(BigInt(s.claimableWei)),
          tradeUrl: rh.rhTradeUrl(s.token),
          explorerUrl: rh.rhExplorerTokenUrl(s.token),
          error: s.error,
        })),
        note: 'Use action "claim" with a token address, or "claim_all" to claim every token with a balance.',
      });
    }

    // claim_all
    const claimable = states.filter(s => s.isClaimer && s.claimableWei !== '0');
    if (claimable.length === 0) {
      return jsonResult({
        status: 'nothing_to_claim',
        chain: 'robinhood',
        chainId: rh.RH_CHAIN_ID,
        address,
        message: 'No unclaimed fees found.',
        tokens: states.map(s => ({ token: s.token, claimableWei: s.claimableWei, error: s.error })),
      });
    }

    const safety = await checkRhGas(address);
    if (!safety.safe) {
      return errorResult(`Claim blocked:\n${safety.blockers.map(b => `  ✗ ${b}`).join('\n')}`);
    }

    const results: Record<string, unknown>[] = [];
    for (const state of claimable) {
      try {
        const result = await rhClaimOne(state.token, address);
        results.push({ token: state.token, status: 'claimed', details: result.details ?? result });
      } catch (err) {
        results.push({ token: state.token, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }

    return jsonResult({
      status: 'complete',
      chain: 'robinhood',
      chainId: rh.RH_CHAIN_ID,
      tokensProcessed: results.length,
      successCount: results.filter(r => r.status === 'claimed').length,
      failureCount: results.filter(r => r.status === 'failed').length,
      results,
    });
  } catch (err) {
    return errorResult(`Robinhood Chain fee claim failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Claim a single Robinhood Chain token (returns a jsonResult). */
async function rhClaimOne(token: string, address: string) {
  const claim = await rh.requestRhClaimTx({ apiKey: requireAgentApiKey(), token });

  if (!claim.ready || !claim.claim) {
    return jsonResult({
      status: 'nothing_to_claim',
      chain: 'robinhood',
      chainId: rh.RH_CHAIN_ID,
      token,
      claimableWei: claim.claimableWei,
      note: claim.note
        ?? 'Nothing claimable right now. Post-migration fees sweep into the fee share when a claim runs.',
    });
  }

  const safety = await checkRhGas(address);
  if (!safety.safe) {
    return errorResult(`Claim blocked:\n${safety.blockers.map(b => `  ✗ ${b}`).join('\n')}`);
  }

  const txHash = await rh.sendRhTransaction(claim.claim);

  return jsonResult({
    status: 'success',
    chain: 'robinhood',
    chainId: rh.RH_CHAIN_ID,
    token,
    feeShare: claim.claim.to,
    claimableWei: claim.claimableWei,
    claimableEth: claim.claimableEth ?? formatEther(BigInt(claim.claimableWei)),
    creatorFeeBps: claim.meta?.bps,
    txHash,
    txUrl: explorerTxUrl('robinhood', txHash),
    note: 'Fees claimed as native ETH to your agent wallet.',
  });
}

/** Token list to check: an explicit token, or every launch by this agent. */
async function rhAgentTokens(explicitToken: string | undefined, address: string): Promise<string[]> {
  if (explicitToken) return [explicitToken];

  const feed = await rh.getRhLaunches({ agent: address, limit: 200 });
  const tokens = feed.launches.map(l => l.token).filter((t): t is string => typeof t === 'string' && t.length > 0);
  return [...new Set(tokens)];
}

interface RhClaimStateRow {
  token: string;
  feeShare?: string;
  isClaimer: boolean;
  bps: number;
  claimableWei: string;
  error?: string;
}

/**
 * Read claim state for each token; a single failure never hides the rest —
 * unless the caller asked for one specific token, in which case the API error
 * is surfaced instead of being reported as a zero balance.
 */
async function readRhClaimStates(
  tokens: string[],
  address: string,
  opts: { throwOnError?: boolean } = {},
): Promise<RhClaimStateRow[]> {
  const rows: RhClaimStateRow[] = [];
  for (const token of tokens) {
    try {
      const state = await rh.readRhClaim({ token, address });
      rows.push({
        token,
        feeShare: state.feeShare,
        isClaimer: state.isClaimer,
        bps: state.bps,
        claimableWei: state.claimableWei,
      });
    } catch (err) {
      if (opts.throwOnError) throw err;
      rows.push({
        token,
        isClaimer: false,
        bps: 0,
        claimableWei: '0',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows;
}

/** Agent API key from the credential vault (clawnch_fees path). */
function requireAgentApiKey(): string {
  const apiKey = getCredentialVault().getSecret('clawnch.launcherApiKey', 'clawnch-fees')
    ?? getCredentialVault().getSecret('clawnch.apiKey', 'clawnch-fees');
  if (!apiKey) {
    throw new Error(
      'Clawnch agent API key required to claim on Robinhood Chain. Set CLAWNCHER_API_KEY env var.',
    );
  }
  return apiKey;
}

/** Gas-only balance check against the Robinhood Chain RPC. */
async function checkRhGas(address: string): Promise<{ safe: boolean; blockers: string[] }> {
  const publicClient = await rh.getRhPublicClient();
  const balanceWei: bigint = await publicClient.getBalance({ address: address as `0x${string}` });
  const gasBufferWei = 2_000_000_000_000_000n; // 0.002 ETH
  if (balanceWei < gasBufferWei) {
    return {
      safe: false,
      blockers: [
        `Insufficient ETH on Robinhood Chain for gas. Have ${formatEther(balanceWei)} ETH, need ~${formatEther(gasBufferWei)} ETH.`,
      ],
    };
  }
  return { safe: true, blockers: [] };
}
