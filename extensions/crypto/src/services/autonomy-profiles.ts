/**
 * Graduated Autonomy Profiles
 *
 * Preset delegation configurations that give users easy on-ramps to
 * agent autonomy. Each profile defines a set of policy rules and
 * recommended delegation parameters.
 *
 * Profiles:
 *   supervised    — no delegation, all actions require ClawnchConnect approval
 *   training      — small limits, short expiry, limited actions
 *   autonomous    — production-level limits, weekly budgets, approved contracts
 *   custom        — user-defined (just a label, no preset rules)
 *
 * The /profile command creates policies from a profile template, then
 * optionally compiles them to on-chain delegations in delegation mode.
 */

import type {
  Policy,
  PolicyRule,
  PolicyScope,
} from './policy-types.js';
import { getPolicyMode, isDelegationMode } from './policy-types.js';
import { getPolicyStore } from './policy-store.js';
import { randomUUID } from 'node:crypto';

// ─── Profile Types ──────────────────────────────────────────────────────

export type ProfileId = 'supervised' | 'training' | 'autonomous' | 'custom';

export interface AutonomyProfile {
  id: ProfileId;
  name: string;
  description: string;
  /** Human-readable summary of what the agent can do. */
  summary: string[];
  /** Policy rules created when profile is activated. */
  rules: PolicyRule[];
  /** Which tool categories are in scope. Empty = all tools. */
  scopeCategories: string[];
  /** Delegation parameters (for on-chain mode). */
  delegation: {
    /** Expiry duration in seconds. 0 = no delegation (supervised). */
    expirySec: number;
    /** Max single-tx value in USD. 0 = no cap (uses spending limit). */
    maxTxUsd: number;
  };
}

// ─── Profile Definitions ────────────────────────────────────────────────

const PROFILES: Record<ProfileId, AutonomyProfile> = {
  supervised: {
    id: 'supervised',
    name: 'Supervised',
    description: 'All actions require wallet approval via ClawnchConnect.',
    summary: [
      'Every transaction goes to your wallet for manual approval.',
      'No spending limits — you review each action.',
      'No on-chain delegation created.',
      'This is the safest mode. The agent cannot act without you.',
    ],
    rules: [],
    scopeCategories: [],
    delegation: { expirySec: 0, maxTxUsd: 0 },
  },

  training: {
    id: 'training',
    name: 'Training Wheels',
    description: 'Small limits, short expiry. Good for getting started.',
    summary: [
      'Max $50 per transaction.',
      'Max $200/day total spending.',
      'Max 10 write actions per day.',
      '24-hour expiry — delegation auto-expires.',
      'Only DeFi and transfer tools allowed.',
    ],
    rules: [
      { type: 'max_amount', maxAmountUsd: 50 },
      { type: 'spending_limit', maxAmountUsd: 200, period: 'daily' },
      { type: 'rate_limit', maxCalls: 10, periodMs: 86_400_000 },
    ],
    scopeCategories: ['defi', 'transfer'],
    delegation: { expirySec: 86_400, maxTxUsd: 50 },
  },

  autonomous: {
    id: 'autonomous',
    name: 'Autonomous',
    description: 'Production-level autonomy with weekly budgets.',
    summary: [
      'Max $500 per transaction.',
      'Max $2,000/week total spending.',
      'Max 50 write actions per day.',
      '30-day expiry — renew monthly.',
      'DeFi, transfers, and orchestration tools allowed.',
      'Confirmation required above $500.',
    ],
    rules: [
      { type: 'max_amount', maxAmountUsd: 500 },
      { type: 'spending_limit', maxAmountUsd: 2000, period: 'weekly' },
      { type: 'rate_limit', maxCalls: 50, periodMs: 86_400_000 },
      { type: 'approval_threshold', amountUsd: 500 },
    ],
    scopeCategories: ['defi', 'transfer', 'orchestration'],
    delegation: { expirySec: 2_592_000, maxTxUsd: 500 },
  },

  custom: {
    id: 'custom',
    name: 'Custom',
    description: 'Define your own rules using natural language policies.',
    summary: [
      'No preset rules — you define everything.',
      'Use `/policies` to create and manage rules.',
      'Use `/delegate create <name>` to compile to on-chain delegation.',
    ],
    rules: [],
    scopeCategories: [],
    delegation: { expirySec: 0, maxTxUsd: 0 },
  },
};

