/**
 * Delegation Compiler — Converts openclawnch policies to EIP-7710 delegations.
 *
 * Takes a Policy (with its PolicyRules) and produces an UnsignedDelegation
 * containing the corresponding on-chain caveat enforcers.
 *
 * Rules without a direct on-chain mapping (blocklist, approval_threshold)
 * are flagged as "app-layer only" — they're still enforced by the policy
 * engine but won't have on-chain caveats.
 *
 * Uses viem's encodeAbiParameters for terms encoding. No external SDK needed.
 */

import { encodeAbiParameters, encodePacked, type Address, type Hex } from 'viem';
import type { PolicyRule, Policy } from './policy-types.js';
import {
  DELEGATION_CONTRACTS,
  PERIOD_SECONDS,
  SUPPORTED_CHAIN_IDS,
  type Caveat,
  type CaveatMappingResult,
  type UnsignedDelegation,
} from './delegation-types.js';

// ─── Compilation Context ────────────────────────────────────────────────

/**
 * Optional context for price-aware compilation.
 * When provided, USD amounts are converted to real token amounts
 * using live prices. Without it, USD * 1e18 placeholder is used.
 */
export interface CompilationContext {
  /** ETH price in USD at compilation time. */
  ethPriceUsd?: number;
  /** ERC-20 token address → { priceUsd, decimals } for token-aware enforcers. */
  tokenPrices?: Map<string, { priceUsd: number; decimals: number }>;
}

// ─── Compilation Result ─────────────────────────────────────────────────

export interface CompilationResult {
  /** The unsigned delegation struct, ready for signing. */
  delegation: UnsignedDelegation;
  /** Rules that mapped to on-chain caveats. */
  mappedRules: Array<{ rule: PolicyRule; caveats: Caveat[] }>;
  /** Rules that have no on-chain enforcer and are app-layer only. */
  unmappedRules: Array<{ rule: PolicyRule; reason: string }>;
  /** Warnings about the compilation (e.g., approximate mappings). */
  warnings: string[];
}

export interface CompilationError {
  type: 'error';
  message: string;
}

// ─── Module-level compilation context ───────────────────────────────────
// Set before compilePolicyToDelegation via setCompilationContext().

let _compCtx: CompilationContext = {};

/** Set compilation context (prices) before compiling. */
export function setCompilationContext(ctx: CompilationContext): void {
  _compCtx = ctx;
}

/** Get current compilation context. */
export function getCompilationContext(): CompilationContext {
  return _compCtx;
}

// ─── USD → Token Conversion ─────────────────────────────────────────────

/**
 * Convert a USD amount to native token (ETH) wei.
 * Returns the placeholder (usd * 1e18) if no ETH price is available.
 */
function usdToNativeWei(usdAmount: number): { wei: bigint; converted: boolean; ethPrice?: number } {
  const ethPrice = _compCtx.ethPriceUsd;
  if (ethPrice && ethPrice > 0) {
    const ethAmount = usdAmount / ethPrice;
    // ETH has 18 decimals
    const wei = BigInt(Math.floor(ethAmount * 1e18));
    return { wei, converted: true, ethPrice };
  }
  // Fallback: store raw USD * 1e18 as a placeholder
  return { wei: BigInt(Math.floor(usdAmount * 1e18)), converted: false };
}

// ─── Policy → Caveats Compilation ───────────────────────────────────────

/**
 * Compile a single PolicyRule into zero or more on-chain caveats.
 */
export function compileRuleToCaveats(rule: PolicyRule): CaveatMappingResult {
  switch (rule.type) {
    case 'spending_limit':
      return compileSpendingLimit(rule);

    case 'max_amount':
      return compileMaxAmount(rule);

    case 'rate_limit':
      return compileRateLimit(rule);

    case 'allowlist':
      return compileAllowlist(rule);

    case 'time_window':
      return compileTimeWindow(rule);

    case 'erc20_limit':
      return compileErc20Limit(rule);

    case 'blocklist':
      return {
        type: 'app_layer_only',
        reason: 'Blocklist has no direct on-chain enforcer. The delegation framework uses allowlists (AllowedTargetsEnforcer). Blocklists are enforced at the app layer only.',
      };

    case 'approval_threshold':
      return {
        type: 'app_layer_only',
        reason: 'Approval threshold is an app-layer concept (human confirmation). On-chain, use max_amount to hard-block above a threshold instead.',
      };

    default:
      return {
        type: 'app_layer_only',
        reason: `Unknown rule type: ${(rule as any).type}`,
      };
  }
}

/**
 * spending_limit → NativeTokenPeriodTransferEnforcer.
 *
 * Converts USD to ETH wei using live price when available.
 * Falls back to USD * 1e18 placeholder when no price context is set.
 */
