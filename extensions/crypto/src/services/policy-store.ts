/**
 * Policy Store — File-based CRUD persistence for policies and usage tracking.
 *
 * Layout:
 *   ~/.openclawnch/policies/<userId>/
 *     policies.json   — array of Policy objects
 *     usage.json      — array of PolicyUsage (rolling window, pruned on load)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Policy, PolicyUsage, UsageEntry } from './policy-types.js';

const HOME = process.env.HOME ?? '/home/openclawnch';
const BASE_DIR = join(HOME, '.openclawnch', 'policies');

/** Max usage entries per policy before pruning (keep 30 days). */
const MAX_USAGE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum policies per user (DoS prevention). */
const MAX_POLICIES_PER_USER = 50;

/** File permissions for policy files (owner read/write only). */
const FILE_MODE = 0o600;

// ─── Path helpers ───────────────────────────────────────────────────────

/**
 * Hash userId to prevent collisions: "user@1" and "user_1" must NOT
 * map to the same directory. SHA-256 prefix is collision-resistant.
 */
function sanitizeUserId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}

function userDir(userId: string): string {
  const dir = join(BASE_DIR, sanitizeUserId(userId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function policiesPath(userId: string): string {
  return join(userDir(userId), 'policies.json');
}

function usagePath(userId: string): string {
  return join(userDir(userId), 'usage.json');
}

// ─── Policy CRUD ────────────────────────────────────────────────────────

export class PolicyStore {
  private cache = new Map<string, Policy[]>();
  private usageCache = new Map<string, PolicyUsage[]>();
  /** Set of userIds whose policy files are corrupted. Fail-closed: block all. */
  private _corrupted = new Set<string>();

  /** Check if the store is corrupted for a user (fail-closed). */
  isCorrupted(userId: string): boolean {
    return this._corrupted.has(userId);
  }

  /** Load all policies for a user. */
  listPolicies(userId: string): Policy[] {
    const cached = this.cache.get(userId);
    if (cached) return cached;

    const path = policiesPath(userId);
    if (!existsSync(path)) return [];

    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as Policy[];
      this.cache.set(userId, data);
      return data;
    } catch (err) {
      // Corruption detected — rename corrupt file for forensics and fail closed
      this._corrupted.add(userId);
      try {
        renameSync(path, path + '.corrupt.' + Date.now());
      } catch { /* best effort */ }
      return [];
    }
  }

  /** Get active policies only. */
  getActivePolicies(userId: string): Policy[] {
    return this.listPolicies(userId).filter(p => p.status === 'active');
  }

  /** Get a single policy by ID. */
  getPolicy(userId: string, policyId: string): Policy | undefined {
    return this.listPolicies(userId).find(p => p.id === policyId);
  }

  /** Get a single policy by name (case-insensitive). */
  getPolicyByName(userId: string, name: string): Policy | undefined {
    const lower = name.toLowerCase();
    return this.listPolicies(userId).find(p => p.name.toLowerCase() === lower);
  }

  /** Create or update a policy. Throws if max count exceeded on insert. */
  savePolicy(policy: Policy): void {
    const policies = this.listPolicies(policy.userId);
    const idx = policies.findIndex(p => p.id === policy.id);
    if (idx >= 0) {
      policies[idx] = policy;
    } else {
      if (policies.length >= MAX_POLICIES_PER_USER) {
        throw new Error(`Maximum ${MAX_POLICIES_PER_USER} policies per user reached. Delete some before creating new ones.`);
      }
      policies.push(policy);
    }
    this.cache.set(policy.userId, policies);
    this.persist(policy.userId);
  }

  /** Delete a policy by ID. */
  deletePolicy(userId: string, policyId: string): boolean {
    const policies = this.listPolicies(userId);
    const idx = policies.findIndex(p => p.id === policyId);
    if (idx < 0) return false;
    policies.splice(idx, 1);
    this.cache.set(userId, policies);
    this.persist(userId);
    // Also remove usage
    const usages = this.loadUsage(userId);
    const uIdx = usages.findIndex(u => u.policyId === policyId);
    if (uIdx >= 0) {
      usages.splice(uIdx, 1);
      this.usageCache.set(userId, usages);
      this.persistUsage(userId);
    }
    return true;
  }

  // ─── Usage Tracking ─────────────────────────────────────────────────

  /** Load usage data for a user, pruning stale entries. */
  loadUsage(userId: string): PolicyUsage[] {
    const cached = this.usageCache.get(userId);
    if (cached) return cached;

    const path = usagePath(userId);
    if (!existsSync(path)) return [];

    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as PolicyUsage[];
      // Prune old entries
      const cutoff = Date.now() - MAX_USAGE_AGE_MS;
      let pruned = false;
      for (const pu of data) {
        const before = pu.entries.length;
        pu.entries = pu.entries.filter(e => e.timestamp > cutoff);
        if (pu.entries.length < before) pruned = true;
      }
      this.usageCache.set(userId, data);
      // Persist pruned data to prevent unbounded file growth
      if (pruned) this.persistUsage(userId);
      return data;
    } catch {
      return [];
    }
  }

  /** Get usage for a specific policy. */
  getUsage(userId: string, policyId: string): PolicyUsage | undefined {
    return this.loadUsage(userId).find(u => u.policyId === policyId);
  }

  /** Record a usage entry for a policy. */
  recordUsage(userId: string, policyId: string, entry: UsageEntry): void {
    const usages = this.loadUsage(userId);
    let pu = usages.find(u => u.policyId === policyId);
    if (!pu) {
      pu = { policyId, entries: [] };
      usages.push(pu);
    }
    pu.entries.push(entry);
    this.usageCache.set(userId, usages);
    this.persistUsage(userId);
  }

  /** Get total spend in a time window for a policy. */
  getSpendInWindow(userId: string, policyId: string, windowMs: number): number {
    const pu = this.getUsage(userId, policyId);
    if (!pu) return 0;
    const cutoff = Date.now() - windowMs;
    return pu.entries
      .filter(e => e.timestamp > cutoff && e.amountUsd != null)
      .reduce((sum, e) => sum + (e.amountUsd ?? 0), 0);
  }

  /** Get call count in a time window for a policy. */
  getCallsInWindow(userId: string, policyId: string, windowMs: number): number {
    const pu = this.getUsage(userId, policyId);
    if (!pu) return 0;
    const cutoff = Date.now() - windowMs;
    return pu.entries.filter(e => e.timestamp > cutoff).length;
  }

  // ─── Persistence ────────────────────────────────────────────────────

  private persist(userId: string): void {
    const policies = this.cache.get(userId) ?? [];
    atomicWrite(policiesPath(userId), JSON.stringify(policies, null, 2));
  }

  private persistUsage(userId: string): void {
    const usages = this.usageCache.get(userId) ?? [];
    atomicWrite(usagePath(userId), JSON.stringify(usages, null, 2));
  }

  /** Clear all caches (for testing). */
  reset(): void {
    this.cache.clear();
    this.usageCache.clear();
    this._corrupted.clear();
  }
}

// ─── Atomic Write Helper ────────────────────────────────────────────────

/**
 * Write to a temp file then rename (atomic on POSIX).
 * Prevents data loss on crash mid-write. Sets restrictive permissions.
 */
function atomicWrite(targetPath: string, data: string): void {
  const tmpPath = targetPath + '.tmp.' + Date.now();
  writeFileSync(tmpPath, data, { mode: FILE_MODE });
  renameSync(tmpPath, targetPath);
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _instance: PolicyStore | null = null;

export function getPolicyStore(): PolicyStore {
  if (!_instance) _instance = new PolicyStore();
  return _instance;
}

export function resetPolicyStore(): void {
  _instance?.reset();
  _instance = null;
}
