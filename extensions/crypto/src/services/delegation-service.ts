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
  http,
  encodeAbiParameters,
  encodePacked,
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
    unmappedRules: unmappedRules.length > 0 ? unmappedRules : undefined,
  };

  policy.delegation = info;
  policy.updatedAt = Date.now();
  policyStore.savePolicy(policy);

  return info;
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
 * The permissionContext is an ABI-encoded delegation chain. For a single
 * root delegation (no parent), it encodes:
 *   abi.encode(Delegation[], bytes[])
 * where Delegation[] is the chain (length 1 for root) and bytes[] is the
 * per-caveat args for each delegation in the chain.
 */
function encodePermissionContext(delegation: SignedDelegation): Hex {
  // Single-delegation chain (root delegation, no parent)
  // The DelegationManager expects the delegation struct + caveat args
  // packed as: abi.encode(Delegation[], bytes[])
  //
  // For a single root delegation with N caveats, the args array has N entries
  // (one per caveat, usually all '0x' for compile-time enforcers).

  const delegationTuple = {
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: delegation.caveats.map(c => ({
      enforcer: c.enforcer,
      terms: c.terms,
      args: c.args,
    })),
    salt: delegation.salt,
    signature: delegation.signature,
  };

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
    [[delegationTuple]],
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

  // Check policy status
  const policyStore = getPolicyStore();
  // Find the policy across all users (agent may not know userId)
  // For now, the policyId is globally unique
  const policies = policyStore.listPolicies('owner');
  const policy = policies.find(p => p.id === policyId);
  if (policy?.delegation?.status === 'revoked') {
    return { error: 'Delegation has been revoked. Cannot redeem.' };
  }

  // Get the agent's wallet (delegate)
  const wallet = await getWallet();
  if (wallet.mode === 'none' || !wallet.walletClient) {
    return { error: 'No wallet connected. The agent needs a connected wallet to redeem delegations.' };
  }

  // Encode the redemption parameters
  const permissionContext = encodePermissionContext(delegation);
  const executionCallData = encodeExecution(action);

  try {
    const txHash = await wallet.walletClient.writeContract({
      address: DELEGATION_CONTRACTS.DelegationManager,
      abi: DELEGATION_MANAGER_ABI,
      functionName: 'redeemDelegations',
      args: [
        [permissionContext],          // bytes[] _permissionContexts
        [EXECUTE_MODE_DEFAULT],       // bytes32[] _modes
        [executionCallData],          // bytes[] _executionCallData
      ],
      chain: CHAIN_CONFIGS[chainId],
    });

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
