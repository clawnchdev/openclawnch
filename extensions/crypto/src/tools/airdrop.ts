/**
 * Airdrop Tool — check eligibility and claim airdrops.
 *
 * Actions:
 *   list       — List known active/recent airdrops
 *   check      — Check eligibility for a specific airdrop
 *   check_all  — Check eligibility across all active airdrops
 *   claim      — Generate claim calldata for eligible airdrop
 *
 * Uses AirdropService for eligibility checks and claim calldata generation.
 * Falls back to PinchTab browser tool for dApps that require UI interaction.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { getAirdropService } from '../services/airdrop-service.js';
import {
  getWalletState,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { resolveAddressOrEns, isEnsName } from '../lib/ens-resolver.js';

const ACTIONS = ['list', 'check', 'check_all', 'claim'] as const;

const AirdropSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'list: list known airdrops. check: check eligibility for one airdrop. ' +
      'check_all: check all active airdrops for your address. ' +
      'claim: generate claim transaction for an eligible airdrop.',
  }),
  airdrop_id: Type.Optional(Type.String({
    description: 'Airdrop ID (e.g. "eigen-s2", "morpho"). Required for check and claim.',
  })),
  address: Type.Optional(Type.String({
    description: 'Address or ENS to check. Defaults to connected wallet.',
  })),
  status: Type.Optional(Type.String({
    description: 'Filter by status: "active" (default), "ended", "upcoming", "all".',
  })),
  chain: Type.Optional(Type.String({
    description: 'Filter by chain: "ethereum", "base", "arbitrum", "optimism", "polygon".',
  })),
  claim_index: Type.Optional(Type.Number({
    description: 'Merkle claim index. Required for claim action (from check result).',
  })),
  amount: Type.Optional(Type.String({
    description: 'Claim amount in wei. Required for claim action (from check result).',
  })),
  proof: Type.Optional(Type.String({
    description: 'JSON-encoded merkle proof array. Required for claim action (from check result).',
  })),
});

export function createAirdropTool() {
  return {
    name: 'airdrop',
    label: 'Airdrop Tracker',
    ownerOnly: true,
    description:
      'Check airdrop eligibility and claim tokens. Tracks known active airdrops ' +
      '(EigenLayer, LayerZero, Scroll, Morpho, etc.). For airdrops requiring browser ' +
      'interaction, guides you to use the browser tool.',
    parameters: AirdropSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'list':
          return handleList(params);
        case 'check':
          return handleCheck(params);
        case 'check_all':
          return handleCheckAll(params);
        case 'claim':
          return handleClaim(params);
        default:
          return errorResult(`Unknown action: ${action}. Use: list, check, check_all, claim`);
      }
    },
  };
}

// ── Action Handlers ─────────────────────────────────────────────────────

function handleList(params: Record<string, unknown>) {
  const status = (readStringParam(params, 'status') ?? 'active') as any;
  const chain = readStringParam(params, 'chain') ?? undefined;

  const service = getAirdropService();
  const airdrops = service.listAirdrops({ status, chain });

  if (airdrops.length === 0) {
    return jsonResult({
      airdrops: [],
      message: `No ${status} airdrops found${chain ? ` on ${chain}` : ''}.`,
    });
  }

  return jsonResult({
    count: airdrops.length,
    filter: { status, chain: chain ?? 'all' },
    airdrops: airdrops.map(a => ({
      id: a.id,
      name: a.name,
      token: a.tokenSymbol,
      chain: a.chain,
      status: a.status,
      requiresBrowser: a.requiresBrowser ?? false,
      deadline: a.deadline,
      description: a.description,
    })),
    tip: 'Use action=check with an airdrop_id to check eligibility, or action=check_all to scan all active airdrops.',
  });
}

async function handleCheck(params: Record<string, unknown>) {
  const airdropId = readStringParam(params, 'airdrop_id');
  if (!airdropId) {
    return errorResult('airdrop_id is required. Use action=list to see available airdrops.');
  }

  const address = await resolveAddress(params);
  if (!address) {
    return errorResult('No wallet connected and no address provided.');
  }

  const service = getAirdropService();
  const airdrop = service.getAirdrop(airdropId);

  let publicClient: any;
  try { publicClient = requirePublicClient(); } catch { /* optional */ }

  const result = await service.checkEligibility(airdropId, address, publicClient);

  return jsonResult({
    ...result,
    chain: airdrop?.chain,
    address,
    tip: result.eligible
      ? 'Use action=claim with the proof data to generate the claim transaction.'
      : result.error?.includes('browser')
        ? `Use the browser tool to check ${airdrop?.name ?? airdropId} eligibility at the project\'s claim page.`
        : undefined,
  });
}

