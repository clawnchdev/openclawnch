/**
 * Herd Intelligence Tool — on-chain investigation via HerdIntelligence + HalBuilder
 *
 * Investigates contracts, transactions, wallets. Audits token safety.
 * Validates swap routes and fee claims. Profiles counterparties.
 * Searches code, tracks token flows. Manages bookmarks.
 * Simulates operations via HAL expressions.
 *
 * All actions are read-only. Requires HERD_ACCESS_TOKEN for some operations.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { checkToolConfig } from '../services/tool-config-service.js';

const ACTIONS = [
  'investigate', 'audit_token', 'validate_swap', 'validate_claim',
  'profile_counterparty', 'search_code', 'track_token',
  'bookmark', 'simulate',
] as const;

const HerdSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'investigate: auto-detect address/tx and analyze. audit_token: safety audit. ' +
      'validate_swap: check swap route. validate_claim: check fee claim viability. ' +
      'profile_counterparty: assess wallet trustworthiness. search_code: search contract source. ' +
      'track_token: trace token flow for a holder. bookmark: manage bookmarks. ' +
      'simulate: build HAL simulation expressions.',
  }),
  target: Type.Optional(Type.String({
    description: 'Address (contract/wallet) or transaction hash to investigate',
  })),
  token_in: Type.Optional(Type.String({
    description: 'Token-in address for validate_swap; token address for track_token',
  })),
  token_out: Type.Optional(Type.String({
    description: 'Token-out address for validate_swap',
  })),
  amount: Type.Optional(Type.String({
    description: 'Amount for validate_swap (human-readable, default "1.0")',
  })),
  pattern: Type.Optional(Type.String({
    description: 'Search pattern/regex for search_code',
  })),
  bookmark_action: Type.Optional(Type.String({
    description: '"list", "add", or "remove" for bookmark action',
  })),
  label: Type.Optional(Type.String({
    description: 'Label for bookmark add',
  })),
  bookmark_type: Type.Optional(Type.String({
    description: '"contract", "wallet", or "transaction"',
  })),
  simulate_type: Type.Optional(Type.String({
    description: '"transfer", "swap", "balance", "allowance", or "approve"',
  })),
  recipient: Type.Optional(Type.String({
    description: 'Recipient for simulate transfer; spender for simulate allowance',
  })),
  chain: Type.Optional(Type.String({
    description: '"base" or "ethereum" (default: "base")',
  })),
});

// Lazy singleton
let _herd: any = null;

async function getHerd(): Promise<any> {
  if (_herd) return _herd;
  const { HerdIntelligence } = await import('@clawnch/clawncher-sdk');
  _herd = new HerdIntelligence({
    accessToken: process.env.HERD_ACCESS_TOKEN,
    blockchain: 'base',
  });
  return _herd;
}

export function createHerdIntelligenceTool() {
  return {
    name: 'herd_intelligence',
    label: 'Herd Intelligence',
    ownerOnly: false,
    description:
      'On-chain intelligence: investigate contracts, transactions, and wallets. ' +
      'Audit token safety (rug pull detection, honeypot analysis). ' +
      'Validate swap routes and fee claims. Profile counterparties. ' +
      'Search contract source code. Track token flows. All read-only.',
    parameters: HerdSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      // Early check: is the tool configured?
      const notReady = checkToolConfig('herd_intelligence');
      if (notReady) return notReady;

      const p = args as Record<string, unknown>;
      const action = readStringParam(p, 'action', { required: true })!;
      const chain = (readStringParam(p, 'chain') || 'base') as 'base' | 'ethereum';

      try {
        const herd = await getHerd();

        // Check availability
        const available = await herd.isAvailable();
        if (!available) {
          return errorResult(
            'Herd Intelligence service unavailable. Set HERD_ACCESS_TOKEN env var.'
          );
        }

        switch (action) {
          // ── Investigate ─────────────────────────────────────────────
          case 'investigate': {
            const target = readStringParam(p, 'target', { required: true })!;

            // Auto-detect: tx hash (66 chars) vs address (42 chars)
            if (target.length === 66 && target.startsWith('0x')) {
              const result = await herd.investigateTransaction(target, { blockchain: chain });
              return jsonResult(result);
            }

            // Try as contract first, fall back to wallet
            try {
              const result = await herd.investigateContract(target, { blockchain: chain });
              if (result && result.name) return jsonResult(result);
            } catch {
              // Not a contract — try as wallet
            }

            const result = await herd.investigateWallet(target, {
              blockchain: chain,
              includeActivity: true,
            });
            return jsonResult(result);
          }

          // ── Audit Token ─────────────────────────────────────────────
          case 'audit_token': {
            const target = readStringParam(p, 'target', { required: true })!;
            const result = await herd.auditTokenSafety(target, { blockchain: chain });
            return jsonResult(result);
          }

          // ── Validate Swap ───────────────────────────────────────────
          case 'validate_swap': {
            const tokenIn = readStringParam(p, 'token_in') || readStringParam(p, 'target');
            if (!tokenIn) return errorResult('Provide token_in or target for validate_swap');
            const tokenOut = readStringParam(p, 'token_out', { required: true })!;
            const amount = readStringParam(p, 'amount') || '1.0';
            const result = await herd.validateSwapRoute(tokenIn, tokenOut, amount, {
              blockchain: chain,
            });
            return jsonResult(result);
          }

          // ── Validate Claim ──────────────────────────────────────────
          case 'validate_claim': {
            const target = readStringParam(p, 'target', { required: true })!;
            const result = await herd.validateFeeClaim(target, { blockchain: chain });
            return jsonResult(result);
          }

          // ── Profile Counterparty ────────────────────────────────────
          case 'profile_counterparty': {
            const target = readStringParam(p, 'target', { required: true })!;
            const result = await herd.profileCounterparty(target, { blockchain: chain });
            return jsonResult(result);
          }

          // ── Search Code ─────────────────────────────────────────────
          case 'search_code': {
            const target = readStringParam(p, 'target', { required: true })!;
            const pattern = readStringParam(p, 'pattern', { required: true })!;
            const addresses = target.split(',').map(a => a.trim());
            const result = await herd.searchCode(addresses, pattern);
            return jsonResult({ query: pattern, addresses, result });
          }

          // ── Track Token ─────────────────────────────────────────────
          case 'track_token': {
            const holder = readStringParam(p, 'target', { required: true })!;
            const token = readStringParam(p, 'token_in', { required: true })!;
            const result = await herd.trackTokenFlow(holder, token, {
              blockchain: chain,
            });
            return jsonResult(result);
          }

          // ── Bookmarks ───────────────────────────────────────────────
          case 'bookmark': {
            const bmAction = readStringParam(p, 'bookmark_action') || 'list';

            if (bmAction === 'list') {
              const bookmarks = await herd.getBookmarks();
              return jsonResult({ bookmarks });
            }

            if (bmAction === 'add') {
              const target = readStringParam(p, 'target', { required: true })!;
              const bmType = (readStringParam(p, 'bookmark_type') || 'contract') as any;
              const label = readStringParam(p, 'label');
              await herd.bookmark(bmType, target, label, chain);
              return jsonResult({ status: 'bookmarked', type: bmType, target, label });
            }

            if (bmAction === 'remove') {
              const target = readStringParam(p, 'target', { required: true })!;
              const bmType = (readStringParam(p, 'bookmark_type') || 'contract') as any;
              await herd.removeBookmark(bmType, target, chain);
              return jsonResult({ status: 'removed', type: bmType, target });
            }

            return errorResult(`Unknown bookmark_action: ${bmAction}. Use "list", "add", or "remove".`);
          }

          // ── Simulate (HAL) ──────────────────────────────────────────
          case 'simulate': {
            const simType = readStringParam(p, 'simulate_type', { required: true })!;
            const { HalBuilder } = await import('@clawnch/clawncher-sdk');
            const hal = new HalBuilder();

            let expression: any;

            switch (simType) {
              case 'transfer': {
                const token = readStringParam(p, 'target', { required: true })!;
                expression = hal.buildTransferAdapter({ token, blockchain: chain });
                break;
              }
              case 'swap': {
                const sellToken = readStringParam(p, 'token_in', { required: true })!;
                const buyToken = readStringParam(p, 'token_out', { required: true })!;
                expression = hal.buildSwapAction({
                  sellToken, buyToken, blockchain: chain,
                  includeApproval: true,
                });
                break;
              }
              case 'balance': {
                const token = readStringParam(p, 'target', { required: true })!;
                expression = hal.buildBalanceReader({ token, blockchain: chain });
                break;
              }
              case 'allowance': {
                const token = readStringParam(p, 'target', { required: true })!;
                expression = hal.buildAllowanceReader({
                  token, blockchain: chain,
                  spender: readStringParam(p, 'recipient'),
                });
                break;
              }
              case 'approve': {
                const token = readStringParam(p, 'target', { required: true })!;
                expression = hal.buildApproveAdapter({ token, blockchain: chain });
                break;
              }
              default:
                return errorResult(
                  `Unknown simulate_type: ${simType}. Use: transfer, swap, balance, allowance, approve`
                );
            }

            return jsonResult({
              simulate_type: simType,
              expression,
              note: 'HAL expression built. This can be executed by a HAL runtime.',
            });
          }

          default:
            return errorResult(`Unknown herd_intelligence action: ${action}`);
        }
      } catch (err) {
        return errorResult(`Herd error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
