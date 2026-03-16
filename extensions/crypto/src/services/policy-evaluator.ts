/**
 * Policy Evaluator — Runtime enforcement of user-defined policies.
 *
 * Checks an ActionContext against all active policies for a user.
 * Returns the most restrictive decision: block > confirm > allow.
 *
 * Also handles:
 * - Usage recording after successful tool execution
 * - Extracting ActionContext from tool args (best-effort)
 * - Rendering policy displays for user verification
 */

import { randomUUID } from 'node:crypto';
import { getPolicyStore } from './policy-store.js';
import {
  type ActionContext,
  type Policy,
  type PolicyAction,
  type PolicyDecision,
  type PolicyDisplay,
  type PolicyRule,
  type PolicyScope,
  type UsageEntry,
  TOOL_CATEGORIES,
  TOOL_TO_CATEGORY,
  periodToMs,
  describeRule,
  describeScope,
} from './policy-types.js';

// ─── Evaluation ─────────────────────────────────────────────────────────

/** Priority: block > confirm > allow. */
const ACTION_PRIORITY: Record<PolicyAction, number> = {
  block: 3,
  confirm: 2,
  allow: 1,
};

/**
 * Evaluate all active policies for a user against a proposed action.
 * Returns the most restrictive decision across all matching policies.
 */
export function evaluatePolicies(ctx: ActionContext): PolicyDecision {
  const store = getPolicyStore();

  // Fail-closed: if the policy store is corrupted, block everything
  if (store.isCorrupted(ctx.userId)) {
    return {
      action: 'block',
      reason: 'Policy store is corrupted — all write operations are blocked for safety. Check ~/.openclawnch/policies/ for .corrupt files and restore or delete them.',
    };
  }

  const policies = store.getActivePolicies(ctx.userId);

  if (policies.length === 0) {
    return { action: 'allow' };
  }

  let worst: PolicyDecision = { action: 'allow' };

  for (const policy of policies) {
    if (!policyApplies(policy, ctx.toolName)) continue;

    for (const rule of policy.rules) {
      const decision = evaluateRule(rule, ctx, policy);
      if (ACTION_PRIORITY[decision.action] > ACTION_PRIORITY[worst.action]) {
        worst = decision;
      }
      // Short-circuit: can't get worse than block
      if (worst.action === 'block') return worst;
    }
  }

  return worst;
}

/** Check if a policy's scope covers a given tool. */
function policyApplies(policy: Policy, toolName: string): boolean {
  const { scope } = policy;
  switch (scope.type) {
    case 'all_write':
      return true;
    case 'tools':
      return (scope.tools ?? []).includes(toolName);
    case 'categories': {
      const toolCategory = TOOL_TO_CATEGORY[toolName];
      if (!toolCategory) return false;
      return (scope.categories ?? []).includes(toolCategory);
    }
  }
}

