/**
 * @clawnch/openclaw-crypto — OpenClaw extension for crypto/DeFi
 * 
 * Registers tools, commands, and hooks with the OpenClaw plugin system.
 * This is the entry point loaded by OpenClaw's plugin loader.
 * 
 * Works both as:
 * 1. Bundled extension in OpenClawnch (thin wrapper)
 * 2. Standalone extension for vanilla OpenClaw (`clawhub install @clawnch/openclaw-crypto`)
 */

// Tools — Core (13 original)
import { createClawnchConnectTool } from './src/tools/clawnchconnect.js';
import { createDefiPriceTool } from './src/tools/defi-price.js';
import { createDefiBalanceTool } from './src/tools/defi-balance.js';
import { createDefiSwapTool } from './src/tools/defi-swap.js';
import { createClawnchLaunchTool } from './src/tools/clawnch-launch.js';
import { createClawnchFeesTool } from './src/tools/clawnch-fees.js';
import { createMarketIntelTool } from './src/tools/market-intel.js';
import { createHummingbotTool } from './src/tools/hummingbot.js';
import { createManageOrdersTool } from './src/tools/manage-orders.js';
import { createWatchActivityTool } from './src/tools/watch-activity.js';
import { createClawnXTool } from './src/tools/clawnx.js';
import { createHerdIntelligenceTool } from './src/tools/herd-intelligence.js';
import { createCryptoWorkflowTool } from './src/tools/crypto-workflow.js';

// Tools — Phase 2 (4 new: critical gap coverage)
import { createTransferTool } from './src/tools/transfer.js';
import { createLiquidityTool } from './src/tools/liquidity.js';
import { createWayfinderTool } from './src/tools/wayfinder.js';
import { createClawnchInfoTool } from './src/tools/clawnch-info.js';

// Tools — Phase 3 (4 new: Permit2, cost basis, analytics, block explorer)
import { createPermit2Tool } from './src/tools/permit2.js';
import { createCostBasisTool } from './src/tools/cost-basis.js';
import { createAnalyticsTool } from './src/tools/analytics.js';
import { createBlockExplorerTool } from './src/tools/block-explorer.js';

// Tools — Phase 4 (bridge aggregation)
import { createBridgeTool } from './src/tools/bridge.js';

// Commands
import { walletCommand } from './src/commands/wallet-command.js';
import { policyCommand } from './src/commands/policy-command.js';
import { txCommand } from './src/commands/tx-command.js';

// Services
import { initWalletService } from './src/services/walletconnect-service.js';
import { getOnboardingFlow, isNewUser } from './src/services/onboarding-flow.js';
import { recordSwapTrade } from './src/tools/cost-basis.js';

/**
 * OpenClaw Plugin Definition
 * 
 * The `api` parameter is OpenClawPluginApi — provides registerTool(),
 * registerCommand(), on(), registerService(), etc.
 * 
 * We use `any` for the API type since we don't want a hard dependency
 * on openclaw internals. The plugin loader provides the typed API at runtime.
 */
