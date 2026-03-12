/**
 * Multi-Currency Accounting Service — unified view of crypto + fiat balances.
 *
 * Aggregates balances across:
 * - On-chain crypto (via wallet/publicClient)
 * - Fiat accounts (via FiatService bank accounts + transfer history)
 * - Pending transfers (in-flight fiat off-ramps/on-ramps)
 *
 * Provides a single portfolio view with fiat-equivalent totals, per-asset
 * breakdown, and cost basis integration for P&L tracking across both worlds.
 *
 * This is a read-only aggregation layer — it does not hold funds or
 * execute transactions. It queries other services for current state.
 */

import { getFiatService, type FiatTransfer, type FiatCurrency } from './fiat-service.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface AssetBalance {
  /** Asset identifier (token symbol or fiat currency code). */
  asset: string;
  /** Asset type. */
  type: 'crypto' | 'fiat' | 'pending';
  /** Balance amount (in asset's native units). */
  balance: number;
  /** USD equivalent. */
  usdValue: number;
  /** Source (e.g., "wallet", "bridge_bank", "moonpay_pending"). */
  source: string;
  /** Chain ID (crypto only). */
  chainId?: number;
  /** Token contract address (crypto ERC-20 only). */
  tokenAddress?: string;
  /** Last updated timestamp. */
  updatedAt: number;
}

export interface PortfolioSummary {
  /** Total portfolio value in USD. */
  totalUsd: number;
  /** Breakdown by asset type. */
  cryptoUsd: number;
  fiatUsd: number;
  pendingUsd: number;
  /** Individual asset balances. */
  assets: AssetBalance[];
  /** Fiat currency for display. */
  displayCurrency: FiatCurrency;
  /** Snapshot timestamp. */
  snapshotAt: number;
}

export interface AccountingEntry {
  id: string;
  timestamp: number;
  type: 'crypto_in' | 'crypto_out' | 'fiat_in' | 'fiat_out' | 'swap' | 'fee';
  /** Asset moving. */
  asset: string;
  /** Amount (positive = inflow, negative = outflow). */
  amount: number;
  /** USD value at time of transaction. */
  usdValue: number;
  /** Reference to source (tx hash, transfer ID, etc.). */
  reference?: string;
  /** Counterparty (address, bank, etc.). */
  counterparty?: string;
  /** Notes. */
  note?: string;
}

// ─── Exchange Rates ─────────────────────────────────────────────────────

// Rough fiat-to-USD rates for multi-currency display.
// In production these would come from a forex API.
const FIAT_TO_USD: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.74,
  AUD: 0.65,
  CHF: 1.13,
  JPY: 0.0067,
};

function fiatToUsd(amount: number, currency: string): number {
  const rate = FIAT_TO_USD[currency.toUpperCase()] ?? 1;
  return amount * rate;
}

// ─── Service ────────────────────────────────────────────────────────────

export class MultiCurrencyAccountingService {
  private entries: AccountingEntry[] = [];
  private cryptoBalanceProvider?: () => Promise<AssetBalance[]>;
  private cryptoPriceProvider?: (token: string) => Promise<number>;

  /**
   * Set the provider for on-chain crypto balances.
   * Called during plugin init to wire in wallet + publicClient.
   */
  setCryptoBalanceProvider(fn: () => Promise<AssetBalance[]>): void {
    this.cryptoBalanceProvider = fn;
  }

  /**
   * Set the provider for crypto price lookups.
   * Called during plugin init to wire in price service.
   */
  setCryptoPriceProvider(fn: (token: string) => Promise<number>): void {
    this.cryptoPriceProvider = fn;
  }

