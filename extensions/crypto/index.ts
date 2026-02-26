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

// Tools
import { createClawnchConnectTool } from './src/tools/clawnchconnect.js';
import { createDefiPriceTool } from './src/tools/defi-price.js';
import { createDefiBalanceTool } from './src/tools/defi-balance.js';
import { createDefiSwapTool } from './src/tools/defi-swap.js';
import { createClawnchLaunchTool } from './src/tools/clawnch-launch.js';
import { createClawnchFeesTool } from './src/tools/clawnch-fees.js';
import { createMarketIntelTool } from './src/tools/market-intel.js';

// Commands
import { walletCommand } from './src/commands/wallet-command.js';
import { policyCommand } from './src/commands/policy-command.js';
import { txCommand } from './src/commands/tx-command.js';

// Services
import { initWalletService } from './src/services/walletconnect-service.js';

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
    // ─── Register Tools ────────────────────────────────────────────
    api.registerTool(createClawnchConnectTool());
    api.registerTool(createDefiPriceTool());
    api.registerTool(createDefiBalanceTool());
    api.registerTool(createDefiSwapTool());
    api.registerTool(createClawnchLaunchTool());
    api.registerTool(createClawnchFeesTool());
    api.registerTool(createMarketIntelTool());

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
  },
};

export default plugin;
