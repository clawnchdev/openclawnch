/**
 * Delegation Service — On-chain delegation lifecycle management.
 *
 * Handles creating, signing, revoking, and checking delegations via the
 * MetaMask DelegationManager contract. Uses viem for all chain interaction.
 *
 * Delegation flow:
 *   1. Policy is compiled to caveats (delegation-compiler.ts)
 *   2. User signs the delegation (EIP-712 via wallet client)
 *   3. Signed delegation is stored in the policy metadata
 *   4. Agent can redeem the delegation to execute actions on-chain
 *   5. User or agent can revoke via disableDelegation()
 *
 * Signing paths:
 *   - Private key mode: walletClient.signTypedData() (auto-sign)
 *   - WalletConnect: walletClient.signTypedData() (prompts user's wallet)
 *   - Bankr: bankrSign({ signatureType: 'eth_signTypedData_v4', ... })
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  decodeAbiParameters,
  encodePacked,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { mainnet, base, arbitrum, optimism, polygon, sepolia, linea, baseSepolia } from 'viem/chains';

import {
  DELEGATION_CONTRACTS,
  DELEGATION_MANAGER_ABI,
  DELEGATION_EIP712_TYPES,
  CHAIN_NAMES,
  SUPPORTED_CHAIN_IDS,
  EXECUTE_MODE_DEFAULT,
  getDelegationDomain,
  type Caveat,
  type SignedDelegation,
  type UnsignedDelegation,
  type DelegationStatus,
  type ExecutionAction,
} from './delegation-types.js';
import {
  compilePolicyToDelegation,
  formatCompilationSummary,
  setCompilationContext,
  type CompilationResult,
} from './delegation-compiler.js';
import { getPolicyStore } from './policy-store.js';
import { getDelegationStore } from './delegation-store.js';
import type { Policy, DelegationInfo } from './policy-types.js';

// ─── Chain Configuration ────────────────────────────────────────────────

const CHAIN_CONFIGS: Record<number, any> = {
  1:        mainnet,
  8453:     base,
  42161:    arbitrum,
  10:       optimism,
  137:      polygon,
  59144:    linea,
  11155111: sepolia,
  84532:    baseSepolia,
};

/** Default chain for delegation operations. */
const DEFAULT_CHAIN_ID = 8453; // Base

// ─── Public Client Cache ────────────────────────────────────────────────

const clientCache = new Map<number, any>();

function getDelegationPublicClient(chainId: number): any {
  let client = clientCache.get(chainId);
  if (client) return client;

  const chain = CHAIN_CONFIGS[chainId];
  if (!chain) throw new Error(`No chain config for chainId ${chainId}`);

  client = createPublicClient({ chain, transport: http() });
  clientCache.set(chainId, client);
  return client;
}

// ─── Wallet Access Helpers ──────────────────────────────────────────────

/**
 * Get the wallet state from the wallet service.
 * Uses dynamic import to avoid circular dependency.
 */
async function getWallet(): Promise<{
  mode: 'private_key' | 'walletconnect' | 'bankr' | 'none';
  address: Address | null;
  walletClient: any | null;
}> {
  try {
    const { getWalletState, getWalletClient } = await import('./walletconnect-service.js');
    const state = getWalletState();
    if (!state.connected || !state.address) {
      return { mode: 'none', address: null, walletClient: null };
    }
    let wc: any = null;
    try { wc = getWalletClient(); } catch { /* not available */ }
    return {
      mode: state.mode as any,
      address: state.address as Address,
      walletClient: wc,
    };
  } catch {
    return { mode: 'none', address: null, walletClient: null };
  }
}

// ─── Delegation Lifecycle ───────────────────────────────────────────────

export interface CreateDelegationInput {
  /** The policy to create a delegation for. */
  policy: Policy;
  /** The user's wallet address (delegator). Override auto-detected. */
  delegator?: Address;
  /** The agent's wallet address (delegate). Override auto-detected. */
  delegate?: Address;
  /** Target chain ID. Defaults to Base (8453). */
  chainId?: number;
}