/** Evaluate a single rule against an action context. */
function evaluateRule(
  rule: PolicyRule,
  ctx: ActionContext,
  policy: Policy,
): PolicyDecision {
  const base = { policyId: policy.id, policyName: policy.name };

  switch (rule.type) {
    case 'spending_limit': {
      if (ctx.amountUsd == null) {
        // Unknown amount — require confirmation rather than guessing
        return {
          ...base,
          action: 'confirm',
          reason: `Policy "${policy.name}" has a spending limit but the USD value of this action is unknown. Confirm to proceed.`,
          ruleSummary: describeRule(rule),
        };
      }
      const windowMs = periodToMs(rule.period);
      const store = getPolicyStore();
      const spent = store.getSpendInWindow(ctx.userId, policy.id, windowMs);
      const remaining = rule.maxAmountUsd - spent;
      if (ctx.amountUsd > remaining) {
        return {
          ...base,
          action: 'block',
          reason: `Policy "${policy.name}": spending limit $${rule.maxAmountUsd}/${rule.period}. Already spent $${spent.toFixed(2)}, remaining $${remaining.toFixed(2)}. This action ($${ctx.amountUsd.toFixed(2)}) would exceed the limit.`,
          ruleSummary: describeRule(rule),
        };
      }
      return { action: 'allow' };
    }

    case 'rate_limit': {
      const store = getPolicyStore();
      const calls = store.getCallsInWindow(ctx.userId, policy.id, rule.periodMs);
      if (calls >= rule.maxCalls) {
        return {
          ...base,
          action: 'block',
          reason: `Policy "${policy.name}": rate limit ${rule.maxCalls} calls reached. Wait for the window to reset.`,
          ruleSummary: describeRule(rule),
        };
      }
      return { action: 'allow' };
    }

    case 'allowlist': {
      const value = getFieldValue(rule.field, ctx);
      if (value == null) {
        return {
          ...base,
          action: 'confirm',
          reason: `Policy "${policy.name}": cannot determine ${rule.field} for allowlist check. Confirm to proceed.`,
          ruleSummary: describeRule(rule),
        };
      }
      const allowed = rule.values.map(v => v.toLowerCase());
      if (!allowed.includes(value.toLowerCase())) {
        return {
          ...base,
          action: 'block',
          reason: `Policy "${policy.name}": ${rule.field} "${value}" is not in the allowlist [${rule.values.join(', ')}].`,
          ruleSummary: describeRule(rule),
        };
      }
      return { action: 'allow' };
    }

    case 'blocklist': {
      const value = getFieldValue(rule.field, ctx);
      if (value == null) {
        return {
          ...base,
          action: 'confirm',
          reason: `Policy "${policy.name}": cannot determine ${rule.field} for blocklist check. Confirm to proceed.`,
          ruleSummary: describeRule(rule),
        };
      }
      const blocked = rule.values.map(v => v.toLowerCase());
      if (blocked.includes(value.toLowerCase())) {
        return {
          ...base,
          action: 'block',
          reason: `Policy "${policy.name}": ${rule.field} "${value}" is blocked [${rule.values.join(', ')}].`,
          ruleSummary: describeRule(rule),
        };
      }
      return { action: 'allow' };
    }

    case 'time_window': {
      const tz = rule.timezone ?? 'UTC';
      const now = new Date();
      let hour: number;
      let day: number;
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hour: 'numeric',
          hour12: false,
          weekday: 'short',
        }).formatToParts(now);
        hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
        const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Mon';
        const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        day = dayMap[weekday] ?? 1;
      } catch {
        // Bad timezone — allow to avoid blocking on config error
        return { action: 'allow' };
      }

      if (rule.allowedHours) {
        const { start, end } = rule.allowedHours;
        const inWindow = start <= end
          ? (hour >= start && hour < end)
          : (hour >= start || hour < end); // wraps midnight
        if (!inWindow) {
          return {
            ...base,
            action: 'block',
            reason: `Policy "${policy.name}": outside allowed hours (${start}:00–${end}:00 ${tz}). Current hour: ${hour}:00.`,
            ruleSummary: describeRule(rule),
          };
        }
      }

      if (rule.allowedDays && rule.allowedDays.length > 0) {
        if (!rule.allowedDays.includes(day)) {
          const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          return {
            ...base,
            action: 'block',
            reason: `Policy "${policy.name}": not an allowed day. Today: ${dayNames[day]}. Allowed: ${rule.allowedDays.map(d => dayNames[d]).join(', ')}.`,
            ruleSummary: describeRule(rule),
          };
        }
      }

      return { action: 'allow' };
    }

    case 'approval_threshold': {
      if (ctx.amountUsd == null) {
        return {
          ...base,
          action: 'confirm',
          reason: `Policy "${policy.name}" requires confirmation above $${rule.amountUsd}, but USD value is unknown. Confirm to proceed.`,
          ruleSummary: describeRule(rule),
        };
      }
      if (ctx.amountUsd > rule.amountUsd) {
        return {
          ...base,
          action: 'confirm',
          reason: `Policy "${policy.name}": this action ($${ctx.amountUsd.toFixed(2)}) exceeds the $${rule.amountUsd} confirmation threshold.`,
          ruleSummary: describeRule(rule),
        };
      }
      return { action: 'allow' };
    }

    case 'max_amount': {
      if (ctx.amountUsd == null) {
        return {
          ...base,
          action: 'confirm',
          reason: `Policy "${policy.name}" blocks actions above $${rule.maxAmountUsd}, but USD value is unknown. Confirm to proceed.`,
          ruleSummary: describeRule(rule),
        };
      }
      if (ctx.amountUsd > rule.maxAmountUsd) {
        return {
          ...base,
          action: 'block',
          reason: `Policy "${policy.name}": this action ($${ctx.amountUsd.toFixed(2)}) exceeds the hard limit of $${rule.maxAmountUsd}.`,
          ruleSummary: describeRule(rule),
        };
      }
      return { action: 'allow' };
    }

    case 'erc20_limit': {
      // ERC-20 limits are enforced on-chain by ERC20TransferAmountEnforcer.
      // At the app layer, allow the action — the caveat enforcer handles the cap.
      return { action: 'allow' };
    }
  }
}

