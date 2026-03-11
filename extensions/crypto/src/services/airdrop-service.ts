/**
 * Airdrop Service — check eligibility and generate claim calldata.
 *
 * Layered approach:
 * 1. Known airdrop contracts with hardcoded merkle root endpoints
 * 2. On-chain eligibility checks via direct contract calls
 * 3. PinchTab (browser tool) fallback for UI-based claims
 *
 * No single API covers all airdrops. This service maintains a registry
 * of known active/recent airdrops and their claim mechanisms.
 *
 * No external dependencies — uses viem for contract reads and
 * guardedFetch for any HTTP endpoints.
 */

import { guardedFetch } from './endpoint-allowlist.js';
import { encodeFunctionData, type Address } from 'viem';

// ── Types ────────────────────────────────────────────────────────────────

export interface AirdropInfo {
  id: string;
  name: string;
  token: string;
  tokenSymbol: string;
  chain: string;
  chainId: number;
  status: 'active' | 'ended' | 'upcoming';
  claimContract: string;
  /** URL to check eligibility (REST API or dApp) */
  eligibilityUrl?: string;
  /** If true, claim requires browser automation (no direct contract call) */
  requiresBrowser?: boolean;
  deadline?: string;
  description: string;
}

export interface EligibilityResult {
  airdropId: string;
  airdropName: string;
  eligible: boolean;
  amount?: string;
  amountFormatted?: string;
  proof?: string[];
  claimIndex?: number;
  claimed?: boolean;
  error?: string;
}

export interface ClaimCalldata {
  to: string;
  data: string;
  value: string;
  description: string;
}

// ── Known Airdrops Registry ─────────────────────────────────────────────
// Maintained manually. Each entry describes a known airdrop with its
// claim mechanism. Active airdrops are checked first.

const KNOWN_AIRDROPS: AirdropInfo[] = [
  // ── Active / Recent ───────────────────────────────────────────────
  {
    id: 'eigen-s2',
    name: 'EigenLayer Season 2',
    token: '0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83',
    tokenSymbol: 'EIGEN',
    chain: 'ethereum',
    chainId: 1,
    status: 'active',
    claimContract: '0x035bdA26Bf4d270CfdBe9b32F3580C76BbDdE1F9',
    eligibilityUrl: 'https://claims.eigenfoundation.org/clique-eigenlayer-s2/check',
    description: 'EigenLayer Season 2 stakedrop for restakers and operators.',
  },
  {
    id: 'zk-nation',
    name: 'ZKsync (ZK Nation)',
    token: '0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E',
    tokenSymbol: 'ZK',
    chain: 'ethereum',
    chainId: 1,
    status: 'active',
    claimContract: '0x66Fd4FC8FA52c9bec2AbA368047A0b27e24ecfe4',
    description: 'ZKsync governance token airdrop for ecosystem participants.',
    requiresBrowser: true,
  },
  {
    id: 'layerzero',
    name: 'LayerZero (ZRO)',
    token: '0x6985884C4392D348587B19cb9eAAf157F13271cd',
    tokenSymbol: 'ZRO',
    chain: 'ethereum',
    chainId: 1,
    status: 'active',
    claimContract: '0xB09F16F625B363875e39ADa56C03682c4B8C01C9',
    eligibilityUrl: 'https://www.layerzero.foundation/eligibility',
    description: 'LayerZero protocol token for cross-chain messaging users.',
    requiresBrowser: true,
  },
  {
    id: 'scroll',
    name: 'Scroll (SCR)',
    token: '0xd29687c813D741E2F938F4aC377128810E217b1b',
    tokenSymbol: 'SCR',
    chain: 'ethereum',
    chainId: 1,
    status: 'active',
    claimContract: '0xA6EA2f3299b63c53143c993d2d5E60A69CD139Ed',
    description: 'Scroll zkEVM L2 token airdrop for bridge and ecosystem users.',
    requiresBrowser: true,
  },

  // ── Base Ecosystem ────────────────────────────────────────────────
  {
    id: 'degen-s2',
    name: 'Degen Chain Season 2',
    token: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
    tokenSymbol: 'DEGEN',
    chain: 'base',
    chainId: 8453,
    status: 'active',
    claimContract: '0x0000000000000000000000000000000000000000',
    description: 'DEGEN token airdrop for Farcaster tippers and Degen L3 users.',
    requiresBrowser: true,
  },
  {
    id: 'morpho',
    name: 'Morpho (MORPHO)',
    token: '0x58D97B57BB95320F9a05dC918Aef65434969c2B2',
    tokenSymbol: 'MORPHO',
    chain: 'ethereum',
    chainId: 1,
    status: 'active',
    claimContract: '0x678dDC1d07eaa166E502E4eb00E6752Ec7BFc530',
    description: 'Morpho lending protocol token for depositors and borrowers.',
  },

  // ── Ended (for history/reference) ─────────────────────────────────
  {
    id: 'arb-dao',
    name: 'Arbitrum DAO (ARB)',
    token: '0x912CE59144191C1204E64559FE8253a0e49E6548',
    tokenSymbol: 'ARB',
    chain: 'arbitrum',
    chainId: 42161,
    status: 'ended',
    claimContract: '0x67a24CE4321aB3aF51c2D0a4801c3E111D88C9d9',
    description: 'Arbitrum governance token airdrop (March 2023). Claim period ended.',
  },
  {
    id: 'op-s4',
    name: 'Optimism Season 4 (OP)',
    token: '0x4200000000000000000000000000000000000042',
    tokenSymbol: 'OP',
    chain: 'optimism',
    chainId: 10,
    status: 'ended',
    claimContract: '0xFeDFAF1A10335448b7FA0268F56D2B44DBD357de',
    description: 'Optimism governance token Season 4 airdrop. Claim period ended.',
  },
];

