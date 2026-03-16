/**
 * Policy Engine — Type Definitions
 *
 * Defines the type system for user-defined spending policies, approval rules,
 * and autonomy bounds. Policies are checked before every write-tool execution.
 *
 * Design principles:
 * - Natural language in, structured rules out. User never writes JSON.
 * - Multi-turn confirmation: agent proposes interpretation, user approves.
 *   Ambiguity → clarifying questions, never silent defaults.
 * - Full transparency: every policy shows the original NL description AND
 *   the exact structured rules being enforced. No hidden interpretation.
 * - Rules map cleanly to EIP-7710 caveats for future on-chain enforcement.
 * - Most restrictive rule wins: block > confirm > allow.
 */

// ─── Policy ─────────────────────────────────────────────────────────────

export type PolicyStatus = 'draft' | 'active' | 'disabled';

export interface Policy {
  id: string;
  name: string;
  description: string;          // original natural language, verbatim
  rules: PolicyRule[];
  scope: PolicyScope;
  status: PolicyStatus;
  /** Why it's a draft — what the agent still needs to clarify. */
  pendingClarifications?: string[];
  /** Timestamp when user explicitly confirmed the draft. Set by handleConfirm. */
  confirmedAt?: number;
  createdAt: number;
  updatedAt: number;
  userId: string;
  /**
   * On-chain delegation metadata (EIP-7710).
   * Present when the policy has been compiled and signed as an on-chain delegation.
   * Contains chain ID, delegation hash, addresses, and lifecycle status.
   */
  delegation?: DelegationInfo;
}

/**
 * On-chain delegation info stored with a policy.
 * Maps to DelegationMetadata in delegation-types.ts but uses plain types
 * here to avoid circular imports. The delegation service converts between them.
 */
export interface DelegationInfo {
  /** Chain ID where the delegation is deployed. */
  chainId: number;
  /** Keccak256 hash of the delegation struct. */
  hash: string;
  /** DelegationManager contract address on this chain. */
  delegationManager: string;
  /** Current lifecycle status. */
  status: 'unsigned' | 'signed' | 'active' | 'revoked' | 'expired';
  /** The delegate address (agent). */
  delegate: string;
  /** The delegator address (user). */
  delegator: string;
  /** Salt used for uniqueness. */
  salt: string;
  /** ISO timestamp when the delegation was created. */
  createdAt: string;
  /** ISO timestamp when the delegation expires. Null = no time-bound. */
  expiresAt?: string;
  /** ISO timestamp when last status check was performed. */
  lastCheckedAt?: string;
  /** Policy rules that couldn't map to on-chain caveats (app-layer only). */
  unmappedRules?: string[];
}

// ─── Scope ──────────────────────────────────────────────────────────────

export interface PolicyScope {
  type: 'all_write' | 'tools' | 'categories';
  tools?: string[];             // specific tool names
  categories?: string[];        // category keys from TOOL_CATEGORIES
}

// ─── Rules ──────────────────────────────────────────────────────────────

export type PolicyRule =
  | SpendingLimitRule
  | RateLimitRule
  | AllowlistRule
  | BlocklistRule
  | TimeWindowRule
  | ApprovalThresholdRule
  | MaxAmountRule
  | Erc20LimitRule;

/** Cumulative spending cap over a time period. */
export interface SpendingLimitRule {
  type: 'spending_limit';
  maxAmountUsd: number;
  period: 'hourly' | 'daily' | 'weekly' | 'monthly';
}

/** Maximum number of tool calls in a time window. */
export interface RateLimitRule {
  type: 'rate_limit';
  maxCalls: number;
  periodMs: number;
}

/** Only allow interactions with specific tokens/chains/addresses. */
export interface AllowlistRule {
  type: 'allowlist';
  field: 'tokens' | 'chains' | 'addresses' | 'contracts';
  values: string[];             // lowercase for comparison
}

/** Block interactions with specific tokens/chains/addresses. */
export interface BlocklistRule {
  type: 'blocklist';
  field: 'tokens' | 'chains' | 'addresses' | 'contracts';
  values: string[];             // lowercase for comparison
}

/** Restrict tool execution to certain hours / days. */
export interface TimeWindowRule {
  type: 'time_window';
  allowedHours?: { start: number; end: number };  // 0-23
  allowedDays?: number[];                          // 0=Sun, 6=Sat
  timezone?: string;                               // IANA, default UTC
}

/** Require human confirmation above a USD amount. */
export interface ApprovalThresholdRule {
  type: 'approval_threshold';
  amountUsd: number;
}

