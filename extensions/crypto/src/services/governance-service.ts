/**
 * Governance Service — Snapshot (off-chain) + on-chain Governor integration.
 *
 * Snapshot: GraphQL API at hub.snapshot.org/graphql (off-chain votes, gasless).
 * Tally: REST API at api.tally.xyz (on-chain Governor proposals, voting power).
 * Direct Governor contract calls for on-chain voting via viem.
 *
 * No new dependencies — uses guardedFetch for HTTP, viem for contract calls.
 */

import { type Address, formatUnits } from 'viem';
import { guardedFetch } from './endpoint-allowlist.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface SnapshotProposal {
  id: string;
  title: string;
  body: string;
  state: 'active' | 'closed' | 'pending';
  choices: string[];
  scores: number[];
  scoresTotal: number;
  start: number;
  end: number;
  author: string;
  space: { id: string; name: string };
  votes: number;
  quorum: number;
  link: string;
}

export interface SnapshotVotingPower {
  space: string;
  vp: number;
  vpByStrategy: number[];
  vpState: string;
}

export interface TallyProposal {
  id: string;
  title: string;
  description: string;
  status: string;
  governor: { name: string; chainId: number };
  voteStats: Array<{ support: string; weight: string; percent: number }>;
  startBlock: number;
  endBlock: number;
  proposer: { address: string; name?: string };
}

export interface GovernorInfo {
  address: Address;
  chainId: number;
  name: string;
  tokenAddress?: Address;
}

// ── Known Governor Contracts ─────────────────────────────────────────────

export const KNOWN_GOVERNORS: Record<string, GovernorInfo> = {
  // Base ecosystem governors
  'aerodrome': {
    address: '0x77758EBdD55270809E96DCfe3CDEBe26d4A0eFb1' as Address,
    chainId: 8453,
    name: 'Aerodrome Finance',
    tokenAddress: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as Address,
  },
  // Ethereum mainnet governors
  'uniswap': {
    address: '0x408ED6354d4973f66138C91495F2f2FCbd8724C3' as Address,
    chainId: 1,
    name: 'Uniswap Governor Bravo',
    tokenAddress: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' as Address,
  },
  'aave': {
    address: '0xEC568fffba86c094cf06b22134B23074DFE2252c' as Address,
    chainId: 1,
    name: 'Aave Governance V2',
    tokenAddress: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as Address,
  },
  'ens': {
    address: '0x323A76393544d5ecca80cd6ef2A560C6a395b7E3' as Address,
    chainId: 1,
    name: 'ENS Governor',
    tokenAddress: '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72' as Address,
  },
};

// ── Minimal Governor ABI (OpenZeppelin Governor) ─────────────────────────

