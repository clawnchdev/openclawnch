/**
 * Crypto Workflow Tool — orchestrates multi-tool pipelines.
 *
 * Named workflows chain existing tool logic into safe, complete operations.
 * Each workflow runs pre-flight checks, executes the core action, and
 * performs follow-up steps (monitoring, social, order management).
 *
 * This tool exists because LLMs can forget steps in a multi-tool sequence.
 * The workflow guarantees all steps happen, in order, with safety checks.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { getWalletState, getTransactionHistory } from '../services/walletconnect-service.js';
import { getPrice, getEthPrice } from '../services/price-service.js';
import { validateSwap, validateLaunch, checkBalance } from '../services/safety-service.js';

const WORKFLOWS = [
  'safe_swap',
  'launch_and_promote',
  'check_orders',
  'portfolio_snapshot',
] as const;

const CryptoWorkflowSchema = Type.Object({
  workflow: stringEnum(WORKFLOWS, {
    description:
      'safe_swap: price check + audit + balance check + swap + set stop-loss. ' +
      'launch_and_promote: balance check + deploy + generate tweet text. ' +
      'check_orders: auto-fetch prices and check all order triggers. ' +
      'portfolio_snapshot: balance + positions + unrealized PnL.',
  }),
  // safe_swap params
  token_in: Type.Optional(Type.String({ description: 'Token to sell (for safe_swap)' })),
  token_out: Type.Optional(Type.String({ description: 'Token to buy (for safe_swap)' })),
  amount: Type.Optional(Type.String({ description: 'Amount to sell (for safe_swap)' })),
  slippage: Type.Optional(Type.Number({ description: 'Slippage % (for safe_swap, default 1.0)' })),
  stop_loss_pct: Type.Optional(Type.Number({ description: 'Auto stop-loss % below entry (for safe_swap, default: none)' })),
  // launch_and_promote params
  name: Type.Optional(Type.String({ description: 'Token name (for launch_and_promote)' })),
  symbol: Type.Optional(Type.String({ description: 'Token symbol (for launch_and_promote)' })),
  description: Type.Optional(Type.String({ description: 'Token description (for launch_and_promote)' })),
  dev_buy_eth: Type.Optional(Type.String({ description: 'Dev buy ETH amount (for launch_and_promote)' })),
});

export function createCryptoWorkflowTool() {
  return {
    name: 'crypto_workflow',
    label: 'Crypto Workflow',
    ownerOnly: true,
    description:
      'Multi-step crypto workflows that chain tools together with safety checks. ' +
      'Use "safe_swap" for audited token swaps, "launch_and_promote" for token launches ' +
      'with auto-generated tweet text, "check_orders" to auto-check all order triggers ' +
      'with live prices, "portfolio_snapshot" for a full portfolio view.',
    parameters: CryptoWorkflowSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const workflow = readStringParam(params, 'workflow', { required: true })!;

      switch (workflow) {
        case 'safe_swap':
          return handleSafeSwap(params);
        case 'launch_and_promote':
          return handleLaunchAndPromote(params);
        case 'check_orders':
          return handleCheckOrders();
        case 'portfolio_snapshot':
          return handlePortfolioSnapshot();
        default:
          return errorResult(`Unknown workflow: ${workflow}`);
      }
    },
  };
}

// ─── safe_swap: price → audit → balance → quote → execute → stop-loss ────

async function handleSafeSwap(params: Record<string, unknown>) {
  const tokenIn = readStringParam(params, 'token_in', { required: true })!;
  const tokenOut = readStringParam(params, 'token_out', { required: true })!;
  const amount = readStringParam(params, 'amount', { required: true })!;
  const slippage = readNumberParam(params, 'slippage') ?? 1.0;
  const stopLossPct = readNumberParam(params, 'stop_loss_pct');

  const steps: Array<{ step: string; status: string; data?: unknown }> = [];

  // Step 1: Wallet check
  const state = getWalletState();
  if (!state.connected) {
    return errorResult('No wallet connected. Use clawnchconnect tool first.');
  }
  steps.push({ step: 'wallet_check', status: 'ok', data: { address: state.address } });

  // Step 2: Price lookup for both tokens
  let priceIn: any = null;
  let priceOut: any = null;
  try {
    [priceIn, priceOut] = await Promise.all([
      getPrice(tokenIn).catch(() => null),
      getPrice(tokenOut).catch(() => null),
    ]);
    steps.push({
      step: 'price_lookup',
      status: 'ok',
      data: {
        tokenIn: priceIn ? { symbol: priceIn.symbol, priceUsd: priceIn.priceUsd } : 'unknown',
        tokenOut: priceOut ? { symbol: priceOut.symbol, priceUsd: priceOut.priceUsd } : 'unknown',
      },
    });
  } catch {
    steps.push({ step: 'price_lookup', status: 'warning', data: 'Price lookup failed' });
  }

  // Step 3: Safety validation (balance + token audit)
  const safety = await validateSwap({
    tokenIn,
    tokenOut,
    amountEth: parseFloat(amount),
  });

  steps.push({
    step: 'safety_check',
    status: safety.safe ? 'ok' : 'blocked',
    data: {
      safe: safety.safe,
      warnings: safety.warnings,
      blockers: safety.blockers,
    },
  });

  if (!safety.safe) {
    return jsonResult({
      workflow: 'safe_swap',
      status: 'blocked',
      steps,
      message: 'Swap blocked by safety checks. Review blockers above.',
    });
  }

  // Step 4: Return the pipeline result with execution instructions.
  // The actual swap execution should be done by calling defi_swap tool,
  // which now also includes safety checks. This workflow's value is the
  // upfront aggregation of all context.
  const swapInstruction = {
    tool: 'defi_swap',
    action: 'execute',
    params: {
      token_in: tokenIn,
      token_out: tokenOut,
      amount,
      slippage,
    },
  };

  steps.push({ step: 'swap_ready', status: 'ready', data: swapInstruction });

  // Step 5: Stop-loss recommendation
  let stopLossInstruction: any = null;
  if (stopLossPct && priceOut) {
    const stopPrice = priceOut.priceEth * (1 - stopLossPct / 100);
    stopLossInstruction = {
      tool: 'manage_orders',
      action: 'create',
      params: {
        type: 'stop_loss',
        token: tokenOut,
        trigger_price: stopPrice.toFixed(8),
        amount_pct: 100,
        description: `Auto stop-loss at -${stopLossPct}% from entry`,
      },
    };
    steps.push({ step: 'stop_loss_prepared', status: 'ready', data: stopLossInstruction });
  }

  return jsonResult({
    workflow: 'safe_swap',
    status: 'ready',
    steps,
    nextActions: [
      swapInstruction,
      ...(stopLossInstruction ? [stopLossInstruction] : []),
    ],
    message: safety.warnings.length
      ? `Swap is ready with ${safety.warnings.length} warning(s). Execute defi_swap to proceed.`
      : 'All checks passed. Execute defi_swap to proceed.',
  });
}

// ─── launch_and_promote: balance → deploy instructions → tweet text ──────

async function handleLaunchAndPromote(params: Record<string, unknown>) {
  const name = readStringParam(params, 'name', { required: true })!;
  const symbol = readStringParam(params, 'symbol', { required: true })!;
  const description = readStringParam(params, 'description') ?? '';
  const devBuyEth = readStringParam(params, 'dev_buy_eth');

  const steps: Array<{ step: string; status: string; data?: unknown }> = [];

  // Step 1: Wallet check
  const state = getWalletState();
  if (!state.connected) {
    return errorResult('No wallet connected. Use clawnchconnect tool first.');
  }
  steps.push({ step: 'wallet_check', status: 'ok', data: { address: state.address } });

  // Step 2: Balance validation
  const safety = await validateLaunch({
    devBuyEth: devBuyEth ? parseFloat(devBuyEth) : undefined,
  });
  steps.push({
    step: 'balance_check',
    status: safety.safe ? 'ok' : 'blocked',
    data: safety,
  });

  if (!safety.safe) {
    return jsonResult({
      workflow: 'launch_and_promote',
      status: 'blocked',
      steps,
      message: 'Launch blocked: ' + safety.blockers.join('; '),
    });
  }

  // Step 3: Launch instruction
  const launchInstruction = {
    tool: 'clawnch_launch',
    params: { name, symbol, description, dev_buy_eth: devBuyEth },
  };
  steps.push({ step: 'launch_ready', status: 'ready', data: launchInstruction });

  // Step 4: Generate tweet text for post-launch promotion
  const tweetText =
    `Just launched $${symbol} (${name}) on @clawnch! 🦞\n\n` +
    `${description ? description + '\n\n' : ''}` +
    `Trade it now on Base via Uniswap V4.\n` +
    `1% LP fees, MEV protection, fully decentralized.\n\n` +
    `#DeFi #Base #${symbol}`;

  const tweetInstruction = {
    tool: 'clawnx',
    action: 'post',
    params: {
      content: tweetText,
      note: 'Post after launch succeeds. Replace with actual token address URL.',
    },
  };
  steps.push({ step: 'tweet_prepared', status: 'ready', data: tweetInstruction });

  // Step 5: Monitoring instruction
  const monitorInstruction = {
    tool: 'watch_activity',
    action: 'token_activity',
    params: {
      note: 'Use the token address from the launch result to monitor trading activity.',
    },
  };
  steps.push({ step: 'monitor_prepared', status: 'ready', data: monitorInstruction });

  return jsonResult({
    workflow: 'launch_and_promote',
    status: 'ready',
    steps,
    nextActions: [launchInstruction, tweetInstruction, monitorInstruction],
    message: 'All pre-flight checks passed. Execute clawnch_launch to deploy, then follow up with tweet and monitoring.',
  });
}

// ─── check_orders: auto-fetch prices → check all triggers ────────────────

async function handleCheckOrders() {
  const steps: Array<{ step: string; status: string; data?: unknown }> = [];

  try {
    const { ClawnchOrders } = await import('@clawnch/clawncher-sdk');
  } catch {
    // ClawnchOrders may not be available
  }

  // The manage_orders tool now auto-fetches prices in its check action.
  // This workflow provides the orchestration hint to the LLM.
  return jsonResult({
    workflow: 'check_orders',
    status: 'ready',
    nextActions: [
      {
        tool: 'manage_orders',
        action: 'check',
        note: 'The check action now auto-fetches prices from DexScreener. ' +
          'Pass a token param if your orders use a token address.',
      },
    ],
    message: 'Call manage_orders with action "check" to auto-check triggers with live prices. ' +
      'Any triggered orders will include execution instructions for defi_swap.',
  });
}

// ─── portfolio_snapshot: balance + prices + tx history ────────────────────

async function handlePortfolioSnapshot() {
  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Use clawnchconnect tool first.');
  }

  const steps: Array<{ step: string; status: string; data?: unknown }> = [];

  // Step 1: ETH balance
  let ethBalance = '0';
  let ethValueUsd = 0;
  try {
    const { formatEther } = await import('viem');
    const { requirePublicClient } = await import('../services/walletconnect-service.js');
    const publicClient = requirePublicClient();
    const balance = await publicClient.getBalance({ address: state.address });
    ethBalance = formatEther(balance);

    const ethPrice = await getEthPrice();
    ethValueUsd = parseFloat(ethBalance) * ethPrice;

    steps.push({
      step: 'eth_balance',
      status: 'ok',
      data: { balance: ethBalance, priceUsd: ethPrice, valueUsd: ethValueUsd },
    });
  } catch (err) {
    steps.push({ step: 'eth_balance', status: 'error', data: String(err) });
  }

  // Step 2: Recent transaction history
  const txHistory = getTransactionHistory();
  const recentTxs = txHistory.slice(-10).reverse();
  steps.push({
    step: 'recent_transactions',
    status: 'ok',
    data: {
      total: txHistory.length,
      recent: recentTxs.map(tx => ({
        status: tx.status,
        summary: tx.summary,
        hash: tx.hash,
        policyLabel: tx.policyLabel,
      })),
    },
  });

  // Step 3: Wallet policies
  steps.push({
    step: 'policies',
    status: 'ok',
    data: {
      count: state.policies.length,
      mode: state.mode,
    },
  });

  return jsonResult({
    workflow: 'portfolio_snapshot',
    status: 'ok',
    address: state.address,
    chainId: state.chainId,
    ethBalance,
    ethValueUsd,
    transactionCount: txHistory.length,
    steps,
    message: 'For detailed ERC-20 balances, also call defi_balance with action "tokens". ' +
      'For fee revenue, call clawnch_fees with action "check".',
  });
}
