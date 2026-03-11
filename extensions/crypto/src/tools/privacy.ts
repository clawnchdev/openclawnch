/**
 * Privacy Tool — private transactions via Veil.cash on Base.
 *
 * Actions:
 *   deposit   — Deposit ETH/USDC into privacy pool (public → shielded)
 *   withdraw  — Withdraw from privacy pool (shielded → public)
 *   transfer  — Private-to-private transfer within the pool
 *   balance   — Check shielded balance
 *   info      — Show supported assets and pool info
 *
 * Uses @veil-cash/sdk for ZK proof generation. Privacy pools on Base
 * use zero-knowledge proofs to break the on-chain link between deposits
 * and withdrawals.
 *
 * Requires: @veil-cash/sdk npm package (optional dependency).
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { getVeilService } from '../services/veil-service.js';
import { getWalletState, requirePublicClient } from '../services/walletconnect-service.js';
import { resolveAddressOrEns, isEnsName } from '../lib/ens-resolver.js';

const ACTIONS = ['deposit', 'withdraw', 'transfer', 'balance', 'info'] as const;

const PrivacySchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'deposit: send to privacy pool. withdraw: exit privacy pool to an address. ' +
      'transfer: private-to-private transfer. balance: check shielded balance. ' +
      'info: supported assets and pool details.',
  }),
  asset: Type.Optional(Type.String({
    description: 'Asset: "ETH" or "USDC". Required for deposit/withdraw/transfer.',
  })),
  amount: Type.Optional(Type.String({
    description: 'Amount in human-readable units (e.g. "0.1" ETH, "100" USDC). Required for deposit/withdraw/transfer.',
  })),
  recipient: Type.Optional(Type.String({
    description: 'Recipient address, ENS name, or shielded public key. Required for withdraw/transfer.',
  })),
});

export function createPrivacyTool() {
  return {
    name: 'privacy',
    label: 'Privacy',
    ownerOnly: true,
    description:
      'Private transactions on Base via Veil.cash. Deposit ETH/USDC into ZK privacy pools, ' +
      'withdraw to any address (breaking on-chain link), or transfer privately within the pool. ' +
      'Requires @veil-cash/sdk package.',
    parameters: PrivacySchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'deposit':
          return handleDeposit(params);
        case 'withdraw':
          return handleWithdraw(params);
        case 'transfer':
          return handleTransfer(params);
        case 'balance':
          return handleBalance(params);
        case 'info':
          return handleInfo();
        default:
          return errorResult(`Unknown action: ${action}. Use: deposit, withdraw, transfer, balance, info`);
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Validate amount is a non-empty positive number string. */
function validateAmount(amount: string): string {
  const trimmed = amount.trim();
  if (!trimmed) throw new Error('Amount cannot be empty.');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount "${trimmed}". Must be a positive number (e.g. "0.1", "100").`);
  }
  if (parseFloat(trimmed) === 0) throw new Error('Amount must be greater than zero.');
  return trimmed;
}

// ── Action Handlers ─────────────────────────────────────────────────────────

async function handleDeposit(params: Record<string, unknown>) {
  const asset = readStringParam(params, 'asset', { required: true });
  const amountRaw = readStringParam(params, 'amount', { required: true });
  if (!asset || !amountRaw) {
    return errorResult('Both asset and amount are required for deposit.');
  }

  let amount: string;
  try { amount = validateAmount(amountRaw); } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  try {
    const service = getVeilService();

    // Check SDK availability first
    const available = await service.isAvailable();
    if (!available) {
      return errorResult(
        '@veil-cash/sdk not installed. Install with: pnpm add @veil-cash/sdk',
      );
    }

    const result = await service.deposit(asset, amount);

    return jsonResult({
      status: result.status,
      action: 'deposit',
      asset: result.asset,
      amount: result.amount,
      txHash: result.txHash,
      noteHash: result.noteHash,
      chain: 'base',
      note: 'Funds are now shielded. Use action=withdraw to exit to any address.',
      warning: 'SAVE your encrypted note. It is required for withdrawal if you lose access to this wallet.',
    });
  } catch (err) {
    return errorResult(`Deposit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleWithdraw(params: Record<string, unknown>) {
  const asset = readStringParam(params, 'asset', { required: true });
  const amountRaw = readStringParam(params, 'amount', { required: true });
  const recipientInput = readStringParam(params, 'recipient', { required: true });
  if (!asset || !amountRaw || !recipientInput) {
    return errorResult('asset, amount, and recipient are required for withdraw.');
  }

  let amount: string;
  try { amount = validateAmount(amountRaw); } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  try {
    const service = getVeilService();
    const available = await service.isAvailable();
    if (!available) {
      return errorResult('@veil-cash/sdk not installed. Install with: pnpm add @veil-cash/sdk');
    }

    // Resolve ENS if needed
    let recipient = recipientInput;
    if (isEnsName(recipientInput)) {
      const publicClient = requirePublicClient();
      const resolved = await resolveAddressOrEns(recipientInput, publicClient);
      recipient = resolved.address;
    }

    const result = await service.withdraw(asset, amount, recipient);

    return jsonResult({
      status: result.status,
      action: 'withdraw',
      asset: result.asset,
      amount: result.amount,
      recipient: result.recipient,
      ensName: isEnsName(recipientInput) ? recipientInput : undefined,
      txHash: result.txHash,
      relayerFee: result.relayerFee,
      chain: 'base',
      note: result.status === 'submitted_to_relayer'
        ? 'Withdrawal submitted to relayer for privacy. Transaction will appear shortly.'
        : 'Withdrawal confirmed on-chain.',
    });
  } catch (err) {
    return errorResult(`Withdraw failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleTransfer(params: Record<string, unknown>) {
  const asset = readStringParam(params, 'asset', { required: true });
  const amountRaw = readStringParam(params, 'amount', { required: true });
  const recipient = readStringParam(params, 'recipient', { required: true });
  if (!asset || !amountRaw || !recipient) {
    return errorResult('asset, amount, and recipient (shielded public key) are required for transfer.');
  }

  let amount: string;
  try { amount = validateAmount(amountRaw); } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  try {
    const service = getVeilService();
    const available = await service.isAvailable();
    if (!available) {
      return errorResult('@veil-cash/sdk not installed. Install with: pnpm add @veil-cash/sdk');
    }

    const result = await service.transfer(asset, amount, recipient);

    return jsonResult({
      status: result.status,
      action: 'transfer',
      asset: result.asset,
      amount: result.amount,
      txHash: result.txHash,
      noteHash: result.noteHash,
      chain: 'base',
      note: 'Private transfer completed. Both sender and recipient balances updated within the privacy pool.',
    });
  } catch (err) {
    return errorResult(`Transfer failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleBalance(params: Record<string, unknown>) {
  try {
    const service = getVeilService();
    const available = await service.isAvailable();
    if (!available) {
      return errorResult('@veil-cash/sdk not installed. Install with: pnpm add @veil-cash/sdk');
    }

    const state = getWalletState();
    if (!state.connected) {
      return errorResult('No wallet connected. Connect a wallet first.');
    }

    const asset = readStringParam(params, 'asset');
    const balances = await service.getBalance(asset ?? undefined);

    return jsonResult({
      chain: 'base',
      balances: balances.map(b => ({
        asset: b.asset,
        shielded: b.shielded,
        pendingDeposits: b.pendingDeposits !== '0' ? b.pendingDeposits : undefined,
        pendingWithdrawals: b.pendingWithdrawals !== '0' ? b.pendingWithdrawals : undefined,
      })),
      note: 'Shielded balances are private — only visible to the wallet owner.',
    });
  } catch (err) {
    return errorResult(`Balance check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleInfo() {
  const service = getVeilService();
  const available = await service.isAvailable();
  const assets = service.getSupportedAssets();

  return jsonResult({
    protocol: 'Veil.cash',
    chain: 'base',
    sdkInstalled: available,
    supportedAssets: assets.map(a => ({
      symbol: a.symbol,
      poolDenomination: a.poolDenomination,
      address: a.address === '0x0000000000000000000000000000000000000000' ? 'native ETH' : a.address,
    })),
    howItWorks: [
      '1. Deposit: Send ETH/USDC to the privacy pool (public transaction)',
      '2. Wait: Let time pass for anonymity set to grow',
      '3. Withdraw: Exit to any address (ZK proof breaks the on-chain link)',
    ],
    privacy: 'ZK proofs ensure no one can link your deposit to your withdrawal.',
    sdkRequired: !available
      ? 'Install @veil-cash/sdk: pnpm add @veil-cash/sdk'
      : undefined,
  });
}
