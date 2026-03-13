/**
 * Delegation Store — File-based persistence for full SignedDelegation structs.
 *
 * The DelegationInfo on Policy stores lightweight metadata (hash, addresses,
 * status). This store persists the complete signed delegation including caveats
 * and signature bytes — required for on-chain redemption and revocation.
 *
 * Layout:
 *   ~/.openclawnch/delegations/<policyId>.json
 *
 * Each file contains a StoredDelegation: the full SignedDelegation struct
 * plus chainId and metadata. Bigints are serialized as hex strings.
 *
 * Follows the same patterns as policy-store.ts: atomic writes, 0o600
 * permissions, singleton instance, in-memory cache.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import type { SignedDelegation, Caveat } from './delegation-types.js';

const HOME = process.env.HOME ?? '/home/openclawnch';
const DELEGATIONS_DIR = join(HOME, '.openclawnch', 'delegations');

/** File permissions (owner read/write only). */
const FILE_MODE = 0o600;

// ─── Serialized Format ──────────────────────────────────────────────────
// bigint fields (salt) are stored as hex strings for JSON compatibility.

interface StoredDelegation {
  /** The full signed delegation struct. */
  delegate: Address;
  delegator: Address;
  authority: Hex;
  caveats: Caveat[];
  /** Salt as hex string (bigint serialized). */
  salt: string;
  signature: Hex;
  /** Chain ID this delegation targets. */
  chainId: number;
  /** ISO timestamp when stored. */
  storedAt: string;
  /** Policy ID this delegation belongs to. */
  policyId: string;
}

// ─── Ensure directory exists ────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(DELEGATIONS_DIR)) {
    mkdirSync(DELEGATIONS_DIR, { recursive: true });
  }
}

function delegationPath(policyId: string): string {
  // Sanitize policyId for filesystem safety
  const safe = policyId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(DELEGATIONS_DIR, `${safe}.json`);
}

// ─── Atomic Write ───────────────────────────────────────────────────────

function atomicWrite(targetPath: string, data: string): void {
  const tmpPath = targetPath + '.tmp.' + Date.now();
  writeFileSync(tmpPath, data, { mode: FILE_MODE });
  renameSync(tmpPath, targetPath);
}

// ─── Conversion Helpers ─────────────────────────────────────────────────

function toStored(
  delegation: SignedDelegation,
  chainId: number,
  policyId: string,
): StoredDelegation {
  return {
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: delegation.caveats.map(c => ({
      enforcer: c.enforcer,
      terms: c.terms,
      args: c.args,
    })),
    salt: '0x' + delegation.salt.toString(16),
    signature: delegation.signature,
    chainId,
    policyId,
    storedAt: new Date().toISOString(),
  };
}

function fromStored(stored: StoredDelegation): SignedDelegation {
  return {
    delegate: stored.delegate as Address,
    delegator: stored.delegator as Address,
    authority: stored.authority as Hex,
    caveats: stored.caveats.map(c => ({
      enforcer: c.enforcer as Address,
      terms: c.terms as Hex,
      args: c.args as Hex,
    })),
    salt: BigInt(stored.salt),
    signature: stored.signature as Hex,
  };
}

// ─── DelegationStore Class ──────────────────────────────────────────────

export class DelegationStore {
  private cache = new Map<string, StoredDelegation>();

  /** Save a signed delegation for a policy. Overwrites any existing. */
  save(delegation: SignedDelegation, chainId: number, policyId: string): void {
    ensureDir();
    const stored = toStored(delegation, chainId, policyId);
    this.cache.set(policyId, stored);
    atomicWrite(delegationPath(policyId), JSON.stringify(stored, null, 2));
  }

  /** Load a signed delegation by policy ID. Returns null if not found. */
  load(policyId: string): { delegation: SignedDelegation; chainId: number } | null {
    // Check cache first
    const cached = this.cache.get(policyId);
    if (cached) {
      return { delegation: fromStored(cached), chainId: cached.chainId };
    }

    // Try disk
    const path = delegationPath(policyId);
    if (!existsSync(path)) return null;

    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as StoredDelegation;
      this.cache.set(policyId, data);
      return { delegation: fromStored(data), chainId: data.chainId };
    } catch {
      // Corrupted file — remove it
      try { unlinkSync(path); } catch { /* best effort */ }
      return null;
    }
  }

  /** Check if a delegation exists for a policy. */
  has(policyId: string): boolean {
    if (this.cache.has(policyId)) return true;
    return existsSync(delegationPath(policyId));
  }

  /** Delete a stored delegation. */
  delete(policyId: string): boolean {
    this.cache.delete(policyId);
    const path = delegationPath(policyId);
    if (existsSync(path)) {
      try { unlinkSync(path); return true; } catch { return false; }
    }
    return false;
  }

  /** Clear all caches (for testing). */
  reset(): void {
    this.cache.clear();
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _instance: DelegationStore | null = null;

export function getDelegationStore(): DelegationStore {
  if (!_instance) _instance = new DelegationStore();
  return _instance;
}

export function resetDelegationStore(): void {
  _instance?.reset();
  _instance = null;
}
