/**
 * Fiat Rails Service — off-ramps, on-ramps, and payment routing.
 *
 * Provides a unified interface for moving money between crypto and fiat.
 * Supports multiple providers (Bridge.xyz, MoonPay, Coinbase) with a
 * preference-based fallback system.
 *
 * Architecture:
 * - Provider-agnostic interface: all providers implement FiatProvider
 * - Quote aggregation: fetch quotes from multiple providers, pick best
 * - Idempotent transfers: each transfer gets a unique ID for tracking
 * - Persistent state: transfer history saved to disk for accounting
 *
 * Env vars:
 *   BRIDGE_API_KEY         — Bridge.xyz API key
 *   MOONPAY_API_KEY        — MoonPay API key (optional)
 *   COINBASE_API_KEY       — Coinbase Pay API key (optional)
 *   FIAT_CURRENCY          — Default fiat currency (default: USD)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────

export type FiatDirection = 'off_ramp' | 'on_ramp';
export type FiatCurrency = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD' | 'CHF' | 'JPY';
export type FiatTransferStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface FiatQuote {
  provider: string;
  direction: FiatDirection;
  cryptoAmount: number;
  cryptoToken: string;
  cryptoChainId: number;
  fiatAmount: number;
  fiatCurrency: FiatCurrency;
  /** Fee in fiat currency. */
  fee: number;
  /** Exchange rate: 1 crypto token = X fiat. */
  exchangeRate: number;
  /** How long the quote is valid (ms). */
  expiresIn: number;
  /** Provider-specific quote ID. */
  quoteId: string;
  /** Estimated settlement time. */
  estimatedSettlement: string;
}

export interface FiatTransfer {
  id: string;
  userId: string;
  direction: FiatDirection;
  provider: string;
  cryptoAmount: number;
  cryptoToken: string;
  cryptoChainId: number;
  fiatAmount: number;
  fiatCurrency: FiatCurrency;
  fee: number;
  status: FiatTransferStatus;
  /** Provider-specific transfer/order ID. */
  externalId?: string;
  /** Crypto tx hash (for off-ramps: the send-to-provider tx). */
  txHash?: string;
  /** Bank account identifier (masked). */
  bankAccount?: string;
  createdAt: number;
  updatedAt: number;
  /** Error message if failed. */
  error?: string;
}

export interface BankAccount {
  id: string;
  label: string;
  /** Masked account number (e.g. "****1234"). */
  maskedNumber: string;
  bankName: string;
  currency: FiatCurrency;
  /** Provider-specific account ID. */
  externalId: string;
  provider: string;
}

export interface FiatProvider {
  name: string;
  isConfigured(): boolean;
  getQuote(params: {
    direction: FiatDirection;
    cryptoToken: string;
    cryptoChainId: number;
    amount: number;
    amountType: 'crypto' | 'fiat';
    fiatCurrency: FiatCurrency;
  }): Promise<FiatQuote>;
  executeTransfer(quote: FiatQuote, opts: {
    walletAddress: string;
    bankAccountId?: string;
  }): Promise<{ transferId: string; depositAddress?: string; instructions?: string }>;
  getTransferStatus(transferId: string): Promise<FiatTransferStatus>;
  listBankAccounts?(): Promise<BankAccount[]>;
}

// ─── Bridge.xyz Provider ────────────────────────────────────────────────

class BridgeProvider implements FiatProvider {
  name = 'bridge';

  isConfigured(): boolean {
    return !!process.env.BRIDGE_API_KEY;
  }