export interface CreateDelegationResult {
  /** The compilation result with delegation and caveat details. */
  compilation: CompilationResult;
  /** Human-readable summary for user review before signing. */
  summary: string;
  /** The chain ID for this delegation. */
  chainId: number;
}

/**
 * Step 1: Compile a policy into a delegation and return it for user review.
 * Fetches live ETH price for USD→wei conversion when possible.
 * Does NOT sign or store — the user must review and approve first.
 */
export async function prepareDelegation(input: CreateDelegationInput): Promise<CreateDelegationResult | { error: string }> {
  const chainId = input.chainId ?? DEFAULT_CHAIN_ID;

  // Resolve addresses from wallet if not provided.
  // Delegator = user's wallet (the one granting permissions).
  // Delegate = agent's wallet (the one receiving permissions).
  // These should be DIFFERENT addresses — the agent address comes from
  // CLAWNCHER_ADDRESS env var, not the connected user wallet.
  const wallet = await getWallet();
  const zeroAddr = ('0x' + '0'.repeat(40)) as Address;
  const agentAddr = process.env.CLAWNCHER_ADDRESS as Address | undefined;
  const delegator = input.delegator ?? wallet.address ?? zeroAddr;
  const delegate = input.delegate ?? agentAddr ?? zeroAddr;

  // Fetch live ETH price for accurate USD → wei conversion
  try {
    const { getEthPrice } = await import('./price-service.js');
    const ethPriceUsd = await getEthPrice();
    if (ethPriceUsd > 0) {
      setCompilationContext({ ethPriceUsd });
    }
  } catch {
    // Price unavailable — compiler falls back to placeholder
    setCompilationContext({});
  }

  const result = compilePolicyToDelegation(input.policy, delegator, delegate, chainId);

  if ('type' in result && result.type === 'error') {
    return { error: result.message };
  }

  const compilation = result as CompilationResult;
  const summary = formatCompilationSummary(compilation, chainId);

  return { compilation, summary, chainId };
}

/**
 * Step 2: Sign a delegation using the connected wallet.
 *
 * Supports three modes:
 *   - private_key: auto-sign via viem WalletClient.signTypedData()
 *   - walletconnect: prompts user's external wallet for EIP-712 signature
 *   - bankr: signs via Bankr Agent API (eth_signTypedData_v4)
 *
 * Returns the signed delegation or an error string.
 */
