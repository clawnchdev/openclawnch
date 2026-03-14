/**
 * Delegation Executor — Bridges the policy gate to on-chain delegation redemption.
 *
 * This is the "last mile" that connects the delegation infrastructure to the
 * actual tool execution path. When a write tool is about to execute:
 *
 *   1. Policy gate evaluates rules → allow/confirm/block
 *   2. If allowed AND delegation mode is active AND a matching delegation exists:
 *      → Route through redeemDelegation() (on-chain enforcement)
 *   3. If delegation redemption fails or no delegation exists:
 *      → Fall back to normal tool execution (ClawnchConnect approval)
 *
 * The executor does NOT replace the tool's execution — it intercepts the
 * transaction at the point where the tool would call wallet.sendTransaction().
 * For tools where we can extract the target/value/calldata, we redeem directly.
 * For tools where we can't, we fall through to normal execution.
 *
 * Design constraints:
 * - Must be non-breaking: if anything fails, fall back silently
 * - Must not modify tool signatures or return types
 * - Must work with all 3 wallet modes (private_key, walletconnect, bankr)
 * - Must record usage on successful redemption
 */

import type { ActionContext } from './policy-types.js';
import { isDelegationMode } from './policy-types.js';
import { getPolicyStore } from './policy-store.js';
import { canRedeem, redeemDelegation, getDelegatedPolicies } from './delegation-service.js';
import type { ExecutionAction } from './delegation-types.js';
import type { Address, Hex } from 'viem';

// ─── Types ──────────────────────────────────────────────────────────────

export interface DelegationExecutionResult {
  /** Whether the action was executed via delegation. */
  executed: boolean;
  /** Transaction hash from on-chain redemption. */
  txHash?: string;
  /** Chain ID where the redemption happened. */
  chainId?: number;
  /** Why delegation execution was skipped (for debugging). */
  skipReason?: string;
  /** Error message if delegation execution was attempted but failed. */
  error?: string;
}

// ─── Tool-to-Action Extraction ──────────────────────────────────────────

/**
 * Tools that support delegation execution.
 *
 * Each entry maps a tool name to a function that extracts the ExecutionAction
 * (target, value, callData) from the tool's args. Only tools where we can
 * reliably construct the on-chain call are included.
 *
 * For transfer: we know the target (recipient), value (amount), and calldata (0x for native ETH).
 * For ERC-20 transfer: target is the token contract, calldata is transfer(to, amount).
 * For swap/bridge/etc: the calldata is constructed by the aggregator response and
 * would need the tool to expose it — we skip these for now and let them execute
 * normally via the wallet. The on-chain caveats still enforce limits when the
 * wallet IS the delegator's smart account.
 *
 * This is intentionally conservative: only extract what we can verify.
 */

interface ActionExtractor {
  (args: Record<string, unknown>): ExecutionAction | null;
}

const SUPPORTED_EXTRACTORS: Record<string, ActionExtractor> = {
  /**
   * transfer tool — native ETH sends.
   * Args: { action: 'send', to: address, amount: string, token?: 'ETH' }
   */
  transfer: (args) => {
    const action = args.action as string | undefined;
    if (action !== 'send') return null;

    const to = args.to as string | undefined;
    const amount = args.amount as string | undefined;
    const token = (args.token as string | undefined)?.toUpperCase();

    // Only handle native ETH transfers for now
    // ERC-20 transfers need token contract address + transfer() encoding
    if (token && token !== 'ETH' && token !== 'NATIVE') return null;
    if (!to || !amount) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return null;

    try {
      // Parse amount as ETH and convert to wei
      const ethAmount = parseFloat(amount);
      if (isNaN(ethAmount) || ethAmount <= 0) return null;
      const weiValue = BigInt(Math.floor(ethAmount * 1e18));

      return {
        target: to as Address,
        value: weiValue,
        callData: '0x' as Hex,
      };
    } catch {
      return null;
    }
  },
};

// ─── Core Executor ──────────────────────────────────────────────────────

/**
 * Attempt to execute a tool action via delegation redemption.
 *
 * Called from the policy gate AFTER policies have been evaluated as 'allow'.
 * Returns { executed: true } if the action was successfully redeemed on-chain,
 * or { executed: false, skipReason } if delegation was not applicable.
 *
 * The caller should fall back to normal tool execution when executed === false.
 */