  /**
   * Get a unified portfolio snapshot across all asset types.
   */
  async getPortfolio(opts?: { displayCurrency?: FiatCurrency }): Promise<PortfolioSummary> {
    const displayCurrency = opts?.displayCurrency ?? 'USD';
    const assets: AssetBalance[] = [];
    const now = Date.now();

    // 1. Crypto balances (from wallet)
    if (this.cryptoBalanceProvider) {
      try {
        const cryptoAssets = await this.cryptoBalanceProvider();
        assets.push(...cryptoAssets);
      } catch { /* wallet not connected or unavailable */ }
    }

    // 2. Fiat balances from transfer history (net settled amounts)
    const fiat = getFiatService();
    if (fiat.isAvailable()) {
      const transfers = fiat.listTransfers();
      const fiatBalances = this.aggregateFiatBalances(transfers);

      for (const [currency, balance] of Object.entries(fiatBalances)) {
        if (balance.settled !== 0) {
          assets.push({
            asset: currency,
            type: 'fiat',
            balance: balance.settled,
            usdValue: fiatToUsd(balance.settled, currency),
            source: 'fiat_settled',
            updatedAt: now,
          });
        }
        if (balance.pending !== 0) {
          assets.push({
            asset: currency,
            type: 'pending',
            balance: balance.pending,
            usdValue: fiatToUsd(balance.pending, currency),
            source: 'fiat_pending',
            updatedAt: now,
          });
        }
      }
    }

    // 3. Compute totals
    let cryptoUsd = 0, fiatUsd = 0, pendingUsd = 0;
    for (const a of assets) {
      switch (a.type) {
        case 'crypto': cryptoUsd += a.usdValue; break;
        case 'fiat': fiatUsd += a.usdValue; break;
        case 'pending': pendingUsd += a.usdValue; break;
      }
    }

    return {
      totalUsd: cryptoUsd + fiatUsd + pendingUsd,
      cryptoUsd,
      fiatUsd,
      pendingUsd,
      assets: assets.sort((a, b) => b.usdValue - a.usdValue),
      displayCurrency,
      snapshotAt: now,
    };
  }

  /**
   * Record an accounting entry (for audit trail).
   */
  recordEntry(entry: Omit<AccountingEntry, 'id' | 'timestamp'>): AccountingEntry {
    const full: AccountingEntry = {
      id: `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...entry,
    };
    this.entries.push(full);
    return full;
  }

  /**
   * Get accounting entries, optionally filtered.
   */
  getEntries(opts?: {
    asset?: string;
    type?: AccountingEntry['type'];
    since?: number;
    limit?: number;
  }): AccountingEntry[] {
    let filtered = this.entries;
    if (opts?.asset) filtered = filtered.filter(e => e.asset === opts.asset);
    if (opts?.type) filtered = filtered.filter(e => e.type === opts.type);
    if (opts?.since) filtered = filtered.filter(e => e.timestamp >= opts.since!);
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    if (opts?.limit) filtered = filtered.slice(0, opts.limit);
    return filtered;
  }

  /**
   * Get net flow summary for a period.
   */
  getNetFlow(sinceMs?: number): {
    totalInUsd: number;
    totalOutUsd: number;
    netUsd: number;
    byAsset: Record<string, { inflow: number; outflow: number; net: number }>;
  } {
    const since = sinceMs ?? 0;
    const relevant = this.entries.filter(e => e.timestamp >= since);

    let totalInUsd = 0, totalOutUsd = 0;
    const byAsset: Record<string, { inflow: number; outflow: number; net: number }> = {};

    for (const e of relevant) {
      const entry = byAsset[e.asset] ?? { inflow: 0, outflow: 0, net: 0 };

      if (e.amount > 0) {
        totalInUsd += e.usdValue;
        entry.inflow += Math.abs(e.amount);
      } else {
        totalOutUsd += Math.abs(e.usdValue);
        entry.outflow += Math.abs(e.amount);
      }
      entry.net = entry.inflow - entry.outflow;
      byAsset[e.asset] = entry;
    }

    return {
      totalInUsd,
      totalOutUsd,
      netUsd: totalInUsd - totalOutUsd,
      byAsset,
    };
  }

  /** Clear all state (for testing). */
  clear(): void {
    this.entries = [];
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private aggregateFiatBalances(transfers: FiatTransfer[]): Record<string, { settled: number; pending: number }> {
    const balances: Record<string, { settled: number; pending: number }> = {};

    for (const t of transfers) {
      const currency = t.fiatCurrency;
      if (!balances[currency]) balances[currency] = { settled: 0, pending: 0 };

      if (t.status === 'completed') {
        if (t.direction === 'off_ramp') {
          balances[currency]!.settled += t.fiatAmount - t.fee;
        } else {
          balances[currency]!.settled -= t.fiatAmount + t.fee;
        }
      } else if (t.status === 'pending' || t.status === 'processing') {
        if (t.direction === 'off_ramp') {
          balances[currency]!.pending += t.fiatAmount - t.fee;
        } else {
          balances[currency]!.pending -= t.fiatAmount + t.fee;
        }
      }
    }

    return balances;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: MultiCurrencyAccountingService | null = null;

export function getAccountingService(): MultiCurrencyAccountingService {
  if (!instance) {
    instance = new MultiCurrencyAccountingService();
  }
  return instance;
}

export function resetAccountingService(): void {
  instance?.clear();
  instance = null;
}