export async function signDelegation(
  unsigned: UnsignedDelegation,
  chainId: number,
): Promise<{ signed: SignedDelegation } | { error: string }> {
  const wallet = await getWallet();

  if (wallet.mode === 'none' || !wallet.address) {
    return { error: 'No wallet connected. Use /connect or set CLAWNCHER_PRIVATE_KEY.' };
  }

  const domain = getDelegationDomain(chainId);
  const message = {
    delegate: unsigned.delegate,
    delegator: unsigned.delegator,
    authority: unsigned.authority,
    caveats: unsigned.caveats.map(c => ({
      enforcer: c.enforcer,
      terms: c.terms,
      args: c.args,
    })),
    salt: unsigned.salt,
  };

  try {
    let signature: Hex;

    if (wallet.mode === 'bankr') {
      // Bankr: use bankrSign API
      const { bankrSign } = await import('./bankr-api.js');
      const result = await bankrSign({
        signatureType: 'eth_signTypedData_v4',
        typedData: {
          domain,
          types: DELEGATION_EIP712_TYPES,
          primaryType: 'Delegation',
          message,
        },
        chainId,
      });
      signature = result.signature as Hex;
    } else if (wallet.walletClient) {
      // Private key or WalletConnect: use viem walletClient.signTypedData
      signature = await wallet.walletClient.signTypedData({
        domain,
        types: DELEGATION_EIP712_TYPES,
        primaryType: 'Delegation',
        message,
      });
    } else {
      return { error: `Wallet mode "${wallet.mode}" connected but no wallet client available for signing.` };
    }

    const signed: SignedDelegation = { ...unsigned, signature };
    return { signed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Signing failed: ${msg}` };
  }
}

/**
 * Extract the earliest expiry timestamp from TimestampEnforcer caveats.
 * TimestampEnforcer terms are: (uint128 executeAfter, uint128 executeBefore).
 * Returns ISO string for the earliest executeBefore, or undefined if none.
 */
function extractExpiryFromCaveats(caveats: Caveat[]): string | undefined {
  const timestampEnforcerAddr = DELEGATION_CONTRACTS.TimestampEnforcer.toLowerCase();
  let earliestExpiry: bigint | undefined;

  for (const caveat of caveats) {
    if (caveat.enforcer.toLowerCase() !== timestampEnforcerAddr) continue;

    try {
      const decoded = decodeAbiParameters(
        [
          { type: 'uint128', name: 'executeAfter' },
          { type: 'uint128', name: 'executeBefore' },
        ],
        caveat.terms as Hex,
      );
      const executeBefore = decoded[1] as bigint;
      if (executeBefore > 0n) {
        if (earliestExpiry === undefined || executeBefore < earliestExpiry) {
          earliestExpiry = executeBefore;
        }
      }
    } catch {
      // Couldn't decode — skip
    }
  }

  if (earliestExpiry !== undefined) {
    return new Date(Number(earliestExpiry) * 1000).toISOString();
  }
  return undefined;
}

/**
 * Step 3: Store a signed delegation in the policy metadata and get its hash.
 * Persists the full SignedDelegation struct to the delegation store (for
 * later redemption and on-chain revocation) and lightweight metadata on
 * the policy. Attempts to read the delegation hash from DelegationManager.
 */
export async function storeDelegation(
  policy: Policy,
  userId: string,
  delegation: SignedDelegation,
  chainId: number,
  unmappedRules: string[],
  expiresAt?: string,
): Promise<DelegationInfo> {
  const policyStore = getPolicyStore();
  const delegationStore = getDelegationStore();

  // Persist the full signed delegation struct for redemption/revocation
  delegationStore.save(delegation, chainId, policy.id);

  // Try to get the delegation hash from the on-chain contract
  let hash: string = '0x';
  try {
    const client = getDelegationPublicClient(chainId);
    const onChainHash = await client.readContract({
      address: DELEGATION_CONTRACTS.DelegationManager,
      abi: DELEGATION_MANAGER_ABI,
      functionName: 'getDelegationHash',
      args: [{
        delegate: delegation.delegate,
        delegator: delegation.delegator,
        authority: delegation.authority,
        caveats: delegation.caveats,
        salt: delegation.salt,
        signature: delegation.signature,
      }],
    });
    hash = onChainHash as string;
  } catch {
    // Hash lookup failed — store without it
  }

  const info: DelegationInfo = {
    chainId,
    hash,
    delegationManager: DELEGATION_CONTRACTS.DelegationManager,
    status: 'signed',
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    salt: delegation.salt.toString(),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ?? extractExpiryFromCaveats(delegation.caveats),
    unmappedRules: unmappedRules.length > 0 ? unmappedRules : undefined,
  };

  policy.delegation = info;
  policy.updatedAt = Date.now();
  policyStore.savePolicy(policy);

  return info;
}

// ─── Sub-Delegation (V7 — Agent Hierarchy) ─────────────────────────────

export interface CreateSubDelegationInput {
  /** The parent signed delegation to derive from. */
  parentDelegation: SignedDelegation;
  /** Parent delegation hash (used as authority for chaining). */
  parentHash: Hex;
  /** Chain ID for the sub-delegation. */
  chainId: number;
  /** Sub-agent's ephemeral wallet address (the new delegate). */
  subAgentAddress: Address;
  /** Sub-agent's ephemeral private key (for signing the sub-delegation). */
  subAgentPrivateKey: Hex;
  /** Optional: additional caveats to narrow the parent's permissions. */
  additionalCaveats?: Caveat[];
  /** Optional: subset of parent's caveats to include (by enforcer address). */
  caveatFilter?: Address[];
}

export interface SubDelegationResult {
  /** The signed sub-delegation. */
  delegation: SignedDelegation;
  /** Chain of delegations (parent + child) for redemption. */
  chain: SignedDelegation[];
  /** The parent delegation hash used as authority. */
  authority: Hex;
}

/**
 * Create a sub-delegation from a parent delegation.
 *
 * Sub-delegation narrows the parent's permissions by:
 * 1. Setting the `authority` field to the parent delegation's hash
 *    (creating a delegation chain)
 * 2. Inheriting the parent's caveats (optionally filtered)
 * 3. Adding additional restricting caveats (narrowing only — cannot expand)
 *
 * The parent agent (current delegate) signs the sub-delegation, granting
 * the sub-agent a subset of its own permissions.
 *
 * DelegationManager verifies the full chain during redemption:
 *   User → Agent (parent) → Sub-Agent (child)
 *
 * Important: caveats can only be made MORE restrictive in sub-delegations.
 * The on-chain enforcers check both the parent and child caveats during
 * redemption. Adding a wider spending limit on the child delegation is
 * harmless — the parent's enforcer still caps the total.
 */
export async function createSubDelegation(
  input: CreateSubDelegationInput,
): Promise<SubDelegationResult | { error: string }> {
  const {
    parentDelegation,
    parentHash,
    chainId,
    subAgentAddress,
    subAgentPrivateKey,
    additionalCaveats,
    caveatFilter,
  } = input;

  // Build the child delegation's caveats:
  // Start with parent's caveats (optionally filtered by enforcer)
  let childCaveats: Caveat[] = [];

  if (caveatFilter && caveatFilter.length > 0) {
    const filterSet = new Set(caveatFilter.map(a => a.toLowerCase()));
    childCaveats = parentDelegation.caveats.filter(
      c => filterSet.has(c.enforcer.toLowerCase()),
    );
  } else {
    // Inherit all parent caveats
    childCaveats = [...parentDelegation.caveats];
  }

  // Add any additional narrowing caveats
  if (additionalCaveats && additionalCaveats.length > 0) {
    childCaveats.push(...additionalCaveats);
  }

  // The sub-delegation's delegator is the parent's delegate (the agent),
  // and the delegate is the sub-agent's ephemeral address.
  const salt = BigInt('0x' + Array.from(
    { length: 32 },
    () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join(''));

  const unsigned: UnsignedDelegation = {
    delegate: subAgentAddress,
    delegator: parentDelegation.delegate, // parent agent is the delegator
    authority: parentHash,                // chain to parent delegation
    caveats: childCaveats,
    salt,
  };

  // Sign with the parent agent's key (the current delegate becomes delegator)
  const domain = getDelegationDomain(chainId);
  const message = {
    delegate: unsigned.delegate,
    delegator: unsigned.delegator,
    authority: unsigned.authority,
    caveats: unsigned.caveats.map(c => ({
      enforcer: c.enforcer,
      terms: c.terms,
      args: c.args,
    })),
    salt: unsigned.salt,
  };

  try {
    // The delegator of the sub-delegation is the parent agent (parentDelegation.delegate).
    // The agent's private key (CLAWNCHER_PRIVATE_KEY) is needed to sign.
    const agentPrivateKey = process.env.CLAWNCHER_PRIVATE_KEY as Hex | undefined;
    if (!agentPrivateKey) {
      return { error: 'CLAWNCHER_PRIVATE_KEY is required for sub-delegation signing. The agent must have its own private key.' };
    }

    const chain = CHAIN_CONFIGS[chainId];
    if (!chain) {
      return { error: `No chain config for chainId ${chainId}` };
    }

    const { privateKeyToAccount } = await import('viem/accounts');
    const agentSignerClient = createWalletClient({
      account: privateKeyToAccount(agentPrivateKey),
      chain,
      transport: http(),
    });

    const signature = await agentSignerClient.signTypedData({
      domain,
      types: DELEGATION_EIP712_TYPES,
      primaryType: 'Delegation',
      message,
    });

    const signed: SignedDelegation = { ...unsigned, signature };

    return {
      delegation: signed,
      chain: [parentDelegation, signed], // ordered: root first, child last
      authority: parentHash,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Sub-delegation signing failed: ${msg}` };
  }
}