function compileSpendingLimit(rule: { type: 'spending_limit'; maxAmountUsd: number; period: string }): CaveatMappingResult {
  const periodSec = PERIOD_SECONDS[rule.period];
  if (!periodSec) {
    return { type: 'app_layer_only', reason: `Unknown period: ${rule.period}` };
  }

  const { wei: allowanceWei } = usdToNativeWei(rule.maxAmountUsd);
  const startTime = 0n;  // 0 = from first use
  const period = BigInt(periodSec);

  const terms = encodeAbiParameters(
    [
      { type: 'uint256', name: 'allowance' },
      { type: 'uint256', name: 'startTime' },
      { type: 'uint256', name: 'period' },
    ],
    [allowanceWei, startTime, period],
  );

  return {
    type: 'mapped',
    caveats: [{
      enforcer: DELEGATION_CONTRACTS.NativeTokenPeriodTransferEnforcer,
      terms,
      args: '0x' as Hex,
    }],
  };
}

/**
 * max_amount → ValueLteEnforcer + NativeTokenTransferAmountEnforcer.
 *
 * ValueLteEnforcer caps msg.value per call. NativeTokenTransferAmountEnforcer
 * caps cumulative native token transfers. Both use ETH wei.
 */
function compileMaxAmount(rule: { type: 'max_amount'; maxAmountUsd: number }): CaveatMappingResult {
  const { wei: maxValueWei } = usdToNativeWei(rule.maxAmountUsd);

  // ValueLteEnforcer: caps msg.value per call
  const valueLteTerms = encodeAbiParameters(
    [{ type: 'uint256', name: 'maxValue' }],
    [maxValueWei],
  );

  // NativeTokenTransferAmountEnforcer: caps cumulative ETH transfers
  const nativeCapTerms = encodeAbiParameters(
    [{ type: 'uint256', name: 'amount' }],
    [maxValueWei],
  );

  return {
    type: 'mapped',
    caveats: [
      {
        enforcer: DELEGATION_CONTRACTS.ValueLteEnforcer,
        terms: valueLteTerms,
        args: '0x' as Hex,
      },
      {
        enforcer: DELEGATION_CONTRACTS.NativeTokenTransferAmountEnforcer,
        terms: nativeCapTerms,
        args: '0x' as Hex,
      },
    ],
  };
}

/**
 * erc20_limit → ERC20TransferAmountEnforcer.
 *
 * Caps cumulative ERC-20 transfers for a specific token.
 * Terms: encodePacked(address token, uint256 maxAmount) — 52 bytes.
 * The enforcer tracks cumulative transfer(to, amount) calldata
 * and reverts when the total exceeds the cap.
 *
 * Example: "max 100 USDC" becomes:
 *   - ERC20TransferAmountEnforcer(USDC_address, 100_000_000)
 */
function compileErc20Limit(rule: { type: 'erc20_limit'; token: string; maxAmount: string; decimals: number }): CaveatMappingResult {
  if (!rule.token || !/^0x[0-9a-fA-F]{40}$/.test(rule.token)) {
    return { type: 'app_layer_only', reason: `Invalid token address: ${rule.token}` };
  }

  // Parse the human-readable amount to smallest unit
  const [whole = '0', frac = ''] = rule.maxAmount.split('.');
  const paddedFrac = (frac + '0'.repeat(rule.decimals)).slice(0, rule.decimals);
  const amountSmallest = BigInt(whole + paddedFrac);

  if (amountSmallest <= 0n) {
    return { type: 'app_layer_only', reason: 'ERC-20 limit amount must be positive.' };
  }

  // ERC20TransferAmountEnforcer uses encodePacked(address, uint256) — 52 bytes
  const terms = encodePacked(
    ['address', 'uint256'],
    [rule.token as Address, amountSmallest],
  );

  return {
    type: 'mapped',
    caveats: [
      {
        enforcer: DELEGATION_CONTRACTS.ERC20TransferAmountEnforcer,
        terms,
        args: '0x' as Hex,
      },
    ],
  };
}

/**
 * rate_limit → LimitedCallsEnforcer + TimestampEnforcer.
 *
 * LimitedCallsEnforcer is a lifetime cap — it never resets. To approximate
 * a windowed rate limit, we pair it with a TimestampEnforcer that expires
 * the delegation at the end of the current window. The user must create
 * a new delegation for the next window.
 *
 * Example: "max 10 calls per day" becomes:
 *   - LimitedCallsEnforcer(10)
 *   - TimestampEnforcer(now, now + 86400)
 */
