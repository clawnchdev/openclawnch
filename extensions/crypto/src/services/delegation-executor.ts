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
// detectAccountType removed — EOA check now uses getCode on the delegation's delegator address
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
 * Tier 1 (simple extraction): transfer, clawnchconnect, approvals, permit2, nft
 * Tier 2 (known ABIs): defi_lend (borrow/withdraw), defi_stake, governance
 * Tier 3 (approval-gated): yield (withdraw only)
 *
 * Not extractable (calldata from external APIs/SDKs):
 * - defi_swap: DEX aggregator constructs calldata (0x/1inch/Paraswap)
 * - bridge: LI.FI aggregator constructs calldata
 * - liquidity: Uniswap SDK multicall with complex math
 * - privacy: ZK proof generation via Veil SDK
 * - bankr_*: natural-language prompt API, opaque
 * - farcaster/clawnx: API-only, no on-chain tx
 *
 * For unsupported tools, the delegation's on-chain caveats still enforce
 * limits when the wallet IS the delegator's smart account — the tool
 * submits the tx through the wallet, and the wallet's caveats are checked.
 */

/** Context passed to extractors for API-based calldata resolution. */
interface ExtractorContext {
  walletAddress?: Address;
  chainId?: number;
}

interface ActionExtractor {
  (args: Record<string, unknown>, ctx?: ExtractorContext): Promise<ExecutionAction | null>;
}

// ─── Redemption Rate Limiter ────────────────────────────────────────────
// Prevents gas-burning loops when a malfunctioning agent repeatedly
// attempts to redeem a delegation that reverts.
// Max 3 attempts per policy per 60 seconds. Resets on success.

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 3;
const _redemptionAttempts = new Map<string, number[]>();

function isRateLimited(policyId: string): boolean {
  const now = Date.now();
  const attempts = _redemptionAttempts.get(policyId) ?? [];
  const recent = attempts.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  return recent.length >= RATE_LIMIT_MAX_ATTEMPTS;
}

function recordRedemptionAttempt(policyId: string): void {
  const now = Date.now();
  const attempts = _redemptionAttempts.get(policyId) ?? [];
  // Prune old entries
  const recent = attempts.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  _redemptionAttempts.set(policyId, recent);
}