/**
 * Revoke a delegation on-chain via DelegationManager.disableDelegation().
 * Requires the delegator's wallet to send the transaction.
 */
export async function revokeDelegationOnChain(
  delegation: SignedDelegation,
  chainId: number,
): Promise<{ txHash: string } | { error: string }> {
  const wallet = await getWallet();

  if (wallet.mode === 'none' || !wallet.walletClient) {
    return { error: 'No wallet connected. Connect a wallet to revoke on-chain.' };
  }

  try {
    const txHash = await wallet.walletClient.writeContract({
      address: DELEGATION_CONTRACTS.DelegationManager,
      abi: DELEGATION_MANAGER_ABI,
      functionName: 'disableDelegation',
      args: [{
        delegate: delegation.delegate,
        delegator: delegation.delegator,
        authority: delegation.authority,
        caveats: delegation.caveats,
        salt: delegation.salt,
        signature: delegation.signature,
      }],
      chain: CHAIN_CONFIGS[chainId],
    });

    return { txHash: txHash as string };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `On-chain revocation failed: ${msg}` };
  }
}

/**
 * Check delegation status on-chain.
 * Reads the `disabledDelegations` mapping on DelegationManager.
 */
export async function checkDelegationStatus(
  delegationHash: Hex,
  chainId: number,
): Promise<DelegationStatus> {
  if (!SUPPORTED_CHAIN_IDS.has(chainId)) {
    throw new Error(`Chain ${chainId} not supported`);
  }

  try {
    const client = getDelegationPublicClient(chainId);
    const isDisabled = await client.readContract({
      address: DELEGATION_CONTRACTS.DelegationManager,
      abi: DELEGATION_MANAGER_ABI,
      functionName: 'disabledDelegations',
      args: [delegationHash],
    });

    return isDisabled ? 'revoked' : 'active';
  } catch {
    return 'signed';
  }
}