  private async apiFetch(path: string, opts?: RequestInit): Promise<any> {
    const apiKey = process.env.BRIDGE_API_KEY;
    if (!apiKey) throw new Error('BRIDGE_API_KEY not set');

    const res = await fetch(`https://api.bridge.xyz/v0${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
        ...(opts?.headers as Record<string, string> ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Bridge API ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async getQuote(params: {
    direction: FiatDirection;
    cryptoToken: string;
    cryptoChainId: number;
    amount: number;
    amountType: 'crypto' | 'fiat';
    fiatCurrency: FiatCurrency;
  }): Promise<FiatQuote> {
    // Bridge uses /transfers/quote endpoint
    const chainMap: Record<number, string> = {
      1: 'ethereum', 8453: 'base', 42161: 'arbitrum',
      10: 'optimism', 137: 'polygon', 43114: 'avalanche',
    };
    const chain = chainMap[params.cryptoChainId] ?? 'base';

    const body: Record<string, unknown> = {
      source_currency: params.direction === 'off_ramp' ? params.cryptoToken.toLowerCase() : params.fiatCurrency.toLowerCase(),
      destination_currency: params.direction === 'off_ramp' ? params.fiatCurrency.toLowerCase() : params.cryptoToken.toLowerCase(),
      chain,
    };

    if (params.amountType === 'crypto') {
      body.amount = String(params.amount);
    } else {
      body.destination_amount = String(params.amount);
    }

    const data = await this.apiFetch('/transfers/quote', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const cryptoAmt = parseFloat(data.source_amount ?? data.amount ?? params.amount);
    const fiatAmt = parseFloat(data.destination_amount ?? data.fiat_amount ?? params.amount);
    const fee = parseFloat(data.fee ?? '0');

    return {
      provider: 'bridge',
      direction: params.direction,
      cryptoAmount: params.direction === 'off_ramp' ? cryptoAmt : fiatAmt,
      cryptoToken: params.cryptoToken,
      cryptoChainId: params.cryptoChainId,
      fiatAmount: params.direction === 'off_ramp' ? fiatAmt : cryptoAmt,
      fiatCurrency: params.fiatCurrency,
      fee,
      exchangeRate: fiatAmt / (cryptoAmt || 1),
      expiresIn: 60_000, // 1 minute
      quoteId: data.id ?? `bridge_${Date.now()}`,
      estimatedSettlement: data.estimated_settlement ?? '1-3 business days',
    };
  }

  async executeTransfer(quote: FiatQuote, opts: {
    walletAddress: string;
    bankAccountId?: string;
  }): Promise<{ transferId: string; depositAddress?: string; instructions?: string }> {
    const data = await this.apiFetch('/transfers', {
      method: 'POST',
      body: JSON.stringify({
        quote_id: quote.quoteId,
        source_address: opts.walletAddress,
        external_account_id: opts.bankAccountId,
      }),
    });

    return {
      transferId: data.id ?? `bridge_tx_${Date.now()}`,
      depositAddress: data.deposit_address,
      instructions: data.instructions ?? `Transfer ${quote.cryptoAmount} ${quote.cryptoToken} to the deposit address.`,
    };
  }

  async getTransferStatus(transferId: string): Promise<FiatTransferStatus> {
    const data = await this.apiFetch(`/transfers/${transferId}`);
    const statusMap: Record<string, FiatTransferStatus> = {
      pending: 'pending', processing: 'processing', completed: 'completed',
      failed: 'failed', cancelled: 'cancelled',
    };
    return statusMap[data.status] ?? 'pending';
  }

  async listBankAccounts(): Promise<BankAccount[]> {
    try {
      const data = await this.apiFetch('/external_accounts');
      return (data.data ?? []).map((a: any) => ({
        id: a.id,
        label: a.account_name ?? a.label ?? 'Bank Account',
        maskedNumber: a.last_4 ? `****${a.last_4}` : '****',
        bankName: a.bank_name ?? 'Unknown',
        currency: (a.currency ?? 'USD').toUpperCase() as FiatCurrency,
        externalId: a.id,
        provider: 'bridge',
      }));
    } catch {
      return [];
    }
  }
}

// ─── MoonPay Provider (Stub) ────────────────────────────────────────────
// MoonPay requires a widget-based flow for KYC. The service provides
// quote information; actual execution redirects users to the MoonPay widget.

class MoonPayProvider implements FiatProvider {
  name = 'moonpay';

  isConfigured(): boolean {
    return !!process.env.MOONPAY_API_KEY;
  }

  async getQuote(params: {
    direction: FiatDirection;
    cryptoToken: string;
    cryptoChainId: number;
    amount: number;
    amountType: 'crypto' | 'fiat';
    fiatCurrency: FiatCurrency;
  }): Promise<FiatQuote> {
    const apiKey = process.env.MOONPAY_API_KEY;
    if (!apiKey) throw new Error('MOONPAY_API_KEY not set');

    const endpoint = params.direction === 'on_ramp'
      ? 'https://api.moonpay.com/v3/currencies/quote'
      : 'https://api.moonpay.com/v3/sell_quotes';

    const queryParams = new URLSearchParams({
      apiKey,
      baseCurrencyCode: params.fiatCurrency.toLowerCase(),
      currencyCode: params.cryptoToken.toLowerCase(),
      baseCurrencyAmount: String(params.amountType === 'fiat' ? params.amount : ''),
      quoteCurrencyAmount: String(params.amountType === 'crypto' ? params.amount : ''),
    });

    const res = await fetch(`${endpoint}?${queryParams}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`MoonPay ${res.status}`);
    const data: any = await res.json();

    return {
      provider: 'moonpay',
      direction: params.direction,
      cryptoAmount: parseFloat(data.quoteCurrencyAmount ?? params.amount),
      cryptoToken: params.cryptoToken,
      cryptoChainId: params.cryptoChainId,
      fiatAmount: parseFloat(data.baseCurrencyAmount ?? params.amount),
      fiatCurrency: params.fiatCurrency,
      fee: parseFloat(data.feeAmount ?? data.totalFee ?? '0'),
      exchangeRate: parseFloat(data.quoteCurrencyPrice ?? '0'),
      expiresIn: 30_000,
      quoteId: `moonpay_${Date.now()}`,
      estimatedSettlement: 'Instant to 1 business day',
    };
  }

