/**
 * Cost Basis & P&L Tool — Track trade history and calculate profit/loss.
 *
 * Records buy/sell prices per token, computes unrealized and realized P&L
 * using FIFO (first-in, first-out) cost basis. Persists trade records to
 * disk so data survives agent restarts.
 *
 * Actions:
 *   record_trade   — Manually record a trade (buy/sell) with price data
 *   portfolio_pnl  — Show unrealized P&L for all held tokens
 *   token_pnl      — Show detailed P&L for a specific token
 *   history        — List recent trade records
 *   export         — Export full trade history as JSON
 *
 * The after_tool_call hook in index.ts should call recordSwapTrade() when
 * defi_swap completes to auto-record trades.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { getWalletState } from '../services/walletconnect-service.js';
import * as fs from 'fs';
import * as path from 'path';

const ACTIONS = ['record_trade', 'portfolio_pnl', 'token_pnl', 'history', 'export'] as const;

// ─── Trade Record Types ──────────────────────────────────────────────────

interface TradeRecord {
  id: string;
  timestamp: number;
  type: 'buy' | 'sell';
  token: string;          // token address
  symbol: string;
  amount: number;         // token amount
  priceUsd: number;       // price per token at time of trade
  totalUsd: number;       // amount * priceUsd
  txHash?: string;
  notes?: string;
}

interface TaxLot {
  tradeId: string;
  timestamp: number;
  remainingAmount: number;
  costBasisPerUnit: number;
}

interface TradeStore {
  trades: TradeRecord[];
  version: number;
}

// ─── Persistence ─────────────────────────────────────────────────────────

function getDataDir(): string {
  return process.env.OPENCLAWNCH_TX_DIR
    || path.join(process.env.HOME ?? '', '.openclawnch', 'data');
}

function getStorePath(): string {
  return path.join(getDataDir(), 'trade-history.json');
}

function loadStore(): TradeStore {
  try {
    const raw = fs.readFileSync(getStorePath(), 'utf-8');
    return JSON.parse(raw) as TradeStore;
  } catch {
    return { trades: [], version: 1 };
  }
}

function saveStore(store: TradeStore): void {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getStorePath(), JSON.stringify(store, null, 2));
}

// ─── Public API for Hook Integration ─────────────────────────────────────

/**
 * Called by after_tool_call hook when a swap completes.
 * Records the trade automatically.
 */
export function recordSwapTrade(params: {
  token: string;
  symbol: string;
  amount: number;
  priceUsd: number;
  type: 'buy' | 'sell';
  txHash?: string;
}): void {
  const store = loadStore();
  const trade: TradeRecord = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    type: params.type,
    token: params.token.toLowerCase(),
    symbol: params.symbol.toUpperCase(),
    amount: params.amount,
    priceUsd: params.priceUsd,
    totalUsd: params.amount * params.priceUsd,
    txHash: params.txHash,
  };
  store.trades.push(trade);
  saveStore(store);
}

// ─── Schema ──────────────────────────────────────────────────────────────

const CostBasisSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'record_trade: manually record a buy/sell. ' +
      'portfolio_pnl: unrealized P&L for all holdings. ' +
      'token_pnl: detailed P&L for one token. ' +
      'history: list recent trades. ' +
      'export: full trade history JSON.',
  }),
  token: Type.Optional(Type.String({
    description: 'Token contract address (0x...). Required for record_trade, token_pnl.',
  })),
  symbol: Type.Optional(Type.String({
    description: 'Token symbol (e.g. "USDC"). Required for record_trade.',
  })),
  type: Type.Optional(stringEnum(['buy', 'sell'] as const, {
    description: 'Trade type. Required for record_trade.',
  })),
  amount: Type.Optional(Type.Number({
    description: 'Token amount. Required for record_trade.',
  })),
  price_usd: Type.Optional(Type.Number({
    description: 'Price per token in USD at time of trade. Required for record_trade.',
  })),
  current_price: Type.Optional(Type.Number({
    description: 'Current price per token in USD. Used for P&L calculation. If omitted, uses last known price.',
  })),
  tx_hash: Type.Optional(Type.String({
    description: 'Transaction hash associated with the trade.',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Max records to return for history action. Default: 50.',
  })),
});

export function createCostBasisTool() {
  return {
    name: 'cost_basis',
    label: 'Cost Basis',
    ownerOnly: true,
    description:
      'Track trade cost basis and calculate P&L. Records buy/sell prices, computes ' +
      'unrealized/realized profit using FIFO. Use record_trade to log trades, ' +
      'portfolio_pnl for overall P&L, token_pnl for per-token detail.',
    parameters: CostBasisSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'record_trade':
          return handleRecordTrade(params);
        case 'portfolio_pnl':
          return handlePortfolioPnl(params);
        case 'token_pnl':
          return handleTokenPnl(params);
        case 'history':
          return handleHistory(params);
        case 'export':
          return handleExport();
        default:
          return errorResult(`Unknown action: ${action}. Use: ${ACTIONS.join(', ')}`);
      }
    },
  };
}