/**
 * Refresh delegation status for a policy and persist the result.
 */
export async function refreshDelegationStatus(
  policy: Policy,
  userId: string,
): Promise<DelegationInfo | null> {
  if (!policy.delegation) return null;
  if (!policy.delegation.hash || policy.delegation.hash === '0x') {
    return policy.delegation;
  }

  try {
    const status = await checkDelegationStatus(
      policy.delegation.hash as Hex,
      policy.delegation.chainId,
    );

    policy.delegation.status = status;
    policy.delegation.lastCheckedAt = new Date().toISOString();

    const store = getPolicyStore();
    store.savePolicy(policy);

    return policy.delegation;
  } catch {
    return policy.delegation;
  }
}

/**
 * Build an EIP-7715 wallet_requestExecutionPermissions request payload.
 * Can be sent to wallets that support the EIP-7715 JSON-RPC method.
 */
export function buildEip7715Request(
  compilation: CompilationResult,
  chainId: number,
): Record<string, unknown> {
  // Map caveats to EIP-7715 permission format
  const permissions = compilation.mappedRules.map(({ rule, caveats }) => {
    const base: Record<string, unknown> = { type: rule.type };

    if (rule.type === 'spending_limit' || rule.type === 'max_amount') {
      base.type = 'native-token-allowance';
      base.data = { allowance: '0x' + caveats[0]?.terms.slice(2, 66) };
    } else if (rule.type === 'rate_limit') {
      base.type = 'call-limit';
      base.data = { count: (rule as any).maxCalls };
    } else if (rule.type === 'allowlist' && (rule as any).field === 'addresses') {
      base.type = 'allowed-targets';
      base.data = { targets: (rule as any).values };
    }

    return base;
  });

  return {
    method: 'wallet_requestExecutionPermissions',
    params: [{
      chainId: `0x${chainId.toString(16)}`,
      permissions,
      expiry: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days default
    }],
  };
}