/** Clear rate limit for a policy (call on successful redemption). */
export function clearRateLimit(policyId: string): void {
  _redemptionAttempts.delete(policyId);
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

  // ── Tier 1: Simple arg extraction ────────────────────────────────────

  /**
   * approvals tool — revoke ERC-20 approvals.
   * Args: { action: 'revoke', token: address, spender: address }
   */
  approvals: async (args) => {
    const action = args.action as string | undefined;
    if (action !== 'revoke') return null;

    const token = args.token as string | undefined;
    const spender = args.spender as string | undefined;
    if (!token || !spender) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(spender)) return null;

    return {
      target: token as Address,
      value: 0n,
      callData: encodeErc20Approve(spender as Address, 0n),
    };
  },

  /**
   * permit2 tool — approve tokens to the Permit2 contract.
   * Args: { action: 'approve', token: address }
   */
  permit2: async (args) => {
    const action = args.action as string | undefined;
    if (action !== 'approve') return null;

    const token = args.token as string | undefined;
    if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) return null;

    const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;
    const MAX_UINT256 = (2n ** 256n) - 1n;

    return {
      target: token as Address,
      value: 0n,
      callData: encodeErc20Approve(PERMIT2, MAX_UINT256),
    };
  },

  /**
   * nft tool — transfer ERC-721 tokens.
   * Args: { action: 'transfer', contract: address, token_id: string, to: address }
   */
  nft: async (args) => {
    const action = args.action as string | undefined;
    if (action !== 'transfer') return null;

    const contract = args.contract as string | undefined;
    const tokenId = args.token_id as string | undefined;
    const to = args.to as string | undefined;
    if (!contract || !tokenId || !to) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(contract) || !/^0x[0-9a-fA-F]{40}$/.test(to)) return null;

    // ERC-721 transferFrom(address from, address to, uint256 tokenId)
    // Selector: 0x23b872dd
    // Note: uses transferFrom not safeTransferFrom to avoid callback complexity
    const selector = '0x23b872dd';
    const fromParam = '0'.repeat(64); // filled at execution time from delegator address
    const toParam = to.slice(2).toLowerCase().padStart(64, '0');
    const idParam = BigInt(tokenId).toString(16).padStart(64, '0');

    return {
      target: contract as Address,
      value: 0n,
      callData: `${selector}${fromParam}${toParam}${idParam}` as Hex,
    };
  },

  // ── Tier 2: Known ABIs, deterministic args ───────────────────────────

  /**
   * defi_lend tool — Aave V3 borrow/withdraw (no prior approval needed).
   * Args: { action: 'borrow'|'withdraw'|'supply'|'repay', asset: string, amount: string }
   */
  defi_lend: async (args) => {
    const action = args.action as string | undefined;
    // Only extract actions that don't require a prior approval tx
    if (action !== 'borrow' && action !== 'withdraw') return null;

    const asset = args.asset as string | undefined;
    const amount = args.amount as string | undefined;
    if (!asset || !amount) return null;

    // Resolve asset symbol to address (Base mainnet)
    const AAVE_ASSETS: Record<string, { address: Address; decimals: number }> = {
      'eth': { address: '0x4200000000000000000000000000000000000006' as Address, decimals: 18 },
      'weth': { address: '0x4200000000000000000000000000000000000006' as Address, decimals: 18 },
      'usdc': { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address, decimals: 6 },
      'usdbc': { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' as Address, decimals: 6 },
      'cbeth': { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' as Address, decimals: 18 },
    };

    const assetLower = asset.toLowerCase();
    const assetInfo = AAVE_ASSETS[assetLower];
    // If asset is already a 0x address, use it directly
    const assetAddr = assetInfo?.address ?? ((/^0x[0-9a-fA-F]{40}$/.test(asset)) ? asset as Address : null);
    if (!assetAddr) return null;

    const decimals = assetInfo?.decimals ?? 18;
    const amountWei = parseTokenAmount(amount, decimals);
    if (amountWei <= 0n) return null;

    const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address; // Base

    if (action === 'borrow') {
      // borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
      // Selector: 0xa415bcad
      const sel = '0xa415bcad';
      const p1 = assetAddr.slice(2).toLowerCase().padStart(64, '0');
      const p2 = amountWei.toString(16).padStart(64, '0');
      const p3 = (2n).toString(16).padStart(64, '0'); // variable rate
      const p4 = (0n).toString(16).padStart(64, '0'); // referralCode
      const p5 = '0'.repeat(64); // onBehalfOf = delegator (filled at execution)
      return { target: AAVE_POOL, value: 0n, callData: `${sel}${p1}${p2}${p3}${p4}${p5}` as Hex };
    }

    // withdraw(address asset, uint256 amount, address to)
    // Selector: 0x69328dec
    const sel = '0x69328dec';
    const p1 = assetAddr.slice(2).toLowerCase().padStart(64, '0');
    const p2 = amountWei.toString(16).padStart(64, '0');
    const p3 = '0'.repeat(64); // to = delegator (filled at execution)
    return { target: AAVE_POOL, value: 0n, callData: `${sel}${p1}${p2}${p3}` as Hex };
  },

  /**
   * defi_stake tool — Lido/Rocket Pool staking.
   * Args: { action: 'stake'|'unstake'|'unwrap', protocol: string, amount: string }
   */
  defi_stake: async (args) => {
    const action = args.action as string | undefined;
    const protocol = (args.protocol as string | undefined)?.toLowerCase();
    const amount = args.amount as string | undefined;
    if (!action || !amount) return null;

    const weiValue = parseTokenAmount(amount, 18);
    if (weiValue <= 0n) return null;

    // Lido stake: stETH.submit(referral) with ETH value
    if (action === 'stake' && (!protocol || protocol === 'lido')) {
      const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84' as Address;
      // submit(address _referral) — selector: 0xa1903eab
      const sel = '0xa1903eab';
      const ref = '0'.repeat(64); // no referral
      return { target: STETH, value: weiValue, callData: `${sel}${ref}` as Hex };
    }

    // Rocket Pool stake: depositPool.deposit() with ETH value
    if (action === 'stake' && protocol === 'rocketpool') {
      const DEPOSIT_POOL = '0xDD3f50F8A6CafbE9b31a427582963f465E745AF8' as Address;
      // deposit() — selector: 0xd0e30db0 (same as WETH deposit)
      return { target: DEPOSIT_POOL, value: weiValue, callData: '0xd0e30db0' as Hex };
    }

    // Rocket Pool unstake: rETH.burn(amount)
    if (action === 'unstake' && protocol === 'rocketpool') {
      const RETH = '0xae78736Cd615f374D3085123A210448E74Fc6393' as Address;
      // burn(uint256 _rethAmount) — selector: 0x42966c68
      const sel = '0x42966c68';
      const p1 = weiValue.toString(16).padStart(64, '0');
      return { target: RETH, value: 0n, callData: `${sel}${p1}` as Hex };
    }

    // Lido unwrap: wstETH.unwrap(amount)
    if (action === 'unwrap') {
      const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Address;
      // unwrap(uint256 _wstETHAmount) — selector: 0xde0e9a3e
      const sel = '0xde0e9a3e';
      const p1 = weiValue.toString(16).padStart(64, '0');
      return { target: WSTETH, value: 0n, callData: `${sel}${p1}` as Hex };
    }

    return null;
  },

  /**
   * governance tool — on-chain voting and token delegation.
   * Args (vote): { action: 'vote', governor: address, proposal_id: string, support: number }
   * Args (delegate): { action: 'delegate', token: address, delegatee: address }
   */
  governance: async (args) => {
    const action = args.action as string | undefined;

    if (action === 'vote') {
      const governor = args.governor as string | undefined;
      const proposalId = args.proposal_id as string | undefined;
      const support = args.support as number | undefined;
      if (!governor || !proposalId || support === undefined) return null;
      if (!/^0x[0-9a-fA-F]{40}$/.test(governor)) return null;

      // castVote(uint256 proposalId, uint8 support) — selector: 0x56781388
      const sel = '0x56781388';
      const p1 = BigInt(proposalId).toString(16).padStart(64, '0');
      const p2 = BigInt(support).toString(16).padStart(64, '0');
      return { target: governor as Address, value: 0n, callData: `${sel}${p1}${p2}` as Hex };
    }

    if (action === 'delegate') {
      const token = args.token as string | undefined;
      const delegatee = args.delegatee as string | undefined;
      if (!token || !delegatee) return null;
      if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(delegatee)) return null;

      // delegate(address delegatee) — selector: 0x5c19a95c
      const sel = '0x5c19a95c';
      const p1 = delegatee.slice(2).toLowerCase().padStart(64, '0');
      return { target: token as Address, value: 0n, callData: `${sel}${p1}` as Hex };
    }

    return null;
  },

  // ── Tier 3: Extractable but may need prior approval ──────────────────

  /**
   * yield tool — ERC-4626 vault withdraw (no approval needed).
   * Args: { action: 'withdraw', vault: address, amount: string }
   */
  yield: async (args) => {
    const action = args.action as string | undefined;
    if (action !== 'withdraw') return null;

    const vault = args.vault as string | undefined;
    const amount = args.amount as string | undefined;
    if (!vault || !amount) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) return null;

    const amountWei = parseTokenAmount(amount, 18); // ERC-4626 uses share decimals
    if (amountWei <= 0n) return null;

    // withdraw(uint256 assets, address receiver, address owner) — selector: 0xb460af94
    const sel = '0xb460af94';
    const p1 = amountWei.toString(16).padStart(64, '0');
    const p2 = '0'.repeat(64); // receiver = delegator
    const p3 = '0'.repeat(64); // owner = delegator
    return { target: vault as Address, value: 0n, callData: `${sel}${p1}${p2}${p3}` as Hex };
  },

  // ── P6: API-based extractors (async, fetch calldata from external APIs) ──

  /**
   * defi_swap tool — fetch swap calldata from Clawnch/0x API.
   * Args: { action: 'execute', token_in, token_out, amount, slippage? }
   */
  defi_swap: async (args, ctx) => {
    const action = args.action as string | undefined;
    if (action !== 'execute') return null;
    if (!ctx?.walletAddress) return null;

    const tokenIn = args.token_in as string | undefined;
    const tokenOut = args.token_out as string | undefined;
    const amount = args.amount as string | undefined;
    const slippage = (args.slippage as number | undefined) ?? 1.0;
    if (!tokenIn || !tokenOut || !amount) return null;

    // Resolve token symbols to addresses (Base)
    const inAddr = resolveSwapToken(tokenIn);
    const outAddr = resolveSwapToken(tokenOut);
    if (!inAddr || !outAddr) return null;

    // Parse amount to wei
    const isNativeIn = inAddr.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
    const decimals = isNativeIn ? 18 : getTokenDecimals(inAddr);
    const sellAmountWei = parseTokenAmount(amount, decimals);
    if (sellAmountWei <= 0n) return null;

    try {
      const apiBase = process.env.CLAWNCHER_API_URL || 'https://clawn.ch';
      const chainId = ctx.chainId ?? 8453;
      const params = new URLSearchParams({
        chainId: String(chainId),
        sellToken: inAddr,
        buyToken: outAddr,
        sellAmount: sellAmountWei.toString(),
        slippageBps: String(Math.round(slippage * 100)),
        taker: ctx.walletAddress,
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`${apiBase}/api/swap/quote?${params}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) return null;
      const data = await resp.json() as any;
      if (!data.transaction?.to || !data.transaction?.data) return null;

      return {
        target: data.transaction.to as Address,
        value: BigInt(data.transaction.value || '0'),
        callData: data.transaction.data as Hex,
      };
    } catch {
      // API timeout or error — fall through to normal execution
      return null;
    }
  },

  /**
   * bridge tool — fetch bridge calldata from LI.FI API.
   * Args: { action: 'execute', from_chain, to_chain, from_token, to_token, amount, slippage? }
   */
  bridge: async (args, ctx) => {
    const action = args.action as string | undefined;
    if (action !== 'execute') return null;
    if (!ctx?.walletAddress) return null;

    const fromChain = args.from_chain as string | undefined;
    const toChain = args.to_chain as string | undefined;
    const amount = args.amount as string | undefined;
    if (!toChain || !amount) return null;

    const fromToken = (args.from_token as string | undefined) ?? '0x0000000000000000000000000000000000000000';
    const toToken = (args.to_token as string | undefined) ?? '0x0000000000000000000000000000000000000000';
    const slippage = (args.slippage as number | undefined) ?? 0.005;

    // Resolve chain names to IDs
    const fromChainId = resolveChainId(fromChain ?? 'base') ?? ctx.chainId ?? 8453;
    const toChainId = resolveChainId(toChain);
    if (!toChainId) return null;

    try {
      const params = new URLSearchParams({
        fromChain: String(fromChainId),
        toChain: String(toChainId),
        fromToken,
        toToken,
        fromAmount: amount,
        fromAddress: ctx.walletAddress,
        slippage: String(slippage),
      });

      const headers: Record<string, string> = { Accept: 'application/json' };
      const apiKey = process.env.LIFI_API_KEY;
      if (apiKey) headers['x-lifi-api-key'] = apiKey;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`https://li.quest/v1/quote?${params}`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) return null;
      const data = await resp.json() as any;
      const txReq = data.transactionRequest;
      if (!txReq?.to || !txReq?.data) return null;

      return {
        target: txReq.to as Address,
        value: txReq.value ? BigInt(txReq.value) : 0n,
        callData: txReq.data as Hex,
      };
    } catch {
      return null;
    }
  },
};

// ─── Token / Chain Resolution Helpers ───────────────────────────────────

const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Resolve token symbol or address for swap API. */
function resolveSwapToken(token: string): string | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(token)) return token;
  const SYMBOLS: Record<string, string> = {
    eth: NATIVE_TOKEN_ADDRESS,
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdt: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    dai: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    cbeth: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  };
  return SYMBOLS[token.toLowerCase()] ?? null;
}

