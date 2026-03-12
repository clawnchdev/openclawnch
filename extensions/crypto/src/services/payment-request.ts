/**
 * Payment Request Service — Generate payment links and invoices.
 *
 * Creates shareable payment requests that encode recipient, amount, token,
 * and chain info into a URL. Supports both crypto-native (EIP-681 style)
 * and fiat payment requests.
 *
 * Payment requests are persisted to disk for tracking.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────

export type PaymentRequestStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

export interface PaymentRequest {
  id: string;
  /** Who created the request (wallet address). */
  createdBy: string;
  /** Recipient wallet address. */
  recipientAddress: string;
  /** Amount in human-readable units. */
  amount: string;
  /** Token symbol (e.g. "ETH", "USDC"). */
  token: string;
  /** Token contract address (undefined for native token). */
  tokenAddress?: string;
  /** Chain ID. */
  chainId: number;
  /** Optional memo/note. */
  memo?: string;
  /** Fiat equivalent at time of creation. */
  fiatEquivalent?: { amount: number; currency: string };
  /** Payment request status. */
  status: PaymentRequestStatus;
  /** Payment URL (EIP-681 or custom). */
  paymentUrl: string;
  /** Tx hash once paid. */
  txHash?: string;
  createdAt: number;
  updatedAt: number;
  /** Expiry timestamp (ms). */
  expiresAt?: number;
}

// ─── EIP-681 Payment URL Builder ────────────────────────────────────────

const CHAIN_SHORT_NAMES: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
  137: 'polygon',
};

/**
 * Build an EIP-681 payment URL.
 * Format: ethereum:<address>@<chainId>/transfer?address=<to>&uint256=<amount>
 * For native: ethereum:<address>@<chainId>?value=<weiAmount>
 */
function buildPaymentUrl(params: {
  recipientAddress: string;
  amount: string;
  token: string;
  tokenAddress?: string;
  chainId: number;
}): string {
  const prefix = CHAIN_SHORT_NAMES[params.chainId] ?? 'ethereum';

  if (params.tokenAddress) {
    // ERC-20 transfer
    return `${prefix}:${params.tokenAddress}@${params.chainId}/transfer?address=${params.recipientAddress}&uint256=${params.amount}`;
  }

  // Native token transfer
  return `${prefix}:${params.recipientAddress}@${params.chainId}?value=${params.amount}`;
}

// ─── Service ────────────────────────────────────────────────────────────

export class PaymentRequestService {
  private requests = new Map<string, PaymentRequest>();
  private stateDir: string;

  constructor(opts?: { stateDir?: string }) {
    this.stateDir = opts?.stateDir ?? join(
      process.env.HOME ?? '', '.openclawnch', 'payment-requests'
    );
    this.loadState();
  }

  /** Create a new payment request. */
  create(params: {
    createdBy: string;
    recipientAddress: string;
    amount: string;
    token: string;
    tokenAddress?: string;
    chainId?: number;
    memo?: string;
    fiatEquivalent?: { amount: number; currency: string };
    expiresInMs?: number;
  }): PaymentRequest {
    const chainId = params.chainId ?? 8453;
    const id = `pr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const paymentUrl = buildPaymentUrl({
      recipientAddress: params.recipientAddress,
      amount: params.amount,
      token: params.token,
      tokenAddress: params.tokenAddress,
      chainId,
    });

    const request: PaymentRequest = {
      id,
      createdBy: params.createdBy,
      recipientAddress: params.recipientAddress,
      amount: params.amount,
      token: params.token,
      tokenAddress: params.tokenAddress,
      chainId,
      memo: params.memo,
      fiatEquivalent: params.fiatEquivalent,
      status: 'pending',
      paymentUrl,
      createdAt: now,
      updatedAt: now,
      expiresAt: params.expiresInMs ? now + params.expiresInMs : undefined,
    };

    this.requests.set(id, request);
    this.saveState();
    return request;
  }

  /** Get a payment request by ID. */
  get(id: string): PaymentRequest | null {
    const req = this.requests.get(id) ?? null;
    if (req && req.expiresAt && Date.now() > req.expiresAt && req.status === 'pending') {
      req.status = 'expired';
      req.updatedAt = Date.now();
      this.saveState();
    }
    return req;
  }

  /** Mark a payment request as paid. */
  markPaid(id: string, txHash: string): PaymentRequest | null {
    const req = this.requests.get(id);
    if (!req) return null;
    req.status = 'paid';
    req.txHash = txHash;
    req.updatedAt = Date.now();
    this.saveState();
    return req;
  }

  /** Cancel a payment request. */
  cancel(id: string): PaymentRequest | null {
    const req = this.requests.get(id);
    if (!req) return null;
    req.status = 'cancelled';
    req.updatedAt = Date.now();
    this.saveState();
    return req;
  }

  /** List all requests (optionally filtered by creator). */
  list(createdBy?: string): PaymentRequest[] {
    const all = Array.from(this.requests.values());
    // Check for expired
    const now = Date.now();
    for (const req of all) {
      if (req.expiresAt && now > req.expiresAt && req.status === 'pending') {
        req.status = 'expired';
        req.updatedAt = now;
      }
    }
    if (!createdBy) return all;
    return all.filter(r => r.createdBy === createdBy);
  }

  /** Clear all state (for testing). */
  clear(): void {
    this.requests.clear();
  }

  // ── Persistence ─────────────────────────────────────────────────

  private loadState(): void {
    try {
      const filePath = join(this.stateDir, 'requests.json');
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        for (const r of data) {
          this.requests.set(r.id, r);
        }
      }
    } catch { /* fresh start */ }
  }

  private saveState(): void {
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
      const filePath = join(this.stateDir, 'requests.json');
      writeFileSync(filePath, JSON.stringify(Array.from(this.requests.values()), null, 2), 'utf8');
    } catch { /* best effort */ }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: PaymentRequestService | null = null;

export function getPaymentRequestService(opts?: { stateDir?: string }): PaymentRequestService {
  if (!instance) {
    instance = new PaymentRequestService(opts);
  }
  return instance;
}

export function resetPaymentRequestService(): void {
  instance?.clear();
  instance = null;
}
