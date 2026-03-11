/**
 * Safe Multisig Tool — manage Safe{Wallet} multisig wallets.
 *
 * Actions:
 *   info          — Get Safe details (threshold, owners, nonce, version)
 *   balances      — Get Safe token balances (ETH + ERC-20)
 *   pending_txs   — List pending/queued transactions awaiting signatures
 *   history       — Get executed transaction history
 *   propose       — Propose a new transaction to a Safe
 *   confirm       — Confirm (co-sign) a pending transaction
 *   execute       — Check execution readiness for a pending transaction
 *
 * Uses Safe Transaction Service REST API. No SDK dependency.
 * Supports Ethereum, Base, Arbitrum, Optimism, and Polygon.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { getSafeService } from '../services/safe-service.js';
import {
  getWalletState,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { resolveAddressOrEns, isEnsName } from '../lib/ens-resolver.js';

const ACTIONS = ['info', 'balances', 'pending_txs', 'history', 'propose', 'confirm', 'execute'] as const;

const SafeSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'info: Safe details. balances: token balances. pending_txs: pending transactions. ' +
      'history: executed transactions. propose: propose new tx. confirm: co-sign pending tx. ' +
      'execute: check if pending tx has enough signatures to execute.',
  }),
  safe_address: Type.Optional(Type.String({
    description: 'Safe multisig address or ENS name. Required for most actions.',
  })),
  chain: Type.Optional(Type.String({
    description: 'Chain: "ethereum" (default), "base", "arbitrum", "optimism", "polygon".',
  })),
  safe_tx_hash: Type.Optional(Type.String({
    description: 'Safe transaction hash. Required for confirm and execute actions.',
  })),
  to: Type.Optional(Type.String({
    description: 'Destination address for propose action.',
  })),
  value: Type.Optional(Type.String({
    description: 'ETH value in wei for propose action. Default: "0".',
  })),
  data: Type.Optional(Type.String({
    description: 'Calldata hex for propose action. Default: "0x" (plain ETH transfer).',
  })),
  signature: Type.Optional(Type.String({
    description: 'EIP-712 signature for propose/confirm. Must be generated off-chain.',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Max results to return. Default: 20.',
  })),
});

export function createSafeTool() {
  return {
    name: 'safe',
    label: 'Safe Multisig',
    ownerOnly: true,
    description:
      'Manage Safe{Wallet} multisig wallets: view info, balances, pending transactions, ' +
      'propose new transactions, confirm/co-sign, and check execution readiness. ' +
      'Supports Ethereum, Base, Arbitrum, Optimism, and Polygon.',
    parameters: SafeSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'info':
          return handleInfo(params);
        case 'balances':
          return handleBalances(params);
        case 'pending_txs':
          return handlePendingTxs(params);
        case 'history':
          return handleHistory(params);
        case 'propose':
          return handlePropose(params);
        case 'confirm':
          return handleConfirm(params);
        case 'execute':
          return handleExecute(params);
        default:
          return errorResult(`Unknown action: ${action}. Use: info, balances, pending_txs, history, propose, confirm, execute`);
      }
    },
  };
}

// ── Action Handlers ─────────────────────────────────────────────────────

async function handleInfo(params: Record<string, unknown>) {
  const { safeAddress, chainId } = await resolveSafeParams(params);
  if (!safeAddress) return errorResult('safe_address is required.');

  try {
    const service = getSafeService();
    const info = await service.getInfo(safeAddress, chainId);

    return jsonResult({
      address: info.address,
      threshold: info.threshold,
      owners: info.owners,
      ownerCount: info.owners.length,
      nonce: info.nonce,
      version: info.version,
      modules: info.modules.length > 0 ? info.modules : undefined,
      guard: info.guard !== '' && info.guard !== '0x0000000000000000000000000000000000000000' ? info.guard : undefined,
      chain: chainLabel(chainId),
      note: `${info.threshold}-of-${info.owners.length} multisig`,
    });
  } catch (err) {
    return errorResult(`Safe info failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleBalances(params: Record<string, unknown>) {
  const { safeAddress, chainId } = await resolveSafeParams(params);
  if (!safeAddress) return errorResult('safe_address is required.');

  try {
    const service = getSafeService();
    const balances = await service.getBalances(safeAddress, chainId);

    const formatted = balances.map(b => ({
      symbol: b.token?.symbol ?? (chainId === 137 ? 'MATIC' : 'ETH'),
      name: b.token?.name ?? 'Native Token',
      balance: formatBalance(b.balance, b.token?.decimals ?? 18),
      rawBalance: b.balance,
      tokenAddress: b.tokenAddress ?? 'native',
    }));

    return jsonResult({
      safeAddress,
      chain: chainLabel(chainId),
      tokens: formatted,
      tokenCount: formatted.length,
    });
  } catch (err) {
    return errorResult(`Balances fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handlePendingTxs(params: Record<string, unknown>) {
  const { safeAddress, chainId } = await resolveSafeParams(params);
  if (!safeAddress) return errorResult('safe_address is required.');
  const limit = readNumberParam(params, 'limit') ?? 20;

  try {
    const service = getSafeService();
    const txs = await service.getPendingTransactions(safeAddress, chainId, limit);

    if (txs.length === 0) {
      return jsonResult({
        safeAddress,
        chain: chainLabel(chainId),
        pending: [],
        message: 'No pending transactions.',
      });
    }

    return jsonResult({
      safeAddress,
      chain: chainLabel(chainId),
      count: txs.length,
      pending: txs.map(tx => ({
        safeTxHash: tx.safeTxHash,
        to: tx.to,
        value: tx.value !== '0' ? formatBalance(tx.value, 18) + ' ETH' : undefined,
        data: tx.data ? (tx.data.length > 10 ? tx.data.slice(0, 10) + '...' : tx.data) : undefined,
        dataDecoded: tx.dataDecoded ? summarizeDecoded(tx.dataDecoded) : undefined,
        nonce: tx.nonce,
        confirmations: tx.confirmations.length,
        confirmationsRequired: tx.confirmationsRequired,
        signers: tx.confirmations.map(c => c.owner),
        submittedAt: tx.submissionDate,
        canExecute: tx.confirmations.length >= tx.confirmationsRequired,
      })),
    });
  } catch (err) {
    return errorResult(`Pending transactions fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleHistory(params: Record<string, unknown>) {
  const { safeAddress, chainId } = await resolveSafeParams(params);
  if (!safeAddress) return errorResult('safe_address is required.');
  const limit = readNumberParam(params, 'limit') ?? 20;

  try {
    const service = getSafeService();
    const txs = await service.getTransactionHistory(safeAddress, chainId, limit);

    return jsonResult({
      safeAddress,
      chain: chainLabel(chainId),
      count: txs.length,
      transactions: txs.map(tx => ({
        safeTxHash: tx.safeTxHash,
        to: tx.to,
        value: tx.value !== '0' ? formatBalance(tx.value, 18) + ' ETH' : undefined,
        dataDecoded: tx.dataDecoded ? summarizeDecoded(tx.dataDecoded) : undefined,
        nonce: tx.nonce,
        executedAt: tx.executionDate,
        success: tx.isSuccessful,
        txHash: tx.transactionHash,
        executor: tx.executor,
      })),
    });
  } catch (err) {
    return errorResult(`Transaction history fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handlePropose(params: Record<string, unknown>) {
  const { safeAddress, chainId } = await resolveSafeParams(params);
  if (!safeAddress) return errorResult('safe_address is required.');

  const to = readStringParam(params, 'to');
  if (!to) return errorResult('to address is required for propose.');

  const value = readStringParam(params, 'value') ?? '0';
  if (!/^\d+$/.test(value)) {
    return errorResult(`Invalid value "${value}". Must be a non-negative integer in wei (e.g. "1000000000000000000" for 1 ETH).`);
  }
  const data = readStringParam(params, 'data') ?? '0x';
  if (data !== '0x' && !/^0x[0-9a-fA-F]*$/.test(data)) {
    return errorResult(`Invalid data "${data.slice(0, 20)}...". Must be a hex string starting with "0x".`);
  }
  const signature = readStringParam(params, 'signature');
  if (!signature) {
    return errorResult(
      'signature is required. You must generate an EIP-712 signature of the Safe transaction hash off-chain. ' +
      'Use the Safe signing scheme: domain separator + typehash + tx struct hash.',
    );
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first to propose transactions.');
  }

  try {
    const service = getSafeService();

    // Verify sender is an owner
    const isOwner = await service.isOwner(safeAddress, state.address, chainId);
    if (!isOwner) {
      return errorResult(`Address ${state.address} is not an owner of Safe ${safeAddress}.`);
    }

    // Get current nonce for the proposal
    const info = await service.getInfo(safeAddress, chainId);

    await service.proposeTransaction(
      {
        safeAddress,
        to,
        value,
        data,
        signature,
        sender: state.address,
        nonce: info.nonce,
      },
      chainId,
    );

    return jsonResult({
      status: 'success',
      action: 'propose',
      safeAddress,
      to,
      value: value !== '0' ? formatBalance(value, 18) + ' ETH' : undefined,
      hasData: data !== '0x',
      nonce: info.nonce,
      chain: chainLabel(chainId),
      note: `Transaction proposed at nonce ${info.nonce}. Other owners must confirm before execution.`,
    });
  } catch (err) {
    return errorResult(`Propose failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleConfirm(params: Record<string, unknown>) {
  const safeTxHash = readStringParam(params, 'safe_tx_hash');
  if (!safeTxHash) return errorResult('safe_tx_hash is required for confirm.');

  const signature = readStringParam(params, 'signature');
  if (!signature) {
    return errorResult(
      'signature is required. Generate an EIP-712 signature of the safeTxHash using the Safe signing scheme.',
    );
  }

  const service = getSafeService();
  const chainId = service.resolveChainId(readStringParam(params, 'chain') ?? undefined);

  try {
    await service.confirmTransaction(safeTxHash, signature, chainId);

    // Fetch updated tx to show confirmation count
    const tx = await service.getTransaction(safeTxHash, chainId);

    return jsonResult({
      status: 'success',
      action: 'confirm',
      safeTxHash,
      confirmations: tx.confirmations.length,
      confirmationsRequired: tx.confirmationsRequired,
      canExecute: tx.confirmations.length >= tx.confirmationsRequired,
      chain: chainLabel(chainId),
      note: tx.confirmations.length >= tx.confirmationsRequired
        ? 'Threshold reached — this transaction can now be executed.'
        : `${tx.confirmationsRequired - tx.confirmations.length} more confirmation(s) needed.`,
    });
  } catch (err) {
    return errorResult(`Confirm failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleExecute(params: Record<string, unknown>) {
  const safeTxHash = readStringParam(params, 'safe_tx_hash');
  if (!safeTxHash) return errorResult('safe_tx_hash is required for execute.');

  const service = getSafeService();
  const chainId = service.resolveChainId(readStringParam(params, 'chain') ?? undefined);

  try {
    const tx = await service.getTransaction(safeTxHash, chainId);

    if (tx.isExecuted) {
      return jsonResult({
        status: 'already_executed',
        safeTxHash,
        txHash: tx.transactionHash,
        success: tx.isSuccessful,
        executedAt: tx.executionDate,
        chain: chainLabel(chainId),
      });
    }

    const canExecute = tx.confirmations.length >= tx.confirmationsRequired;

    return jsonResult({
      status: canExecute ? 'ready' : 'not_ready',
      safeTxHash,
      to: tx.to,
      value: tx.value !== '0' ? formatBalance(tx.value, 18) + ' ETH' : undefined,
      dataDecoded: tx.dataDecoded ? summarizeDecoded(tx.dataDecoded) : undefined,
      nonce: tx.nonce,
      confirmations: tx.confirmations.length,
      confirmationsRequired: tx.confirmationsRequired,
      signers: tx.confirmations.map(c => c.owner),
      chain: chainLabel(chainId),
      note: canExecute
        ? 'Transaction has enough confirmations and can be executed. Submit via the Safe app or directly on-chain.'
        : `Needs ${tx.confirmationsRequired - tx.confirmations.length} more confirmation(s) before execution.`,
    });
  } catch (err) {
    return errorResult(`Execute check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function resolveSafeParams(params: Record<string, unknown>): Promise<{
  safeAddress: string | null;
  chainId: number;
}> {
  const service = getSafeService();
  const chainId = service.resolveChainId(readStringParam(params, 'chain') ?? undefined);
  let safeAddress: string | null = readStringParam(params, 'safe_address') ?? null;

  if (safeAddress && isEnsName(safeAddress)) {
    try {
      const publicClient = requirePublicClient();
      const resolved = await resolveAddressOrEns(safeAddress, publicClient);
      safeAddress = resolved.address;
    } catch {
      // If ENS resolution fails, pass through — the API will error with a clear message
    }
  }

  return { safeAddress, chainId };
}

function formatBalance(raw: string, decimals: number): string {
  const num = Number(raw) / 10 ** decimals;
  if (num === 0) return '0';
  if (num < 0.0001) return '<0.0001';
  if (num < 1) return num.toFixed(4);
  if (num < 1000) return num.toFixed(2);
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function chainLabel(chainId: number): string {
  switch (chainId) {
    case 1: return 'ethereum';
    case 8453: return 'base';
    case 42161: return 'arbitrum';
    case 10: return 'optimism';
    case 137: return 'polygon';
    default: return String(chainId);
  }
}

function summarizeDecoded(decoded: any): string {
  if (!decoded) return '';
  const method = decoded.method ?? 'unknown';
  const params = decoded.parameters?.map((p: any) => `${p.name}=${p.value}`)?.join(', ') ?? '';
  return params ? `${method}(${params})` : method;
}