// ─── Revoke By Policy ───────────────────────────────────────────────────

/**
 * Revoke a delegation by policy ID. Loads the full SignedDelegation from the
 * delegation store and calls disableDelegation() on-chain. Also updates the
 * policy metadata and cleans up the stored struct.
 *
 * Returns { txHash } on success, or { error } if wallet/store/chain fails.
 * Falls back to local-only revocation if the full struct isn't stored.
 */
export async function revokeByPolicy(
  policy: Policy,
  userId: string,
): Promise<{ txHash: string } | { localOnly: true } | { error: string }> {
  if (!policy.delegation) {
    return { error: 'Policy has no delegation to revoke.' };
  }

  const delegationStore = getDelegationStore();
  const stored = delegationStore.load(policy.id);

  if (!stored) {
    // No full struct — can only revoke locally
    policy.delegation.status = 'revoked';
    policy.updatedAt = Date.now();
    getPolicyStore().savePolicy(policy);
    return { localOnly: true };
  }

  // Try on-chain revocation
  const result = await revokeDelegationOnChain(stored.delegation, stored.chainId);

  if ('error' in result) {
    // On-chain failed — still revoke locally
    policy.delegation.status = 'revoked';
    policy.updatedAt = Date.now();
    getPolicyStore().savePolicy(policy);
    return result;
  }

  // On-chain succeeded — update metadata and clean up
  policy.delegation.status = 'revoked';
  policy.delegation.lastCheckedAt = new Date().toISOString();
  policy.updatedAt = Date.now();
  getPolicyStore().savePolicy(policy);
  delegationStore.delete(policy.id);

  return result;
}

// ─── Redemption ─────────────────────────────────────────────────────────

/**
 * Encode the permissionContext for redeemDelegations().
 *
 * The permissionContext is an ABI-encoded delegation chain. Supports both
 * single-delegation (root) and multi-delegation (sub-delegation) chains.
 *
 * For a single root delegation:
 *   abi.encode(Delegation[1])
 *
 * For a sub-delegation chain (User → Agent → Sub-Agent):
 *   abi.encode(Delegation[2])  — ordered [parent, child]
 *
 * The DelegationManager walks the chain, verifying each delegation's
 * authority field matches the hash of its parent.
 */
function encodePermissionContext(delegation: SignedDelegation): Hex {
  return encodePermissionContextChain([delegation]);
}

/**
 * Encode a delegation chain as permissionContext.
 * Accepts an array of SignedDelegations ordered from root (parent) to leaf (child).
 * For a single root delegation, pass a 1-element array.
 */
export function encodePermissionContextChain(chain: SignedDelegation[]): Hex {
  const delegationTuples = chain.map(d => ({
    delegate: d.delegate,
    delegator: d.delegator,
    authority: d.authority,
    caveats: d.caveats.map(c => ({
      enforcer: c.enforcer,
      terms: c.terms,
      args: c.args,
    })),
    salt: d.salt,
    signature: d.signature,
  }));

  // Encode as: abi.encode(Delegation[])
  // The DelegationManager decodes the permissionContext as a delegation chain.
  return encodeAbiParameters(
    [{
      type: 'tuple[]',
      components: [
        { name: 'delegate', type: 'address' },
        { name: 'delegator', type: 'address' },
        { name: 'authority', type: 'bytes32' },
        {
          name: 'caveats', type: 'tuple[]',
          components: [
            { name: 'enforcer', type: 'address' },
            { name: 'terms', type: 'bytes' },
            { name: 'args', type: 'bytes' },
          ],
        },
        { name: 'salt', type: 'uint256' },
        { name: 'signature', type: 'bytes' },
      ],
    }],
    [delegationTuples],
  );
}

/**
 * Encode execution calldata for a single action.
 * ERC-7579 single execution: abi.encodePacked(target, value, callData).
 */