/** Cap cumulative ERC-20 transfer amount for a specific token. */
export interface Erc20LimitRule {
  type: 'erc20_limit';
  token: string;       // ERC-20 contract address (0x...)
  maxAmount: string;    // Human-readable amount (e.g., "100" for 100 USDC)
  decimals: number;     // Token decimals (6 for USDC, 18 for DAI)
}

/** Hard block on any single transaction above a USD amount. */
export interface MaxAmountRule {
  type: 'max_amount';
  maxAmountUsd: number;
}

// ─── Evaluation ─────────────────────────────────────────────────────────

export type PolicyAction = 'allow' | 'confirm' | 'block';

export interface PolicyDecision {
  action: PolicyAction;
  reason?: string;
  policyId?: string;
  policyName?: string;
  ruleSummary?: string;         // human-readable rule that triggered decision
}

/** Context about the action being evaluated. */
export interface ActionContext {
  toolName: string;
  action?: string;              // sub-action (e.g., 'send', 'swap', 'supply')
  amountUsd?: number;           // estimated USD value (undefined = unknown)
  token?: string;               // token symbol or address
  chain?: number;               // chain ID
  toAddress?: string;           // destination address
  userId: string;
}

// ─── Usage Tracking ─────────────────────────────────────────────────────

export interface UsageEntry {
  timestamp: number;
  toolName: string;
  action?: string;
  amountUsd?: number;
}

export interface PolicyUsage {
  policyId: string;
  entries: UsageEntry[];
}

// ─── Display ────────────────────────────────────────────────────────────

/**
 * Human-readable rendering of a policy for user verification.
 * Both the NL description and the structured interpretation are shown
 * so there is zero ambiguity about what's enforced.
 */
export interface PolicyDisplay {
  name: string;
  status: PolicyStatus;
  /** The user's original words. */
  description: string;
  /** Plain-English rendering of each structured rule. */
  ruleDescriptions: string[];
  /** Which tools are affected. */
  scopeDescription: string;
  /** Current period usage vs limits (for spending/rate limits). */
  usageSummary?: string;
}

// ─── Tool Categories ────────────────────────────────────────────────────

/**
 * Maps category names to the write tools they contain.
 * Every tool in WRITE_TOOL_NAMES should be in exactly one category.
 */
export const TOOL_CATEGORIES: Record<string, string[]> = {
  defi:          ['defi_swap', 'defi_lend', 'defi_stake', 'liquidity', 'yield',
                  'bridge', 'permit2', 'approvals', 'wayfinder', 'molten'],
  transfer:      ['transfer'],
  fiat:          ['fiat_payment'],
  bankr:         ['bankr_launch', 'bankr_automate', 'bankr_polymarket', 'bankr_leverage'],
  social:        ['clawnx', 'farcaster'],
  nft:           ['nft', 'airdrop'],
  governance:    ['governance', 'safe'],
  platform:      ['clawnch_launch', 'clawnch_fees', 'clawnch_info', 'hummingbot'],
  orchestration: ['manage_orders', 'compound_action', 'crypto_workflow'],
  privacy:       ['privacy'],
  browser:       ['browser'],
  wallet:        ['clawnchconnect'],
};

/** Human-readable category labels. */
export const CATEGORY_LABELS: Record<string, string> = {
  defi:          'DeFi (swap, lend, stake, bridge, LP, yield, approvals)',
  transfer:      'Transfers (send ETH/tokens)',
  fiat:          'Fiat (on-ramp, off-ramp)',
  bankr:         'Bankr (launch, automate, polymarket, leverage)',
  social:        'Social (X/Twitter, Farcaster)',
  nft:           'NFT & Airdrops',
  governance:    'Governance & Safe multisig',
  platform:      'Platform (launch, fees, hummingbot)',
  orchestration: 'Orchestration (orders, compound actions, workflows)',
  privacy:       'Privacy tools',
  browser:       'Web3 browser',
  wallet:        'Wallet connection',
};

/** Reverse lookup: tool name → category. */
export const TOOL_TO_CATEGORY: Record<string, string> = {};
for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
  for (const tool of tools) {
    TOOL_TO_CATEGORY[tool] = category;
  }
}

// ─── Period Helpers ─────────────────────────────────────────────────────

