/**
 * Transaction Status Polling Service — monitor pending and confirmed txs.
 *
 * Provides:
 * - Poll pending transaction status with exponential backoff
 * - Multi-chain tx monitoring
 * - Notification callbacks on confirmation/failure
 * - Batch monitoring for multiple txs
 * - Speed-up (gas bump) detection
 * - Block explorer link generation
 */

import { getRpcManager } from './rpc-provider.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface TxStatus {
  hash: string;
  chainId: number;
  chain: string;
  status: 'pending' | 'confirmed' | 'failed' | 'dropped' | 'unknown';
  confirmations: number;
  blockNumber: number | null;
  gasUsed: string | null;
  effectiveGasPrice: string | null;
  gasCostWei: string | null;
  from: string;
  to: string | null;
  value: string;
  explorerUrl: string;
  timestamp: number;
  error?: string;
}

export interface TxMonitorOptions {
  /** How many confirmations to consider "final". Default: 1. */
  confirmations?: number;
  /** Maximum time to wait in ms. Default: 300000 (5 minutes). */
  timeoutMs?: number;
  /** Initial poll interval in ms. Default: 2000 (2s). */
  initialIntervalMs?: number;
  /** Max poll interval in ms (after backoff). Default: 15000 (15s). */
  maxIntervalMs?: number;
  /** Callback on each status update. */
  onUpdate?: (status: TxStatus) => void;
}

export interface MonitoredTx {
  hash: string;
  chainId: number;
  startedAt: number;
  lastStatus: TxStatus;
  resolved: boolean;
}

// ── Constants ───────────────────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon',
};

const EXPLORER_URLS: Record<number, string> = {
  1: 'https://etherscan.io/tx/',
  8453: 'https://basescan.org/tx/',
  42161: 'https://arbiscan.io/tx/',
  10: 'https://optimistic.etherscan.io/tx/',
  137: 'https://polygonscan.com/tx/',
};

// ── Service ─────────────────────────────────────────────────────────────────

export class TxMonitor {
  private monitored: Map<string, MonitoredTx> = new Map();