// ── Standard Merkle Distributor ABI (minimal) ───────────────────────────
// Most airdrops use a Merkle distributor pattern. We only need these functions.

const MERKLE_CLAIM_ABI = [
  {
    name: 'isClaimed',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'claim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'index', type: 'uint256' },
      { name: 'account', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'merkleProof', type: 'bytes32[]' },
    ],
    outputs: [],
  },
] as const;

// ── Service ──────────────────────────────────────────────────────────────

export class AirdropService {
  /**
   * List known airdrops, optionally filtered by status or chain.
   */
  listAirdrops(opts?: {
    status?: 'active' | 'ended' | 'upcoming' | 'all';
    chain?: string;
  }): AirdropInfo[] {
    let results = [...KNOWN_AIRDROPS];

    if (opts?.status && opts.status !== 'all') {
      results = results.filter(a => a.status === opts.status);
    }
    if (opts?.chain) {
      const chainLower = opts.chain.toLowerCase();
      results = results.filter(a => a.chain === chainLower);
    }

    return results;
  }

  /**
   * Check eligibility for a specific airdrop.
   * Returns eligibility info including amount and claim status.
   */
  async checkEligibility(
    airdropId: string,
    address: string,
    publicClient?: any,
  ): Promise<EligibilityResult> {
    const airdrop = KNOWN_AIRDROPS.find(a => a.id === airdropId);
    if (!airdrop) {
      return {
        airdropId,
        airdropName: 'Unknown',
        eligible: false,
        error: `Unknown airdrop: ${airdropId}. Use action=list to see known airdrops.`,
      };
    }

    // Try eligibility URL if available
    if (airdrop.eligibilityUrl && !airdrop.requiresBrowser) {
      try {
        return await this.checkViaApi(airdrop, address);
      } catch {
        // Fall through to on-chain check
      }
    }

    // If browser required, return guidance
    if (airdrop.requiresBrowser) {
      return {
        airdropId: airdrop.id,
        airdropName: airdrop.name,
        eligible: false, // unknown without browser
        error: `${airdrop.name} requires browser-based eligibility check. Use the browser tool to navigate to the claim page.`,
      };
    }

    // Try on-chain eligibility check
    if (publicClient && airdrop.claimContract !== '0x0000000000000000000000000000000000000000') {
      try {
        return await this.checkOnchain(airdrop, address, publicClient);
      } catch {
        return {
          airdropId: airdrop.id,
          airdropName: airdrop.name,
          eligible: false,
          error: 'On-chain eligibility check failed. The contract may use a non-standard interface.',
        };
      }
    }

    return {
      airdropId: airdrop.id,
      airdropName: airdrop.name,
      eligible: false,
      error: 'Could not determine eligibility. Check the project\'s claim page directly.',
    };
  }

