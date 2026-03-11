/**
 * after_tool_call hook — Post-execution tracking and progression
 *
 * Handles:
 * - Onboarding progression (advance tutorial on tool success)
 * - Missing config detection (hint user about required env vars)
 * - Auto-record swaps to cost basis tracker
 * - Auto-record to transaction ledger (event-sourced audit trail)
 * - Auto-record costs to budget service
 * - Session recall indexing
 * - Evolution mode nudge tracking
 */

import { getOnboardingFlow, type OnboardingMessage } from '../services/onboarding-flow.js';
import { recordSwapTrade } from '../tools/cost-basis.js';
import { getTxLedger, toolToEventType, chainIdToName } from '../services/tx-ledger.js';
import { getBudgetService } from '../services/budget-service.js';
import { getEvolutionMode } from '../services/evolution-mode.js';
import { getSessionRecall } from '../services/session-recall.js';
import { parseSessionKey, extractSenderId, extractChannelId, type ChannelId } from '../services/channel-sender.js';

/** Dependencies injected by the plugin register() function. */
export interface AfterToolCallDeps {
  /** The single source of truth for write-tool names. */
  writeToolNames: Set<string>;
  /** Send an onboarding message to a specific channel/user. */
  sendOnboardingMessage: (channel: ChannelId, chatId: string, msg: OnboardingMessage) => Promise<void>;
  /** Set of conversation IDs where onboarding handled the last message. */
  onboardingHandledConversations: Set<string>;
  /** Get current wallet connection state. */
  getWalletState: () => {
    connected: boolean;
    address?: string | null;
    chainId?: number | null;
    mode?: string | null;
  };
  logger?: {
    info?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
  } | null;
}

/**
 * Handle the after_tool_call hook event.
 *
 * This function contains all post-tool-call side effects: onboarding,
 * cost basis recording, ledger, budget, session recall, and evolution.
 */