const PERIOD_MS: Record<string, number> = {
  hourly:  60 * 60 * 1000,
  daily:   24 * 60 * 60 * 1000,
  weekly:  7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** Convert a named period to milliseconds. Throws on unknown periods. */
export function periodToMs(period: string): number {
  const ms = PERIOD_MS[period];
  if (ms == null) {
    throw new Error(`Unknown period: "${period}". Valid: ${Object.keys(PERIOD_MS).join(', ')}.`);
  }
  return ms;
}

// ─── Rule Rendering ─────────────────────────────────────────────────────

/** Render a single rule as unambiguous plain English. */
export function describeRule(rule: PolicyRule): string {
  switch (rule.type) {
    case 'spending_limit':
      return `Spending limit: max $${rule.maxAmountUsd} USD per ${rule.period} period`;
    case 'rate_limit': {
      const hours = Math.round(rule.periodMs / 3_600_000);
      const label = hours >= 24 ? `${Math.round(hours / 24)} day(s)` : `${hours} hour(s)`;
      return `Rate limit: max ${rule.maxCalls} calls per ${label}`;
    }
    case 'allowlist':
      return `Allowlist (${rule.field}): only ${rule.values.join(', ')}`;
    case 'blocklist':
      return `Blocklist (${rule.field}): never ${rule.values.join(', ')}`;
    case 'time_window': {
      const parts: string[] = [];
      if (rule.allowedHours) parts.push(`hours ${rule.allowedHours.start}:00–${rule.allowedHours.end}:00`);
      if (rule.allowedDays) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        parts.push(rule.allowedDays.map(d => dayNames[d] ?? d).join(', '));
      }
      const tz = rule.timezone ?? 'UTC';
      return `Time window: allowed during ${parts.join(' on ')} (${tz})`;
    }
    case 'approval_threshold':
      return `Require confirmation: for any action above $${rule.amountUsd} USD`;
    case 'max_amount':
      return `Hard limit: block any single action above $${rule.maxAmountUsd} USD`;
    case 'erc20_limit':
      return `ERC-20 limit: max ${rule.maxAmount} tokens (${rule.decimals} decimals) for ${rule.token}`;
  }
}

/** Render a scope as plain English. */
export function describeScope(scope: PolicyScope): string {
  switch (scope.type) {
    case 'all_write':
      return 'All write operations (any tool that sends transactions or modifies state)';
    case 'tools':
      return `Specific tools: ${(scope.tools ?? []).join(', ')}`;
    case 'categories': {
      const labels = (scope.categories ?? []).map(c => CATEGORY_LABELS[c] ?? c);
      return `Categories: ${labels.join('; ')}`;
    }
  }
}

// ─── Policy Mode ────────────────────────────────────────────────────────
//
// Controls how policies are enforced:
//   - 'delegation' (default): policies compile to EIP-7710 on-chain delegations.
//     The agent redeems delegations for execution. Full on-chain enforcement.
//   - 'simple': policies are natural-language only, enforced at app layer.
//     No on-chain delegation, no signing, no smart account required.
//     This is the V6 behavior — lightweight and works with any wallet.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export type PolicyMode = 'delegation' | 'simple';

const POLICY_MODE_HOME = join(process.env.HOME ?? '/home/openclawnch', '.openclawnch');
const POLICY_MODE_FILE = join(POLICY_MODE_HOME, 'policy-mode.json');

/** Default mode — delegation is the default for new installs. */
const DEFAULT_MODE: PolicyMode = 'delegation';

/** In-memory cache. */
let _cachedMode: PolicyMode | null = null;

/** Get the current policy enforcement mode. */
export function getPolicyMode(): PolicyMode {
  if (_cachedMode) return _cachedMode;

  try {
    if (existsSync(POLICY_MODE_FILE)) {
      const data = JSON.parse(readFileSync(POLICY_MODE_FILE, 'utf8'));
      if (data.mode === 'delegation' || data.mode === 'simple') {
        _cachedMode = data.mode;
        return data.mode as PolicyMode;
      }
    }
  } catch { /* fall through to default */ }

  _cachedMode = DEFAULT_MODE;
  return _cachedMode;
}

/** Set the policy enforcement mode. Persists to disk. */
export function setPolicyMode(mode: PolicyMode): void {
  _cachedMode = mode;
  if (!existsSync(POLICY_MODE_HOME)) {
    mkdirSync(POLICY_MODE_HOME, { recursive: true });
  }
  const tmpPath = POLICY_MODE_FILE + '.tmp.' + Date.now();
  writeFileSync(tmpPath, JSON.stringify({ mode }, null, 2), { mode: 0o600 });
  renameSync(tmpPath, POLICY_MODE_FILE);
}

/** Check if delegation features are enabled (mode === 'delegation'). */
export function isDelegationMode(): boolean {
  return getPolicyMode() === 'delegation';
}

/** Reset cached mode (for testing). */
export function resetPolicyMode(): void {
  _cachedMode = null;
}