const plugin = {
  id: 'crypto',
  name: 'Crypto DeFi Tools',
  description: 'ClawnchConnect wallet, DeFi trading, token launchpad, and market intelligence',
  version: '0.1.0',

  register(api: any) {
    // ─── Register Tools (22 total) ────────────────────────────────
    // Core tools (13)
    api.registerTool(createClawnchConnectTool());
    api.registerTool(createDefiPriceTool());
    api.registerTool(createDefiBalanceTool());
    api.registerTool(createDefiSwapTool());
    api.registerTool(createClawnchLaunchTool());
    api.registerTool(createClawnchFeesTool());
    api.registerTool(createMarketIntelTool());
    api.registerTool(createHummingbotTool());
    api.registerTool(createManageOrdersTool());
    api.registerTool(createWatchActivityTool());
    api.registerTool(createClawnXTool());
    api.registerTool(createHerdIntelligenceTool());
    api.registerTool(createCryptoWorkflowTool());

    // Phase 2 tools (4) — critical gap coverage
    api.registerTool(createTransferTool());
    api.registerTool(createLiquidityTool());
    api.registerTool(createWayfinderTool());
    api.registerTool(createClawnchInfoTool());

    // Phase 3 tools (4) — Permit2, cost basis, analytics, block explorer
    api.registerTool(createPermit2Tool());
    api.registerTool(createCostBasisTool());
    api.registerTool(createAnalyticsTool());
    api.registerTool(createBlockExplorerTool());

    // Phase 4 tools (1) — cross-chain bridge
    api.registerTool(createBridgeTool());

    // ─── Register Chat Commands ────────────────────────────────────
    api.registerCommand(walletCommand);
    api.registerCommand(policyCommand);
    api.registerCommand(txCommand);

    // ─── Gateway Startup Hook ──────────────────────────────────────
    // Initialize WalletConnect session at gateway boot
    api.on('gateway_start', async () => {
      const projectId = process.env.WALLETCONNECT_PROJECT_ID;
      const privateKey = process.env.CLAWNCHER_PRIVATE_KEY;

      if (!projectId && !privateKey) {
        api.logger?.info?.(
          '[crypto] No wallet configured. Set WALLETCONNECT_PROJECT_ID or CLAWNCHER_PRIVATE_KEY to enable write operations.'
        );
        return;
      }

      try {
        const result = await initWalletService({
          privateKey,
          walletConnectProjectId: projectId,
          rpcUrl: process.env.CLAWNCHER_RPC_URL,
          network: (process.env.CLAWNCHER_NETWORK as 'mainnet' | 'sepolia') || 'mainnet',
          sessionPath: process.env.WALLETCONNECT_SESSION
            || `${process.env.HOME ?? ''}/.openclawnch/wc-session.json`,
          onSessionChange: (state) => {
            if (state.status === 'connected') {
              api.logger?.info?.(`[crypto] Wallet connected: ${state.address}`);
            } else if (state.status === 'disconnected') {
              api.logger?.info?.('[crypto] Wallet disconnected');
            }
          },
        });

        if (result.mode === 'private_key') {
          api.logger?.info?.(`[crypto] Wallet ready (private key mode): ${result.address}`);
        } else if (result.pairingUri) {
          api.logger?.info?.(
            `[crypto] WalletConnect pairing URI generated. ` +
            `The agent will present the QR code when a user connects.`
          );
        } else if (result.address) {
          api.logger?.info?.(`[crypto] Wallet session restored: ${result.address}`);
        }
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Wallet initialization failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    // ─── Onboarding: Message Received Hook ─────────────────────────────
    // Intercepts first message from new Telegram users to start the tutorial.
    api.on('message_received', (event: any) => {
      try {
        const userId = event?.userId ?? event?.context?.userId;
        if (!userId) return;

        const flow = getOnboardingFlow(String(userId));
        if (!flow.isActive) return;

        const message = event?.text ?? event?.content ?? '';
        const response = flow.processMessage(String(message));

        if (response) {
          // Attach onboarding response to the event for the channel adapter
          // to send before/alongside the agent response
          event._onboardingMessage = response;
          api.logger?.info?.(
            `[crypto] Onboarding step for user ${userId}: ${flow.currentStep}`
          );
        }
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Onboarding message hook error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    // ─── Onboarding: After Tool Call Hook ──────────────────────────────
    // Advances the tutorial when read/write tools complete successfully.
    // Also auto-records swaps to cost basis tracker.
    api.on('after_tool_call', (event: any) => {
      try {
        // ── Onboarding progression ─────────────────────────────────
        const userId = event?.userId ?? event?.context?.userId;
        if (userId) {
          const flow = getOnboardingFlow(String(userId));
          if (flow.isActive) {
            const toolName = event?.toolName ?? event?.tool;
            const success = event?.success !== false && !event?.error;
            const response = flow.processToolResult(String(toolName), success);
            if (response) {
              event._onboardingMessage = response;
              api.logger?.info?.(
                `[crypto] Onboarding advanced for user ${userId}: ${flow.currentStep}`
              );
            }
          }
        }

        // ── Auto-record swaps to cost basis tracker ────────────────
        const tool = event?.toolName ?? event?.tool;
        const result = event?.result ?? event?.details;
        if (tool === 'defi_swap' && result && !event?.error) {
          try {
            const data = typeof result === 'string' ? JSON.parse(result) : result;
            // The swap result from defi-swap.ts contains these fields on success
            const details = data?.details ?? data;
            if (details?.status === 'success' && details?.txHash) {
              const sellToken = details.sellToken ?? details.sell_token;
              const buyToken = details.buyToken ?? details.buy_token;
              const sellAmount = parseFloat(details.sellAmount ?? details.sell_amount ?? '0');
              const buyAmount = parseFloat(details.buyAmount ?? details.buy_amount ?? '0');
              const sellSymbol = details.sellSymbol ?? details.sell_symbol ?? 'UNKNOWN';
              const buySymbol = details.buySymbol ?? details.buy_symbol ?? 'UNKNOWN';
              const txHash = details.txHash ?? details.tx_hash;

              // Infer price from the swap ratio
              // If selling token A for token B: A is sold, B is bought
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
              api.logger?.info?.(
                `[crypto] Auto-recorded swap: ${sellSymbol} → ${buySymbol} (${txHash?.slice(0, 10)}...)`
              );
            }
          } catch (swapErr) {
            // Non-critical — don't block the hook pipeline
            api.logger?.warn?.(
              `[crypto] Failed to auto-record swap: ${swapErr instanceof Error ? swapErr.message : String(swapErr)}`
            );
          }
        }
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] After tool call hook error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
  },
};

export default plugin;