function compileRateLimit(rule: { type: 'rate_limit'; maxCalls: number; periodMs: number }): CaveatMappingResult {
  const callsTerms = encodeAbiParameters(
    [{ type: 'uint256', name: 'count' }],
    [BigInt(rule.maxCalls)],
  );

  const caveats: Caveat[] = [{
    enforcer: DELEGATION_CONTRACTS.LimitedCallsEnforcer,
    terms: callsTerms,
    args: '0x' as Hex,
  }];

  // Add TimestampEnforcer to bound the window
  if (rule.periodMs > 0) {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const periodSec = BigInt(Math.floor(rule.periodMs / 1000));
    const expiry = nowSec + periodSec;

    const timestampTerms = encodeAbiParameters(
      [
        { type: 'uint128', name: 'executeAfter' },
        { type: 'uint128', name: 'executeBefore' },
      ],
      [nowSec, expiry],
    );

    caveats.push({
      enforcer: DELEGATION_CONTRACTS.TimestampEnforcer,
      terms: timestampTerms,
      args: '0x' as Hex,
    });
  }

  return { type: 'mapped', caveats };
}

/**
 * allowlist (addresses/contracts) → AllowedTargetsEnforcer.
 * allowlist (tokens) → ERC20TransferAmountEnforcer per token (if addresses known).
 * allowlist (chains) → App-layer only (delegation is per-chain).
 */
function compileAllowlist(rule: { type: 'allowlist'; field: string; values: string[] }): CaveatMappingResult {
  if (rule.field === 'addresses' || rule.field === 'contracts') {
    const addresses = rule.values
      .filter(v => /^0x[0-9a-fA-F]{40}$/.test(v))
      .map(v => v as Address);

    if (addresses.length === 0) {
      return { type: 'app_layer_only', reason: 'No valid addresses in allowlist.' };
    }

    const terms = encodeAbiParameters(
      [{ type: 'address[]', name: 'targets' }],
      [addresses],
    );

    return {
      type: 'mapped',
      caveats: [{
        enforcer: DELEGATION_CONTRACTS.AllowedTargetsEnforcer,
        terms,
        args: '0x' as Hex,
      }],
    };
  }

  if (rule.field === 'tokens') {
    // Token allowlist: if any values are 0x addresses, use AllowedTargetsEnforcer
    // to restrict which token contracts can be called
    const tokenAddresses = rule.values
      .filter(v => /^0x[0-9a-fA-F]{40}$/.test(v))
      .map(v => v as Address);

    if (tokenAddresses.length > 0) {
      const terms = encodeAbiParameters(
        [{ type: 'address[]', name: 'targets' }],
        [tokenAddresses],
      );
      return {
        type: 'mapped',
        caveats: [{
          enforcer: DELEGATION_CONTRACTS.AllowedTargetsEnforcer,
          terms,
          args: '0x' as Hex,
        }],
      };
    }

    return {
      type: 'app_layer_only',
      reason: 'Token allowlist with symbols only (no contract addresses) cannot be enforced on-chain. Use token contract addresses for on-chain enforcement.',
    };
  }

  if (rule.field === 'chains') {
    return {
      type: 'app_layer_only',
      reason: 'Chain restrictions are inherent to delegation scope (each delegation is per-chain). No enforcer needed.',
    };
  }

  return { type: 'app_layer_only', reason: `Unknown allowlist field: ${rule.field}` };
}

/**
 * time_window → TimestampEnforcer.
 *
 * TimestampEnforcer uses (uint128 executeAfter, uint128 executeBefore).
 * Recurring windows (weekdays, hours) are enforced at app layer only.
 */
function compileTimeWindow(rule: {
  type: 'time_window';
  allowedHours?: { start: number; end: number };
  allowedDays?: number[];
  timezone?: string;
}): CaveatMappingResult {
  if (rule.allowedDays && rule.allowedDays.length > 0) {
    return {
      type: 'app_layer_only',
      reason: 'Recurring day-of-week restrictions have no on-chain equivalent. TimestampEnforcer only supports absolute time ranges. Enforced at app layer.',
    };
  }

  if (rule.allowedHours) {
    return {
      type: 'app_layer_only',
      reason: 'Recurring hour-of-day restrictions have no on-chain equivalent. TimestampEnforcer only supports absolute time ranges. Enforced at app layer.',
    };
  }

  return { type: 'app_layer_only', reason: 'No time constraints to enforce on-chain.' };
}

// ─── Full Policy → Delegation Compilation ───────────────────────────────

/**
 * Compile a full Policy into an UnsignedDelegation.
 *
 * @param policy - The policy to compile
 * @param delegator - The user's wallet address (who grants the delegation)
 * @param delegate - The agent's wallet address (who receives the delegation)
 * @param chainId - Target chain ID
 * @returns CompilationResult with the delegation and mapping details, or error
 */
