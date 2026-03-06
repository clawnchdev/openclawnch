/**
 * Bankr Automate Tool — set up trading automations via Bankr Agent API.
 *
 * Supports: limit buy, limit sell, stop-loss, DCA, TWAP, cancel, list.
 * All automations are submitted as natural language prompts to Bankr's
 * prompt API and polled for completion.
 *
 * Automations are EVM-only, primarily Base.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { hasBankrApi } from '../services/bankr-api.js';

const ACTIONS = ['limit_buy', 'limit_sell', 'stop_loss', 'dca', 'twap', 'cancel', 'list'] as const;

const BankrAutomateSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'limit_buy: buy when price drops. limit_sell: sell when price rises. ' +
      'stop_loss: sell if price drops below threshold. ' +
      'dca: dollar-cost average on a schedule. twap: time-weighted sell. ' +
      'cancel: cancel an automation. list: show active automations.',
  }),
  token: Type.Optional(Type.String({
    description: 'Token symbol or address. Required for buy/sell/dca/twap.',
  })),
  amount: Type.Optional(Type.String({
    description: 'Dollar amount or token amount (e.g. "$100", "0.5 ETH").',
  })),
  trigger: Type.Optional(Type.String({
    description: 'Trigger condition for limit/stop (e.g. "drops 10%", "rises 20%", "reaches $50000").',
  })),
  interval: Type.Optional(Type.String({
    description: 'DCA interval (e.g. "every day", "every 6 hours", "every week").',
  })),
  duration: Type.Optional(Type.String({
    description: 'Duration for DCA/TWAP (e.g. "for 7 days", "over 4 hours").',
  })),
  time: Type.Optional(Type.String({
    description: 'Execution time for DCA (e.g. "at 9am", "at midnight UTC").',
  })),
  chain: Type.Optional(Type.String({
    description: 'Chain (default: base). Automations are primarily Base.',
  })),
  automation_id: Type.Optional(Type.String({
    description: 'ID of automation to cancel.',
  })),
});

// ─── Input Sanitization (C3: prevent prompt injection) ──────────────────
// Bankr NL prompts are built from user-supplied fields. Validate that
// token symbols/addresses, amounts, and triggers contain only expected chars.

const SAFE_TOKEN_RE = /^[a-zA-Z0-9_.\-\/]{1,60}$/;
const SAFE_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SAFE_AMOUNT_RE = /^\$?[0-9][0-9,._]*\s*[a-zA-Z]*$/;
const SAFE_TRIGGER_RE = /^[a-zA-Z0-9$%.,\s\-+<>=!]{1,120}$/;
const SAFE_INTERVAL_RE = /^[a-zA-Z0-9\s]{1,60}$/;
const SAFE_ID_RE = /^[a-zA-Z0-9_\-]{1,80}$/;

function sanitizeToken(input: string): string {
  const trimmed = input.trim();
  if (SAFE_ADDRESS_RE.test(trimmed) || SAFE_TOKEN_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid token: "${trimmed.slice(0, 30)}". Use a symbol (e.g. "ETH") or address (0x...).`);
}

function sanitizeAmount(input: string): string {
  const trimmed = input.trim();
  if (SAFE_AMOUNT_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid amount: "${trimmed.slice(0, 30)}". Use a number like "$100" or "0.5 ETH".`);
}

function sanitizeTrigger(input: string): string {
  const trimmed = input.trim();
  if (SAFE_TRIGGER_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid trigger: "${trimmed.slice(0, 30)}". Use a simple condition like "drops 10%" or "reaches $50000".`);
}

function sanitizeInterval(input: string): string {
  const trimmed = input.trim();
  if (SAFE_INTERVAL_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid interval: "${trimmed.slice(0, 30)}". Use something like "every day" or "every 6 hours".`);
}

function sanitizeId(input: string): string {
  const trimmed = input.trim();
  if (SAFE_ID_RE.test(trimmed)) return trimmed;
  throw new Error(`Invalid automation ID: "${trimmed.slice(0, 30)}".`);
}

// Prompt templates for each action
function buildPrompt(action: string, params: Record<string, unknown>): string {
  const token = readStringParam(params, 'token') ? sanitizeToken(readStringParam(params, 'token')!) : '';
  const amount = readStringParam(params, 'amount') ? sanitizeAmount(readStringParam(params, 'amount')!) : '';
  const trigger = readStringParam(params, 'trigger') ? sanitizeTrigger(readStringParam(params, 'trigger')!) : '';
  const interval = readStringParam(params, 'interval') ? sanitizeInterval(readStringParam(params, 'interval')!) : '';
  const duration = readStringParam(params, 'duration') ? sanitizeInterval(readStringParam(params, 'duration')!) : '';
  const time = readStringParam(params, 'time') ? sanitizeInterval(readStringParam(params, 'time')!) : '';
  const automationId = readStringParam(params, 'automation_id') ? sanitizeId(readStringParam(params, 'automation_id')!) : '';

  switch (action) {
    case 'limit_buy':
      return `buy ${amount} of ${token} if it ${trigger}`;
    case 'limit_sell':
      return `sell my ${token} when it ${trigger}`;
    case 'stop_loss':
      return `sell all my ${token} if it ${trigger}`;
    case 'dca':
      return `DCA ${amount} into ${token} ${interval}${time ? ` at ${time}` : ''}${duration ? ` ${duration}` : ''}`;
    case 'twap':
      return `sell ${amount} ${token} ${duration}`;
    case 'cancel':
      return automationId
        ? `cancel my automation ${automationId}`
        : 'cancel my automations';
    case 'list':
      return 'show my active automations';
    default:
      return action;
  }
}

export function createBankrAutomateTool() {
  return {
    name: 'bankr_automate',
    label: 'Bankr Automate',
    ownerOnly: true,
    description:
      'Set up trading automations via Bankr: limit orders (buy/sell), stop-loss, ' +
      'dollar-cost averaging (DCA), and time-weighted average price (TWAP) sells. ' +
      'Automations execute server-side on Base. Use "list" to see active automations, ' +
      '"cancel" to stop them. Requires Bankr wallet (/connect_bankr).',
    parameters: BankrAutomateSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      if (!hasBankrApi()) {
        return errorResult(
          'Bankr API key not configured. Connect via /connect_bankr first.'
        );
      }

      // Validate required params per action
      if (['limit_buy', 'limit_sell', 'stop_loss'].includes(action)) {
        if (!readStringParam(params, 'token')) {
          return errorResult(`"token" is required for ${action}.`);
        }
        if (!readStringParam(params, 'trigger')) {
          return errorResult(`"trigger" is required for ${action} (e.g. "drops 10%", "reaches $50000").`);
        }
        if (action === 'limit_buy' && !readStringParam(params, 'amount')) {
          return errorResult('"amount" is required for limit_buy.');
        }
      }

      if (action === 'dca') {
        if (!readStringParam(params, 'token')) {
          return errorResult('"token" is required for DCA.');
        }
        if (!readStringParam(params, 'amount')) {
          return errorResult('"amount" is required for DCA.');
        }
        if (!readStringParam(params, 'interval')) {
          return errorResult('"interval" is required for DCA (e.g. "every day", "every 6 hours").');
        }
      }

      if (action === 'twap') {
        if (!readStringParam(params, 'token')) {
          return errorResult('"token" is required for TWAP.');
        }
        if (!readStringParam(params, 'amount')) {
          return errorResult('"amount" is required for TWAP.');
        }
        if (!readStringParam(params, 'duration')) {
          return errorResult('"duration" is required for TWAP (e.g. "over 4 hours").');
        }
      }

      try {
        const { bankrPromptAndPoll } = await import('../services/bankr-api.js');

        const prompt = buildPrompt(action, params);
        const timeoutMs = action === 'list' ? 30_000 : 60_000;
        const result = await bankrPromptAndPoll(prompt, { timeoutMs });

        if (result.status === 'failed') {
          return errorResult(`Automation failed: ${result.error ?? 'Unknown error'}`);
        }

        return jsonResult({
          status: 'success',
          action,
          response: result.response,
          richData: result.richData,
          transactions: result.transactions,
        });
      } catch (err) {
        return errorResult(
          `Automation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  };
}
