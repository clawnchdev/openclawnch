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

import { createPublicClient, http, type Address, type Hex } from 'viem';
import { base, mainnet, arbitrum, optimism, polygon, sepolia, linea, baseSepolia } from 'viem/chains';
import type { Policy, DelegationInfo } from './policy-types.js';
import { isDelegationMode } from './policy-types.js';
import { getPolicyStore } from './policy-store.js';
import { getDelegationStore } from './delegation-store.js';
import { getDelegatedPolicies } from './delegation-service.js';
import {
  DELEGATION_CONTRACTS,
  NATIVE_PERIOD_ENFORCER_ABI,
  ERC20_PERIOD_ENFORCER_ABI,
  LIMITED_CALLS_ENFORCER_ABI,
} from './delegation-types.js';

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
  /** On-chain state reads (populated by checkOnChainState). */
  onChain?: OnChainUsage;
}

export interface OnChainUsage {
  /** Native token (ETH) spent on-chain in wei. Null if no period enforcer. */
  nativeSpentWei: bigint | null;
  /** ERC-20 spent on-chain in smallest unit. Null if no period enforcer. */
  erc20Spent: bigint | null;
  /** Call count from on-chain LimitedCallsEnforcer. Null if no enforcer. */
  callCount: bigint | null;
  /** Whether on-chain data diverges from local tracking. */
  driftDetected: boolean;
  /** Human-readable drift description if any. */
  driftDetails?: string;
  /** Timestamp of the on-chain query (epoch ms). */
  queriedAt: number;
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