export async function handleAfterToolCall(
  event: any,
  ctx: any,
  deps: AfterToolCallDeps,
): Promise<void> {
  try {
    // ── Onboarding progression ─────────────────────────────────
    const sessionKey = ctx?.sessionKey ?? '';
    const parsedSession = parseSessionKey(sessionKey);
    const userId = parsedSession?.userId ?? extractSenderId(null, ctx);
    const channel: ChannelId = parsedSession?.channel ?? extractChannelId(ctx) ?? 'telegram';

    if (userId) {
      const flow = getOnboardingFlow(userId);
      if (flow.isActive) {
        const toolName = event?.toolName ?? event?.tool;
        const success = !event?.error;
        const response = flow.processToolResult(String(toolName), success);
        if (response) {
          await deps.sendOnboardingMessage(channel, userId, response).catch((err: any) =>
            deps.logger?.warn?.(`[crypto] Failed to send onboarding msg: ${err}`));
          deps.onboardingHandledConversations.add(userId);
          deps.logger?.info?.(
            `[crypto] Onboarding advanced for user ${userId}: ${flow.currentStep}`
          );
        }
      }
    }

    // ── Missing config detection ──────────────────────────────
    const tool = event?.toolName ?? event?.tool;
    const result = event?.result ?? event?.details;
    const errorStr = typeof event?.error === 'string' ? event.error
      : typeof result === 'string' ? result : '';

    if (event?.error || (typeof result === 'string' && result.includes('error'))) {
      const MISSING_CONFIG_HINTS: Record<string, { envVar: string; hint: string }> = {
        herd_intelligence: {
          envVar: 'HERD_ACCESS_TOKEN',
          hint: 'Get a token from the Herd dashboard, then set HERD_ACCESS_TOKEN.\n  Fly.io: `/flykeys set HERD_ACCESS_TOKEN your-token` then /flyrestart\n  Docker: add to your `.env` file and restart',
        },
        hummingbot: {
          envVar: 'HUMMINGBOT_API_URL',
          hint: 'Point to a running Hummingbot instance. Set HUMMINGBOT_API_URL.\n  Fly.io: `/flykeys set HUMMINGBOT_API_URL http://your-hummingbot:8000` then /flyrestart\n  Docker: add to your `.env` file and restart',
        },
        molten: {
          envVar: 'MOLTEN_API_KEY',
          hint: 'Register on Molten first (ask me to "register on Molten"), then set MOLTEN_API_KEY.\n  Fly.io: `/flykeys set MOLTEN_API_KEY your-key` then /flyrestart\n  Docker: add to your `.env` file and restart',
        },
        bankr_launch: {
          envVar: 'BANKR_API_KEY',
          hint: 'Connect via Bankr first: /connect_bankr',
        },
        bankr_automate: {
          envVar: 'BANKR_API_KEY',
          hint: 'Connect via Bankr first: /connect_bankr',
        },
        bankr_polymarket: {
          envVar: 'BANKR_API_KEY',
          hint: 'Connect via Bankr first: /connect_bankr',
        },
        bankr_leverage: {
          envVar: 'BANKR_API_KEY',
          hint: 'Connect via Bankr first: /connect_bankr',
        },
      };

      const configHint = MISSING_CONFIG_HINTS[String(tool)];
      if (configHint && !process.env[configHint.envVar]) {
        const chatId = ctx?.conversationId ?? userId;
        if (chatId) {
          await deps.sendOnboardingMessage(channel, String(chatId), {
            text: `This feature requires ${configHint.envVar} to be configured.\n\n${configHint.hint}`,
          }).catch((err: any) =>
            deps.logger?.warn?.(`[crypto] Failed to send config hint: ${err}`));
        }
      }
    }

    // ── Auto-record swaps to cost basis tracker ────────────────
    if (tool === 'defi_swap' && result && !event?.error) {
      try {
        const data = typeof result === 'string' ? JSON.parse(result) : result;
        const details = data?.details ?? data;
        if (details?.status === 'success' && details?.txHash) {
          const sellToken = details.sellToken ?? details.sell_token;
          const buyToken = details.buyToken ?? details.buy_token;
          const sellAmount = parseFloat(details.sellAmount ?? details.sell_amount ?? '0');
          const buyAmount = parseFloat(details.buyAmount ?? details.buy_amount ?? '0');
          const sellSymbol = details.sellSymbol ?? details.sell_symbol ?? 'UNKNOWN';
          const buySymbol = details.buySymbol ?? details.buy_symbol ?? 'UNKNOWN';
          const txHash = details.txHash ?? details.tx_hash;

          if (sellToken && sellAmount > 0) {
            const priceUsd = buyAmount > 0 && sellAmount > 0
              ? (details.sellValueUsd ?? details.sell_value_usd ?? 0) / sellAmount
              : 0;
            if (priceUsd > 0) {
              recordSwapTrade({
                token: sellToken,
                symbol: sellSymbol,
                amount: sellAmount,
                priceUsd,
                type: 'sell',
                txHash,
              });
            }
          }
          if (buyToken && buyAmount > 0) {
            const priceUsd = buyAmount > 0
              ? (details.buyValueUsd ?? details.buy_value_usd ?? details.sellValueUsd ?? details.sell_value_usd ?? 0) / buyAmount
              : 0;
            if (priceUsd > 0) {
              recordSwapTrade({
                token: buyToken,
                symbol: buySymbol,
                amount: buyAmount,
                priceUsd,
                type: 'buy',
                txHash,
              });
            }
          }
          deps.logger?.info?.(
            `[crypto] Auto-recorded swap: ${sellSymbol} → ${buySymbol} (${txHash?.slice(0, 10)}...)`
          );
        }
      } catch (swapErr) {
        deps.logger?.warn?.(
          `[crypto] Failed to auto-record swap: ${swapErr instanceof Error ? swapErr.message : String(swapErr)}`
        );
      }
    }

    // ── Auto-record to Transaction Ledger ─────────────────────────
    if (tool && deps.writeToolNames.has(String(tool))) {
      const writeData = typeof result === 'string' ? (() => { try { return JSON.parse(result); } catch { return {}; } })() : (result ?? {});
      const details = (writeData as any)?.details ?? writeData;
      const walletState = deps.getWalletState();

      try {
        const ledger = getTxLedger();

        ledger.append({
          type: toolToEventType(String(tool)),
          userId: userId ?? 'unknown',
          txHash: details?.txHash ?? details?.tx_hash ?? null,
          chainId: details?.chainId ?? walletState.chainId ?? 8453,
          chain: chainIdToName(details?.chainId ?? walletState.chainId ?? 8453),
          from: walletState.address ?? 'unknown',
          to: details?.to ?? details?.contract ?? null,
          status: event?.error ? 'failed' : (details?.status === 'success' ? 'confirmed' : 'pending'),
          summary: details?.summary ?? `${String(tool)} call`,
          data: typeof details === 'object' ? details : {},
          gasCostUsd: details?.gasCostUsd ?? details?.gas_cost_usd,
          tool: String(tool),
          error: event?.error ? String(event.error) : undefined,
        });
      } catch (ledgerErr) {
        deps.logger?.warn?.(
          `[crypto] Failed to record to tx ledger: ${ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr)}`
        );
      }

      // ── Auto-record costs to Budget Service ─────────────────────
      try {
        const budgetSvc = getBudgetService();
        const budgetUserId = userId ?? 'unknown';
        const activeSession = budgetSvc.getActiveSession(budgetUserId);
        if (activeSession) {
          const gasCostUsd = parseFloat(details?.gasCostUsd ?? details?.gas_cost_usd ?? '0') || 0;
          const feesUsd = parseFloat(details?.feesUsd ?? details?.fees_usd ?? '0') || 0;
          const slippageUsd = parseFloat(details?.slippageUsd ?? details?.slippage_usd ?? '0') || 0;
          const tradeValueUsd = parseFloat(details?.sellValueUsd ?? details?.sell_value_usd ?? details?.valueUsd ?? '0') || 0;

          budgetSvc.recordCost(activeSession.id, {
            stepLabel: `${String(tool)}: ${details?.summary ?? 'operation'}`,
            gasUsd: Math.max(0, gasCostUsd),
            slippageUsd: Math.max(0, slippageUsd),
            feesUsd: Math.max(0, feesUsd),
            tradeValueUsd: Math.max(0, tradeValueUsd),
            txHash: details?.txHash ?? details?.tx_hash,
          });

          const check = budgetSvc.checkBudget(activeSession.id);
          if (!check.ok) {
            deps.logger?.warn?.(
              `[crypto] Budget exceeded for user ${budgetUserId}: ${check.blockers.join('; ')}`
            );
          }
        }
      } catch (budgetErr) {
        deps.logger?.warn?.(
          `[crypto] Failed to record to budget service: ${budgetErr instanceof Error ? budgetErr.message : String(budgetErr)}`
        );
      }
    }

    // ── Session recall: index tool results ────────────────────────
    try {
      const recallSessionKey = ctx?.sessionKey ?? (parsedSession ? `${parsedSession.channel}-${parsedSession.userId}` : undefined);
      if (recallSessionKey) {
        const toolName = event?.toolName ?? event?.tool ?? 'unknown';
        const toolResult = event?.result ?? event?.details;
        const resultStr = typeof toolResult === 'string'
          ? toolResult
          : (toolResult ? JSON.stringify(toolResult).slice(0, 2000) : '');
        if (resultStr) {
          getSessionRecall().recordTurn({
            sessionKey: recallSessionKey,
            role: 'assistant',
            content: `[tool:${toolName}] ${resultStr}`.slice(0, 2000),
            userId: userId ? String(userId) : undefined,
            timestamp: Date.now(),
          });
        }
      }
    } catch {
      // Non-critical
    }

    // ── Evolution mode: nudge tracking ────────────────────────────
    try {
      if (userId) {
        const evo = getEvolutionMode();
        if (evo.isEvolving(String(userId))) {
          const nudge = evo.recordTurn(String(userId));
          if (nudge) {
            deps.logger?.info?.(`[crypto] Evolution nudge for ${userId}: ${nudge.slice(0, 80)}...`);
          }
        }
      }
    } catch {
      // Non-critical
    }
  } catch (err) {
    deps.logger?.warn?.(
      `[crypto] After tool call hook error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
