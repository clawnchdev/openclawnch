/**
 * Governance Tool — DAO proposals, voting, and delegation.
 *
 * Actions:
 *   proposals       — List proposals from a Snapshot space or on-chain Governor
 *   vote            — Vote on a proposal (Snapshot off-chain or on-chain Governor)
 *   delegate        — Delegate voting power to another address
 *   voting_power    — Check voting power on a space/protocol
 *   spaces          — Search Snapshot spaces
 *   governors       — List known on-chain Governors
 *
 * Uses Snapshot GraphQL API (off-chain) and direct Governor contract calls (on-chain).
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { getGovernanceService } from '../services/governance-service.js';
import { resolveAddressOrEns, isEnsName } from '../lib/ens-resolver.js';

const ACTIONS = ['proposals', 'vote', 'delegate', 'voting_power', 'spaces', 'governors'] as const;

const GovernanceSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'proposals: list active proposals. vote: cast vote. delegate: delegate voting power. ' +
      'voting_power: check VP. spaces: search Snapshot spaces. governors: list on-chain Governors.',
  }),
  space: Type.Optional(Type.String({
    description: 'Snapshot space ID (e.g. "aave.eth", "uniswap") or on-chain governor name.',
  })),
  proposal_id: Type.Optional(Type.String({
    description: 'Proposal ID for voting or viewing. Required for vote.',
  })),
  choice: Type.Optional(Type.String({
    description: 'Vote choice: "for" (1), "against" (0), "abstain" (2), or choice number. Required for vote.',
  })),
  reason: Type.Optional(Type.String({
    description: 'Reason for vote (on-chain voting with reason).',
  })),
  delegatee: Type.Optional(Type.String({
    description: 'Address or ENS to delegate voting power to. Required for delegate.',
  })),
  state: Type.Optional(Type.String({
    description: 'Filter proposals by state: "active" (default), "closed", "all".',
  })),
  address: Type.Optional(Type.String({
    description: 'Address to check voting power for. Defaults to connected wallet.',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Max proposals to return. Default: 10.',
  })),
});

export function createGovernanceTool() {
  return {
    name: 'governance',
    label: 'Governance',
    ownerOnly: true,
    description:
      'DAO governance: browse proposals, vote (Snapshot off-chain or on-chain Governor), ' +
      'delegate voting power, and check VP. Supports Snapshot spaces (Aave, Uniswap, ENS, etc.) ' +
      'and on-chain Governors on Ethereum and Base.',
    parameters: GovernanceSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'proposals':
          return handleProposals(params);
        case 'vote':
          return handleVote(params);
        case 'delegate':
          return handleDelegate(params);
        case 'voting_power':
          return handleVotingPower(params);
        case 'spaces':
          return handleSpaces(params);
        case 'governors':
          return handleGovernors();
        default:
          return errorResult(`Unknown action: ${action}. Use: proposals, vote, delegate, voting_power, spaces, governors`);
      }
    },
  };
}

// ── Action Handlers ─────────────────────────────────────────────────────

async function handleProposals(params: Record<string, unknown>) {
  const space = readStringParam(params, 'space');
  if (!space) {
    return errorResult('space is required (e.g. "aave.eth", "uniswap", "ens.eth").');
  }

  const stateInput = readStringParam(params, 'state') ?? 'active';
  const state = stateInput === 'all' ? 'all' : stateInput === 'closed' ? 'closed' : 'active';
  const limit = readNumberParam(params, 'limit') ?? 10;

  try {
    const service = getGovernanceService();
    const proposals = await service.getSnapshotProposals(space, state as any, limit);

    if (proposals.length === 0) {
      return jsonResult({
        space,
        state,
        proposals: [],
        message: `No ${state} proposals found for ${space}.`,
      });
    }

    return jsonResult({
      space,
      state,
      count: proposals.length,
      proposals: proposals.map(p => ({
        id: p.id,
        title: p.title,
        state: p.state,
        choices: p.choices,
        scores: p.scores.map(s => Math.round(s)),
        totalVotes: p.votes,
        quorum: p.quorum,
        endsAt: new Date(p.end * 1000).toISOString(),
        link: p.link,
      })),
    });
  } catch (err) {
    return errorResult(`Proposals fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleVote(params: Record<string, unknown>) {
  const space = readStringParam(params, 'space');
  const proposalId = readStringParam(params, 'proposal_id');
  const choiceInput = readStringParam(params, 'choice');
  if (!space || !proposalId || !choiceInput) {
    return errorResult('space, proposal_id, and choice are required for voting.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  // Check if this is an on-chain Governor vote
  const service = getGovernanceService();
  const governor = service.resolveGovernor(space);

  if (governor) {
    return handleOnchainVote(governor, proposalId, choiceInput, params);
  }

  // Off-chain Snapshot vote — return guidance (signing happens in Snapshot UI)
  const choice = resolveChoice(choiceInput);
  return jsonResult({
    status: 'snapshot_vote',
    space,
    proposalId,
    choice: choiceInput,
    choiceIndex: choice,
    voter: state.address,
    note: 'Snapshot votes require signing via the Snapshot UI. ' +
      `Visit: https://snapshot.org/#/${space}/proposal/${proposalId}`,
    tip: 'For on-chain Governor votes (Uniswap, Aave, ENS), this tool submits the transaction directly.',
  });
}

async function handleOnchainVote(
  governor: { address: `0x${string}`; chainId: number; name: string },
  proposalId: string,
  choiceInput: string,
  params: Record<string, unknown>,
) {
  // Validate proposalId is a valid integer before BigInt conversion
  if (!/^\d+$/.test(proposalId)) {
    return errorResult(`Invalid proposal_id "${proposalId}". Must be a numeric ID.`);
  }

  const support = resolveChoice(choiceInput);
  const reason = readStringParam(params, 'reason') ?? undefined;

  try {
    const service = getGovernanceService();
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const result = await service.castVote(
      governor.address as `0x${string}`,
      BigInt(proposalId),
      support,
      reason,
      wallet,
      publicClient,
    );

    const supportLabel = support === 1 ? 'For' : support === 0 ? 'Against' : 'Abstain';

    return jsonResult({
      status: 'success',
      action: 'vote',
      governor: governor.name,
      governorAddress: governor.address,
      proposalId,
      support: supportLabel,
      reason: reason ?? undefined,
      txHash: result.hash,
    });
  } catch (err) {
    return errorResult(`On-chain vote failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleDelegate(params: Record<string, unknown>) {
  const space = readStringParam(params, 'space');
  const delegateeInput = readStringParam(params, 'delegatee');
  if (!space || !delegateeInput) {
    return errorResult('space (governor name) and delegatee (address or ENS) are required for delegate.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const service = getGovernanceService();
  const governor = service.resolveGovernor(space);
  if (!governor || !governor.tokenAddress) {
    return errorResult(
      `Unknown governor or no governance token for "${space}". ` +
      `Known governors: ${service.getKnownGovernors().map(g => g.id).join(', ')}`,
    );
  }

  try {
    // Resolve ENS if needed
    let delegatee = delegateeInput;
    if (isEnsName(delegateeInput)) {
      const publicClient = requirePublicClient();
      const resolved = await resolveAddressOrEns(delegateeInput, publicClient);
      delegatee = resolved.address;
    }

    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const result = await service.delegate(
      governor.tokenAddress as `0x${string}`,
      delegatee as `0x${string}`,
      wallet,
      publicClient,
    );

    return jsonResult({
      status: 'success',
      action: 'delegate',
      governor: governor.name,
      token: governor.tokenAddress,
      delegatee,
      ensName: isEnsName(delegateeInput) ? delegateeInput : undefined,
      txHash: result.hash,
    });
  } catch (err) {
    return errorResult(`Delegate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleVotingPower(params: Record<string, unknown>) {
  const space = readStringParam(params, 'space');
  if (!space) {
    return errorResult('space is required (Snapshot space ID or on-chain governor name).');
  }

  const state = getWalletState();
  const addressInput = readStringParam(params, 'address') ?? state.address;
  if (!addressInput) {
    return errorResult('No wallet connected and no address provided.');
  }

  const service = getGovernanceService();
  const governor = service.resolveGovernor(space);

  try {
    if (governor && governor.tokenAddress) {
      // On-chain voting power
      const publicClient = requirePublicClient();
      const vp = await service.getOnchainVotingPower(
        governor.tokenAddress as `0x${string}`,
        addressInput as `0x${string}`,
        publicClient,
      );

      return jsonResult({
        type: 'on-chain',
        governor: governor.name,
        address: addressInput,
        votingPower: vp.votes,
        tokenBalance: vp.balance,
        delegatedTo: vp.delegate,
        note: vp.votes === '0.0' && vp.balance !== '0.0'
          ? 'You hold tokens but have not delegated. Delegate to yourself to activate voting power.'
          : undefined,
      });
    }

    // Snapshot voting power
    const vp = await service.getSnapshotVotingPower(space, addressInput);
    return jsonResult({
      type: 'snapshot',
      space,
      address: addressInput,
      votingPower: vp.vp,
      vpByStrategy: vp.vpByStrategy,
      vpState: vp.vpState,
    });
  } catch (err) {
    return errorResult(`Voting power check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleSpaces(params: Record<string, unknown>) {
  // Return well-known Snapshot spaces + on-chain governors
  const service = getGovernanceService();
  const governors = service.getKnownGovernors();

  const snapshotSpaces = [
    { id: 'aave.eth', name: 'Aave', members: '~230K' },
    { id: 'uniswapgovernance.eth', name: 'Uniswap', members: '~330K' },
    { id: 'ens.eth', name: 'ENS', members: '~80K' },
    { id: 'safe.eth', name: 'Safe', members: '~50K' },
    { id: 'opcollective.eth', name: 'Optimism Collective', members: '~135K' },
    { id: 'arbitrumfoundation.eth', name: 'Arbitrum', members: '~680K' },
    { id: 'lido-snapshot.eth', name: 'Lido', members: '~25K' },
    { id: 'balancer.eth', name: 'Balancer', members: '~20K' },
    { id: 'gitcoindao.eth', name: 'Gitcoin', members: '~20K' },
    { id: 'aerodromefi.eth', name: 'Aerodrome (Base)', members: '~10K' },
  ];

  return jsonResult({
    snapshotSpaces: snapshotSpaces.map(s => ({
      id: s.id,
      name: s.name,
      members: s.members,
      link: `https://snapshot.org/#/${s.id}`,
    })),
    onchainGovernors: governors.map(g => ({
      id: g.id,
      name: g.name,
      address: g.address,
      chain: g.chainId === 1 ? 'ethereum' : g.chainId === 8453 ? 'base' : String(g.chainId),
    })),
    tip: 'Use action=proposals with a space ID to see active proposals.',
  });
}

function handleGovernors() {
  const service = getGovernanceService();
  const governors = service.getKnownGovernors();

  return jsonResult({
    governors: governors.map(g => ({
      id: g.id,
      name: g.name,
      address: g.address,
      chain: g.chainId === 1 ? 'ethereum' : g.chainId === 8453 ? 'base' : String(g.chainId),
    })),
    note: 'On-chain Governors support direct voting and delegation via this tool.',
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

function resolveChoice(input: string): number {
  const lower = input.toLowerCase();
  if (lower === 'for' || lower === 'yes' || lower === '1') return 1;
  if (lower === 'against' || lower === 'no' || lower === '0') return 0;
  if (lower === 'abstain' || lower === '2') return 2;
  // Try parsing as number (for Snapshot multi-choice)
  const num = parseInt(input, 10);
  return isNaN(num) ? 1 : num;
}