  /**
   * Check the current status of a transaction (single poll, no waiting).
   */
  async checkStatus(hash: string, chainId = 8453): Promise<TxStatus> {
    const rpcManager = getRpcManager();
    const client = await rpcManager.getClient(chainId);
    const chain = CHAIN_NAMES[chainId] ?? String(chainId);
    const explorerUrl = (EXPLORER_URLS[chainId] ?? `https://blockscan.com/tx/`) + hash;

    try {
      // Try to get the receipt (only exists if tx is mined)
      const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null);

      if (receipt) {
        const currentBlock = await client.getBlockNumber();
        const confirmations = Number(currentBlock) - Number(receipt.blockNumber);

        return {
          hash,
          chainId,
          chain,
          status: receipt.status === 'success' ? 'confirmed' : 'failed',
          confirmations,
          blockNumber: Number(receipt.blockNumber),
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice.toString(),
          gasCostWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
          from: receipt.from,
          to: receipt.to,
          value: '0', // not in receipt, need tx for this
          explorerUrl,
          timestamp: Date.now(),
          error: receipt.status === 'reverted' ? 'Transaction reverted' : undefined,
        };
      }

      // No receipt — check if tx is in mempool
      const tx = await client.getTransaction({ hash: hash as `0x${string}` }).catch(() => null);

      if (tx) {
        return {
          hash,
          chainId,
          chain,
          status: 'pending',
          confirmations: 0,
          blockNumber: tx.blockNumber ? Number(tx.blockNumber) : null,
          gasUsed: null,
          effectiveGasPrice: null,
          gasCostWei: null,
          from: tx.from,
          to: tx.to,
          value: tx.value.toString(),
          explorerUrl,
          timestamp: Date.now(),
        };
      }

      // Neither receipt nor tx found — likely dropped or not propagated yet
      return {
        hash,
        chainId,
        chain,
        status: 'unknown',
        confirmations: 0,
        blockNumber: null,
        gasUsed: null,
        effectiveGasPrice: null,
        gasCostWei: null,
        from: '',
        to: null,
        value: '0',
        explorerUrl,
        timestamp: Date.now(),
        error: 'Transaction not found — may be pending propagation or dropped',
      };
    } catch (err) {
      return {
        hash,
        chainId,
        chain,
        status: 'unknown',
        confirmations: 0,
        blockNumber: null,
        gasUsed: null,
        effectiveGasPrice: null,
        gasCostWei: null,
        from: '',
        to: null,
        value: '0',
        explorerUrl,
        timestamp: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Wait for a transaction to be confirmed (blocking with exponential backoff).
   * Calls onUpdate callback on each poll if provided.
   */
  async waitForConfirmation(
    hash: string,
    chainId = 8453,
    options: TxMonitorOptions = {},
  ): Promise<TxStatus> {
    const {
      confirmations = 1,
      timeoutMs = 300_000,
      initialIntervalMs = 2_000,
      maxIntervalMs = 15_000,
      onUpdate,
    } = options;

    const startedAt = Date.now();
    let interval = initialIntervalMs;
    let lastStatus: TxStatus | null = null;

    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.checkStatus(hash, chainId);
      lastStatus = status;

      // Track in monitored map
      this.monitored.set(hash, {
        hash,
        chainId,
        startedAt,
        lastStatus: status,
        resolved: status.status === 'confirmed' || status.status === 'failed',
      });

      if (onUpdate) onUpdate(status);

      if (status.status === 'confirmed' && status.confirmations >= confirmations) {
        return status;
      }

      if (status.status === 'failed') {
        return status;
      }

      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(interval * 1.5, maxIntervalMs);
    }

    // Timeout
    return lastStatus ?? {
      hash,
      chainId,
      chain: CHAIN_NAMES[chainId] ?? String(chainId),
      status: 'unknown',
      confirmations: 0,
      blockNumber: null,
      gasUsed: null,
      effectiveGasPrice: null,
      gasCostWei: null,
      from: '',
      to: null,
      value: '0',
      explorerUrl: (EXPLORER_URLS[chainId] ?? '') + hash,
      timestamp: Date.now(),
      error: `Timed out waiting for confirmation after ${timeoutMs / 1000}s`,
    };
  }

  /**
   * Monitor multiple transactions in parallel.
   */
  async monitorBatch(
    txs: Array<{ hash: string; chainId?: number }>,
    options: TxMonitorOptions = {},
  ): Promise<TxStatus[]> {
    return Promise.all(
      txs.map((tx) => this.waitForConfirmation(tx.hash, tx.chainId ?? 8453, options)),
    );
  }

  /**
   * Get all currently monitored transactions.
   */
  getMonitored(): MonitoredTx[] {
    return Array.from(this.monitored.values());
  }

  /**
   * Get a specific monitored transaction.
   */
  getMonitoredTx(hash: string): MonitoredTx | undefined {
    return this.monitored.get(hash);
  }

  /**
   * Generate a block explorer URL for a transaction.
   */
  getExplorerUrl(hash: string, chainId = 8453): string {
    return (EXPLORER_URLS[chainId] ?? 'https://blockscan.com/tx/') + hash;
  }

  /**
   * Get the explorer base URL for a chain.
   */
  getExplorerBase(chainId = 8453): string {
    return EXPLORER_URLS[chainId] ?? 'https://blockscan.com';
  }

  /**
   * Get supported chains for tx monitoring.
   */
  getSupportedChains(): Array<{ chainId: number; name: string; explorer: string }> {
    return Object.entries(CHAIN_NAMES).map(([id, name]) => ({
      chainId: Number(id),
      name,
      explorer: EXPLORER_URLS[Number(id)] ?? '',
    }));
  }

  /** Clear all monitored transaction records. */
  clear(): void {
    this.monitored.clear();
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: TxMonitor | null = null;

export function getTxMonitor(): TxMonitor {
  if (!_instance) {
    _instance = new TxMonitor();
  }
  return _instance;
}

export function resetTxMonitor(): void {
  _instance = null;
}
