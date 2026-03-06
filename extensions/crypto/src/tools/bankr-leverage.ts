/**
 * Bankr Leverage Tool — leveraged trading via Avantis on Base.
 *
 * Open long/short positions with up to 10x leverage on crypto pairs,
 * forex, and commodities. View and close existing positions.
 * All operations go through Bankr's prompt API.
 *
 * Requires Bankr wallet (/connect_bankr).
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { hasBankrApi } from '../services/bankr-api.js';

const ACTIONS = ['long', 'short', 'close', 'positions'] as const;

const BankrLeverageSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'long: open a long position. short: open a short position. ' +
      'close: close an existing position. positions: view open positions.',
  }),
  pair: Type.Optional(Type.String({
    description: 'Trading pair (e.g. "BTC/USD", "ETH/USD", "GOLD", "EUR/USD").',
  })),
  amount: Type.Optional(Type.String({
    description: 'Dollar amount for the position (e.g. "100", "500").',
  })),
  leverage: Type.Optional(Type.Number({
    description: 'Leverage multiplier: 1-10 (default: 1). Higher = more risk.',
  })),
  stop_loss: Type.Optional(Type.String({
    description: 'Stop-loss percentage (e.g. "5%", "10%"). Closes position if loss exceeds this.',
  })),
  take_profit: Type.Optional(Type.String({
    description: 'Take-profit percentage (e.g. "50%", "200%"). Closes position when profit reaches this.',
  })),
});

// ─── Input Sanitization (C3: prevent prompt injection) ──────────────────
const SAFE_PAIR_RE = /^[A-Za-z0-9/.\-_ ]{1,30}$/;
const SAFE_AMOUNT_RE = /^\$?[0-9][0-9,._]*$/;
const SAFE_PERCENT_RE = /^[0-9]{1,5}%?$/;

function sanitizePair(input: string): string {
  const trimmed = input.trim();
  if (SAFE_PAIR_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid pair: "${trimmed.slice(0, 20)}". Use format like "BTC/USD" or "ETH/USD".`);
}
function sanitizeAmount(input: string): string {
  const trimmed = input.trim();
  if (SAFE_AMOUNT_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid amount: "${trimmed.slice(0, 20)}". Use a number like "100" or "500".`);
}
function sanitizePercent(input: string): string {
  const trimmed = input.trim();
  if (SAFE_PERCENT_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid percentage: "${trimmed.slice(0, 20)}". Use format like "5%" or "200%".`);
}

function buildPrompt(action: string, params: Record<string, unknown>): string {
  const pair = readStringParam(params, 'pair') ? sanitizePair(readStringParam(params, 'pair')!) : '';
  const amount = readStringParam(params, 'amount') ? sanitizeAmount(readStringParam(params, 'amount')!) : '';
  const leverage = readNumberParam(params, 'leverage');
  const stopLoss = readStringParam(params, 'stop_loss') ? sanitizePercent(readStringParam(params, 'stop_loss')!) : undefined;
  const takeProfit = readStringParam(params, 'take_profit') ? sanitizePercent(readStringParam(params, 'take_profit')!) : undefined;

  const leverageStr = leverage && leverage > 1 ? ` with ${leverage}x leverage` : '';
  const slStr = stopLoss ? `, ${stopLoss} stop loss` : '';
  const tpStr = takeProfit ? `, ${takeProfit} take profit` : '';

  switch (action) {
    case 'long':
      return `long $${amount} ${pair}${leverageStr}${slStr}${tpStr}`;
    case 'short':
      return `short $${amount} ${pair}${leverageStr}${slStr}${tpStr}`;
    case 'close':
      return `close my ${pair} position`;
    case 'positions':
      return 'show my Avantis positions';
    default:
      return action;
  }
}

export function createBankrLeverageTool() {
  return {
    name: 'bankr_leverage',
    label: 'Bankr Leverage',
    ownerOnly: true,
    description:
      'Leveraged trading via Avantis on Base. Open long/short positions ' +
      'with 1-10x leverage on crypto (BTC, ETH), forex (EUR/USD), and ' +
      'commodities (GOLD). Set stop-loss and take-profit levels. ' +
      'WARNING: Leveraged trading carries significant risk of loss. ' +
      'Requires Bankr wallet (/connect_bankr).',
    parameters: BankrLeverageSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      if (!hasBankrApi()) {
        return errorResult(
          'Bankr API key not configured. Connect via /connect_bankr first.'
        );
      }

      // Validate required params
      if (action === 'long' || action === 'short') {
        if (!readStringParam(params, 'pair')) {
          return errorResult(`"pair" is required for ${action} (e.g. "BTC/USD", "ETH/USD").`);
        }
        if (!readStringParam(params, 'amount')) {
          return errorResult(`"amount" is required for ${action} (dollar amount).`);
        }
        const leverage = readNumberParam(params, 'leverage');
        if (leverage !== undefined && (leverage < 1 || leverage > 10)) {
          return errorResult('Leverage must be between 1 and 10.');
        }
      }

      if (action === 'close' && !readStringParam(params, 'pair')) {
        return errorResult('"pair" is required for close (e.g. "BTC/USD").');
      }

      try {
        const { bankrPromptAndPoll } = await import('../services/bankr-api.js');

        const prompt = buildPrompt(action, params);
        const timeoutMs = action === 'positions' ? 30_000 : 60_000;
        const result = await bankrPromptAndPoll(prompt, { timeoutMs });

        if (result.status === 'failed') {
          return errorResult(`Leverage ${action} failed: ${result.error ?? 'Unknown error'}`);
        }

        return jsonResult({
          status: 'success',
          action,
          chain: 'base',
          protocol: 'avantis',
          response: result.response,
          richData: result.richData,
          transactions: result.transactions,
        });
      } catch (err) {
        return errorResult(
          `Leverage ${action} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  };
}
