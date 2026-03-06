/**
 * Permit2 Tool — Manage Uniswap Permit2 token allowances.
 *
 * Permit2 is the universal token approval system used by Uniswap V4 and other
 * modern DeFi protocols. Instead of approving each contract individually,
 * you approve Permit2 once per token, then use gas-free signatures for
 * individual spender allowances.
 *
 * Actions:
 *   check_allowance — Read current Permit2 allowance for a token/spender pair
 *   approve         — Approve a token for Permit2 (ERC-20 → Permit2 max approval)
 *   approve_batch   — Approve multiple tokens for Permit2 in sequence
 *   revoke          — Set a Permit2 allowance to zero for a specific spender
 *   lockdown        — Emergency: revoke all Permit2 allowances for multiple pairs
 *
 * Uses Permit2Client from @clawnch/clawncher-sdk.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
  isBankrMode,
} from '../services/walletconnect-service.js';

const ACTIONS = ['check_allowance', 'approve', 'approve_batch', 'revoke', 'lockdown'] as const;

/** Canonical Permit2 address (same on all chains) */
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** Well-known spender addresses on Base */
const KNOWN_SPENDERS: Record<string, string> = {
  universal_router: '0x198EF79F1F515F02dFE9e3115eD9fC07183f02fC',
  position_manager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
};

const Permit2Schema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'check_allowance: read current Permit2 allowance for token/spender. ' +
      'approve: approve a token for Permit2 (one-time ERC-20 max approval). ' +
      'approve_batch: approve multiple tokens for Permit2. ' +
      'revoke: set Permit2 allowance to zero for a spender. ' +
      'lockdown: emergency revoke multiple token/spender pairs.',
  }),
  token: Type.Optional(Type.String({
    description: 'ERC-20 token contract address (0x...). Required for check_allowance, approve, revoke.',
  })),
  amount: Type.Optional(Type.String({
    description: 'Scoped approval amount in token smallest unit. If omitted, max approval is used. Use to limit Permit2 exposure.',
  })),
  tokens: Type.Optional(Type.Array(Type.String(), {
    description: 'Array of token addresses for approve_batch.',
  })),
  spender: Type.Optional(Type.String({
    description:
      'Spender address (0x...) or alias: "universal_router", "position_manager". ' +
      'Required for check_allowance, revoke.',
  })),
  pairs: Type.Optional(Type.Array(
    Type.Object({
      token: Type.String({ description: 'Token address' }),
      spender: Type.String({ description: 'Spender address or alias' }),
    }),
    { description: 'Token/spender pairs for lockdown action.' },
  )),
});