// ─── FIFO Cost Basis Engine ──────────────────────────────────────────────

function buildTaxLots(trades: TradeRecord[], tokenAddress: string): {
  lots: TaxLot[];
  realizedPnl: number;
  totalSold: number;
  totalBought: number;
} {
  const filtered = trades
    .filter((t) => t.token === tokenAddress.toLowerCase())
    .sort((a, b) => a.timestamp - b.timestamp);

  const lots: TaxLot[] = [];
  let realizedPnl = 0;
  let totalSold = 0;
  let totalBought = 0;

  for (const trade of filtered) {
    if (trade.type === 'buy') {
      lots.push({
        tradeId: trade.id,
        timestamp: trade.timestamp,
        remainingAmount: trade.amount,
        costBasisPerUnit: trade.priceUsd,
      });
      totalBought += trade.amount;
    } else {
      // FIFO: consume oldest lots first
      let remaining = trade.amount;
      totalSold += trade.amount;

      for (const lot of lots) {
        if (remaining <= 0) break;
        if (lot.remainingAmount <= 0) continue;

        const consumed = Math.min(lot.remainingAmount, remaining);
        const costBasis = consumed * lot.costBasisPerUnit;
        const saleProceeds = consumed * trade.priceUsd;
        realizedPnl += saleProceeds - costBasis;

        lot.remainingAmount -= consumed;
        remaining -= consumed;
      }
    }
  }

  return {
    lots: lots.filter((l) => l.remainingAmount > 0),
    realizedPnl,
    totalSold,
    totalBought,
  };
}

// ─── Action Handlers ──────────────────────────────────────────────────────

function handleRecordTrade(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token', { required: true })!;
  const symbol = readStringParam(params, 'symbol', { required: true })!;
  const tradeType = readStringParam(params, 'type', { required: true })!;
  const amount = readNumberParam(params, 'amount', { required: true })!;
  const priceUsd = readNumberParam(params, 'price_usd') ?? readNumberParam(params, 'priceUsd');
  const txHash = readStringParam(params, 'tx_hash') ?? readStringParam(params, 'txHash');

  if (tradeType !== 'buy' && tradeType !== 'sell') {
    return errorResult('type must be "buy" or "sell".');
  }

  if (priceUsd === undefined || priceUsd === null) {
    return errorResult('price_usd is required for record_trade.');
  }

  const store = loadStore();
  const trade: TradeRecord = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    type: tradeType,
    token: token.toLowerCase(),
    symbol: symbol.toUpperCase(),
    amount,
    priceUsd,
    totalUsd: amount * priceUsd,
    txHash: txHash ?? undefined,
  };
  store.trades.push(trade);
  saveStore(store);

  return jsonResult({
    status: 'recorded',
    trade: {
      id: trade.id,
      type: trade.type,
      token: trade.token,
      symbol: trade.symbol,
      amount: trade.amount,
      priceUsd: trade.priceUsd,
      totalUsd: trade.totalUsd,
      txHash: trade.txHash,
    },
    totalTrades: store.trades.length,
  });
}

