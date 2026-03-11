/**
 * Hummingbot Tool — market-making bot control via HummingbotClient
 *
 * Wraps the @clawnch/clawncher-sdk HummingbotClient (76 methods) behind a single
 * OpenClaw tool with action-based dispatch. Requires a running Hummingbot instance.
 *
 * Env vars: HUMMINGBOT_API_URL, HUMMINGBOT_USERNAME, HUMMINGBOT_PASSWORD
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { checkToolConfig } from '../services/tool-config-service.js';
import { getCredentialVault } from '../services/credential-vault.js';

const ACTIONS = [
  'status', 'portfolio', 'order', 'cancel_order', 'active_orders',
  'executor', 'stop_executor', 'executors', 'executor_types',
  'market_data', 'candles', 'orderbook', 'funding_rate',
  'bot_deploy', 'bot_status', 'bot_stop', 'bot_logs', 'bot_history',
  'controllers', 'controller_configs',
  'gateway_status', 'gateway_start', 'gateway_stop',
  'leverage', 'history', 'templates', 'backtest',
  'connectors', 'accounts', 'scripts',
  // Condor-specific actions (Hummingbot Condor upgrade)
  'pnl', 'clmm_positions', 'routines', 'routine_start', 'routine_stop', 'dashboard',
] as const;

const HummingbotSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'status: health check. portfolio: balances/positions. order: place order. ' +
      'cancel_order: cancel. active_orders: list open. executor: create executor. ' +
      'bot_deploy/bot_status/bot_stop/bot_logs/bot_history: manage bots. ' +
      'market_data/candles/orderbook: prices & data. templates: strategy templates. ' +
      'gateway_status/start/stop: DEX gateway. leverage: set leverage. ' +
      'history: search trade history. backtest: run backtest. ' +
      'pnl: PnL tracking. clmm_positions: CLMM LP positions. ' +
      'routines: list auto-discoverable routines. routine_start/stop: manage routines. ' +
      'dashboard: Condor portfolio dashboard.',
  }),
  connector: Type.Optional(Type.String({ description: 'Connector name (e.g. "binance", "uniswap")' })),
  trading_pair: Type.Optional(Type.String({ description: 'Trading pair (e.g. "ETH-USDT")' })),
  account: Type.Optional(Type.String({ description: 'Account name' })),
  trade_type: Type.Optional(Type.String({ description: '"BUY" or "SELL"' })),
  amount: Type.Optional(Type.String({ description: 'Order/trade amount' })),
  price: Type.Optional(Type.String({ description: 'Limit price' })),
  order_type: Type.Optional(Type.String({ description: '"MARKET", "LIMIT", or "LIMIT_MAKER"' })),
  order_id: Type.Optional(Type.String({ description: 'Client order ID for cancel' })),
  executor_type: Type.Optional(Type.String({
    description: '"position_executor", "dca_executor", "grid_executor", "order_executor", "arbitrage_executor"',
  })),
  executor_id: Type.Optional(Type.String({ description: 'Executor ID' })),
  executor_config: Type.Optional(Type.String({ description: 'JSON executor config' })),
  bot_name: Type.Optional(Type.String({ description: 'Bot name' })),
  controllers_config: Type.Optional(Type.String({ description: 'JSON array of controller config names' })),
  template: Type.Optional(Type.String({ description: 'Strategy template name' })),
  template_overrides: Type.Optional(Type.String({ description: 'JSON overrides for template' })),
  interval: Type.Optional(Type.String({ description: 'Candle interval: 1m, 5m, 15m, 30m, 1h, 4h, 1d' })),
  days: Type.Optional(Type.Number({ description: 'Number of days for candle/history lookback' })),
  leverage: Type.Optional(Type.Number({ description: 'Leverage multiplier' })),
  position_mode: Type.Optional(Type.String({ description: '"HEDGE" or "ONE-WAY"' })),
  limit: Type.Optional(Type.Number({ description: 'Result limit' })),
  backtest_config: Type.Optional(Type.String({ description: 'JSON backtest config or controller config name' })),
  start_time: Type.Optional(Type.Number({ description: 'Start timestamp (seconds)' })),
  end_time: Type.Optional(Type.Number({ description: 'End timestamp (seconds)' })),
  log_type: Type.Optional(Type.String({ description: '"error", "general", or "all"' })),
  passphrase: Type.Optional(Type.String({ description: 'Gateway passphrase' })),
  image: Type.Optional(Type.String({ description: 'Docker image for gateway/bot' })),
});

// Lazy singleton
let _client: any = null;

async function getClient(): Promise<any> {
  if (_client) return _client;
  const { HummingbotClient } = await import('@clawnch/clawncher-sdk');
  // H3 FIX: Require explicit credentials — no default admin/admin
  const apiUrl = process.env.HUMMINGBOT_API_URL;
  const username = getCredentialVault().getSecret('bot.hummingbot.username', 'hummingbot');
  const password = getCredentialVault().getSecret('bot.hummingbot.password', 'hummingbot');
  if (!apiUrl || !username || !password) {
    throw new Error(
      'Hummingbot not configured. Set HUMMINGBOT_API_URL, HUMMINGBOT_USERNAME, and HUMMINGBOT_PASSWORD.'
    );
  }
  _client = new HummingbotClient({ apiUrl, username, password });
  return _client;
}

export function createHummingbotTool() {
  return {
    name: 'hummingbot',
    label: 'Hummingbot',
    ownerOnly: true,
    description:
      'Control Hummingbot/Condor market-making bots. Place orders, manage executors, ' +
      'deploy bots with strategies, check portfolio + PnL, CLMM LP positions, auto-routines, ' +
      'get market data, run backtests. Requires a running Hummingbot/Condor instance (set HUMMINGBOT_API_URL).',
    parameters: HummingbotSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      // Early check: is the tool configured?
      const notReady = checkToolConfig('hummingbot');
      if (notReady) return notReady;

      const p = args as Record<string, unknown>;
      const action = readStringParam(p, 'action', { required: true })!;

      try {
        const client = await getClient();

        switch (action) {
          // ── Health & Status ─────────────────────────────────────────
          case 'status': {
            const health = await client.checkHealth();
            return jsonResult(health);
          }

          // ── Portfolio ───────────────────────────────────────────────
          case 'portfolio': {
            const result = await client.getPortfolioOverview({
              accountNames: p.account ? [p.account as string] : undefined,
              connectorNames: p.connector ? [p.connector as string] : undefined,
              includeBalances: true,
              includePerpPositions: true,
              includeActiveOrders: true,
            });
            return jsonResult(result);
          }

          // ── Orders ──────────────────────────────────────────────────
          case 'order': {
            const connector = readStringParam(p, 'connector', { required: true })!;
            const tradingPair = readStringParam(p, 'trading_pair', { required: true })!;
            const tradeType = readStringParam(p, 'trade_type', { required: true })!;
            const amount = readStringParam(p, 'amount', { required: true })!;
            const result = await client.placeOrder({
              connectorName: connector,
              tradingPair,
              tradeType: tradeType.toUpperCase(),
              amount,
              orderType: (readStringParam(p, 'order_type') || 'LIMIT').toUpperCase(),
              price: readStringParam(p, 'price'),
              accountName: readStringParam(p, 'account'),
            });
            return jsonResult(result);
          }

          case 'cancel_order': {
            const connector = readStringParam(p, 'connector', { required: true })!;
            const orderId = readStringParam(p, 'order_id', { required: true })!;
            const account = readStringParam(p, 'account') || 'master_account';
            const result = await client.cancelOrder(account, connector, orderId);
            return jsonResult(result);
          }

          case 'active_orders': {
            const result = await client.getActiveOrders({
              connectorNames: p.connector ? [p.connector as string] : undefined,
              tradingPairs: p.trading_pair ? [p.trading_pair as string] : undefined,
              limit: readNumberParam(p, 'limit') ?? 50,
            });
            return jsonResult(result);
          }

          // ── Executors ───────────────────────────────────────────────
          case 'executor': {
            const configStr = readStringParam(p, 'executor_config', { required: true })!;
            const config = JSON.parse(configStr);
            const result = await client.createExecutor(config);
            return jsonResult(result);
          }

          case 'stop_executor': {
            const eid = readStringParam(p, 'executor_id', { required: true })!;
            const result = await client.stopExecutor(eid);
            return jsonResult(result);
          }

          case 'executors': {
            const result = await client.searchExecutors({
              executorTypes: p.executor_type ? [p.executor_type as string] : undefined,
              connectorNames: p.connector ? [p.connector as string] : undefined,
              tradingPairs: p.trading_pair ? [p.trading_pair as string] : undefined,
              limit: readNumberParam(p, 'limit') ?? 20,
            });
            return jsonResult(result);
          }

          case 'executor_types': {
            const result = await client.getExecutorTypes();
            return jsonResult(result);
          }

          // ── Market Data ─────────────────────────────────────────────
          case 'market_data': {
            const connector = readStringParam(p, 'connector', { required: true })!;
            const pairs = readStringParam(p, 'trading_pair', { required: true })!;
            const result = await client.getPrices(connector, pairs.split(',').map(s => s.trim()));
            return jsonResult(result);
          }

          case 'candles': {
            const connector = readStringParam(p, 'connector', { required: true })!;
            const pair = readStringParam(p, 'trading_pair', { required: true })!;
            const result = await client.getCandles(
              connector, pair,
              readStringParam(p, 'interval') as any ?? '1h',
              readNumberParam(p, 'days') ?? 1,
            );
            return jsonResult(result);
          }

          case 'orderbook': {
            const connector = readStringParam(p, 'connector', { required: true })!;
            const pair = readStringParam(p, 'trading_pair', { required: true })!;
            const result = await client.getOrderBook(connector, pair);
            return jsonResult(result);
          }

          case 'funding_rate': {
            const connector = readStringParam(p, 'connector', { required: true })!;
            const pair = readStringParam(p, 'trading_pair', { required: true })!;
            const result = await client.getFundingRate(connector, pair);
            return jsonResult(result);
          }

          // ── Bot Management ──────────────────────────────────────────
          case 'bot_deploy': {
            const botName = readStringParam(p, 'bot_name', { required: true })!;
            const configStr = readStringParam(p, 'controllers_config', { required: true })!;
            const result = await client.deployBot({
              botName,
              controllersConfig: JSON.parse(configStr),
              accountName: readStringParam(p, 'account'),
              image: readStringParam(p, 'image'),
            });
            return jsonResult(result);
          }

          case 'bot_status': {
            const result = await client.getBotsStatus();
            return jsonResult(result);
          }

          case 'bot_stop': {
            const botName = readStringParam(p, 'bot_name', { required: true })!;
            const result = await client.stopBot(botName);
            return jsonResult(result);
          }

          case 'bot_logs': {
            const botName = readStringParam(p, 'bot_name', { required: true })!;
            const result = await client.getBotLogs({
              botName,
              logType: (readStringParam(p, 'log_type') as any) ?? 'all',
              limit: readNumberParam(p, 'limit') ?? 50,
            });
            return jsonResult(result);
          }

          case 'bot_history': {
            const botName = readStringParam(p, 'bot_name', { required: true })!;
            const result = await client.getBotHistory(
              botName,
              readNumberParam(p, 'days') ?? 7,
            );
            return jsonResult(result);
          }

          // ── Controllers ─────────────────────────────────────────────
          case 'controllers': {
            const result = await client.listControllers();
            return jsonResult(result);
          }

          case 'controller_configs': {
            const result = await client.listControllerConfigs();
            return jsonResult(result);
          }

          // ── Gateway ─────────────────────────────────────────────────
          case 'gateway_status': {
            const result = await client.getGatewayStatus();
            return jsonResult(result);
          }

          case 'gateway_start': {
            const passphrase = readStringParam(p, 'passphrase', { required: true })!;
            const img = readStringParam(p, 'image', { required: true })!;
            const result = await client.startGateway({ passphrase, image: img });
            return jsonResult(result);
          }

          case 'gateway_stop': {
            const result = await client.stopGateway();
            return jsonResult(result);
          }

          // ── Leverage ────────────────────────────────────────────────
          case 'leverage': {
            const account = readStringParam(p, 'account', { required: true })!;
            const connector = readStringParam(p, 'connector', { required: true })!;
            const result = await client.setPositionModeAndLeverage({
              accountName: account,
              connectorName: connector,
              tradingPair: readStringParam(p, 'trading_pair'),
              positionMode: readStringParam(p, 'position_mode') as any,
              leverage: readNumberParam(p, 'leverage'),
            });
            return jsonResult(result);
          }

          // ── History ─────────────────────────────────────────────────
          case 'history': {
            const result = await client.searchHistory({
              dataType: 'orders' as any,
              connectorNames: p.connector ? [p.connector as string] : undefined,
              tradingPairs: p.trading_pair ? [p.trading_pair as string] : undefined,
              limit: readNumberParam(p, 'limit') ?? 50,
              startTime: readNumberParam(p, 'start_time'),
              endTime: readNumberParam(p, 'end_time'),
            });
            return jsonResult(result);
          }

          // ── Templates ───────────────────────────────────────────────
          case 'templates': {
            const name = readStringParam(p, 'template');
            if (name) {
              const overridesStr = readStringParam(p, 'template_overrides');
              if (overridesStr) {
                const config = client.buildFromTemplate(name, JSON.parse(overridesStr));
                return jsonResult({ template: name, config });
              }
              const tmpl = client.getStrategyTemplate(name);
              return jsonResult(tmpl ?? { error: `Template "${name}" not found` });
            }
            return jsonResult(client.getStrategyTemplates());
          }

          // ── Backtest ────────────────────────────────────────────────
          case 'backtest': {
            const configStr = readStringParam(p, 'backtest_config', { required: true })!;
            const startTime = readNumberParam(p, 'start_time', { required: true })!;
            const endTime = readNumberParam(p, 'end_time', { required: true })!;
            let config: string | Record<string, unknown>;
            try { config = JSON.parse(configStr); } catch { config = configStr; }
            const result = await client.runBacktest({ config, startTime, endTime });
            return jsonResult(result);
          }

          // ── Connectors & Accounts ───────────────────────────────────
          case 'connectors': {
            const result = await client.listConnectors();
            return jsonResult(result);
          }

          case 'accounts': {
            const result = await client.listAccounts();
            return jsonResult(result);
          }

          case 'scripts': {
            const result = await client.listScripts();
            return jsonResult(result);
          }

          // ── Condor-specific Actions ─────────────────────────────────
          // These target Condor's extended API surface. If the backend is
          // plain Hummingbot (not Condor), these will return a helpful error.

          case 'pnl': {
            if (typeof client.getPnL !== 'function') {
              return errorResult('PnL tracking requires Condor backend. Upgrade from Hummingbot to Condor: https://github.com/hummingbot/condor');
            }
            const result = await client.getPnL({
              connectorNames: p.connector ? [p.connector as string] : undefined,
              tradingPairs: p.trading_pair ? [p.trading_pair as string] : undefined,
              days: readNumberParam(p, 'days') ?? 7,
            });
            return jsonResult(result);
          }

          case 'clmm_positions': {
            if (typeof client.getCLMMPositions !== 'function') {
              return errorResult('CLMM LP positions require Condor backend. Upgrade from Hummingbot to Condor: https://github.com/hummingbot/condor');
            }
            const result = await client.getCLMMPositions({
              connectorNames: p.connector ? [p.connector as string] : undefined,
              accountNames: p.account ? [p.account as string] : undefined,
            });
            return jsonResult(result);
          }

          case 'routines': {
            if (typeof client.listRoutines !== 'function') {
              return errorResult('Auto-discoverable routines require Condor backend. Upgrade from Hummingbot to Condor: https://github.com/hummingbot/condor');
            }
            const result = await client.listRoutines();
            return jsonResult(result);
          }

          case 'routine_start': {
            if (typeof client.startRoutine !== 'function') {
              return errorResult('Routines require Condor backend.');
            }
            const name = readStringParam(p, 'bot_name', { required: true })!;
            const result = await client.startRoutine(name);
            return jsonResult(result);
          }

          case 'routine_stop': {
            if (typeof client.stopRoutine !== 'function') {
              return errorResult('Routines require Condor backend.');
            }
            const name = readStringParam(p, 'bot_name', { required: true })!;
            const result = await client.stopRoutine(name);
            return jsonResult(result);
          }

          case 'dashboard': {
            if (typeof client.getDashboard !== 'function') {
              return errorResult('Portfolio dashboard requires Condor backend. Upgrade from Hummingbot to Condor: https://github.com/hummingbot/condor');
            }
            const result = await client.getDashboard({
              includeBalances: true,
              includePnL: true,
              includeCLMM: true,
              includeRoutines: true,
            });
            return jsonResult(result);
          }

          default:
            return errorResult(`Unknown hummingbot action: ${action}`);
        }
      } catch (err) {
        return errorResult(`Hummingbot error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
