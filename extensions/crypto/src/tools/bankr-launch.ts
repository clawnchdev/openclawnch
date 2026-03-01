/**
 * Bankr Launch Tool — deploy tokens on Base and Solana via Bankr Agent API.
 *
 * Uses POST /token-launches/deploy for deploy/simulate (direct REST),
 * and prompt API for fee checking and claiming.
 *
 * Separate from clawnch_launch because: different API, different chains
 * (Base + Solana vs Base-only), different fee structure (57/36/5 vs 80/20).
 *
 * Rate limits: 50 deploys/day (100 with Bankr Club).
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { hasBankrApi } from '../services/bankr-api.js';
import { isBankrMode } from '../services/walletconnect-service.js';

const ACTIONS = ['deploy', 'simulate', 'fees', 'claim'] as const;
const CHAINS = ['base', 'solana'] as const;

const BankrLaunchSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'deploy: launch a token on-chain. simulate: dry run (no broadcast). ' +
      'fees: check earned fees for your tokens. claim: claim earned fees.',
  }),
  name: Type.Optional(Type.String({
    description: 'Token name (1-100 chars). Required for deploy/simulate.',
  })),
  symbol: Type.Optional(Type.String({
    description: 'Token ticker symbol (1-10 chars). Defaults to first 4 chars of name.',
  })),
  description: Type.Optional(Type.String({
    description: 'Token description (max 500 chars).',
  })),
  image: Type.Optional(Type.String({
    description: 'Logo image URL (uploaded to IPFS by Bankr).',
  })),
  chain: Type.Optional(stringEnum(CHAINS, {
    description: 'Chain to deploy on (default: base). Solana uses Raydium LaunchLab.',
  })),
  fee_recipient: Type.Optional(Type.String({
    description: 'Fee recipient — address, ENS name, X handle, or Farcaster handle.',
  })),
  tweet_url: Type.Optional(Type.String({
    description: 'Promotion tweet URL.',
  })),
  website_url: Type.Optional(Type.String({
    description: 'Token website URL.',
  })),
});

export function createBankrLaunchTool() {
  return {
    name: 'bankr_launch',
    label: 'Bankr Launch',
    ownerOnly: false,
    description:
      'Deploy tokens on Base (Uniswap V4) or Solana (Raydium LaunchLab) via Bankr. ' +
      'Fee split: 57% creator / 36.1% Bankr / 5% protocol on Base. ' +
      '0.5% bonding curve fee on Solana. Gas is sponsored. ' +
      'Rate limit: 50 deploys/day (100 with Bankr Club). ' +
      'Use "simulate" for a dry run without broadcasting.',
    parameters: BankrLaunchSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      if (!hasBankrApi()) {
        return errorResult(
          'Bankr API key not configured. Connect via /connect_bankr first, ' +
          'or set BANKR_API_KEY env var.'
        );
      }

      switch (action) {
        case 'deploy':
        case 'simulate':
          return handleDeploy(params, action === 'simulate');
        case 'fees':
          return handleFees(params);
        case 'claim':
          return handleClaim(params);
        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}

async function handleDeploy(params: Record<string, unknown>, simulateOnly: boolean) {
  const name = readStringParam(params, 'name');
  if (!name) {
    return errorResult('Token name is required for deploy/simulate.');
  }
  if (name.length > 100) {
    return errorResult('Token name must be 100 characters or less.');
  }

  const symbol = readStringParam(params, 'symbol');
  const description = readStringParam(params, 'description');
  const image = readStringParam(params, 'image');
  const chain = (readStringParam(params, 'chain') || 'base') as 'base' | 'solana';
  const feeRecipient = readStringParam(params, 'fee_recipient');
  const tweetUrl = readStringParam(params, 'tweet_url');
  const websiteUrl = readStringParam(params, 'website_url');

  if (description && description.length > 500) {
    return errorResult('Description must be 500 characters or less.');
  }
  if (symbol && symbol.length > 10) {
    return errorResult('Symbol must be 10 characters or less.');
  }

  try {
    const { bankrDeployToken } = await import('../services/bankr-api.js');

    const result = await bankrDeployToken({
      name,
      symbol: symbol || undefined,
      description: description || undefined,
      imageUrl: image || undefined,
      chain,
      feeRecipient: feeRecipient || undefined,
      tweetUrl: tweetUrl || undefined,
      websiteUrl: websiteUrl || undefined,
      simulateOnly,
    });

    if (simulateOnly) {
      return jsonResult({
        status: 'simulated',
        chain,
        tokenAddress: result.tokenAddress,
        feeDistribution: result.feeDistribution,
        note: 'Dry run — no transaction was broadcast. Use action "deploy" to launch for real.',
      });
    }

    return jsonResult({
      status: 'deployed',
      chain,
      tokenAddress: result.tokenAddress,
      poolId: result.poolId,
      txHash: result.txHash,
      feeDistribution: result.feeDistribution,
      note: !feeRecipient
        ? 'Fees default to your Bankr wallet. Set fee_recipient to redirect.'
        : undefined,
    });
  } catch (err) {
    return errorResult(`Token deploy failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleFees(params: Record<string, unknown>) {
  try {
    const { bankrPromptAndPoll } = await import('../services/bankr-api.js');
    const name = readStringParam(params, 'name');

    const prompt = name
      ? `check fees for ${name}`
      : 'how much fees have I earned?';

    const result = await bankrPromptAndPoll(prompt, { timeoutMs: 30_000 });

    if (result.status === 'failed') {
      return errorResult(`Fee check failed: ${result.error ?? 'Unknown error'}`);
    }

    return jsonResult({
      status: 'success',
      response: result.response,
      richData: result.richData,
    });
  } catch (err) {
    return errorResult(`Fee check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleClaim(params: Record<string, unknown>) {
  try {
    const { bankrPromptAndPoll } = await import('../services/bankr-api.js');
    const name = readStringParam(params, 'name');

    const prompt = name
      ? `claim my fees for ${name}`
      : 'claim all my earned fees';

    const result = await bankrPromptAndPoll(prompt, { timeoutMs: 60_000 });

    if (result.status === 'failed') {
      return errorResult(`Fee claim failed: ${result.error ?? 'Unknown error'}`);
    }

    const txData = result.transactions?.find(t => t.type === 'claim');

    return jsonResult({
      status: 'success',
      txHash: txData?.hash,
      response: result.response,
      richData: result.richData,
    });
  } catch (err) {
    return errorResult(`Fee claim failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
