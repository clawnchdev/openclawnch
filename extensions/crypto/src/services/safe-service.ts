/**
 * Safe Multisig Service — Safe Transaction Service API client.
 *
 * Interacts with Safe{Wallet} (formerly Gnosis Safe) multisig wallets via
 * the Safe Transaction Service REST API. Supports Ethereum and Base.
 *
 * API: https://safe-transaction-service.safe.global
 * No SDK dependency — direct REST calls via guardedFetch.
 */

import { guardedFetch } from './endpoint-allowlist.js';

// ── Chain-specific API URLs ──────────────────────────────────────────────

const SAFE_API_URLS: Record<number, string> = {
  1: 'https://safe-transaction-mainnet.safe.global/api',
  8453: 'https://safe-transaction-base.safe.global/api',
  42161: 'https://safe-transaction-arbitrum.safe.global/api',
  10: 'https://safe-transaction-optimism.safe.global/api',
  137: 'https://safe-transaction-polygon.safe.global/api',
};

// ── Types ────────────────────────────────────────────────────────────────

export interface SafeInfo {
  address: string;
  nonce: number;
  threshold: number;
  owners: string[];
  modules: string[];
  fallbackHandler: string;
  guard: string;
  version: string;
  chainId: number;
}

export interface SafeBalance {
  tokenAddress: string | null;
  token: { name: string; symbol: string; decimals: number } | null;
  balance: string;
}

export interface SafeTransaction {
  safeTxHash: string;
  to: string;
  value: string;
  data: string | null;
  operation: number;
  nonce: number;
  submissionDate: string;
  executionDate: string | null;
  isExecuted: boolean;
  isSuccessful: boolean | null;
  confirmationsRequired: number;
  confirmations: Array<{
    owner: string;
    submissionDate: string;
    signatureType: string;
  }>;
  executor: string | null;
  transactionHash: string | null;
  dataDecoded: any | null;
}

export interface ProposeTransactionParams {
  safeAddress: string;
  to: string;
  value: string;
  data: string;
  operation?: number;
  safeTxGas?: string;
  baseGas?: string;
  gasPrice?: string;
  gasToken?: string;
  refundReceiver?: string;
  nonce?: number;
  signature: string;
  sender: string;
}

// ── Service ──────────────────────────────────────────────────────────────

export class SafeService {
  /**
   * Get Safe info (threshold, owners, nonce, version).
   */
  async getInfo(safeAddress: string, chainId = 1): Promise<SafeInfo> {
    const data = await this.apiGet(`/v1/safes/${safeAddress}/`, chainId);
    return {
      address: data.address,
      nonce: data.nonce ?? 0,
      threshold: data.threshold ?? 0,
      owners: data.owners ?? [],
      modules: data.modules ?? [],
      fallbackHandler: data.fallbackHandler ?? '',
      guard: data.guard ?? '',
      version: data.version ?? '',
      chainId,
    };
  }

  /**
   * Get Safe balances (ETH + ERC-20 tokens).
   */
  async getBalances(safeAddress: string, chainId = 1): Promise<SafeBalance[]> {
    const data = await this.apiGet(
      `/v1/safes/${safeAddress}/balances/?trusted=true&exclude_spam=true`,
      chainId,
    );
    return (data ?? []).map((b: any) => ({
      tokenAddress: b.tokenAddress,
      token: b.token ? {
        name: b.token.name,
        symbol: b.token.symbol,
        decimals: b.token.decimals,
      } : null,
      balance: b.balance ?? '0',
    }));
  }

  /**
   * Get pending (queued) transactions for a Safe.
   */
  async getPendingTransactions(
    safeAddress: string,
    chainId = 1,
    limit = 20,
  ): Promise<SafeTransaction[]> {
    const data = await this.apiGet(
      `/v1/safes/${safeAddress}/multisig-transactions/?executed=false&limit=${limit}&ordering=-nonce`,
      chainId,
    );
    return (data?.results ?? []).map(this.mapTransaction);
  }

  /**
   * Get transaction history for a Safe.
   */
  async getTransactionHistory(
    safeAddress: string,
    chainId = 1,
    limit = 20,
  ): Promise<SafeTransaction[]> {
    const data = await this.apiGet(
      `/v1/safes/${safeAddress}/multisig-transactions/?executed=true&limit=${limit}&ordering=-executionDate`,
      chainId,
    );
    return (data?.results ?? []).map(this.mapTransaction);
  }