/** Extract a field value from ActionContext for allowlist/blocklist checks. */
function getFieldValue(
  field: 'tokens' | 'chains' | 'addresses' | 'contracts',
  ctx: ActionContext,
): string | undefined {
  switch (field) {
    case 'tokens':    return ctx.token;
    case 'chains':    return ctx.chain?.toString();
    case 'addresses': return ctx.toAddress;
    case 'contracts': return ctx.toAddress; // contract = address for now
  }
}

// ─── Usage Recording ────────────────────────────────────────────────────

/**
 * Record a tool execution against all matching active policies.
 * Called AFTER successful execution (not on block/confirm).
 */
export function recordToolExecution(ctx: ActionContext): void {
  const store = getPolicyStore();
  const policies = store.getActivePolicies(ctx.userId);

  const entry: UsageEntry = {
    timestamp: Date.now(),
    toolName: ctx.toolName,
    action: ctx.action,
    amountUsd: ctx.amountUsd,
  };

  for (const policy of policies) {
    if (!policyApplies(policy, ctx.toolName)) continue;
    store.recordUsage(ctx.userId, policy.id, entry);
  }
}

// ─── User ID Extraction ─────────────────────────────────────────────────

/**
 * Shared helper to extract userId from tool execution context.
 * Used by both the enforcement gate (index.ts) and the policy_manage tool.
 * Ensures consistent fallback chain everywhere.
 */
export function extractPolicyUserId(ctx?: any): string {
  return ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'owner';
}

// ─── Context Extraction ─────────────────────────────────────────────────

/**
 * Best-effort extraction of ActionContext from tool args.
 * Different tools encode amounts, tokens, addresses differently.
 * Returns what we can determine; undefined fields are left out.
 */
export function extractActionContext(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
): ActionContext {
  const ctx: ActionContext = { toolName, userId };

  // Sub-action
  if (typeof args.action === 'string') ctx.action = args.action;

  // Token
  if (typeof args.token === 'string') ctx.token = args.token;
  else if (typeof args.tokenIn === 'string') ctx.token = args.tokenIn;
  else if (typeof args.asset === 'string') ctx.token = args.asset;

  // Destination address
  if (typeof args.to === 'string') ctx.toAddress = args.to;
  else if (typeof args.recipient === 'string') ctx.toAddress = args.recipient;
  else if (typeof args.address === 'string') ctx.toAddress = args.address;

  // Chain
  if (typeof args.chain === 'number') ctx.chain = args.chain;
  else if (typeof args.chainId === 'number') ctx.chain = args.chainId;
  else if (typeof args.toChain === 'number') ctx.chain = args.toChain;

  // Amount — we store raw, caller can convert to USD if price is available
  // For fiat_payment the amount is already in fiat units
  if (typeof args.amount === 'string') {
    const num = parseFloat(args.amount);
    if (!isNaN(num)) {
      // fiat_payment amounts are already USD
      if (toolName === 'fiat_payment') {
        ctx.amountUsd = num;
      }
      // Other tools: amount is in token units, would need price lookup
      // We leave amountUsd undefined — evaluator handles unknown amounts
    }
  }
  if (typeof args.amountUsd === 'number') ctx.amountUsd = args.amountUsd;

  return ctx;
}

// ─── Policy Display ─────────────────────────────────────────────────────

/**
 * Build a full display object for user verification.
 * Shows both the original NL and the exact structured interpretation.
 */
export function buildPolicyDisplay(policy: Policy, userId: string): PolicyDisplay {
  const store = getPolicyStore();
  const ruleDescriptions = policy.rules.map(describeRule);
  const scopeDescription = describeScope(policy.scope);

  // Build usage summary for spending/rate limits
  const usageParts: string[] = [];
  for (const rule of policy.rules) {
    if (rule.type === 'spending_limit') {
      const windowMs = periodToMs(rule.period);
      const spent = store.getSpendInWindow(userId, policy.id, windowMs);
      usageParts.push(`Spent $${spent.toFixed(2)} of $${rule.maxAmountUsd} (${rule.period})`);
    }
    if (rule.type === 'rate_limit') {
      const calls = store.getCallsInWindow(userId, policy.id, rule.periodMs);
      usageParts.push(`${calls} of ${rule.maxCalls} calls used`);
    }
  }

  return {
    name: policy.name,
    status: policy.status,
    description: policy.description,
    ruleDescriptions,
    scopeDescription,
    usageSummary: usageParts.length > 0 ? usageParts.join('; ') : undefined,
  };
}