  /**
   * Check eligibility for ALL active airdrops.
   */
  async checkAll(
    address: string,
    publicClient?: any,
  ): Promise<EligibilityResult[]> {
    const active = this.listAirdrops({ status: 'active' });
    const results: EligibilityResult[] = [];

    for (const airdrop of active) {
      const result = await this.checkEligibility(airdrop.id, address, publicClient);
      results.push(result);
    }

    return results;
  }

  /**
   * Generate claim calldata for a Merkle distributor airdrop.
   * Requires the merkle proof and claim index (from eligibility check).
   */
  generateClaimCalldata(
    airdropId: string,
    claimIndex: number,
    address: string,
    amount: string,
    proof: string[],
  ): ClaimCalldata | null {
    const airdrop = KNOWN_AIRDROPS.find(a => a.id === airdropId);
    if (!airdrop) return null;
    if (airdrop.claimContract === '0x0000000000000000000000000000000000000000') return null;

    // Validate inputs before BigInt conversion to prevent opaque errors
    if (!Number.isInteger(claimIndex) || claimIndex < 0) return null;
    if (!/^\d+$/.test(amount)) return null;

    const data = encodeFunctionData({
      abi: MERKLE_CLAIM_ABI,
      functionName: 'claim',
      args: [
        BigInt(claimIndex),
        address as Address,
        BigInt(amount),
        proof as `0x${string}`[],
      ],
    });

    return {
      to: airdrop.claimContract,
      data,
      value: '0',
      description: `Claim ${airdrop.tokenSymbol} from ${airdrop.name}`,
    };
  }

  /**
   * Get a specific airdrop by ID.
   */
  getAirdrop(id: string): AirdropInfo | undefined {
    return KNOWN_AIRDROPS.find(a => a.id === id);
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async checkViaApi(
    airdrop: AirdropInfo,
    address: string,
  ): Promise<EligibilityResult> {
    const url = `${airdrop.eligibilityUrl}?address=${address.toLowerCase()}`;
    const response = await guardedFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`API ${response.status}`);
    }

    const data = await response.json() as any;

    // Most eligibility APIs return { eligible, amount, proof, index }
    return {
      airdropId: airdrop.id,
      airdropName: airdrop.name,
      eligible: !!data.eligible || !!data.amount || (data.amount && data.amount !== '0'),
      amount: data.amount ?? data.claimableAmount ?? undefined,
      amountFormatted: data.amountFormatted ?? undefined,
      proof: data.proof ?? data.merkleProof ?? undefined,
      claimIndex: data.index ?? data.claimIndex ?? undefined,
      claimed: data.claimed ?? data.hasClaimed ?? undefined,
    };
  }

  private async checkOnchain(
    airdrop: AirdropInfo,
    _address: string,
    _publicClient: any,
  ): Promise<EligibilityResult> {
    // On-chain checks are airdrop-specific. Without a merkle proof index,
    // we can only check if the contract exists and is active.
    // Full on-chain eligibility requires the merkle tree data.
    return {
      airdropId: airdrop.id,
      airdropName: airdrop.name,
      eligible: false,
      error: 'On-chain eligibility requires merkle proof data. Check the claim page or use the browser tool.',
    };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: AirdropService | null = null;

export function getAirdropService(): AirdropService {
  if (!_instance) _instance = new AirdropService();
  return _instance;
}

export function resetAirdropService(): void {
  _instance = null;
}
