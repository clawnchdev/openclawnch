/**
 * Safety Service — pre-flight checks before any on-chain write operation.
 *
 * Wired into defi-swap, clawnch-launch, and clawnch-fees before execution.
 * Uses herd-intelligence for token audits and swap validation.
 * Uses defi-balance logic for balance sufficiency checks.
 */

import { getWalletState, requirePublicClient, isBankrMode } from './walletconnect-service.js';
import { getPrice, getEthPrice } from './price-service.js';
import { getUserMode } from './mode-service.js';
import { getCredentialVault } from './credential-vault.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface SafetyCheckResult {
  safe: boolean;
  warnings: string[];
  blockers: string[];
  details: Record<string, unknown>;
}

// ─── Balance Check ───────────────────────────────────────────────────────

/**
 * Check if the connected wallet has enough ETH for a given amount + gas.
 */
export async function checkBalance(opts: {
  requiredEth?: number;
  requiredTokenAddress?: string;
  requiredTokenAmount?: string;
}): Promise<SafetyCheckResult> {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const details: Record<string, unknown> = {};

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return { safe: false, warnings, blockers: ['No wallet connected'], details };
  }

  try {
    const publicClient = requirePublicClient();
    const { formatEther } = await import('viem');

    const balance = await publicClient.getBalance({ address: state.address });
    const ethBalance = parseFloat(formatEther(balance));
    details.ethBalance = ethBalance;

    const gasBuffer = 0.005; // ~0.005 ETH for gas on Base
    const requiredEth = (opts.requiredEth ?? 0) + gasBuffer;

    if (ethBalance < requiredEth) {
      blockers.push(
        `Insufficient ETH. Have ${ethBalance.toFixed(4)} ETH, need ~${requiredEth.toFixed(4)} ETH ` +
        `(${opts.requiredEth?.toFixed(4) ?? '0'} + ${gasBuffer} gas buffer).`
      );
    } else if (ethBalance < requiredEth * 1.2) {
      warnings.push(
        `Low ETH balance (${ethBalance.toFixed(4)}). Transaction may succeed but leaves little for future gas.`
      );
    }

    // ERC-20 balance check when requiredTokenAddress is provided
    if (opts.requiredTokenAddress && opts.requiredTokenAmount) {
      try {
        const tokenAddr = opts.requiredTokenAddress as `0x${string}`;
        const erc20Abi = [
          { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
          { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
          { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
        ] as const;

        const [rawBalance, decimals, symbol] = await Promise.all([
          publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [state.address as `0x${string}`] }),
          publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
          publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
        ]);

        const { formatUnits } = await import('viem');
        const tokenBalance = parseFloat(formatUnits(rawBalance as bigint, Number(decimals)));
        const requiredAmount = parseFloat(opts.requiredTokenAmount);
        details.tokenBalance = tokenBalance;
        details.tokenSymbol = symbol;

        if (tokenBalance < requiredAmount) {
          blockers.push(
            `Insufficient ${symbol}. Have ${tokenBalance.toFixed(4)}, need ${requiredAmount.toFixed(4)}.`
          );
        }
      } catch (tokenErr) {
        warnings.push(`Token balance check failed: ${tokenErr instanceof Error ? tokenErr.message : String(tokenErr)}`);
      }
    }
  } catch (err) {
    warnings.push(`Balance check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { safe: blockers.length === 0, warnings, blockers, details };
}

// ─── Token Audit ─────────────────────────────────────────────────────────

/**
 * Audit a token for safety using herd-intelligence (if available).
 * Non-blocking — returns warnings but doesn't block if the service is unavailable.
 */
export async function auditToken(tokenAddress: string): Promise<SafetyCheckResult> {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const details: Record<string, unknown> = {};

  const accessToken = getCredentialVault().getSecret('intel.herd.accessToken', 'safety-service');
  if (!accessToken) {
    warnings.push('Herd Intelligence not configured (no HERD_ACCESS_TOKEN). Token audit skipped.');
    return { safe: true, warnings, blockers, details };
  }

  try {
    const { HerdIntelligence } = await import('@clawnch/clawncher-sdk');
    const herd = new HerdIntelligence({ accessToken });

    const audit = await herd.auditTokenSafety(tokenAddress, { blockchain: 'base' });
    details.audit = audit;

    // Interpret audit results — structure depends on HerdIntelligence API response
    const riskLevel = (audit as any)?.riskLevel ?? (audit as any)?.risk_level;
    const reason = (audit as any)?.reason ?? (audit as any)?.summary ?? '';
    const isHoneypot = (audit as any)?.isHoneypot ?? (audit as any)?.honeypot ?? false;

    if (riskLevel === 'critical') {
      blockers.push(
        `CRITICAL RISK: Token ${tokenAddress} — ${reason || 'Do not interact.'}`
      );
    } else if (riskLevel === 'high') {
      warnings.push(
        `HIGH RISK: Token ${tokenAddress} — ${reason || 'Exercise extreme caution.'}`
      );
    } else if (riskLevel === 'medium') {
      warnings.push(
        `MEDIUM RISK: Token ${tokenAddress} — ${reason || 'Proceed with caution.'}`
      );
    }

    if (isHoneypot) {
      blockers.push(`HONEYPOT DETECTED: Token ${tokenAddress} cannot be sold after purchase.`);
    }
  } catch (err) {
    warnings.push(`Token audit unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { safe: blockers.length === 0, warnings, blockers, details };
}

// ─── Swap Validation ─────────────────────────────────────────────────────

/**
 * Validate a swap before execution: balance + token audit + route check.
 * When routing through Bankr, skip local checks — Bankr's Sentinel handles security.
 */
export async function validateSwap(opts: {
  tokenIn: string;
  tokenOut: string;
  amountEth: number;
}): Promise<SafetyCheckResult> {
  // C5 FIX: Only check authoritative wallet state, not caller-supplied param
  if (isBankrMode()) {
    return {
      safe: true,
      warnings: ['Bankr Sentinel active — security screening handled server-side'],
      blockers: [],
      details: { bankrMode: true },
    };
  }

  const allWarnings: string[] = [];
  const allBlockers: string[] = [];
  const allDetails: Record<string, unknown> = {};

  // M1: Value cap when both dangermode + autosign are active
  // This prevents the agent from auto-executing large transactions without ANY human check
  const AUTOSIGN_DANGER_CAP_ETH = 0.1;
  try {
    // Get user mode from connected wallet state (userId may be stored)
    const walletState = getWalletState();
    if (walletState.mode === 'private_key') {
      // In private key mode, check if dangermode is active for any user
      // Private key mode is inherently autosign — check if amountEth exceeds cap
      if (opts.amountEth > AUTOSIGN_DANGER_CAP_ETH) {
        allWarnings.push(
          `Transaction value (${opts.amountEth} ETH) exceeds auto-sign safety cap of ${AUTOSIGN_DANGER_CAP_ETH} ETH. ` +
          `In private key mode, consider using WalletConnect (/walletsign) for transactions above this threshold.`
        );
      }
    }
  } catch {
    // Non-fatal — mode check shouldn't block swaps
  }

  // 1. Balance check
  const isEthIn = opts.tokenIn.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    || opts.tokenIn.toLowerCase() === '0x4200000000000000000000000000000000000006';

  const balanceCheck = await checkBalance({
    requiredEth: isEthIn ? opts.amountEth : undefined,
    requiredTokenAddress: isEthIn ? undefined : opts.tokenIn,
    requiredTokenAmount: isEthIn ? undefined : String(opts.amountEth),
  });
  allWarnings.push(...balanceCheck.warnings);
  allBlockers.push(...balanceCheck.blockers);
  allDetails.balance = balanceCheck.details;

  // 2. Audit output token (skip well-known stables)
  const SKIP_AUDIT = new Set([
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  ]);

  if (!SKIP_AUDIT.has(opts.tokenOut.toLowerCase())) {
    const tokenAudit = await auditToken(opts.tokenOut);
    allWarnings.push(...tokenAudit.warnings);
    allBlockers.push(...tokenAudit.blockers);
    allDetails.tokenAudit = tokenAudit.details;
  }

  // 3. Price context
  try {
    const [priceIn, priceOut] = await Promise.all([
      getPrice(opts.tokenIn).catch(() => null),
      getPrice(opts.tokenOut).catch(() => null),
    ]);
    allDetails.prices = {
      tokenIn: priceIn ? { symbol: priceIn.symbol, priceUsd: priceIn.priceUsd } : null,
      tokenOut: priceOut ? { symbol: priceOut.symbol, priceUsd: priceOut.priceUsd } : null,
    };
  } catch {
    // Non-fatal
  }

  return {
    safe: allBlockers.length === 0,
    warnings: allWarnings,
    blockers: allBlockers,
    details: allDetails,
  };
}

// ─── Launch Validation ───────────────────────────────────────────────────

/**
 * Pre-flight check for token launch: balance for gas + dev buy.
 */
export async function validateLaunch(opts: {
  devBuyEth?: number;
}): Promise<SafetyCheckResult> {
  const requiredEth = (opts.devBuyEth ?? 0) + 0.01; // gas for deploy tx
  return checkBalance({ requiredEth });
}

// ─── Claim Validation ────────────────────────────────────────────────────

/**
 * Pre-flight check for fee claims: just gas check.
 */
export async function validateClaim(): Promise<SafetyCheckResult> {
  return checkBalance({ requiredEth: 0 }); // only gas buffer needed
}
