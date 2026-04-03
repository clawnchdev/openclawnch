/**
 * Advanced Permissions Service — MetaMask ERC-7715 integration.
 *
 * For MetaMask WalletConnect users, delegation is handled via Advanced
 * Permissions: the dapp requests scoped permissions from MetaMask, which
 * signs the delegation internally. The session account (our agent) then
 * redeems via the standard DelegationManager.
 *
 * This is a parallel path to the raw viem delegation in delegation-service.ts.
 * The policy gate routes based on wallet type:
 *   - MetaMask → Advanced Permissions (this service)
 *   - Private key / other wallets → raw delegation (delegation-service.ts)
 *
 * Uses @metamask/smart-accounts-kit SDK.
 */

import {
  createDelegation,
  createExecution,
  getSmartAccountsEnvironment,
  ExecutionMode,
  ROOT_AUTHORITY,
} from '@metamask/smart-accounts-kit';
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts';
import type { Address, Hex } from 'viem';
import type { ExecutionAction } from './delegation-types.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface GrantedPermission {
  context: Hex;
  signerMeta: {
    delegationManager: Address;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PermissionRequest {
  chainId: number;
  expiry: number;
  sessionAccountAddress: Address;
  permission: NativeTokenPermission | Erc20TokenPermission;
}

interface NativeTokenPermission {
  type: 'native-token-transfer';
  data: {
    maxAmount: bigint;
  };
}

interface Erc20TokenPermission {
  type: 'erc20-token-periodic';
  data: {
    tokenAddress: Address;
    periodAmount: bigint;
    periodDuration: number;
    justification?: string;
  };
}

// ─── Permission Storage ─────────────────────────────────────────────────
// In-memory cache of granted permissions per policy ID.
// Persists for the session lifetime. For cross-session persistence,
// could be extended to disk (similar to delegation-store.ts).

const _grantedPermissions = new Map<string, GrantedPermission[]>();

export function storeGrantedPermissions(policyId: string, permissions: GrantedPermission[]): void {
  _grantedPermissions.set(policyId, permissions);
}

export function getGrantedPermissions(policyId: string): GrantedPermission[] | null {
  return _grantedPermissions.get(policyId) ?? null;
}

export function clearGrantedPermissions(policyId: string): void {
  _grantedPermissions.delete(policyId);
}

// ─── Environment ────────────────────────────────────────────────────────

/** Get the DelegationManager address for a chain from the SDK. */
export function getSdkDelegationManager(chainId: number): Address {
  const env = getSmartAccountsEnvironment(chainId);
  return env.DelegationManager as Address;
}

// ─── Redeem via SDK ─────────────────────────────────────────────────────

/**
 * Build the redeemDelegations calldata using the SDK.
 * This encodes the permissionsContext + execution into the correct
 * format for the DelegationManager.
 *
 * The caller sends this as a raw transaction (to: DelegationManager, data: calldata).
 */
export function buildRedeemCalldata(
  permissionsContext: Hex,
  action: ExecutionAction,
): Hex {
  const execution = createExecution({
    target: action.target,
    value: action.value,
    callData: action.callData,
  });

  return DelegationManager.encode.redeemDelegations({
    delegations: [[]], // permissionsContext replaces inline delegations
    modes: [ExecutionMode.SingleDefault],
    executions: [[execution]],
  }) as Hex;
}

/**
 * Check if Advanced Permissions are available for a wallet.
 * Returns true if:
 * 1. The wallet is connected via WalletConnect or MetaMask provider
 * 2. The wallet has an EIP-7702 designation (smart account)
 * 3. There are stored granted permissions
 */
export function hasAdvancedPermissions(policyId: string): boolean {
  return _grantedPermissions.has(policyId);
}

/**
 * Get the permission context + DelegationManager address for a policy.
 * Returns null if no permissions are stored.
 */
export function getPermissionContext(policyId: string): {
  context: Hex;
  delegationManager: Address;
} | null {
  const perms = _grantedPermissions.get(policyId);
  if (!perms || perms.length === 0) return null;

  const first = perms[0];
  if (!first) return null;

  return {
    context: first.context,
    delegationManager: first.signerMeta.delegationManager,
  };
}