// ─── Profile Store ──────────────────────────────────────────────────────

/** Prefix for policies created by profile activation. */
const PROFILE_POLICY_PREFIX = 'profile:';

/** In-memory cache of active profile per user. */
const _activeProfiles = new Map<string, ProfileId>();

/** Get the list of all available profiles. */
export function listProfiles(): AutonomyProfile[] {
  return Object.values(PROFILES);
}

/** Get a profile by ID. */
export function getProfile(id: string): AutonomyProfile | undefined {
  return PROFILES[id as ProfileId];
}

/** Get the active profile for a user (checks existing policies). */
export function getActiveProfile(userId: string): ProfileId {
  // Check cache first
  const cached = _activeProfiles.get(userId);
  if (cached) return cached;

  // Check if user has profile-generated policies
  const store = getPolicyStore();
  const policies = store.listPolicies(userId);
  const profilePolicy = policies.find(p => p.name.startsWith(PROFILE_POLICY_PREFIX));

  if (profilePolicy) {
    const id = profilePolicy.name.replace(PROFILE_POLICY_PREFIX, '') as ProfileId;
    if (PROFILES[id]) {
      _activeProfiles.set(userId, id);
      return id;
    }
  }

  // Check if user has any custom policies
  if (policies.length > 0) {
    _activeProfiles.set(userId, 'custom');
    return 'custom';
  }

  // No policies at all = supervised
  _activeProfiles.set(userId, 'supervised');
  return 'supervised';
}

/**
 * Activate a profile for a user.
 *
 * - Removes any existing profile-generated policies.
 * - Creates new policies from the profile template.
 * - Does NOT compile to on-chain delegation (use /delegate create after).
 * - Returns the created policies (empty for supervised/custom).
 */
export function activateProfile(
  userId: string,
  profileId: ProfileId,
): { profile: AutonomyProfile; policies: Policy[] } {
  const profile = PROFILES[profileId];
  if (!profile) throw new Error(`Unknown profile: ${profileId}`);

  const store = getPolicyStore();

  // Remove existing profile-generated policies
  const existing = store.listPolicies(userId);
  for (const p of existing) {
    if (p.name.startsWith(PROFILE_POLICY_PREFIX)) {
      store.deletePolicy(userId, p.id);
    }
  }

  // Create policies from profile template
  const created: Policy[] = [];

  if (profile.rules.length > 0) {
    const now = Date.now();
    const hasCategories = profile.scopeCategories.length > 0;
    const scope: PolicyScope = {
      type: hasCategories ? 'categories' : 'all_write',
      tools: undefined,
      categories: hasCategories ? profile.scopeCategories : undefined,
    };

    const policy: Policy = {
      id: randomUUID(),
      name: `${PROFILE_POLICY_PREFIX}${profileId}`,
      description: `${profile.name} profile — ${profile.description}`,
      rules: profile.rules,
      scope,
      status: 'active',
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
      userId,
    };

    store.savePolicy(policy);
    created.push(policy);
  }

  _activeProfiles.set(userId, profileId);
  return { profile, policies: created };
}

/**
 * Deactivate a profile — removes profile-generated policies.
 * Reverts to supervised.
 */
export function deactivateProfile(userId: string): void {
  const store = getPolicyStore();
  const existing = store.listPolicies(userId);
  for (const p of existing) {
    if (p.name.startsWith(PROFILE_POLICY_PREFIX)) {
      store.deletePolicy(userId, p.id);
    }
  }
  _activeProfiles.set(userId, 'supervised');
}

/** Format a profile for display. */
export function formatProfileDisplay(profile: AutonomyProfile, isActive: boolean): string {
  const lines: string[] = [];
  const marker = isActive ? ' (active)' : '';
  lines.push(`**${profile.name}**${marker} — \`/profile ${profile.id}\``);
  for (const s of profile.summary) {
    lines.push(`  ${s}`);
  }
  return lines.join('\n');
}

/** Reset profile cache (for testing). */
export function resetProfileCache(): void {
  _activeProfiles.clear();
}