/**
 * Render a PolicyDisplay as a formatted text block for chat output.
 * Both the user's original words and the structured interpretation
 * are shown so there's no room for misunderstanding.
 */
export function renderPolicyDisplay(display: PolicyDisplay): string {
  const lines: string[] = [];
  const statusEmoji = display.status === 'active' ? '[ACTIVE]'
    : display.status === 'draft' ? '[DRAFT]'
    : '[DISABLED]';

  lines.push(`**${display.name}** ${statusEmoji}`);
  lines.push('');
  lines.push(`You said: "${display.description}"`);
  lines.push('');
  lines.push('**What is enforced:**');
  for (const rd of display.ruleDescriptions) {
    lines.push(`  - ${rd}`);
  }
  lines.push(`  - Applies to: ${display.scopeDescription}`);
  if (display.usageSummary) {
    lines.push('');
    lines.push(`**Current usage:** ${display.usageSummary}`);
  }

  return lines.join('\n');
}

// ─── Confirmation Nonce System ──────────────────────────────────────────
//
// When a policy returns "confirm", a nonce is generated and included in the
// response. The LLM must pass this nonce back as `policyConfirmationNonce` in
// the tool args to prove the user actually confirmed. Nonces expire after TTL.

/** Default TTL for confirmation nonces: 5 minutes. */
const NONCE_TTL_MS = 5 * 60 * 1000;

/** Max nonces stored (prevent unbounded growth). Old entries are evicted. */
const MAX_NONCES = 500;

interface NonceEntry {
  nonce: string;
  userId: string;
  toolName: string;
  createdAt: number;
}

class PolicyConfirmationStore {
  private nonces = new Map<string, NonceEntry>();

  /** Generate a nonce for a confirm decision. */
  create(userId: string, toolName: string): string {
    this.prune();
    const nonce = randomUUID();
    this.nonces.set(nonce, { nonce, userId, toolName, createdAt: Date.now() });
    return nonce;
  }

  /** Validate and consume a nonce. Returns true if valid. */
  consume(nonce: string, userId: string, toolName: string): boolean {
    const entry = this.nonces.get(nonce);
    if (!entry) return false;
    this.nonces.delete(nonce);
    // Check expiry
    if (Date.now() - entry.createdAt > NONCE_TTL_MS) return false;
    // Check user + tool match
    if (entry.userId !== userId) return false;
    if (entry.toolName !== toolName) return false;
    return true;
  }

  /** Prune expired entries and enforce max size. */
  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.nonces) {
      if (now - entry.createdAt > NONCE_TTL_MS) {
        this.nonces.delete(key);
      }
    }
    // Evict oldest if over limit
    if (this.nonces.size > MAX_NONCES) {
      const sorted = [...this.nonces.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toRemove = sorted.slice(0, sorted.length - MAX_NONCES);
      for (const [key] of toRemove) this.nonces.delete(key);
    }
  }

  /** Clear all nonces (for testing). */
  reset(): void {
    this.nonces.clear();
  }
}

let _confirmStore: PolicyConfirmationStore | null = null;

export function getPolicyConfirmationStore(): PolicyConfirmationStore {
  if (!_confirmStore) _confirmStore = new PolicyConfirmationStore();
  return _confirmStore;
}

export function resetPolicyConfirmationStore(): void {
  _confirmStore?.reset();
  _confirmStore = null;
}

/** Expand category names into tool lists for scope rendering. */
export function expandScope(scope: PolicyScope): string[] {
  switch (scope.type) {
    case 'all_write': {
      const all: string[] = [];
      for (const tools of Object.values(TOOL_CATEGORIES)) all.push(...tools);
      return all;
    }
    case 'tools':
      return scope.tools ?? [];
    case 'categories': {
      const result: string[] = [];
      for (const cat of scope.categories ?? []) {
        result.push(...(TOOL_CATEGORIES[cat] ?? []));
      }
      return result;
    }
    default:
      return [];
  }
}