export function createPermit2Tool() {
  return {
    name: 'permit2',
    label: 'Permit2',
    ownerOnly: true,
    description:
      'Manage Uniswap Permit2 token allowances. Check, approve, or revoke Permit2 ' +
      'allowances for DeFi protocols. Use "lockdown" for emergency revocation.',
    parameters: Permit2Schema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      const state = getWalletState();
      if (!state.connected) {
        return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
      }

      // Bankr mode: Permit2 operations are handled differently
      // Approvals go through Bankr prompt API, not local wallet
      if (isBankrMode() && (action === 'approve' || action === 'approve_batch')) {
        return jsonResult({
          status: 'not_needed',
          mode: 'bankr',
          message: 'Bankr wallet handles token approvals automatically during swaps. ' +
            'No manual Permit2 approval is needed.',
        });
      }

      switch (action) {
        case 'check_allowance':
          return handleCheckAllowance(params);
        case 'approve':
          return handleApprove(params);
        case 'approve_batch':
          return handleApproveBatch(params);
        case 'revoke':
          return handleRevoke(params);
        case 'lockdown':
          return handleLockdown(params);
        default:
          return errorResult(`Unknown action: ${action}. Use: ${ACTIONS.join(', ')}`);
      }
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function resolveSpender(input: string): `0x${string}` {
  const alias = KNOWN_SPENDERS[input.toLowerCase()];
  if (alias) return alias as `0x${string}`;
  if (input.startsWith('0x') && input.length === 42) return input as `0x${string}`;
  throw new Error(`Invalid spender: "${input}". Use an address (0x...) or alias: ${Object.keys(KNOWN_SPENDERS).join(', ')}`);
}

async function getPermit2Client() {
  const { Permit2Client } = await import('@clawnch/clawncher-sdk');
  const wallet = requireWalletClient();
  const publicClient = requirePublicClient();

  return new Permit2Client({
    wallet: wallet as any,
    publicClient: publicClient as any,
    chainId: 8453,
  });
}

// ─── Action Handlers ──────────────────────────────────────────────────────

async function handleCheckAllowance(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token', { required: true })!;
  const spenderInput = readStringParam(params, 'spender', { required: true })!;

  try {
    const spender = resolveSpender(spenderInput);
    const client = await getPermit2Client();
    const allowance = await client.getAllowance(token as `0x${string}`, spender);

    const now = Math.floor(Date.now() / 1000);
    const isExpired = allowance.expiration > 0 && allowance.expiration < now;
    const isActive = allowance.amount > 0n && !isExpired;

    return jsonResult({
      token,
      spender,
      spenderAlias: KNOWN_SPENDERS[spenderInput.toLowerCase()] ? spenderInput : undefined,
      amount: allowance.amount.toString(),
      amountReadable: allowance.amount === BigInt('0xffffffffffffffffffffffffffffffffffffffff')
        ? 'MAX (uint160)'
        : allowance.amount.toString(),
      expiration: allowance.expiration,
      expirationDate: allowance.expiration > 0
        ? new Date(allowance.expiration * 1000).toISOString()
        : 'never',
      nonce: allowance.nonce,
      isExpired,
      isActive,
      permit2Address: PERMIT2_ADDRESS,
    });
  } catch (err) {
    return errorResult(`Check allowance failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleApprove(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token', { required: true })!;

  // C4: Validate token address
  if (!token.match(/^0x[a-fA-F0-9]{40}$/)) {
    return errorResult('Invalid token address. Must be a valid 0x... address.');
  }

  try {
    const client = await getPermit2Client();

    // C4: Support scoped approvals — if caller specifies an amount, use directApprove
    // with that amount instead of max uint160. This limits exposure.
    const scopedAmount = readStringParam(params, 'amount');
    if (scopedAmount) {
      // Parse the amount as a BigInt (expected in token's smallest unit)
      const spenderInput = readStringParam(params, 'spender') || 'universal_router';
      const spender = resolveSpender(spenderInput);
      const amount = BigInt(scopedAmount);
      const expiration = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days
      const txHash = await client.directApprove(
        token as `0x${string}`,
        spender,
        amount,
        expiration,
      );
      return jsonResult({
        status: 'approved',
        token,
        permit2Address: PERMIT2_ADDRESS,
        txHash,
        approvedAmount: scopedAmount,
        expiresIn: '30 days',
        message: 'Token approved for Permit2 with scoped allowance.',
      });
    }

    // Default path: ensure max approval (for backward compat)
    const txHash = await client.ensureTokenApproval(token as `0x${string}`);

    if (txHash === null) {
      return jsonResult({
        status: 'already_approved',
        token,
        permit2Address: PERMIT2_ADDRESS,
        message: 'Token already has max approval for Permit2. No transaction needed.',
      });
    }

    return jsonResult({
      status: 'approved',
      token,
      permit2Address: PERMIT2_ADDRESS,
      txHash,
      message: 'Token approved for Permit2 with max allowance. Use "amount" param to scope the approval.',
    });
  } catch (err) {
    return errorResult(`Approve failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleApproveBatch(params: Record<string, unknown>) {
  const tokensRaw = params.tokens;
  if (!Array.isArray(tokensRaw) || tokensRaw.length === 0) {
    return errorResult('approve_batch requires a non-empty "tokens" array of token addresses.');
  }

  const tokens = tokensRaw.map((t) => String(t)) as `0x${string}`[];

  try {
    const client = await getPermit2Client();
    const results = await client.ensureTokenApprovals(tokens);

    const approvals: Array<{ token: string; txHash: string | null; status: string }> = [];
    for (const token of tokens) {
      const hash = results.get(token as any);
      approvals.push({
        token,
        txHash: hash ?? null,
        status: hash ? 'approved' : 'already_approved',
      });
    }

    return jsonResult({
      permit2Address: PERMIT2_ADDRESS,
      totalTokens: tokens.length,
      newApprovals: approvals.filter((a) => a.status === 'approved').length,
      alreadyApproved: approvals.filter((a) => a.status === 'already_approved').length,
      approvals,
    });
  } catch (err) {
    return errorResult(`Batch approve failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleRevoke(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token', { required: true })!;
  const spenderInput = readStringParam(params, 'spender', { required: true })!;

  try {
    const spender = resolveSpender(spenderInput);
    const client = await getPermit2Client();

    // directApprove with amount=0 and expiration=0 effectively revokes
    const txHash = await client.directApprove(
      token as `0x${string}`,
      spender,
      0n,
      0,
    );

    return jsonResult({
      status: 'revoked',
      token,
      spender,
      txHash,
      message: 'Permit2 allowance set to zero for this token/spender pair.',
    });
  } catch (err) {
    return errorResult(`Revoke failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleLockdown(params: Record<string, unknown>) {
  const pairsRaw = params.pairs;
  if (!Array.isArray(pairsRaw) || pairsRaw.length === 0) {
    return errorResult('lockdown requires a non-empty "pairs" array of {token, spender} objects.');
  }

  try {
    const pairs = pairsRaw.map((p: any) => ({
      token: p.token as `0x${string}`,
      spender: resolveSpender(String(p.spender)),
    }));

    const client = await getPermit2Client();
    const txHash = await client.lockdown(pairs);

    return jsonResult({
      status: 'lockdown_complete',
      pairsRevoked: pairs.length,
      pairs: pairs.map((p) => ({ token: p.token, spender: p.spender })),
      txHash,
      message: `Emergency lockdown: ${pairs.length} token/spender pair(s) revoked.`,
    });
  } catch (err) {
    return errorResult(`Lockdown failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