/** Resolve chain name to chain ID. */
function resolveChainId(chain: string): number | null {
  const n = parseInt(chain, 10);
  if (!isNaN(n)) return n;
  const CHAINS: Record<string, number> = {
    ethereum: 1, eth: 1, mainnet: 1,
    base: 8453,
    arbitrum: 42161, arb: 42161,
    optimism: 10, op: 10,
    polygon: 137, matic: 137,
    avalanche: 43114, avax: 43114,
    bnb: 56, bsc: 56,
    linea: 59144,
    zksync: 324,
    scroll: 534352,
  };
  return CHAINS[chain.toLowerCase()] ?? null;
}

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

  // Note: EOA check on the DELEGATOR happens after gate 4 (when we know
  // which delegation will be used). The connected wallet is the DELEGATE
  // (agent), which is always an EOA. The gas simulation in redeemDelegation()
  // also catches delegator-is-EOA reverts before spending gas.

  // Gate 2: tool must have a supported action extractor
  const extractor = SUPPORTED_EXTRACTORS[actionCtx.toolName];
  if (!extractor) {
    return { executed: false, skipReason: `Tool "${actionCtx.toolName}" does not support delegation execution yet.` };
  }

  // Gate 3: extract the on-chain action from tool args
  // Pass wallet context for extractors that need to fetch quotes (swap, bridge)
  const { getWalletState } = await import('./walletconnect-service.js');
  const walletState = getWalletState();
  const extractorCtx: ExtractorContext = {
    walletAddress: walletState.address as Address | undefined,
    chainId: walletState.chainId ?? actionCtx.chain,
  };
  const executionAction = await extractor(toolArgs, extractorCtx);
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

  // Check expiry (P2-2: client-side TimestampEnforcer check)
  if (matchResult.expiresAt) {
    const expiryMs = new Date(matchResult.expiresAt).getTime();
    if (!isNaN(expiryMs) && Date.now() > expiryMs) {
      return { executed: false, skipReason: 'Delegation has expired. Create a new one with /delegate create.' };
    }
  }

  // Check chain match (P2-4: delegation must be for the current chain)
  if (actionCtx.chain && matchResult.chainId && actionCtx.chain !== matchResult.chainId) {
    return {
      executed: false,
      skipReason: `Delegation is for chain ${matchResult.chainId} but wallet is on chain ${actionCtx.chain}. Switch chains or create a new delegation.`,
    };
  }

  // Gate 6b: check if the delegation's delegator is a smart account
  // redeemDelegations calls executeFromExecutor on the delegator — plain EOAs revert.
  if (matchResult.delegator) {
    try {
      const { getPublicClient } = await import('./walletconnect-service.js');
      const pub = getPublicClient();
      if (pub) {
        const code = await pub.getCode({ address: matchResult.delegator as Address });
        if (!code || code === '0x' || code === '0x0') {
          return {
            executed: false,
            skipReason: `Delegator ${matchResult.delegator} is a plain EOA. On-chain delegation requires a smart account. Use /upgrade to convert.`,
          };
        }
      }
    } catch {
      // Non-fatal: if the check fails, let the gas simulation catch it
    }
  }

  // Gate 7: rate limiter — prevent gas-burning loops on repeated failures
  if (isRateLimited(matchResult.policyId)) {
    return {
      executed: false,
      skipReason: `Delegation ${matchResult.policyName} is rate-limited (too many recent attempts). Wait before retrying.`,
    };
  }

  // All gates passed — attempt redemption
  recordRedemptionAttempt(matchResult.policyId);
  try {
    const result = await redeemDelegation(matchResult.policyId, executionAction);

    if ('error' in result) {
      // Redemption failed — caller should fall back to normal execution
      return { executed: false, error: result.error };
    }

    // Success — clear rate limit
    clearRateLimit(matchResult.policyId);

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
  delegator?: string;
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
      delegator: info.delegator,
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
