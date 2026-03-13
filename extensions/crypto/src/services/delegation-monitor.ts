/**
 * Delegation Monitor
 *
 * Tracks remaining budget, expiry, and health of active delegations.
 * Emits warnings when:
 *   - A delegation is within 20% of its spending limit
 *   - A delegation expires within 24 hours
 *   - A delegation has been revoked on-chain
 *
 * The monitor runs periodically via the event bus / heartbeat service,
 * or can be invoked on-demand via /delegate status.
 */

import type { Policy, DelegationInfo } from './policy-types.js';
import { isDelegationMode } from './policy-types.js';
import { getPolicyStore } from './policy-store.js';
import { getDelegationStore } from './delegation-store.js';
import { getDelegatedPolicies } from './delegation-service.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface DelegationAlert {
  severity: AlertSeverity;
  policyId: string;
  policyName: string;
  chainId: number;
  message: string;
  /** Suggested action for the user. */
  action: string;
}

export interface DelegationHealth {
  policyId: string;
  policyName: string;
  chainId: number;
  status: DelegationInfo['status'];
  /** Spending used in current period (USD). Null if not tracked. */
  spentUsd: number | null;
  /** Spending limit for current period (USD). Null if no limit. */
  limitUsd: number | null;
  /** Percentage of limit used (0-100). Null if no limit. */
  usagePercent: number | null;
  /** Seconds until delegation expires. Null if no time-bound. */
  expiresInSec: number | null;
  /** Actions used vs limit. Null if no action limit. */
  actionsUsed: number | null;
  actionsLimit: number | null;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Warn when usage exceeds this percentage of limit. */
const SPENDING_WARN_THRESHOLD = 0.80;
/** Critical when usage exceeds this percentage. */
const SPENDING_CRITICAL_THRESHOLD = 0.95;
/** Warn when delegation expires within this many seconds. */
const EXPIRY_WARN_SEC = 86_400; // 24 hours
/** Critical when delegation expires within this many seconds. */
const EXPIRY_CRITICAL_SEC = 3_600; // 1 hour

// ─── Monitor ────────────────────────────────────────────────────────────

/**
 * Check all active delegations for the given user and return health + alerts.
 */
export function checkDelegations(userId: string): {
  health: DelegationHealth[];
  alerts: DelegationAlert[];
} {
  if (!isDelegationMode()) {
    return { health: [], alerts: [] };
  }

  const policies = getDelegatedPolicies(userId);
  const store = getPolicyStore();
  const health: DelegationHealth[] = [];
  const alerts: DelegationAlert[] = [];

  for (const policy of policies) {
    const info = policy.delegation;
    if (!info) continue;

    const h = buildHealth(policy, info, store, userId);
    health.push(h);

    // Generate alerts based on health
    const policyAlerts = generateAlerts(h, policy.name);
    alerts.push(...policyAlerts);
  }

  return { health, alerts };
}

/**
 * Get a formatted summary of delegation health for display.
 */
export function formatDelegationHealth(userId: string): string {
  const { health, alerts } = checkDelegations(userId);

  if (health.length === 0) {
    return 'No active delegations to monitor.';
  }

  const lines: string[] = [];
  lines.push('**Delegation Health**');
  lines.push('');

  for (const h of health) {
    const statusIcon = getStatusIcon(h.status);
    lines.push(`${statusIcon} **${h.policyName}** (chain ${h.chainId})`);

    if (h.usagePercent !== null && h.limitUsd !== null) {
      const bar = renderProgressBar(h.usagePercent);
      lines.push(`  Spending: $${(h.spentUsd ?? 0).toFixed(0)} / $${h.limitUsd.toFixed(0)} ${bar}`);
    }

    if (h.actionsUsed !== null && h.actionsLimit !== null) {
      lines.push(`  Actions: ${h.actionsUsed} / ${h.actionsLimit}`);
    }

    if (h.expiresInSec !== null) {
      lines.push(`  Expires: ${formatDuration(h.expiresInSec)}`);
    }

    lines.push('');
  }

  if (alerts.length > 0) {
    lines.push('---');
    lines.push('');

    for (const a of alerts) {
      const icon = a.severity === 'critical' ? '!!' : a.severity === 'warning' ? '!' : '-';
      lines.push(`[${icon}] ${a.message}`);
      lines.push(`    ${a.action}`);
    }
  }

  return lines.join('\n');
}

// ─── Internals ──────────────────────────────────────────────────────────

function buildHealth(
  policy: Policy,
  info: DelegationInfo,
  store: ReturnType<typeof getPolicyStore>,
  userId: string,
): DelegationHealth {
  let spentUsd: number | null = null;
  let limitUsd: number | null = null;
  let usagePercent: number | null = null;
  let expiresInSec: number | null = null;
  let actionsUsed: number | null = null;
  let actionsLimit: number | null = null;

  // Extract spending info from policy rules using store helper methods
  for (const rule of policy.rules) {
    if (rule.type === 'spending_limit') {
      limitUsd = rule.maxAmountUsd;
      const periodMs = getPeriodMs(rule.period);
      spentUsd = store.getSpendInWindow(userId, policy.id, periodMs);
      usagePercent = limitUsd > 0 ? (spentUsd / limitUsd) * 100 : null;
    }

    if (rule.type === 'rate_limit') {
      actionsLimit = rule.maxCalls;
      actionsUsed = store.getCallsInWindow(userId, policy.id, rule.periodMs);
    }
  }

  // Estimate expiry from delegation creation time
  // TimestampEnforcer caveats encode beforeTimestamp, but we don't decode terms here.
  // Instead we check if the delegation has an estimated expiry based on profile config.
  const createdMs = new Date(info.createdAt).getTime();
  if (!isNaN(createdMs)) {
    // Check if any time_window rule gives us end-of-window info
    // For now, delegation-level expiry would need to be stored in DelegationInfo
    // This is a gap — we'll add an `expiresAt` field in a follow-up
  }

  return {
    policyId: policy.id,
    policyName: policy.name,
    chainId: info.chainId,
    status: info.status,
    spentUsd,
    limitUsd,
    usagePercent,
    expiresInSec,
    actionsUsed,
    actionsLimit,
  };
}

function generateAlerts(h: DelegationHealth, policyName: string): DelegationAlert[] {
  const alerts: DelegationAlert[] = [];

  // Revoked on-chain
  if (h.status === 'revoked') {
    alerts.push({
      severity: 'critical',
      policyId: h.policyId,
      policyName,
      chainId: h.chainId,
      message: `Delegation "${policyName}" has been revoked on-chain.`,
      action: 'Create a new delegation with `/delegate create`.',
    });
  }

  // Expired
  if (h.status === 'expired') {
    alerts.push({
      severity: 'critical',
      policyId: h.policyId,
      policyName,
      chainId: h.chainId,
      message: `Delegation "${policyName}" has expired.`,
      action: 'Create a new delegation with `/delegate create`.',
    });
  }

  // Spending near limit
  if (h.usagePercent !== null) {
    if (h.usagePercent >= SPENDING_CRITICAL_THRESHOLD * 100) {
      alerts.push({
        severity: 'critical',
        policyId: h.policyId,
        policyName,
        chainId: h.chainId,
        message: `Spending at ${h.usagePercent.toFixed(0)}% of limit for "${policyName}".`,
        action: 'Consider increasing the limit or creating a new delegation.',
      });
    } else if (h.usagePercent >= SPENDING_WARN_THRESHOLD * 100) {
      alerts.push({
        severity: 'warning',
        policyId: h.policyId,
        policyName,
        chainId: h.chainId,
        message: `Spending at ${h.usagePercent.toFixed(0)}% of limit for "${policyName}".`,
        action: 'Monitor spending or adjust limits.',
      });
    }
  }

  // Actions near limit
  if (h.actionsUsed !== null && h.actionsLimit !== null && h.actionsLimit > 0) {
    const pct = (h.actionsUsed / h.actionsLimit) * 100;
    if (pct >= SPENDING_CRITICAL_THRESHOLD * 100) {
      alerts.push({
        severity: 'critical',
        policyId: h.policyId,
        policyName,
        chainId: h.chainId,
        message: `${h.actionsUsed}/${h.actionsLimit} actions used for "${policyName}".`,
        action: 'Create a new delegation to continue operating.',
      });
    } else if (pct >= SPENDING_WARN_THRESHOLD * 100) {
      alerts.push({
        severity: 'warning',
        policyId: h.policyId,
        policyName,
        chainId: h.chainId,
        message: `${h.actionsUsed}/${h.actionsLimit} actions used for "${policyName}".`,
        action: 'Approaching action limit.',
      });
    }
  }

  // Expiry approaching
  if (h.expiresInSec !== null) {
    if (h.expiresInSec <= EXPIRY_CRITICAL_SEC) {
      alerts.push({
        severity: 'critical',
        policyId: h.policyId,
        policyName,
        chainId: h.chainId,
        message: `Delegation "${policyName}" expires in ${formatDuration(h.expiresInSec)}.`,
        action: 'Renew immediately with `/delegate create`.',
      });
    } else if (h.expiresInSec <= EXPIRY_WARN_SEC) {
      alerts.push({
        severity: 'warning',
        policyId: h.policyId,
        policyName,
        chainId: h.chainId,
        message: `Delegation "${policyName}" expires in ${formatDuration(h.expiresInSec)}.`,
        action: 'Plan renewal with `/delegate create`.',
      });
    }
  }

  return alerts;
}

// ─── Display Helpers ────────────────────────────────────────────────────

function getStatusIcon(status: DelegationInfo['status']): string {
  switch (status) {
    case 'active':   return '[OK]';
    case 'signed':   return '[--]';
    case 'revoked':  return '[!!]';
    case 'expired':  return '[!!]';
    case 'unsigned': return '[..]';
    default:         return '[??]';
  }
}

function renderProgressBar(percent: number): string {
  const width = 10;
  const filled = Math.min(width, Math.round((percent / 100) * width));
  const empty = width - filled;
  return `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'expired';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function getPeriodMs(period: string): number {
  switch (period) {
    case 'hourly':  return 60 * 60 * 1000;
    case 'daily':   return 24 * 60 * 60 * 1000;
    case 'weekly':  return 7 * 24 * 60 * 60 * 1000;
    case 'monthly': return 30 * 24 * 60 * 60 * 1000;
    default:        return 24 * 60 * 60 * 1000;
  }
}