function encodeExecution(action: ExecutionAction): Hex {
  return encodePacked(
    ['address', 'uint256', 'bytes'],
    [action.target, action.value, action.callData],
  );
}

// ─── Error Parsing ──────────────────────────────────────────────────────

/** Known DelegationManager error signatures → human-readable messages. */
const DELEGATION_ERROR_SIGS: Record<string, string> = {
  '0x155ff427': 'Signature verification failed (InvalidERC1271Signature). The delegation signature does not match the delegator account.',
  '0xded4370e': 'Invalid authority chain (InvalidAuthority). Root delegations must use authority 0xfff...f.',
  '0x8baa579f': 'Invalid signature (InvalidSignature). ECDSA recovery did not match the delegator.',
  '0xb5863604': 'Invalid delegate (InvalidDelegate). The caller is not the authorized delegate.',
  '0xa9e649e9': 'Invalid delegation struct (InvalidDelegation).',
  '0xac241e11': 'Empty signature (EmptySignature). The delegation has no signature.',
  '0x0ab29062': 'No delegations provided (NoDelegations).',
};

function parseDelegationError(errMsg: string): string {
  // Check for known error signatures in the message
  for (const [sig, humanMsg] of Object.entries(DELEGATION_ERROR_SIGS)) {
    if (errMsg.includes(sig)) {
      return `Delegation simulation reverted: ${humanMsg}`;
    }
  }
  // Generic revert
  if (errMsg.includes('revert')) {
    return `Delegation simulation reverted: ${errMsg.slice(0, 200)}`;
  }
  return `Delegation simulation failed: ${errMsg.slice(0, 200)}`;
}

export interface RedemptionResult {
  /** Transaction hash from the redeemDelegations call. */
  txHash: string;
  /** Chain ID where the redemption was executed. */
  chainId: number;
}

/**
 * Redeem a delegation to execute an action on-chain.
 *
 * This is the core execution path: the agent calls redeemDelegations() on the
 * DelegationManager, which verifies all caveats and executes the action through
 * the delegator's smart account.
 *
 * The caller must have the delegate's wallet (agent wallet) connected, since
 * the agent is the one redeeming.
 *
 * @param policyId - The policy whose delegation to redeem
 * @param action   - The execution action (target, value, calldata)
 * @returns        - Transaction hash or error
 */