export function compilePolicyToDelegation(
  policy: Policy,
  delegator: Address,
  delegate: Address,
  chainId: number,
): CompilationResult | CompilationError {
  // Validate chain
  if (!SUPPORTED_CHAIN_IDS.has(chainId)) {
    return {
      type: 'error',
      message: `Chain ${chainId} is not supported by the MetaMask Delegation Framework. Supported: ${[...SUPPORTED_CHAIN_IDS].join(', ')}`,
    };
  }

  // Validate policy has rules
  if (!policy.rules || policy.rules.length === 0) {
    return {
      type: 'error',
      message: `Policy "${policy.name}" has no rules to compile.`,
    };
  }

  // Validate policy is confirmed
  if (!policy.confirmedAt) {
    return {
      type: 'error',
      message: `Policy "${policy.name}" has never been confirmed. Confirm the policy before creating a delegation.`,
    };
  }

  const allCaveats: Caveat[] = [];
  const mappedRules: CompilationResult['mappedRules'] = [];
  const unmappedRules: CompilationResult['unmappedRules'] = [];
  const warnings: string[] = [];

  for (const rule of policy.rules) {
    const result = compileRuleToCaveats(rule);
    if (result.type === 'mapped') {
      allCaveats.push(...result.caveats);
      mappedRules.push({ rule, caveats: result.caveats });
    } else {
      unmappedRules.push({ rule, reason: result.reason });
    }
  }

  // Warn if no caveats were mapped — delegation would be unrestricted
  if (allCaveats.length === 0) {
    warnings.push(
      'No policy rules mapped to on-chain caveats. All rules are app-layer only. ' +
      'The delegation would have NO on-chain restrictions. This is likely not what you want.',
    );
  }

  // Warn about USD → token conversion
  const hasSpendingRules = policy.rules.some(r =>
    r.type === 'spending_limit' || r.type === 'max_amount',
  );
  if (hasSpendingRules) {
    const ctx = getCompilationContext();
    if (ctx.ethPriceUsd) {
      warnings.push(
        `Spending limits converted at ETH = $${ctx.ethPriceUsd.toFixed(2)}. ` +
        'On-chain enforcers use token amounts, not USD. Re-compile if price drifts significantly.',
      );
    } else {
      warnings.push(
        'No ETH price available at compile time. Amounts use placeholder encoding (USD * 1e18). ' +
        'Re-compile with a connected network to get accurate token amounts.',
      );
    }
  }

  // Warn about rate limit expiry
  const hasRateLimit = policy.rules.some(r => r.type === 'rate_limit');
  if (hasRateLimit) {
    warnings.push(
      'Rate limits use LimitedCallsEnforcer (lifetime cap) + TimestampEnforcer (expiry). ' +
      'The delegation expires at the end of the rate limit window. Create a new delegation for the next window.',
    );
  }

  // Generate a unique salt from the policy ID + timestamp
  const saltBytes = Buffer.from(`${policy.id}-${Date.now()}`);
  const salt = BigInt('0x' + saltBytes.subarray(0, 32).toString('hex').padEnd(64, '0'));

  const delegation: UnsignedDelegation = {
    delegate,
    delegator,
    authority: ('0x' + 'f'.repeat(64)) as Hex, // ROOT_AUTHORITY — sentinel for top-level delegations
    caveats: allCaveats,
    salt,
  };

  return {
    delegation,
    mappedRules,
    unmappedRules,
    warnings,
  };
}

/**
 * Generate a human-readable compilation summary for user review.
 */
export function formatCompilationSummary(result: CompilationResult, chainId: number): string {
  const lines: string[] = [];

  lines.push('**Delegation Compilation Summary**');
  lines.push('');
  lines.push(`Chain: ${chainId}`);
  lines.push(`Delegate: \`${result.delegation.delegate}\``);
  lines.push(`Delegator: \`${result.delegation.delegator}\``);
  lines.push(`Caveats: ${result.delegation.caveats.length}`);
  lines.push('');

  if (result.mappedRules.length > 0) {
    lines.push('**On-chain enforced rules:**');
    for (const { rule, caveats } of result.mappedRules) {
      const enforcerNames = caveats.map(c => {
        const entry = Object.entries(DELEGATION_CONTRACTS).find(([, addr]) => addr === c.enforcer);
        return entry ? entry[0] : c.enforcer;
      });
      lines.push(`  - ${rule.type} -> ${enforcerNames.join(', ')}`);
    }
    lines.push('');
  }

  if (result.unmappedRules.length > 0) {
    lines.push('**App-layer only rules** (not enforced on-chain):');
    for (const { rule, reason } of result.unmappedRules) {
      lines.push(`  - ${rule.type}: ${reason}`);
    }
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push('**Warnings:**');
    for (const w of result.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines.join('\n');
}