async function handleCheckAll(params: Record<string, unknown>) {
  const address = await resolveAddress(params);
  if (!address) {
    return errorResult('No wallet connected and no address provided.');
  }

  const service = getAirdropService();
  let publicClient: any;
  try { publicClient = requirePublicClient(); } catch { /* optional */ }

  const results = await service.checkAll(address, publicClient);

  const eligible = results.filter(r => r.eligible);
  const needsBrowser = results.filter(r => r.error?.includes('browser'));
  const notEligible = results.filter(r => !r.eligible && !r.error?.includes('browser'));

  return jsonResult({
    address,
    totalChecked: results.length,
    eligible: eligible.map(r => ({
      id: r.airdropId,
      name: r.airdropName,
      amount: r.amountFormatted ?? r.amount,
      claimed: r.claimed,
    })),
    needsBrowserCheck: needsBrowser.map(r => ({
      id: r.airdropId,
      name: r.airdropName,
    })),
    notEligible: notEligible.map(r => r.airdropName),
    tip: needsBrowser.length > 0
      ? `${needsBrowser.length} airdrop(s) require browser-based eligibility checks. Use the browser tool to visit their claim pages.`
      : undefined,
  });
}

async function handleClaim(params: Record<string, unknown>) {
  const airdropId = readStringParam(params, 'airdrop_id');
  if (!airdropId) {
    return errorResult('airdrop_id is required for claim.');
  }

  const address = await resolveAddress(params);
  if (!address) {
    return errorResult('No wallet connected and no address provided.');
  }

  const claimIndex = readNumberParam(params, 'claim_index');
  const amount = readStringParam(params, 'amount');
  const proofStr = readStringParam(params, 'proof');

  if (claimIndex === undefined || claimIndex === null || !amount || !proofStr) {
    return errorResult(
      'claim_index, amount, and proof are required for claim. ' +
      'Run action=check first to get these values from the eligibility check.',
    );
  }

  let proof: string[];
  try {
    proof = JSON.parse(proofStr);
    if (!Array.isArray(proof)) throw new Error('not array');
  } catch {
    return errorResult('proof must be a JSON array of hex strings (bytes32[]).');
  }

  const service = getAirdropService();
  const airdrop = service.getAirdrop(airdropId);

  const calldata = service.generateClaimCalldata(
    airdropId,
    claimIndex,
    address,
    amount,
    proof,
  );

  if (!calldata) {
    return errorResult(
      `Cannot generate claim calldata for ${airdropId}. ` +
      (airdrop?.requiresBrowser
        ? 'This airdrop requires browser-based claiming. Use the browser tool.'
        : 'Unknown airdrop or invalid claim contract.'),
    );
  }

  return jsonResult({
    status: 'calldata_ready',
    airdropId,
    airdropName: airdrop?.name ?? airdropId,
    chain: airdrop?.chain ?? 'ethereum',
    transaction: {
      to: calldata.to,
      data: calldata.data,
      value: calldata.value,
    },
    description: calldata.description,
    note: 'Submit this transaction via your wallet to claim the airdrop. The transaction will call the claim function on the distributor contract.',
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function resolveAddress(params: Record<string, unknown>): Promise<string | null> {
  let address = readStringParam(params, 'address');

  if (address && isEnsName(address)) {
    try {
      const publicClient = requirePublicClient();
      const resolved = await resolveAddressOrEns(address, publicClient);
      return resolved.address;
    } catch {
      // fall through
    }
  }

  if (address) return address;

  // Fall back to connected wallet
  const state = getWalletState();
  return state.address ?? null;
}
