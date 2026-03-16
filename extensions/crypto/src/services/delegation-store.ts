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
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
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

// ─── Encryption (AES-256-GCM) ───────────────────────────────────────────
// Encrypts delegation JSON at rest. Key derived from DELEGATION_STORE_KEY
// env var or wallet address (prevents casual filesystem reads).

function getEncryptionKey(): Buffer | null {
  const envKey = process.env.DELEGATION_STORE_KEY;
  if (envKey && envKey.length > 0) {
    return createHash('sha256').update(envKey).digest();
  }
  // No encryption configured — store plaintext (backward compatible)
  return null;
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: ENC:base64(iv + tag + ciphertext)
  const combined = Buffer.concat([iv, tag, encrypted]);
  return 'ENC:' + combined.toString('base64');
}

function decrypt(data: string): string {
  if (!data.startsWith('ENC:')) return data; // plaintext (unencrypted legacy)

  const key = getEncryptionKey();
  if (!key) return data; // no key configured — return raw (will fail JSON.parse)

  const combined = Buffer.from(data.slice(4), 'base64');
  const iv = combined.subarray(0, 12);
  const tag = combined.subarray(12, 28);
  const ciphertext = combined.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
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
    atomicWrite(delegationPath(policyId), encrypt(JSON.stringify(stored, null, 2)));
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
      const raw = readFileSync(path, 'utf8');
      const data = JSON.parse(decrypt(raw)) as StoredDelegation;
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