  async executeTransfer(_quote: FiatQuote, _opts: {
    walletAddress: string;
  }): Promise<{ transferId: string; instructions?: string }> {
    // MoonPay requires widget redirect — return instructions
    const apiKey = process.env.MOONPAY_API_KEY;
    const widgetUrl = `https://buy.moonpay.com?apiKey=${apiKey}&currencyCode=${_quote.cryptoToken.toLowerCase()}&walletAddress=${_opts.walletAddress}`;
    return {
      transferId: `moonpay_${Date.now()}`,
      instructions: `Complete the purchase at: ${widgetUrl}`,
    };
  }

  async getTransferStatus(_transferId: string): Promise<FiatTransferStatus> {
    return 'pending'; // MoonPay status requires webhook
  }
}

// ─── Fiat Service ───────────────────────────────────────────────────────

export class FiatService {
  private providers: FiatProvider[] = [];
  private transfers = new Map<string, FiatTransfer>();
  private stateDir: string;

  constructor(opts?: { stateDir?: string }) {
    this.stateDir = opts?.stateDir ?? join(
      process.env.HOME ?? '', '.openclawnch', 'fiat'
    );

    // Register providers in preference order
    this.providers.push(new BridgeProvider());
    this.providers.push(new MoonPayProvider());

    this.loadState();
  }

  // ── Provider Discovery ──────────────────────────────────────────────

  /** Get configured providers. */
  getConfiguredProviders(): string[] {
    return this.providers.filter(p => p.isConfigured()).map(p => p.name);
  }

  /** Check if any fiat provider is configured. */
  isAvailable(): boolean {
    return this.providers.some(p => p.isConfigured());
  }

  // ── Quotes ──────────────────────────────────────────────────────────

  /** Get quotes from all configured providers. */
  async getQuotes(params: {
    direction: FiatDirection;
    cryptoToken: string;
    cryptoChainId?: number;
    amount: number;
    amountType?: 'crypto' | 'fiat';
    fiatCurrency?: FiatCurrency;
  }): Promise<FiatQuote[]> {
    const configured = this.providers.filter(p => p.isConfigured());
    if (configured.length === 0) throw new Error('No fiat providers configured. Set BRIDGE_API_KEY or MOONPAY_API_KEY.');

    const results = await Promise.allSettled(
      configured.map(p => p.getQuote({
        direction: params.direction,
        cryptoToken: params.cryptoToken,
        cryptoChainId: params.cryptoChainId ?? 8453,
        amount: params.amount,
        amountType: params.amountType ?? 'crypto',
        fiatCurrency: params.fiatCurrency ?? 'USD',
      }))
    );

    const quotes: FiatQuote[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') quotes.push(r.value);
    }

    // Sort by best rate (lowest fee for off-ramp, highest crypto for on-ramp)
    quotes.sort((a, b) => {
      if (params.direction === 'off_ramp') {
        return (b.fiatAmount - b.fee) - (a.fiatAmount - a.fee); // highest payout first
      }
      return (b.cryptoAmount) - (a.cryptoAmount); // most crypto first
    });

    return quotes;
  }