function handlePortfolioPnl(params: Record<string, unknown>) {
  const currentPriceOverride = readNumberParam(params, 'current_price') ?? readNumberParam(params, 'currentPrice');
  const store = loadStore();

  if (store.trades.length === 0) {
    return jsonResult({
      status: 'empty',
      message: 'No trades recorded yet. Use record_trade to add trades.',
      holdings: [],
    });
  }

  // Group by token
  const tokenSet = new Set<string>();
  for (const t of store.trades) tokenSet.add(t.token);

  const holdings: Array<{
    token: string;
    symbol: string;
    holdingAmount: number;
    avgCostBasis: number;
    totalCost: number;
    currentPrice: number;
    currentValue: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    realizedPnl: number;
  }> = [];

  let totalUnrealizedPnl = 0;
  let totalRealizedPnl = 0;
  let totalCurrentValue = 0;

  for (const tokenAddr of tokenSet) {
    const { lots, realizedPnl } = buildTaxLots(store.trades, tokenAddr);
    const holdingAmount = lots.reduce((sum, l) => sum + l.remainingAmount, 0);

    if (holdingAmount <= 0 && realizedPnl === 0) continue;

    const totalCost = lots.reduce((sum, l) => sum + l.remainingAmount * l.costBasisPerUnit, 0);
    const avgCostBasis = holdingAmount > 0 ? totalCost / holdingAmount : 0;

    // Use override price if provided, otherwise use last trade price
    let currentPrice = currentPriceOverride ?? 0;
    if (!currentPrice) {
      const lastTrade = store.trades
        .filter((t) => t.token === tokenAddr)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      currentPrice = lastTrade?.priceUsd ?? 0;
    }

    const currentValue = holdingAmount * currentPrice;
    const unrealizedPnl = currentValue - totalCost;
    const unrealizedPnlPercent = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;

    // Get symbol from most recent trade
    const symbol = store.trades.filter((t) => t.token === tokenAddr).slice(-1)[0]?.symbol ?? 'UNKNOWN';

    holdings.push({
      token: tokenAddr,
      symbol,
      holdingAmount,
      avgCostBasis,
      totalCost,
      currentPrice,
      currentValue,
      unrealizedPnl,
      unrealizedPnlPercent,
      realizedPnl,
    });

    totalUnrealizedPnl += unrealizedPnl;
    totalRealizedPnl += realizedPnl;
    totalCurrentValue += currentValue;
  }

  return jsonResult({
    totalHoldings: holdings.length,
    totalCurrentValue,
    totalUnrealizedPnl,
    totalRealizedPnl,
    totalPnl: totalUnrealizedPnl + totalRealizedPnl,
    holdings: holdings.sort((a, b) => b.currentValue - a.currentValue),
    note: 'Current prices are from last recorded trade unless overridden via current_price parameter.',
  });
}

function handleTokenPnl(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token', { required: true })!;
  const currentPriceOverride = readNumberParam(params, 'current_price') ?? readNumberParam(params, 'currentPrice');
  const store = loadStore();

  const tokenTrades = store.trades.filter((t) => t.token === token.toLowerCase());
  if (tokenTrades.length === 0) {
    return jsonResult({
      token,
      status: 'no_trades',
      message: 'No trades found for this token.',
    });
  }

  const { lots, realizedPnl, totalSold, totalBought } = buildTaxLots(store.trades, token);
  const holdingAmount = lots.reduce((sum, l) => sum + l.remainingAmount, 0);
  const totalCost = lots.reduce((sum, l) => sum + l.remainingAmount * l.costBasisPerUnit, 0);
  const avgCostBasis = holdingAmount > 0 ? totalCost / holdingAmount : 0;

  let currentPrice = currentPriceOverride ?? 0;
  if (!currentPrice) {
    const lastTrade = tokenTrades.sort((a, b) => b.timestamp - a.timestamp)[0];
    currentPrice = lastTrade?.priceUsd ?? 0;
  }

  const currentValue = holdingAmount * currentPrice;
  const unrealizedPnl = currentValue - totalCost;
  const unrealizedPnlPercent = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;

  const symbol = tokenTrades.slice(-1)[0]?.symbol ?? 'UNKNOWN';

  return jsonResult({
    token,
    symbol,
    totalTrades: tokenTrades.length,
    totalBought,
    totalSold,
    holdingAmount,
    avgCostBasis,
    totalCost,
    currentPrice,
    currentValue,
    unrealizedPnl,
    unrealizedPnlPercent: Math.round(unrealizedPnlPercent * 100) / 100,
    realizedPnl,
    totalPnl: unrealizedPnl + realizedPnl,
    openLots: lots.map((l) => ({
      tradeId: l.tradeId,
      date: new Date(l.timestamp).toISOString(),
      remainingAmount: l.remainingAmount,
      costBasisPerUnit: l.costBasisPerUnit,
    })),
    recentTrades: tokenTrades.slice(-10).reverse().map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      priceUsd: t.priceUsd,
      totalUsd: t.totalUsd,
      date: new Date(t.timestamp).toISOString(),
      txHash: t.txHash,
    })),
  });
}

function handleHistory(params: Record<string, unknown>) {
  const limit = readNumberParam(params, 'limit') ?? 50;
  const store = loadStore();

  const trades = store.trades
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map((t) => ({
      id: t.id,
      type: t.type,
      token: t.token,
      symbol: t.symbol,
      amount: t.amount,
      priceUsd: t.priceUsd,
      totalUsd: t.totalUsd,
      date: new Date(t.timestamp).toISOString(),
      txHash: t.txHash,
    }));

  return jsonResult({
    totalRecords: store.trades.length,
    showing: trades.length,
    trades,
  });
}

function handleExport() {
  const store = loadStore();
  return jsonResult({
    exportDate: new Date().toISOString(),
    version: store.version,
    totalTrades: store.trades.length,
    trades: store.trades.map((t) => ({
      ...t,
      date: new Date(t.timestamp).toISOString(),
    })),
  });
}
