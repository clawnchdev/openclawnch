/**
 * Manage Orders Tool — conditional order engine via ClawnchOrders
 *
 * Supports 7 order types: limit_buy, limit_sell, stop_loss, take_profit,
 * dca, trailing_stop, twap. Includes order chaining, risk management,
 * and circuit breaker protection.
 *
 * Orders are stored via a StateStore adapter. In OpenClaw, this uses
 * the agent's persistent state directory.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';

const ACTIONS = [
  'create', 'list', 'cancel', 'cancel_tag', 'check',
  'executed', 'failed', 'pause', 'resume',
  'risk', 'reset_circuit_breaker', 'cleanup',
] as const;

const ORDER_TYPES = [
  'limit_buy', 'limit_sell', 'stop_loss', 'take_profit',
  'dca', 'trailing_stop', 'twap',
] as const;

const ManageOrdersSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'create: new order. list: show all orders. cancel/cancel_tag: cancel by ID/tag. ' +
      'check: check triggers against price. executed/failed: mark order result. ' +
      'pause/resume: toggle order. risk: show risk status. cleanup: remove completed.',
  }),
  type: Type.Optional(stringEnum(ORDER_TYPES, {
    description: 'Order type for create action',
  })),
  token: Type.Optional(Type.String({
    description: 'Token address (defaults to agent\'s token if available)',
  })),
  trigger_price: Type.Optional(Type.String({
    description: 'Trigger price in ETH (e.g. "0.001")',
  })),
  side: Type.Optional(Type.String({
    description: '"buy" or "sell" (auto-inferred from order type if omitted)',
  })),
  amount_pct: Type.Optional(Type.Number({
    description: 'Percentage of holdings to trade (1-100)',
  })),
  amount_raw: Type.Optional(Type.String({
    description: 'Absolute amount to trade',
  })),
  slippage_bps: Type.Optional(Type.Number({
    description: 'Slippage tolerance in basis points (default: 200 = 2%)',
  })),
  order_id: Type.Optional(Type.String({
    description: 'Order ID for cancel/executed/failed/pause/resume',
  })),
  tag: Type.Optional(Type.String({
    description: 'Tag for grouping orders / bulk cancel',
  })),
  current_price: Type.Optional(Type.String({
    description: 'Current price in ETH for "check" action',
  })),
  execution_result: Type.Optional(Type.String({
    description: 'Execution result string for "executed" action',
  })),
  description: Type.Optional(Type.String({
    description: 'Human-readable order description',
  })),
  // DCA params
  dca_interval_hours: Type.Optional(Type.Number({ description: 'Hours between DCA buys' })),
  dca_max_buys: Type.Optional(Type.Number({ description: 'Maximum DCA iterations' })),
  // Trailing stop params
  trailing_pct: Type.Optional(Type.Number({ description: 'Trailing stop: % drop from peak to trigger' })),
  floor_price: Type.Optional(Type.String({ description: 'Trailing stop: absolute floor price in ETH' })),
  // TWAP params
  twap_chunks: Type.Optional(Type.Number({ description: 'TWAP: number of chunks' })),
  twap_window_hours: Type.Optional(Type.Number({ description: 'TWAP: time window in hours' })),
  twap_max_price: Type.Optional(Type.String({ description: 'TWAP: max price ceiling in ETH' })),
  twap_min_price: Type.Optional(Type.String({ description: 'TWAP: min price floor in ETH' })),
  // Chaining params
  chain_type: Type.Optional(Type.String({ description: 'Follow-up order type after this one executes' })),
  chain_trigger_price: Type.Optional(Type.String({ description: 'Follow-up trigger price' })),
  chain_side: Type.Optional(Type.String({ description: 'Follow-up side: buy or sell' })),
  chain_amount_pct: Type.Optional(Type.Number({ description: 'Follow-up amount %' })),
});

// In-memory storage adapter (persists for session lifetime)
// In production, this would be backed by the agent's state store
let _orders: any[] = [];
let _riskConfig: any = null;
let _ordersInstance: any = null;

function getOrdersInstance(): any {
  if (_ordersInstance) return _ordersInstance;

  // Lazy import to avoid hard dep at load time
  const storage = {
    getOrders: () => _orders,
    saveOrders: (orders: any[]) => { _orders = orders; },
  };
  const riskStorage = {
    getRiskConfig: () => _riskConfig,
    saveRiskConfig: (config: any) => { _riskConfig = config; },
  };

  // We'll initialize synchronously since ClawnchOrders doesn't need async
  return null; // will be created on first call
}

async function ensureOrders(): Promise<any> {
  if (_ordersInstance) return _ordersInstance;
  const { ClawnchOrders } = await import('@clawnch/clawncher-sdk');
  const storage = {
    getOrders: () => _orders,
    saveOrders: (orders: any[]) => { _orders = orders; },
  };
  const riskStorage = {
    getRiskConfig: () => _riskConfig,
    saveRiskConfig: (config: any) => { _riskConfig = config; },
  };
  _ordersInstance = new ClawnchOrders(storage, riskStorage);
  return _ordersInstance;
}

export function createManageOrdersTool() {
  return {
    name: 'manage_orders',
    label: 'Manage Orders',
    ownerOnly: true,
    description:
      'Create and manage conditional orders: limit buy/sell, stop-loss, take-profit, ' +
      'DCA, trailing stop, TWAP. Supports order chaining (e.g., buy then set stop-loss). ' +
      'Includes risk management with position sizing, drawdown circuit breaker, and rate limiting.',
    parameters: ManageOrdersSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const p = args as Record<string, unknown>;
      const action = readStringParam(p, 'action', { required: true })!;

      try {
        const orders = await ensureOrders();

        switch (action) {
          case 'create': {
            const orderType = readStringParam(p, 'type', { required: true })!;
            const token = readStringParam(p, 'token') || '0x0000000000000000000000000000000000000000';
            const triggerPrice = parseFloat(readStringParam(p, 'trigger_price', { required: true })!);

            // Auto-infer side from order type
            let side = readStringParam(p, 'side');
            if (!side) {
              if (orderType.includes('buy') || orderType === 'dca') side = 'buy';
              else if (orderType.includes('sell') || orderType === 'stop_loss' || orderType === 'take_profit') side = 'sell';
              else side = 'buy';
            }

            const orderAction: any = {
              side,
              amountPct: readNumberParam(p, 'amount_pct'),
              amountRaw: readStringParam(p, 'amount_raw'),
              slippageBps: readNumberParam(p, 'slippage_bps') ?? 200,
            };

            const createParams: any = {
              type: orderType,
              token,
              triggerPriceEth: triggerPrice,
              action: orderAction,
              description: readStringParam(p, 'description'),
              tag: readStringParam(p, 'tag'),
            };

            // DCA config
            const dcaInterval = readNumberParam(p, 'dca_interval_hours');
            if (dcaInterval) {
              createParams.dca = {
                intervalMs: dcaInterval * 3600 * 1000,
                amountEthPerBuy: triggerPrice, // simplified
                maxBuys: readNumberParam(p, 'dca_max_buys') ?? null,
              };
            }

            // Trailing stop config
            const trailingPct = readNumberParam(p, 'trailing_pct');
            if (trailingPct) {
              createParams.trailing = {
                pct: trailingPct,
                floorPriceEth: readStringParam(p, 'floor_price')
                  ? parseFloat(readStringParam(p, 'floor_price')!)
                  : undefined,
              };
            }

            // TWAP config
            const twapChunks = readNumberParam(p, 'twap_chunks');
            if (twapChunks) {
              const windowHours = readNumberParam(p, 'twap_window_hours') ?? 4;
              createParams.twap = {
                totalChunks: twapChunks,
                windowMs: windowHours * 3600 * 1000,
                chunkIntervalMs: (windowHours * 3600 * 1000) / twapChunks,
                maxPriceEth: readStringParam(p, 'twap_max_price')
                  ? parseFloat(readStringParam(p, 'twap_max_price')!)
                  : undefined,
                minPriceEth: readStringParam(p, 'twap_min_price')
                  ? parseFloat(readStringParam(p, 'twap_min_price')!)
                  : undefined,
              };
            }

            // Chaining
            const chainType = readStringParam(p, 'chain_type');
            if (chainType) {
              createParams.chain = [{
                type: chainType,
                triggerPriceEth: readStringParam(p, 'chain_trigger_price')
                  ? parseFloat(readStringParam(p, 'chain_trigger_price')!)
                  : triggerPrice,
                action: {
                  side: readStringParam(p, 'chain_side') || (chainType.includes('sell') ? 'sell' : 'buy'),
                  amountPct: readNumberParam(p, 'chain_amount_pct') ?? 100,
                },
              }];
            }

            const order = orders.create(createParams);
            return jsonResult({
              status: 'created',
              order: {
                id: order.id,
                type: order.type,
                token: order.token,
                triggerPrice: order.condition.triggerPriceEth,
                side: order.action.side,
                status: order.status,
                tag: order.tag,
                description: order.description,
                hasChain: !!order.chain?.length,
              },
            });
          }

          case 'list': {
            const allOrders = orders.list();
            const riskSummary = orders.getRiskSummary();
            return jsonResult({
              orders: allOrders.map((o: any) => ({
                id: o.id,
                type: o.type,
                status: o.status,
                token: o.token,
                triggerPrice: o.condition.triggerPriceEth,
                side: o.action.side,
                tag: o.tag,
                description: o.description,
                createdAt: o.createdAt,
                executedAt: o.executedAt,
              })),
              count: allOrders.length,
              riskSummary,
            });
          }

          case 'cancel': {
            const orderId = readStringParam(p, 'order_id', { required: true })!;
            const success = orders.cancel(orderId);
            return jsonResult({ status: success ? 'cancelled' : 'not_found', orderId });
          }

          case 'cancel_tag': {
            const tag = readStringParam(p, 'tag', { required: true })!;
            const count = orders.cancelByTag(tag);
            return jsonResult({ status: 'cancelled', tag, count });
          }

          case 'check': {
            const price = parseFloat(readStringParam(p, 'current_price', { required: true })!);
            const triggered = orders.checkTriggers(price);
            return jsonResult({
              currentPrice: price,
              triggered: triggered.map((o: any) => ({
                id: o.id,
                type: o.type,
                token: o.token,
                triggerPrice: o.condition.triggerPriceEth,
                side: o.action.side,
              })),
              count: triggered.length,
            });
          }

          case 'executed': {
            const orderId = readStringParam(p, 'order_id', { required: true })!;
            const result = readStringParam(p, 'execution_result') || 'executed';
            const chained = orders.markExecuted(orderId, result);
            return jsonResult({
              status: 'executed',
              orderId,
              chainedOrders: chained.map((o: any) => ({
                id: o.id,
                type: o.type,
                triggerPrice: o.condition.triggerPriceEth,
              })),
            });
          }

          case 'failed': {
            const orderId = readStringParam(p, 'order_id', { required: true })!;
            orders.markPending(orderId);
            orders.recordFailure();
            return jsonResult({ status: 'reverted_to_pending', orderId, note: 'Failure cooldown activated.' });
          }

          case 'pause': {
            const orderId = readStringParam(p, 'order_id', { required: true })!;
            const success = orders.pause(orderId);
            return jsonResult({ status: success ? 'paused' : 'not_found', orderId });
          }

          case 'resume': {
            const orderId = readStringParam(p, 'order_id', { required: true })!;
            const success = orders.resume(orderId);
            return jsonResult({ status: success ? 'resumed' : 'not_found', orderId });
          }

          case 'risk': {
            const summary = orders.getRiskSummary();
            const config = orders.getRiskConfig();
            return jsonResult({ summary, config });
          }

          case 'reset_circuit_breaker': {
            orders.resetCircuitBreaker();
            return jsonResult({ status: 'circuit_breaker_reset' });
          }

          case 'cleanup': {
            const removed = orders.cleanup();
            return jsonResult({ status: 'cleanup_complete', removedCount: removed });
          }

          default:
            return errorResult(`Unknown orders action: ${action}`);
        }
      } catch (err) {
        return errorResult(`Orders error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