export async function redeemDelegation(
  policyId: string,
  action: ExecutionAction,
): Promise<RedemptionResult | { error: string }> {
  const delegationStore = getDelegationStore();
  const stored = delegationStore.load(policyId);

  if (!stored) {
    return { error: `No signed delegation found for policy "${policyId}". Create and sign a delegation first.` };
  }

  const { delegation, chainId } = stored;

  // Check policy status — try wallet address first, fall back to 'owner'
  const policyStore = getPolicyStore();
  const wallet = await getWallet();
  const userId = wallet.address?.toLowerCase() ?? 'owner';
  let policies = policyStore.listPolicies(userId);
  if (policies.length === 0 && userId !== 'owner') {
    policies = policyStore.listPolicies('owner');
  }
  const policy = policies.find(p => p.id === policyId);
  if (policy?.delegation?.status === 'revoked') {
    return { error: 'Delegation has been revoked. Cannot redeem.' };
  }

  // P2-3: Check on-chain revocation (catches revocations made outside our tool)
  try {
    const publicClient = getDelegationPublicClient(chainId);
    const delegationHash = await publicClient.readContract({
      address: DELEGATION_CONTRACTS.DelegationManager,
      abi: DELEGATION_MANAGER_ABI,
      functionName: 'getDelegationHash',
      args: [delegation],
    });
    const isDisabled = await publicClient.readContract({
      address: DELEGATION_CONTRACTS.DelegationManager,
      abi: DELEGATION_MANAGER_ABI,
      functionName: 'disabledDelegations',
      args: [delegationHash],
    });
    if (isDisabled) {
      // Update local state to match on-chain
      if (policy?.delegation) {
        policy.delegation.status = 'revoked' as DelegationStatus;
      }
      return { error: 'Delegation has been revoked on-chain. Cannot redeem.' };
    }
  } catch {
    // Non-fatal: if the on-chain check fails (network error), proceed with
    // redemption and let the contract itself enforce revocation.
  }

  // Verify wallet is connected (already fetched above for userId)
  if (wallet.mode === 'none' || !wallet.walletClient) {
    return { error: 'No wallet connected. The agent needs a connected wallet to redeem delegations.' };
  }

  // Encode the redemption parameters
  const permissionContext = encodePermissionContext(delegation);
  const executionCallData = encodeExecution(action);

  const contractCallArgs = {
    address: DELEGATION_CONTRACTS.DelegationManager,
    abi: DELEGATION_MANAGER_ABI,
    functionName: 'redeemDelegations' as const,
    args: [
      [permissionContext],          // bytes[] _permissionContexts
      [EXECUTE_MODE_DEFAULT],       // bytes32[] _modes
      [executionCallData],          // bytes[] _executionCallData
    ],
    chain: CHAIN_CONFIGS[chainId],
  };

  // Simulate first to catch reverts before spending gas
  try {
    const publicClient = getDelegationPublicClient(chainId);
    if (publicClient) {
      await publicClient.simulateContract({
        ...contractCallArgs,
        account: wallet.address!,
      });
    }
  } catch (simErr) {
    const msg = simErr instanceof Error ? simErr.message : String(simErr);
    return { error: parseDelegationError(msg) };
  }

  try {
    const txHash = await wallet.walletClient.writeContract(contractCallArgs);
    return { txHash: txHash as string, chainId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Redemption failed: ${msg}` };
  }
}

/**
 * Check if a delegation is available for redemption (stored and not revoked).
 */
export function canRedeem(policyId: string): { ready: boolean; reason?: string } {
  const delegationStore = getDelegationStore();
  if (!delegationStore.has(policyId)) {
    return { ready: false, reason: 'No signed delegation stored for this policy.' };
  }

  const stored = delegationStore.load(policyId);
  if (!stored) {
    return { ready: false, reason: 'Delegation file corrupted or unreadable.' };
  }

  return { ready: true };
}

// ─── Display Helpers ────────────────────────────────────────────────────

/**
 * Format delegation info as a human-readable status block.
 */
export function formatDelegationStatus(meta: DelegationInfo): string {
  const lines: string[] = [];

  const statusLabel = {
    unsigned: 'UNSIGNED (not yet signed)',
    signed: 'SIGNED (ready for on-chain use)',
    active: 'ACTIVE (verified on-chain)',
    revoked: 'REVOKED (disabled on-chain)',
    expired: 'EXPIRED',
  }[meta.status] ?? meta.status;

  lines.push(`  Delegation: [${statusLabel}]`);
  lines.push(`  Chain: ${CHAIN_NAMES[meta.chainId] ?? meta.chainId}`);
  lines.push(`  Delegate: \`${meta.delegate}\``);
  lines.push(`  Delegator: \`${meta.delegator}\``);

  if (meta.hash && meta.hash !== '0x') {
    lines.push(`  Hash: \`${meta.hash}\``);
  }

  if (meta.unmappedRules && meta.unmappedRules.length > 0) {
    lines.push(`  App-layer only: ${meta.unmappedRules.join(', ')}`);
  }

  if (meta.lastCheckedAt) {
    lines.push(`  Last verified: ${meta.lastCheckedAt}`);
  }

  return lines.join('\n');
}

/**
 * Get all policies with delegations for a user.
 */
export function getDelegatedPolicies(userId: string): Policy[] {
  const store = getPolicyStore();
  const policies = store.listPolicies(userId);
  return policies.filter(p => p.delegation != null);
}

/**
 * Get supported chains as a formatted string.
 */
export function formatSupportedChains(): string {
  return [...SUPPORTED_CHAIN_IDS]
    .map(id => `${CHAIN_NAMES[id] ?? id} (${id})`)
    .join(', ');
}
