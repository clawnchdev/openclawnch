/**
 * Fiat Payment Tool — off-ramps, on-ramps, and fiat quote aggregation.
 *
 * Provides a unified interface for moving money between crypto and fiat
 * via Bridge.xyz and MoonPay providers. Aggregates quotes from all
 * configured providers and picks the best rate.
 *
 * Actions:
 *   quote      — Get aggregated quotes for off-ramp or on-ramp
 *   off_ramp   — Execute a crypto → fiat transfer
 *   on_ramp    — Execute a fiat → crypto purchase
 *   status     — Check transfer status
 *   accounts   — List linked bank accounts
 *   history    — View recent fiat transfer history
 *
 * Requires env vars: BRIDGE_API_KEY or MOONPAY_API_KEY (at least one).
 *
 * @see fiat-service.ts for provider implementations
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { getWalletState } from '../services/walletconnect-service.js';
import { getFiatService, type FiatDirection, type FiatCurrency } from '../services/fiat-service.js';
import { checkToolConfig } from '../services/tool-config-service.js';

const ACTIONS = ['quote', 'off_ramp', 'on_ramp', 'status', 'accounts', 'history'] as const;

const FIAT_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY'] as const;

const FiatPaymentSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'quote: get aggregated quotes from all providers. ' +
      'off_ramp: sell crypto for fiat (requires wallet). ' +
      'on_ramp: buy crypto with fiat. ' +
      'status: check transfer status. ' +
      'accounts: list linked bank accounts. ' +
      'history: view recent fiat transfers.',
  }),
  direction: Type.Optional(stringEnum(['off_ramp', 'on_ramp'] as const, {
    description: 'Direction for quote action. off_ramp = crypto→fiat, on_ramp = fiat→crypto.',
  })),
  crypto_token: Type.Optional(Type.String({
    description: 'Crypto token symbol (e.g. "USDC", "ETH"). Default: USDC.',
  })),
  chain_id: Type.Optional(Type.Number({
    description: 'Chain ID for the crypto side. Default: 8453 (Base).',
  })),
  amount: Type.Optional(Type.Number({
    description: 'Amount to convert. Interpretation depends on amount_type.',
  })),
  amount_type: Type.Optional(stringEnum(['crypto', 'fiat'] as const, {
    description: 'Whether amount is in crypto or fiat. Default: crypto.',
  })),
  fiat_currency: Type.Optional(stringEnum(FIAT_CURRENCIES, {
    description: 'Fiat currency code. Default: USD.',
  })),
  transfer_id: Type.Optional(Type.String({
    description: 'Transfer ID for status check.',
  })),
  bank_account_id: Type.Optional(Type.String({
    description: 'Bank account ID for off-ramp execution.',
  })),
  provider: Type.Optional(Type.String({
    description: 'Preferred provider (e.g. "bridge", "moonpay"). Optional — best rate chosen by default.',
  })),
});

export function createFiatPaymentTool() {
  return {
    name: 'fiat_payment',
    label: 'Fiat Payment',
    ownerOnly: true,
    description:
      'Fiat on-ramps and off-ramps — buy crypto with fiat or sell crypto for fiat. ' +
      'Aggregates quotes from Bridge.xyz and MoonPay. Use "quote" to compare rates, ' +
      '"off_ramp" to sell, "on_ramp" to buy.',
    parameters: FiatPaymentSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      // Check configuration
      const notReady = checkToolConfig('fiat_payment');
      if (notReady) return notReady;

      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'quote':
          return handleQuote(params);
        case 'off_ramp':
          return handleOffRamp(params);
        case 'on_ramp':
          return handleOnRamp(params);
        case 'status':
          return handleStatus(params);
        case 'accounts':
          return handleAccounts();
        case 'history':
          return handleHistory(params);
        default:
          return errorResult(`Unknown action: ${action}. Use: ${ACTIONS.join(', ')}`);
      }
    },
  };
}

// ─── Action Handlers ──────────────────────────────────────────────────────

async function handleQuote(params: Record<string, unknown>) {
  const directionInput = readStringParam(params, 'direction') ?? 'off_ramp';
  const direction = directionInput as FiatDirection;
  const cryptoToken = readStringParam(params, 'crypto_token') ?? readStringParam(params, 'cryptoToken') ?? 'USDC';
  const chainId = readNumberParam(params, 'chain_id') ?? readNumberParam(params, 'chainId') ?? 8453;
  const amount = readNumberParam(params, 'amount', { required: true })!;
  const amountType = (readStringParam(params, 'amount_type') ?? readStringParam(params, 'amountType') ?? 'crypto') as 'crypto' | 'fiat';
  const fiatCurrency = (readStringParam(params, 'fiat_currency') ?? readStringParam(params, 'fiatCurrency') ?? 'USD') as FiatCurrency;

  const fiat = getFiatService();
  if (!fiat.isAvailable()) {
    return errorResult('No fiat providers configured. Set BRIDGE_API_KEY or MOONPAY_API_KEY.');
  }

  try {
    const quotes = await fiat.getQuotes({
      direction,
      cryptoToken,
      cryptoChainId: chainId,
      amount,
      amountType,
      fiatCurrency,
    });

    if (quotes.length === 0) {
      return errorResult('No quotes available. Providers may be temporarily unavailable.');
    }

    return jsonResult({
      direction,
      cryptoToken,
      chainId,
      amount,
      amountType,
      fiatCurrency,
      quoteCount: quotes.length,
      quotes: quotes.map((q, idx) => ({
        rank: idx + 1,
        provider: q.provider,
        cryptoAmount: q.cryptoAmount,
        fiatAmount: q.fiatAmount,
        fee: q.fee,
        netFiat: direction === 'off_ramp' ? q.fiatAmount - q.fee : q.fiatAmount,
        exchangeRate: q.exchangeRate,
        estimatedSettlement: q.estimatedSettlement,
        quoteId: q.quoteId,
        expiresInMs: q.expiresIn,
      })),
      bestProvider: quotes[0]!.provider,
      configuredProviders: fiat.getConfiguredProviders(),
    });
  } catch (err) {
    return errorResult(`Quote failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleOffRamp(params: Record<string, unknown>) {
  const state = getWalletState();
  if (!state.connected) {
    return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
  }

  const cryptoToken = readStringParam(params, 'crypto_token') ?? readStringParam(params, 'cryptoToken') ?? 'USDC';
  const chainId = readNumberParam(params, 'chain_id') ?? readNumberParam(params, 'chainId') ?? 8453;
  const amount = readNumberParam(params, 'amount', { required: true })!;
  const amountType = (readStringParam(params, 'amount_type') ?? readStringParam(params, 'amountType') ?? 'crypto') as 'crypto' | 'fiat';
  const fiatCurrency = (readStringParam(params, 'fiat_currency') ?? readStringParam(params, 'fiatCurrency') ?? 'USD') as FiatCurrency;
  const preferredProvider = readStringParam(params, 'provider');
  const bankAccountId = readStringParam(params, 'bank_account_id') ?? readStringParam(params, 'bankAccountId');

  const fiat = getFiatService();

  try {
    // Get quotes for off-ramp
    const quotes = await fiat.getQuotes({
      direction: 'off_ramp',
      cryptoToken,
      cryptoChainId: chainId,
      amount,
      amountType,
      fiatCurrency,
    });

    if (quotes.length === 0) {
      return errorResult('No off-ramp quotes available.');
    }

    // Use preferred provider or best quote
    const quote = preferredProvider
      ? quotes.find(q => q.provider === preferredProvider) ?? quotes[0]!
      : quotes[0]!;

    // Execute the transfer
    const transfer = await fiat.executeTransfer(quote, {
      userId: state.address!,
      walletAddress: state.address!,
      bankAccountId,
    });

    return jsonResult({
      status: 'initiated',
      transferId: transfer.id,
      provider: transfer.provider,
      direction: 'off_ramp',
      cryptoAmount: transfer.cryptoAmount,
      cryptoToken: transfer.cryptoToken,
      fiatAmount: transfer.fiatAmount,
      fiatCurrency: transfer.fiatCurrency,
      fee: transfer.fee,
      externalId: transfer.externalId,
      note: 'Transfer initiated. Use action "status" with this transfer_id to track progress.',
    });
  } catch (err) {
    return errorResult(`Off-ramp failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleOnRamp(params: Record<string, unknown>) {
  const state = getWalletState();
  if (!state.connected) {
    return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
  }

  const cryptoToken = readStringParam(params, 'crypto_token') ?? readStringParam(params, 'cryptoToken') ?? 'USDC';
  const chainId = readNumberParam(params, 'chain_id') ?? readNumberParam(params, 'chainId') ?? 8453;
  const amount = readNumberParam(params, 'amount', { required: true })!;
  const amountType = (readStringParam(params, 'amount_type') ?? readStringParam(params, 'amountType') ?? 'fiat') as 'crypto' | 'fiat';
  const fiatCurrency = (readStringParam(params, 'fiat_currency') ?? readStringParam(params, 'fiatCurrency') ?? 'USD') as FiatCurrency;
  const preferredProvider = readStringParam(params, 'provider');

  const fiat = getFiatService();

  try {
    const quotes = await fiat.getQuotes({
      direction: 'on_ramp',
      cryptoToken,
      cryptoChainId: chainId,
      amount,
      amountType,
      fiatCurrency,
    });

    if (quotes.length === 0) {
      return errorResult('No on-ramp quotes available.');
    }

    const quote = preferredProvider
      ? quotes.find(q => q.provider === preferredProvider) ?? quotes[0]!
      : quotes[0]!;

    const transfer = await fiat.executeTransfer(quote, {
      userId: state.address!,
      walletAddress: state.address!,
    });

    return jsonResult({
      status: 'initiated',
      transferId: transfer.id,
      provider: transfer.provider,
      direction: 'on_ramp',
      cryptoAmount: transfer.cryptoAmount,
      cryptoToken: transfer.cryptoToken,
      fiatAmount: transfer.fiatAmount,
      fiatCurrency: transfer.fiatCurrency,
      fee: transfer.fee,
      externalId: transfer.externalId,
      note: 'On-ramp initiated. Use action "status" with this transfer_id to track progress.',
    });
  } catch (err) {
    return errorResult(`On-ramp failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleStatus(params: Record<string, unknown>) {
  const transferId = readStringParam(params, 'transfer_id') ?? readStringParam(params, 'transferId');
  if (!transferId) return errorResult('transfer_id is required for status check.');

  const fiat = getFiatService();

  try {
    const transfer = await fiat.refreshTransferStatus(transferId);
    if (!transfer) {
      return errorResult(`Transfer "${transferId}" not found.`);
    }

    return jsonResult({
      transferId: transfer.id,
      status: transfer.status,
      direction: transfer.direction,
      provider: transfer.provider,
      cryptoAmount: transfer.cryptoAmount,
      cryptoToken: transfer.cryptoToken,
      fiatAmount: transfer.fiatAmount,
      fiatCurrency: transfer.fiatCurrency,
      fee: transfer.fee,
      externalId: transfer.externalId,
      txHash: transfer.txHash ?? null,
      bankAccount: transfer.bankAccount ?? null,
      createdAt: new Date(transfer.createdAt).toISOString(),
      updatedAt: new Date(transfer.updatedAt).toISOString(),
      error: transfer.error ?? null,
    });
  } catch (err) {
    return errorResult(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleAccounts() {
  const fiat = getFiatService();
  if (!fiat.isAvailable()) {
    return errorResult('No fiat providers configured. Set BRIDGE_API_KEY or MOONPAY_API_KEY.');
  }

  try {
    const accounts = await fiat.listBankAccounts();

    return jsonResult({
      accountCount: accounts.length,
      accounts: accounts.map(a => ({
        id: a.id,
        label: a.label,
        maskedNumber: a.maskedNumber,
        bankName: a.bankName,
        currency: a.currency,
        provider: a.provider,
      })),
      configuredProviders: fiat.getConfiguredProviders(),
      note: accounts.length === 0
        ? 'No bank accounts linked. Use Bridge.xyz dashboard to link a bank account.'
        : undefined,
    });
  } catch (err) {
    return errorResult(`Account lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleHistory(params: Record<string, unknown>) {
  const fiat = getFiatService();
  const state = getWalletState();
  const userId = state.address ?? undefined;

  const transfers = fiat.listTransfers(userId);

  // Sort by most recent first
  transfers.sort((a, b) => b.createdAt - a.createdAt);

  // Limit to last 20
  const recent = transfers.slice(0, 20);

  return jsonResult({
    totalTransfers: transfers.length,
    showing: recent.length,
    transfers: recent.map(t => ({
      id: t.id,
      direction: t.direction,
      status: t.status,
      provider: t.provider,
      cryptoAmount: t.cryptoAmount,
      cryptoToken: t.cryptoToken,
      fiatAmount: t.fiatAmount,
      fiatCurrency: t.fiatCurrency,
      fee: t.fee,
      createdAt: new Date(t.createdAt).toISOString(),
      error: t.error ?? null,
    })),
  });
}