export async function tryDelegationExecution(
  actionCtx: ActionContext,
  toolArgs: Record<string, unknown>,
): Promise<DelegationExecutionResult> {
  // Gate 1: delegation mode must be active
  if (!isDelegationMode()) {
    return { executed: false, skipReason: 'Not in delegation mode.' };
  }

  // Gate 2: tool must have a supported action extractor
  const extractor = SUPPORTED_EXTRACTORS[actionCtx.toolName];
  if (!extractor) {
    return { executed: false, skipReason: `Tool "${actionCtx.toolName}" does not support delegation execution yet.` };
  }

  // Gate 3: extract the on-chain action from tool args
  const executionAction = extractor(toolArgs);
  if (!executionAction) {
    return { executed: false, skipReason: 'Could not extract execution action from tool args.' };
  }

  // Gate 4: find a matching delegation
  const matchResult = findMatchingDelegation(actionCtx);
  if (!matchResult) {
    return { executed: false, skipReason: 'No matching delegation found for this action.' };
  }

  // Gate 5: delegation must be redeemable
  const readiness = canRedeem(matchResult.policyId);
  if (!readiness.ready) {
    return { executed: false, skipReason: readiness.reason ?? 'Delegation not ready.' };
  }

  // Check expiry
  if (matchResult.expiresAt) {
    const expiryMs = new Date(matchResult.expiresAt).getTime();
    if (!isNaN(expiryMs) && Date.now() > expiryMs) {
      return { executed: false, skipReason: 'Delegation has expired. Create a new one with /delegate create.' };
    }
  }

  // All gates passed — attempt redemption
  try {
    const result = await redeemDelegation(matchResult.policyId, executionAction);

    if ('error' in result) {
      // Redemption failed — caller should fall back to normal execution
      return { executed: false, error: result.error };
    }

    return {
      executed: true,
      txHash: result.txHash,
      chainId: result.chainId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { executed: false, error: `Delegation execution error: ${msg}` };
  }
}

// ─── Delegation Matching ────────────────────────────────────────────────

interface DelegationMatch {
  policyId: string;
  policyName: string;
  chainId: number;
  expiresAt?: string;
}

/**
 * Find a delegation that covers the given action.
 *
 * Matching logic:
 * 1. Get all delegated policies for the user
 * 2. Filter to active/signed status (not revoked/expired)
 * 3. Check if the policy's scope covers the tool
 * 4. Return the first match (most recently updated)
 *
 * Future: rank by remaining budget, prefer policies with more headroom.
 */
function findMatchingDelegation(ctx: ActionContext): DelegationMatch | null {
  const policies = getDelegatedPolicies(ctx.userId);

  for (const policy of policies) {
    const info = policy.delegation;
    if (!info) continue;

    // Must be signed or active (not revoked/expired/unsigned)
    if (info.status !== 'signed' && info.status !== 'active') continue;

    // Check scope — does this policy cover the tool?
    if (!policyScopeCovers(policy, ctx.toolName)) continue;

    return {
      policyId: policy.id,
      policyName: policy.name,
      chainId: info.chainId,
      expiresAt: info.expiresAt,
    };
  }

  return null;
}

/**
 * Check if a policy's scope covers a specific tool.
 * Mirrors policyApplies() in policy-evaluator.ts.
 */
function policyScopeCovers(policy: { scope: { type: string; tools?: string[]; categories?: string[] } }, toolName: string): boolean {
  const { scope } = policy;
  if (scope.type === 'all_write') return true;
  if (scope.type === 'tools') return (scope.tools ?? []).includes(toolName);
  if (scope.type === 'categories') {
    // Inline category lookup to avoid circular import
    const TOOL_CATEGORIES: Record<string, string[]> = {
      defi: ['defi_swap', 'defi_lend', 'defi_stake', 'liquidity', 'yield', 'bridge', 'permit2', 'approvals', 'wayfinder', 'molten'],
      transfer: ['transfer'],
      fiat: ['fiat_payment'],
      bankr: ['bankr_launch', 'bankr_automate', 'bankr_polymarket', 'bankr_leverage'],
      social: ['clawnx', 'farcaster'],
      nft: ['nft', 'airdrop'],
      governance: ['governance', 'safe'],
      platform: ['clawnch_launch', 'clawnch_fees', 'clawnch_info', 'hummingbot'],
      orchestration: ['manage_orders', 'compound_action', 'crypto_workflow'],
      privacy: ['privacy'],
      browser: ['browser'],
      wallet: ['clawnchconnect'],
    };
    let toolCategory: string | undefined;
    for (const [cat, tools] of Object.entries(TOOL_CATEGORIES)) {
      if (tools.includes(toolName)) { toolCategory = cat; break; }
    }
    if (!toolCategory) return false;
    return (scope.categories ?? []).includes(toolCategory);
  }
  return false;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Check if delegation execution is available for a tool.
 * Quick check without actually attempting execution.
 */
export function isDelegationExecutionAvailable(toolName: string, userId: string): boolean {
  if (!isDelegationMode()) return false;
  if (!SUPPORTED_EXTRACTORS[toolName]) return false;

  const policies = getDelegatedPolicies(userId);
  return policies.some(p => {
    const info = p.delegation;
    if (!info) return false;
    if (info.status !== 'signed' && info.status !== 'active') return false;
    return policyScopeCovers(p, toolName);
  });
}

/**
 * Get the list of tools that support delegation execution.
 */
export function getDelegationSupportedTools(): string[] {
  return Object.keys(SUPPORTED_EXTRACTORS);
}