  // Check delegation expiry from the expiresAt field
  if (info.expiresAt) {
    const expiryMs = new Date(info.expiresAt).getTime();
    if (!isNaN(expiryMs)) {
      const remainingMs = expiryMs - Date.now();
      expiresInSec = Math.max(0, Math.floor(remainingMs / 1000));
    }
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

// ─── On-Chain State Reading ─────────────────────────────────────────────

const CHAIN_CONFIGS: Record<number, any> = {
  1: mainnet, 8453: base, 42161: arbitrum, 10: optimism,
  137: polygon, 59144: linea, 11155111: sepolia, 84532: baseSepolia,
};

const _clientCache = new Map<number, any>();

function getMonitorClient(chainId: number): any {
  let client = _clientCache.get(chainId);
  if (client) return client;
  const chain = CHAIN_CONFIGS[chainId];
  if (!chain) return null;
  client = createPublicClient({ chain, transport: http() });
  _clientCache.set(chainId, client);
  return client;
}

/**
 * Read on-chain enforcer state for a delegation.
 *
 * Queries the enforcer contracts that track cumulative usage:
 * - NativeTokenPeriodTransferEnforcer.spentMap → ETH spent
 * - ERC20PeriodTransferEnforcer.spentMap → ERC-20 spent
 * - LimitedCallsEnforcer.callCounts → call count
 *
 * Compares on-chain state with local tracking and flags drift.
 * All reads are best-effort: RPC errors are caught silently.
 */
export async function readOnChainUsage(
  policyId: string,
  delegationHash: Hex,
  chainId: number,
  localHealth: DelegationHealth,
): Promise<OnChainUsage> {
  const client = getMonitorClient(chainId);
  const result: OnChainUsage = {
    nativeSpentWei: null,
    erc20Spent: null,
    callCount: null,
    driftDetected: false,
    queriedAt: Date.now(),
  };

  if (!client || !delegationHash || delegationHash === '0x') {
    return result;
  }

  const dmAddr = DELEGATION_CONTRACTS.DelegationManager;

  // Read NativeTokenPeriodTransferEnforcer
  try {
    const [spent] = await client.readContract({
      address: DELEGATION_CONTRACTS.NativeTokenPeriodTransferEnforcer,
      abi: NATIVE_PERIOD_ENFORCER_ABI,
      functionName: 'spentMap',
      args: [dmAddr, delegationHash],
    }) as [bigint, bigint];
    result.nativeSpentWei = spent;
  } catch {
    // Enforcer not used or RPC error — skip
  }

  // Read ERC20PeriodTransferEnforcer
  try {
    const [spent] = await client.readContract({
      address: DELEGATION_CONTRACTS.ERC20PeriodTransferEnforcer,
      abi: ERC20_PERIOD_ENFORCER_ABI,
      functionName: 'spentMap',
      args: [dmAddr, delegationHash],
    }) as [bigint, bigint];
    result.erc20Spent = spent;
  } catch {
    // Enforcer not used or RPC error — skip
  }

  // Read LimitedCallsEnforcer
  try {
    const count = await client.readContract({
      address: DELEGATION_CONTRACTS.LimitedCallsEnforcer,
      abi: LIMITED_CALLS_ENFORCER_ABI,
      functionName: 'callCounts',
      args: [dmAddr, delegationHash],
    }) as bigint;
    result.callCount = count;
  } catch {
    // Enforcer not used or RPC error — skip
  }

  // Detect drift between on-chain and local tracking
  result.driftDetected = false;
  const driftNotes: string[] = [];

  if (result.callCount !== null && localHealth.actionsUsed !== null) {
    const onChainCalls = Number(result.callCount);
    if (onChainCalls !== localHealth.actionsUsed) {
      driftNotes.push(`calls: local=${localHealth.actionsUsed}, on-chain=${onChainCalls}`);
    }
  }

  // For spending, we can only compare if we have ETH price to convert wei→USD.
  // Flag drift if on-chain shows usage but local shows zero, or vice versa.
  if (result.nativeSpentWei !== null && result.nativeSpentWei > 0n) {
    if (localHealth.spentUsd === null || localHealth.spentUsd === 0) {
      driftNotes.push('on-chain shows ETH spending but local tracking is empty');
    }
  }

  if (driftNotes.length > 0) {
    result.driftDetected = true;
    result.driftDetails = driftNotes.join('; ');
  }

  return result;
}

/**
 * Enhanced health check that includes on-chain state reads.
 * Slower than checkDelegations (makes RPC calls) — use for /delegate status detail.
 */
export async function checkDelegationsWithOnChain(userId: string): Promise<{
  health: DelegationHealth[];
  alerts: DelegationAlert[];
}> {
  const base = checkDelegations(userId);
  if (base.health.length === 0) return base;

  const delegationStore = getDelegationStore();

  // Enrich each health entry with on-chain data
  const enriched = await Promise.all(
    base.health.map(async (h) => {
      const stored = delegationStore.load(h.policyId);
      if (!stored) return h;

      const policies = getDelegatedPolicies(userId);
      const policy = policies.find(p => p.id === h.policyId);
      const hash = policy?.delegation?.hash;
      if (!hash || hash === '0x') return h;

      try {
        const onChain = await readOnChainUsage(
          h.policyId,
          hash as Hex,
          h.chainId,
          h,
        );
        h.onChain = onChain;

        // Add drift alerts
        if (onChain.driftDetected && onChain.driftDetails) {
          base.alerts.push({
            severity: 'warning',
            policyId: h.policyId,
            policyName: h.policyName,
            chainId: h.chainId,
            message: `Usage drift detected for "${h.policyName}": ${onChain.driftDetails}`,
            action: 'Local tracking may be stale. On-chain enforcers have the authoritative state.',
          });
        }
      } catch {
        // On-chain read failed — keep local-only health
      }

      return h;
    }),
  );

  return { health: enriched, alerts: base.alerts };
}

/**
 * Format on-chain usage for display (appended to health output).
 */
export function formatOnChainUsage(onChain: OnChainUsage): string {
  const lines: string[] = [];

  if (onChain.nativeSpentWei !== null) {
    const ethSpent = Number(onChain.nativeSpentWei) / 1e18;
    lines.push(`  On-chain ETH spent: ${ethSpent.toFixed(6)} ETH`);
  }

  if (onChain.erc20Spent !== null && onChain.erc20Spent > 0n) {
    lines.push(`  On-chain ERC-20 spent: ${onChain.erc20Spent.toString()} (raw units)`);
  }

  if (onChain.callCount !== null) {
    lines.push(`  On-chain call count: ${onChain.callCount.toString()}`);
  }

  if (onChain.driftDetected) {
    lines.push(`  [!] Drift: ${onChain.driftDetails}`);
  }

  return lines.join('\n');
}