  /**
   * Get a specific transaction by safeTxHash.
   */
  async getTransaction(safeTxHash: string, chainId = 1): Promise<SafeTransaction> {
    const data = await this.apiGet(`/v1/multisig-transactions/${safeTxHash}/`, chainId);
    return this.mapTransaction(data);
  }

  /**
   * Confirm (sign) a pending transaction.
   * The signature must be generated off-chain using the Safe signing scheme.
   */
  async confirmTransaction(
    safeTxHash: string,
    signature: string,
    chainId = 1,
  ): Promise<{ success: boolean }> {
    const baseUrl = this.getApiUrl(chainId);
    const response = await guardedFetch(
      `${baseUrl}/v1/multisig-transactions/${safeTxHash}/confirmations/`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Confirm failed (${response.status}): ${text.slice(0, 200)}`);
    }

    return { success: true };
  }

  /**
   * Propose a new transaction to a Safe.
   * Requires off-chain signature of the Safe transaction hash.
   */
  async proposeTransaction(
    params: ProposeTransactionParams,
    chainId = 1,
  ): Promise<{ success: boolean }> {
    const baseUrl = this.getApiUrl(chainId);
    const response = await guardedFetch(
      `${baseUrl}/v1/safes/${params.safeAddress}/multisig-transactions/`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: params.to,
          value: params.value,
          data: params.data || '0x',
          operation: params.operation ?? 0,
          safeTxGas: params.safeTxGas ?? '0',
          baseGas: params.baseGas ?? '0',
          gasPrice: params.gasPrice ?? '0',
          gasToken: params.gasToken ?? '0x0000000000000000000000000000000000000000',
          refundReceiver: params.refundReceiver ?? '0x0000000000000000000000000000000000000000',
          nonce: params.nonce,
          contractTransactionHash: null,
          sender: params.sender,
          signature: params.signature,
          origin: 'openclawnch',
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Propose failed (${response.status}): ${text.slice(0, 200)}`);
    }

    return { success: true };
  }

  /**
   * Check if an address is an owner of a Safe.
   */
  async isOwner(safeAddress: string, ownerAddress: string, chainId = 1): Promise<boolean> {
    const info = await this.getInfo(safeAddress, chainId);
    return info.owners.some(o => o.toLowerCase() === ownerAddress.toLowerCase());
  }

  /**
   * Resolve chain from input string.
   */
  resolveChainId(chain?: string): number {
    if (!chain) return 1;
    switch (chain.toLowerCase()) {
      case 'base': return 8453;
      case 'arbitrum': case 'arb': return 42161;
      case 'optimism': case 'op': return 10;
      case 'polygon': case 'matic': return 137;
      case 'ethereum': case 'eth': case 'mainnet': default: return 1;
    }
  }

  // ── Internal ───────────────────────────────────────────────────────

  private getApiUrl(chainId: number): string {
    const url = SAFE_API_URLS[chainId];
    if (!url) throw new Error(`Safe Transaction Service not available for chain ${chainId}.`);
    return url;
  }

  private async apiGet(path: string, chainId: number): Promise<any> {
    const baseUrl = this.getApiUrl(chainId);
    const response = await guardedFetch(`${baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Safe API ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json();
  }

  private mapTransaction(tx: any): SafeTransaction {
    return {
      safeTxHash: tx.safeTxHash ?? '',
      to: tx.to ?? '',
      value: tx.value ?? '0',
      data: tx.data,
      operation: tx.operation ?? 0,
      nonce: tx.nonce ?? 0,
      submissionDate: tx.submissionDate ?? '',
      executionDate: tx.executionDate,
      isExecuted: tx.isExecuted ?? false,
      isSuccessful: tx.isSuccessful,
      confirmationsRequired: tx.confirmationsRequired ?? 0,
      confirmations: (tx.confirmations ?? []).map((c: any) => ({
        owner: c.owner ?? '',
        submissionDate: c.submissionDate ?? '',
        signatureType: c.signatureType ?? '',
      })),
      executor: tx.executor,
      transactionHash: tx.transactionHash,
      dataDecoded: tx.dataDecoded,
    };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: SafeService | null = null;

export function getSafeService(): SafeService {
  if (!_instance) {
    _instance = new SafeService();
  }
  return _instance;
}

export function resetSafeService(): void {
  _instance = null;
}
