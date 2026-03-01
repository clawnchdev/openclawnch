/**
 * Bankr Polymarket Tool — prediction markets via Bankr Agent API.
 *
 * Search markets, place bets, view positions, and redeem winnings.
 * All operations go through Bankr's prompt API. Executes on Polygon.
 * Requires Bankr wallet (/connect_bankr).
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { hasBankrApi } from '../services/bankr-api.js';

const ACTIONS = ['search', 'bet', 'positions', 'redeem'] as const;

const BankrPolymarketSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'search: find prediction markets. bet: place a bet. ' +
      'positions: view your current positions. redeem: claim winnings from resolved markets.',
  }),
  query: Type.Optional(Type.String({
    description: 'Search query for finding markets (e.g. "eagles win", "bitcoin price", "election").',
  })),
  market: Type.Optional(Type.String({
    description: 'Market description or ID to bet on.',
  })),
  outcome: Type.Optional(Type.String({
    description: 'Outcome to bet on: "yes", "no", or a specific outcome name.',
  })),
  amount: Type.Optional(Type.String({
    description: 'Dollar amount to bet (e.g. "10", "50").',
  })),
});

function buildPrompt(action: string, params: Record<string, unknown>): string {
  const query = readStringParam(params, 'query') || '';
  const market = readStringParam(params, 'market') || '';
  const outcome = readStringParam(params, 'outcome') || '';
  const amount = readStringParam(params, 'amount') || '';

  switch (action) {
    case 'search':
      return `search polymarket for ${query}`;
    case 'bet':
      return `bet $${amount} on ${outcome} for ${market}`;
    case 'positions':
      return 'show my Polymarket positions';
    case 'redeem':
      return 'redeem my winning polymarket positions';
    default:
      return action;
  }
}

export function createBankrPolymarketTool() {
  return {
    name: 'bankr_polymarket',
    label: 'Bankr Polymarket',
    ownerOnly: false,
    description:
      'Prediction markets via Polymarket. Search for markets on any topic, ' +
      'place bets (yes/no), view your positions, and redeem winnings. ' +
      'Executes on Polygon via Bankr. Requires Bankr wallet (/connect_bankr).',
    parameters: BankrPolymarketSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      if (!hasBankrApi()) {
        return errorResult(
          'Bankr API key not configured. Connect via /connect_bankr first.'
        );
      }

      // Validate required params
      if (action === 'search' && !readStringParam(params, 'query')) {
        return errorResult('"query" is required for search (e.g. "Will Bitcoin reach $100k?").');
      }
      if (action === 'bet') {
        if (!readStringParam(params, 'market')) {
          return errorResult('"market" is required for bet. Search for markets first.');
        }
        if (!readStringParam(params, 'outcome')) {
          return errorResult('"outcome" is required for bet (e.g. "yes" or "no").');
        }
        if (!readStringParam(params, 'amount')) {
          return errorResult('"amount" is required for bet (dollar amount).');
        }
      }

      try {
        const { bankrPromptAndPoll } = await import('../services/bankr-api.js');

        const prompt = buildPrompt(action, params);
        const timeoutMs = action === 'search' || action === 'positions' ? 30_000 : 60_000;
        const result = await bankrPromptAndPoll(prompt, { timeoutMs });

        if (result.status === 'failed') {
          return errorResult(`Polymarket ${action} failed: ${result.error ?? 'Unknown error'}`);
        }

        return jsonResult({
          status: 'success',
          action,
          chain: 'polygon',
          response: result.response,
          richData: result.richData,
          transactions: result.transactions,
        });
      } catch (err) {
        return errorResult(
          `Polymarket ${action} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  };
}