  // ── Transfer Execution ──────────────────────────────────────────────

  /** Execute a fiat transfer using a quote. */
  async executeTransfer(quote: FiatQuote, opts: {
    userId: string;
    walletAddress: string;
    bankAccountId?: string;
  }): Promise<FiatTransfer> {
    const provider = this.providers.find(p => p.name === quote.provider);
    if (!provider) throw new Error(`Provider "${quote.provider}" not found`);

    const result = await provider.executeTransfer(quote, {
      walletAddress: opts.walletAddress,
      bankAccountId: opts.bankAccountId,
    });

    const transfer: FiatTransfer = {
      id: `fiat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId: opts.userId,
      direction: quote.direction,
      provider: quote.provider,
      cryptoAmount: quote.cryptoAmount,
      cryptoToken: quote.cryptoToken,
      cryptoChainId: quote.cryptoChainId,
      fiatAmount: quote.fiatAmount,
      fiatCurrency: quote.fiatCurrency,
      fee: quote.fee,
      status: 'pending',
      externalId: result.transferId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.transfers.set(transfer.id, transfer);
    this.saveState();

    return transfer;
  }

  // ── Status Tracking ─────────────────────────────────────────────────

  /** Check transfer status from provider. */
  async refreshTransferStatus(transferId: string): Promise<FiatTransfer | null> {
    const transfer = this.transfers.get(transferId);
    if (!transfer || !transfer.externalId) return transfer ?? null;

    const provider = this.providers.find(p => p.name === transfer.provider);
    if (!provider) return transfer;

    try {
      const status = await provider.getTransferStatus(transfer.externalId);
      transfer.status = status;
      transfer.updatedAt = Date.now();
      this.saveState();
    } catch { /* keep existing status */ }

    return transfer;
  }

  /** Get transfer by ID. */
  getTransfer(transferId: string): FiatTransfer | null {
    return this.transfers.get(transferId) ?? null;
  }

  /** List all transfers for a user. */
  listTransfers(userId?: string): FiatTransfer[] {
    const all = Array.from(this.transfers.values());
    if (!userId) return all;
    return all.filter(t => t.userId === userId);
  }

  // ── Bank Accounts ───────────────────────────────────────────────────

  /** List linked bank accounts from configured providers. */
  async listBankAccounts(): Promise<BankAccount[]> {
    const accounts: BankAccount[] = [];
    for (const provider of this.providers) {
      if (provider.isConfigured() && provider.listBankAccounts) {
        try {
          const providerAccounts = await provider.listBankAccounts();
          accounts.push(...providerAccounts);
        } catch { /* skip provider */ }
      }
    }
    return accounts;
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private loadState(): void {
    try {
      const filePath = join(this.stateDir, 'transfers.json');
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        for (const t of data) {
          this.transfers.set(t.id, t);
        }
      }
    } catch { /* fresh start */ }
  }

  private saveState(): void {
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
      const filePath = join(this.stateDir, 'transfers.json');
      writeFileSync(filePath, JSON.stringify(Array.from(this.transfers.values()), null, 2), 'utf8');
    } catch { /* best effort */ }
  }

  /** Clear all state (for testing). */
  clear(): void {
    this.transfers.clear();
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: FiatService | null = null;

export function getFiatService(opts?: { stateDir?: string }): FiatService {
  if (!instance) {
    instance = new FiatService(opts);
  }
  return instance;
}

export function resetFiatService(): void {
  instance?.clear();
  instance = null;
}