export const GOVERNOR_ABI = [
  {
    name: 'castVote',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'proposalId', type: 'uint256' },
      { name: 'support', type: 'uint8' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'castVoteWithReason',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'proposalId', type: 'uint256' },
      { name: 'support', type: 'uint8' },
      { name: 'reason', type: 'string' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getVotes',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'timepoint', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'state',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'proposalId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'proposalDeadline',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'proposalId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ERC20_VOTES_ABI = [
  {
    name: 'delegates',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'delegate',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'delegatee', type: 'address' }],
    outputs: [],
  },
  {
    name: 'getVotes',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ── Proposal State Enum (OpenZeppelin) ───────────────────────────────────

const PROPOSAL_STATES = [
  'Pending', 'Active', 'Canceled', 'Defeated',
  'Succeeded', 'Queued', 'Expired', 'Executed',
] as const;

// ── Service ──────────────────────────────────────────────────────────────

export class GovernanceService {
  // ── Snapshot (Off-chain) ───────────────────────────────────────────

  /**
   * Fetch proposals from a Snapshot space.
   */
  async getSnapshotProposals(
    space: string,
    state?: 'active' | 'closed' | 'all',
    limit = 10,
  ): Promise<SnapshotProposal[]> {
    const stateFilter = state === 'all' ? '' : `state: "${state ?? 'active'}"`;
    const query = `{
      proposals(
        first: ${limit},
        skip: 0,
        where: { space: "${space}", ${stateFilter} },
        orderBy: "created",
        orderDirection: desc
      ) {
        id title body state choices scores scores_total
        start end author votes quorum
        space { id name }
      }
    }`;

    const response = await guardedFetch('https://hub.snapshot.org/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Snapshot API error: ${response.status}`);
    }

    const data: any = await response.json();
    const proposals: any[] = data?.data?.proposals ?? [];

    return proposals.map((p: any) => ({
      id: p.id,
      title: p.title,
      body: (p.body ?? '').slice(0, 500),
      state: p.state,
      choices: p.choices ?? [],
      scores: p.scores ?? [],
      scoresTotal: p.scores_total ?? 0,
      start: p.start,
      end: p.end,
      author: p.author,
      space: p.space ?? { id: space, name: space },
      votes: p.votes ?? 0,
      quorum: p.quorum ?? 0,
      link: `https://snapshot.org/#/${space}/proposal/${p.id}`,
    }));
  }

  /**
   * Get voting power on a Snapshot space.
   */
  async getSnapshotVotingPower(
    space: string,
    voter: string,
  ): Promise<SnapshotVotingPower> {
    const query = `{
      vp(voter: "${voter}", space: "${space}") {
        vp vp_by_strategy vp_state
      }
    }`;

    const response = await guardedFetch('https://hub.snapshot.org/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Snapshot VP query failed: ${response.status}`);
    }

    const data: any = await response.json();
    const vp = data?.data?.vp;

    return {
      space,
      vp: vp?.vp ?? 0,
      vpByStrategy: vp?.vp_by_strategy ?? [],
      vpState: vp?.vp_state ?? 'unknown',
    };
  }

  // ── On-chain Governor ──────────────────────────────────────────────

  /**
   * Resolve a governor name or address.
   */
  resolveGovernor(input: string): GovernorInfo | null {
    const lower = input.toLowerCase();
    if (KNOWN_GOVERNORS[lower]) return KNOWN_GOVERNORS[lower]!;

    // Try by address
    for (const gov of Object.values(KNOWN_GOVERNORS)) {
      if (gov.address.toLowerCase() === lower) return gov;
    }
    return null;
  }

  /**
   * Get all known governors.
   */
  getKnownGovernors() {
    return Object.entries(KNOWN_GOVERNORS).map(([id, g]) => ({
      id,
      name: g.name,
      address: g.address,
      chainId: g.chainId,
    }));
  }

  /**
   * Cast an on-chain vote.
   * Support: 0 = Against, 1 = For, 2 = Abstain
   */
  async castVote(
    governorAddress: Address,
    proposalId: bigint,
    support: number,
    reason: string | undefined,
    walletClient: any,
    publicClient: any,
  ): Promise<{ hash: string }> {
    let hash: string;

    if (reason) {
      hash = await walletClient.writeContract({
        address: governorAddress,
        abi: GOVERNOR_ABI,
        functionName: 'castVoteWithReason',
        args: [proposalId, support, reason],
      });
    } else {
      hash = await walletClient.writeContract({
        address: governorAddress,
        abi: GOVERNOR_ABI,
        functionName: 'castVote',
        args: [proposalId, support],
      });
    }

    await publicClient.waitForTransactionReceipt({ hash });
    return { hash };
  }

  /**
   * Delegate voting power on a governance token.
   */
  async delegate(
    tokenAddress: Address,
    delegatee: Address,
    walletClient: any,
    publicClient: any,
  ): Promise<{ hash: string }> {
    const hash = await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_VOTES_ABI,
      functionName: 'delegate',
      args: [delegatee],
    });

    await publicClient.waitForTransactionReceipt({ hash });
    return { hash };
  }

  /**
   * Get on-chain voting power for an address on a governance token.
   */
  async getOnchainVotingPower(
    tokenAddress: Address,
    userAddress: Address,
    publicClient: any,
  ): Promise<{ votes: string; balance: string; delegate: string }> {
    const [votes, balance, delegateTo] = await Promise.all([
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_VOTES_ABI,
        functionName: 'getVotes',
        args: [userAddress],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_VOTES_ABI,
        functionName: 'balanceOf',
        args: [userAddress],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_VOTES_ABI,
        functionName: 'delegates',
        args: [userAddress],
      }) as Promise<string>,
    ]);

    return {
      votes: formatUnits(votes, 18),
      balance: formatUnits(balance, 18),
      delegate: delegateTo,
    };
  }

  /**
   * Get proposal state from an on-chain Governor.
   */
  async getProposalState(
    governorAddress: Address,
    proposalId: bigint,
    publicClient: any,
  ): Promise<string> {
    const stateIndex = await publicClient.readContract({
      address: governorAddress,
      abi: GOVERNOR_ABI,
      functionName: 'state',
      args: [proposalId],
    }) as number;

    return PROPOSAL_STATES[stateIndex] ?? `Unknown (${stateIndex})`;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: GovernanceService | null = null;

export function getGovernanceService(): GovernanceService {
  if (!_instance) {
    _instance = new GovernanceService();
  }
  return _instance;
}

export function resetGovernanceService(): void {
  _instance = null;
}
