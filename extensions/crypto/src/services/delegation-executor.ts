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
 * Each entry maps a tool name to an async function that extracts the
 * ExecutionAction (target, value, callData) from the tool's args.
 *
 * Supported:
 * - transfer: native ETH sends and ERC-20 transfers
 * - clawnchconnect: raw transaction sends (send_tx action)
 *
 * Not yet supported (calldata constructed by external SDK):
 * - defi_swap: ClawnchSwapper.swap() handles tx internally, no extractable calldata
 * - bridge: similar — aggregator constructs calldata server-side
 *
 * For unsupported tools, the delegation's on-chain caveats still enforce
 * limits when the wallet IS the delegator's smart account — the tool
 * submits the tx through the wallet, and the wallet's caveats are checked.
 */

interface ActionExtractor {
  (args: Record<string, unknown>): Promise<ExecutionAction | null>;
}

// ─── Well-Known Token Decimals ──────────────────────────────────────────
// Avoids async on-chain calls for common tokens. Unknown tokens fall back
// to 18 decimals (standard ERC-20 default).

const WELL_KNOWN_DECIMALS: Record<string, number> = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6,  // USDC (Base)
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 6,  // USDT (Base)
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 18, // DAI (Base)
  '0x4200000000000000000000000000000000000006': 18,   // WETH (Base)
  '0xa1f72459dfa10bad200ac160ecd78c6b77a747be': 18,  // CLAWNCH (Base)
};

function getTokenDecimals(address: string): number {
  return WELL_KNOWN_DECIMALS[address.toLowerCase()] ?? 18;
}

/**
 * Encode ERC-20 transfer(address,uint256) calldata.
 * Selector: 0xa9059cbb
 */
function encodeErc20Transfer(to: Address, amount: bigint): Hex {
  const selector = '0xa9059cbb';
  const toParam = to.slice(2).toLowerCase().padStart(64, '0');
  const amountParam = amount.toString(16).padStart(64, '0');
  return `${selector}${toParam}${amountParam}` as Hex;
}

/**
 * Encode ERC-20 approve(address,uint256) calldata.
 * Selector: 0x095ea7b3
 */
function encodeErc20Approve(spender: Address, amount: bigint): Hex {
  const selector = '0x095ea7b3';
  const spenderParam = spender.slice(2).toLowerCase().padStart(64, '0');
  const amountParam = amount.toString(16).padStart(64, '0');
  return `${selector}${spenderParam}${amountParam}` as Hex;
}

/**
 * Parse a human-readable token amount to wei/smallest unit.
 * e.g., "100" with 6 decimals → 100_000_000n
 */
function parseTokenAmount(amount: string, decimals: number): bigint {
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) return 0n;
  // Use string math to avoid floating point precision loss
  const [whole = '0', frac = ''] = amount.split('.');
  const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole + paddedFrac);
}

const SUPPORTED_EXTRACTORS: Record<string, ActionExtractor> = {
  /**
   * transfer tool — native ETH sends and ERC-20 transfers.
   * Args: { action: 'send', to: address, amount: string, token?: string }
   * token is a contract address (0x...) for ERC-20, absent/ETH for native.
   */
  transfer: async (args) => {
    const action = args.action as string | undefined;
    if (action !== 'send') return null;

    const to = args.to as string | undefined;
    const amount = args.amount as string | undefined;
    const token = args.token as string | undefined;

    if (!to || !amount) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return null;

    const isErc20 = token && /^0x[0-9a-fA-F]{40}$/.test(token);
    const isNative = !token || token.toUpperCase() === 'ETH' || token.toUpperCase() === 'NATIVE';

    if (isErc20) {
      // ERC-20 transfer: target = token contract, calldata = transfer(to, amount)
      try {
        const decimals = getTokenDecimals(token);
        const amountWei = parseTokenAmount(amount, decimals);
        if (amountWei <= 0n) return null;

        return {
          target: token as Address,
          value: 0n,
          callData: encodeErc20Transfer(to as Address, amountWei),
        };
      } catch {
        return null;
      }
    }

    if (isNative) {
      // Native ETH transfer: target = recipient, value = amount in wei
      try {
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
    }

    return null;
  },

  /**
   * clawnchconnect tool — raw transaction sends.
   * Args: { action: 'send_tx', to: address, value?: string (ETH), data?: hex }
   */
  clawnchconnect: async (args) => {
    const action = args.action as string | undefined;
    if (action !== 'send_tx') return null;

    const to = args.to as string | undefined;
    if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) return null;

    const valueStr = args.value as string | undefined;
    const data = args.data as string | undefined;

    try {
      let value = 0n;
      if (valueStr) {
        const ethAmount = parseFloat(valueStr);
        if (!isNaN(ethAmount) && ethAmount > 0) {
          value = BigInt(Math.floor(ethAmount * 1e18));
        }
      }

      const callData = (data && data.startsWith('0x') ? data : '0x') as Hex;

      return {
        target: to as Address,
        value,
        callData,
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
  const executionAction = await extractor(toolArgs);
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
 * Quick sync check — verifies the tool has an extractor and a matching
 * delegation exists. Does NOT verify the extractor can parse the specific
 * args (that's async and happens in tryDelegationExecution).
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
