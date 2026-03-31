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

// ── Plugin API type from OpenClaw SDK ────────────────────────────────────
// Type-only import: provides compile-time checking without runtime coupling.
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

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

// Tools — Phase 5 (Molten agent-to-agent matching)
import { createMoltenTool } from './src/tools/molten.js';

// Tools — Phase 6 (Bankr Agent API)
import { createBankrLaunchTool } from './src/tools/bankr-launch.js';
import { createBankrAutomateTool } from './src/tools/bankr-automate.js';
import { createBankrPolymarketTool } from './src/tools/bankr-polymarket.js';
import { createBankrLeverageTool } from './src/tools/bankr-leverage.js';

// Tools — Phase 7 (Compound Operations Engine)
import { createCompoundActionTool } from './src/tools/compound-action.js';

// Tools — Phase 10 (DeFi Primitives Expansion)
import { createDefiLendTool } from './src/tools/defi-lend.js';
import { createApprovalsTool } from './src/tools/approvals.js';
import { createDefiStakeTool } from './src/tools/defi-stake.js';
import { createNftTool } from './src/tools/nft.js';
import { createYieldTool } from './src/tools/yield.js';
import { createGovernanceTool } from './src/tools/governance.js';
import { createFarcasterTool } from './src/tools/farcaster.js';
import { createSafeTool } from './src/tools/safe.js';
import { createAirdropTool } from './src/tools/airdrop.js';

// Tools — Phase 11 (External Integrations)
import { createPrivacyTool } from './src/tools/privacy.js';
import { createBrowserTool } from './src/tools/browser.js';

// Tools — V3 (Fiat & Traditional Finance Rails)
import { createFiatPaymentTool } from './src/tools/fiat-payment.js';

// Commands
import { walletCommand } from './src/commands/wallet-command.js';
import { policyCommand } from './src/commands/policy-command.js';
import { txCommand } from './src/commands/tx-command.js';
import { resetCommand, resetConfirmCommand } from './src/commands/reset-command.js';
import {
  professionalCommand, degenCommand, chillCommand, technicalCommand, mentorCommand,
  capAllCommand, capCommands, skipCommand, backCommand,
  createWalletCommand, importWalletCommand,
} from './src/commands/onboarding-commands.js';
import {
  safemodeCommand, dangermodeCommand, walletsignCommand, autosignCommand, modeCommand, readonlyCommand,
} from './src/commands/mode-commands.js';
import { doctorCommand } from './src/commands/doctor-command.js';
import { rpcCommand } from './src/commands/rpc-command.js';
import { connectCommand, walletConnectCommands, setConnectCommandApi, connectBankrCommand, disconnectCommand } from './src/commands/connect-command.js';
import { modelCommand, llmShortcutCommands } from './src/commands/model-command.js';
import { moltenCommand } from './src/commands/molten-command.js';
import { creditsCommand, usageCommand, automationsCommand, topupCommand, autotopupCommand } from './src/commands/bankr-commands.js';
import {
  providerCommand, providerAnthropicCommand, providerBankrCommand, providerOpenrouterCommand,
  providerOpenaiCommand, flykeysCommand, flystatusCommand, flyrestartCommand,
} from './src/commands/fly-commands.js';
import { setupCommand } from './src/commands/setup-command.js';
import { recoverCommand, exportWalletCommand, walletBackupCommand } from './src/commands/wallet-manage-commands.js';
import { plansCommand, plansActiveCommand, plansCancelCommand, plansClearCommand } from './src/commands/plans-command.js';
import { triggersCommand, triggersPriceCommand, triggersCronCommand, deadLetterCommand } from './src/commands/trigger-commands.js';
import { approveCommand, denyCommand } from './src/commands/confirm-commands.js';
import { helpCommand, portfolioCommand, balanceCommand, chainCommand } from './src/commands/help-command.js';
import { reportCommand, reportOptInCommand, reportOptOutCommand } from './src/commands/report-command.js';
import { isReadonly } from './src/services/mode-service.js';

// Services
import { initWalletService, getWalletState as getWalletStateFn } from './src/services/walletconnect-service.js';
import { getOnboardingFlow, type OnboardingMessage } from './src/services/onboarding-flow.js';
import { getCredentialVault } from './src/services/credential-vault.js';
import { getHeartbeatMonitor } from './src/services/heartbeat-monitor.js';
import { getScheduler } from './src/services/plan-scheduler.js';
import { createPendingConfirmation } from './src/services/confirmation-store.js';
import { persistForumTopics, restoreForumTopics } from './src/services/forum-topics.js';
import { persistThreadBindings, restoreThreadBindings } from './src/services/thread-bindings.js';
import { persistOrders, restoreOrders } from './src/tools/manage-orders.js';

// Self-improvement services (sprint 4)
import { getEvolutionMode } from './src/services/evolution-mode.js';
import { getSessionRecall } from './src/services/session-recall.js';

// Self-improvement tools (sprint 4)
import { createAgentMemoryTool } from './src/tools/agent-memory.js';
import { createSkillEvolveTool } from './src/tools/skill-evolve.js';
import { createSessionRecallTool } from './src/tools/session-recall.js';

// Self-improvement commands (sprint 4)
import { evolveCommand, stableCommand, evolutionCommand } from './src/commands/evolve-command.js';

// Forum topics + thread bindings commands (sprint 8)
import { topicsCommand, topicsSetupCommand, topicBindCommand, topicUnbindCommand } from './src/commands/forum-commands.js';

// V3: Fiat commands
import { fiatCommand } from './src/commands/fiat-command.js';

// V4: User-defined tools
import { toolsCommand } from './src/commands/tools-command.js';
import { compileAllEnabledTools } from './src/services/tool-compiler.js';
import type { ToolDispatcher } from './src/services/sandbox-runtime.js';

// V5: Multi-agent + Webhooks
import { createAgentDelegateTool } from './src/tools/agent-delegate.js';
import { agentsCommand } from './src/commands/agents-command.js';
import { webhooksCommand } from './src/commands/webhooks-command.js';

// Skill registry + /skills command
import { skillsCommand } from './src/commands/skills-command.js';

// Interrupt commands + service
import { interruptCommand, interruptPlanCommand } from './src/commands/interrupt-command.js';
import { getInterruptService } from './src/services/interrupt-service.js';

// API key management
import { apiCommand } from './src/commands/api-command.js';

// Usage reporting
import { usageNewCommand } from './src/commands/usage-command.js';

// Update + restart from Telegram
import { updateCommand, restartCommand, setUpdateCommandSender } from './src/commands/update-command.js';

// Pull files from the running bot
import { pullCommand } from './src/commands/pull-command.js';

// Policy engine — spending policies, approval rules, autonomy bounds
import { createPolicyManageTool } from './src/tools/policy-manage.js';
import { policiesCommand } from './src/commands/policies-command.js';
import { evaluatePolicies, extractActionContext, recordToolExecution, getPolicyConfirmationStore, extractPolicyUserId } from './src/services/policy-evaluator.js';

// Delegation — EIP-7710 on-chain policy enforcement
import { delegateCommand } from './src/commands/delegate-command.js';
import { policymodeCommand } from './src/commands/policymode-command.js';
import { profileCommand } from './src/commands/profile-command.js';
import { upgradeCommand } from './src/commands/upgrade-command.js';
import { agentAccountCommand } from './src/commands/agent-account-command.js';
import { commandsAllCommand } from './src/commands/commands-list.js';
import { tryDelegationExecution } from './src/services/delegation-executor.js';

// Typing indicator — Telegram "typing..." action during agent thinking
import { getTypingIndicator } from './src/services/typing-indicator.js';

// Extracted hook logic
import { buildPromptContext } from './src/hooks/prompt-builder.js';
import { handleAfterToolCall } from './src/hooks/after-tool-call.js';

// Channel abstraction — multi-channel message sending
import {
  createChannelSender,
  parseSessionKey,
  extractSenderId,
  extractChannelId,
  type ChannelId,
} from './src/services/channel-sender.js';

/**
 * OpenClaw Plugin Definition
 * 
 * The `api` parameter is typed via `OpenClawPluginApi` from the plugin SDK.
 * This gives compile-time safety against upstream API changes.
 */
const plugin = {
  id: 'crypto',
  name: 'Crypto DeFi Tools',
  description: 'ClawnchConnect wallet, DeFi trading, token launchpad, and market intelligence',
  version: '0.1.0',

  register(api: OpenClawPluginApi) {
    // ─── Write Tool Names (for readonly enforcement + ledger recording) ───
    // Single source of truth: all tools that perform on-chain writes or
    // financial state changes. Used by readonly gate and tx ledger.
    const WRITE_TOOL_NAMES = new Set([
      'defi_swap', 'transfer', 'bridge', 'permit2', 'clawnch_launch',
      'clawnch_fees', 'liquidity', 'compound_action', 'manage_orders',
      'bankr_launch', 'bankr_automate', 'bankr_polymarket', 'bankr_leverage',
      'clawnchconnect', 'molten', 'hummingbot', 'clawnx',
      'defi_lend', 'approvals', 'defi_stake', 'nft', 'privacy', 'yield', 'browser',
      'governance', 'farcaster', 'safe', 'airdrop',
      'fiat_payment',    // V3: fiat off/on-ramp execution
      // Added in audit: these tools have sub-actions that write on-chain
      'wayfinder',       // execute_swap, strategy
      'clawnch_info',    // vault_claim, agent_register
      'crypto_workflow',  // safe_swap, launch_and_promote
    ]);

    /**
     * Wrap a tool with a hard readonly gate + policy enforcement gate.
     * If the user is in readonly mode, write tools return an error.
     * If active policies block the action, it returns an error.
     * If policies require confirmation, it returns a confirmation request.
     * This is defense-in-depth — the LLM can't bypass by ignoring instructions.
     */
    function registerToolWithReadonlyGate(tool: any): void {
      if (WRITE_TOOL_NAMES.has(tool.name)) {
        const originalExecute = tool.execute;
        tool.execute = async (toolCallId: string, args: unknown, ctx?: any) => {
          // Check if the requesting user is in readonly mode
          const userId = extractPolicyUserId(ctx);
          if (isReadonly(userId)) {
            return {
              text: `BLOCKED: Read-only mode is active. The tool "${tool.name}" writes to the blockchain and cannot be used in readonly mode. Use /safemode or /dangermode to re-enable write operations.`,
              isError: true,
            };
          }
          // Policy enforcement gate
          const argsObj = (args ?? {}) as Record<string, unknown>;
          const actionCtx = extractActionContext(tool.name, argsObj, userId);
          const decision = evaluatePolicies(actionCtx);
          if (decision.action === 'block') {
            return {
              content: [{ type: 'text' as const, text: `BLOCKED by policy: ${decision.reason ?? 'Policy violation.'}` }],
              details: { blocked: true, policy: decision.policyName, rule: decision.ruleSummary },
              isError: true,
            };
          }
          if (decision.action === 'confirm') {
            // Check if the caller provided a valid confirmation nonce
            const nonce = argsObj.policyConfirmationNonce as string | undefined;
            if (nonce) {
              const confirmStore = getPolicyConfirmationStore();
              if (confirmStore.consume(nonce, userId, tool.name)) {
                // Nonce valid — user confirmed, proceed to execution
                // Try delegation execution first (on-chain), fall back to normal
                const delegationResult = await tryDelegationExecution(actionCtx, argsObj);
                if (delegationResult.executed) {
                  try { recordToolExecution(actionCtx); } catch { /* best-effort */ }
                  return {
                    content: [{ type: 'text' as const, text: `Executed via on-chain delegation. Tx: ${delegationResult.txHash} (chain ${delegationResult.chainId})` }],
                    details: { delegationExecution: true, txHash: delegationResult.txHash, chainId: delegationResult.chainId },
                  };
                }
                // Delegation not available or failed — fall through to normal execution
                if (delegationResult.skipReason || delegationResult.error) {
                  console.info(`[delegation] Bypassed for ${tool.name}: ${delegationResult.skipReason ?? delegationResult.error}`);
                }
                const result = await originalExecute.call(tool, toolCallId, args, ctx);
                if (!result?.isError) {
                  try { recordToolExecution(actionCtx); } catch { /* best-effort */ }
                }
                return result;
              }
              // Invalid/expired nonce — fall through to hold
            }
            // Generate a new nonce for the user to confirm
            const confirmStore = getPolicyConfirmationStore();
            const newNonce = confirmStore.create(userId, tool.name);
            return {
              content: [{ type: 'text' as const, text: `POLICY HOLD: ${decision.reason ?? 'Confirmation required.'}\n\nAsk the user to confirm. Once confirmed, retry this tool call with the parameter policyConfirmationNonce="${newNonce}".` }],
              details: { needsConfirmation: true, policy: decision.policyName, rule: decision.ruleSummary, confirmationNonce: newNonce },
              isError: true,
            };
          }
          // action === 'allow' — try delegation execution first, fall back to normal
          const delegationResult = await tryDelegationExecution(actionCtx, argsObj);
          if (delegationResult.executed) {
            try { recordToolExecution(actionCtx); } catch { /* best-effort */ }
            return {
              content: [{ type: 'text' as const, text: `Executed via on-chain delegation. Tx: ${delegationResult.txHash} (chain ${delegationResult.chainId})` }],
              details: { delegationExecution: true, txHash: delegationResult.txHash, chainId: delegationResult.chainId },
            };
          }
          // Delegation not available or failed — normal tool execution
          if (delegationResult.skipReason || delegationResult.error) {
            console.info(`[delegation] Bypassed for ${tool.name}: ${delegationResult.skipReason ?? delegationResult.error}`);
          }
          const result = await originalExecute.call(tool, toolCallId, args, ctx);
          // Record usage on success (not on error)
          if (!result?.isError) {
            try { recordToolExecution(actionCtx); } catch { /* best-effort */ }
          }
          return result;
        };
      }
      api.registerTool(tool);
    }

    // ─── Register Tools (31 total) ────────────────────────────────
    // Core tools (13)
    // Write-operation tools: ownerOnly = true (security: only bot owner can execute financial ops)
    // Read-only tools: ownerOnly = false (paired users can view prices, balances, etc.)
    registerToolWithReadonlyGate(createClawnchConnectTool(api));   // ownerOnly: true (wallet management)
    registerToolWithReadonlyGate(createDefiPriceTool());            // ownerOnly: false (read-only)
    registerToolWithReadonlyGate(createDefiBalanceTool());           // ownerOnly: false (read-only)
    registerToolWithReadonlyGate(createDefiSwapTool());              // ownerOnly: true (financial write)
    registerToolWithReadonlyGate(createClawnchLaunchTool());         // ownerOnly: true (financial write)
    registerToolWithReadonlyGate(createClawnchFeesTool());            // ownerOnly: true (financial write)
    registerToolWithReadonlyGate(createMarketIntelTool());           // ownerOnly: false (read-only)
    registerToolWithReadonlyGate(createHummingbotTool());             // ownerOnly: true (trading bot control)
    registerToolWithReadonlyGate(createManageOrdersTool());           // ownerOnly: true (order management)
    registerToolWithReadonlyGate(createWatchActivityTool());          // ownerOnly: false (read-only)
    registerToolWithReadonlyGate(createClawnXTool());                 // ownerOnly: true (social actions)
    registerToolWithReadonlyGate(createHerdIntelligenceTool());       // ownerOnly: false (read-only)
    registerToolWithReadonlyGate(createCryptoWorkflowTool());         // ownerOnly: false (read-only)

    // Phase 2 tools (4) — critical gap coverage
    registerToolWithReadonlyGate(createTransferTool());              // ownerOnly: true (financial write)
    registerToolWithReadonlyGate(createLiquidityTool());             // ownerOnly: true (financial write)
    registerToolWithReadonlyGate(createWayfinderTool());             // ownerOnly: false (read-only discovery)
    registerToolWithReadonlyGate(createClawnchInfoTool());           // ownerOnly: false (read-only)

    // Phase 3 tools (4) — Permit2, cost basis, analytics, block explorer
    registerToolWithReadonlyGate(createPermit2Tool());               // ownerOnly: true (token approvals)
    registerToolWithReadonlyGate(createCostBasisTool());             // ownerOnly: false (read-only)
    registerToolWithReadonlyGate(createAnalyticsTool());             // ownerOnly: false (read-only)
    registerToolWithReadonlyGate(createBlockExplorerTool());         // ownerOnly: false (read-only)

    // Phase 4 tools (1) — cross-chain bridge
    registerToolWithReadonlyGate(createBridgeTool());                // ownerOnly: true (financial write)

    // Phase 5 tools (1) — Molten agent-to-agent matching
    registerToolWithReadonlyGate(createMoltenTool());                // ownerOnly: true (agent registration)

    // Phase 6 tools (4) — Bankr Agent API (launch, automate, polymarket, leverage)
    registerToolWithReadonlyGate(createBankrLaunchTool());           // ownerOnly: true (financial write)
    registerToolWithReadonlyGate(createBankrAutomateTool());         // ownerOnly: true (financial write)
    registerToolWithReadonlyGate(createBankrPolymarketTool());       // ownerOnly: true (financial write)
    registerToolWithReadonlyGate(createBankrLeverageTool());         // ownerOnly: true (financial write)

    // Phase 7 tools (1) — Compound operations engine
    registerToolWithReadonlyGate(createCompoundActionTool());        // ownerOnly: true (can trigger financial writes)

    // Phase 10 tools — DeFi Primitives Expansion
    registerToolWithReadonlyGate(createDefiLendTool());              // ownerOnly: true (financial write)
    registerToolWithReadonlyGate(createApprovalsTool());             // ownerOnly: true (can revoke approvals)
    registerToolWithReadonlyGate(createDefiStakeTool());             // ownerOnly: true (financial write)
    registerToolWithReadonlyGate(createNftTool());                   // ownerOnly: true (buy/sell/transfer NFTs)
    registerToolWithReadonlyGate(createYieldTool());                  // ownerOnly: true (vault deposits/withdrawals)
    registerToolWithReadonlyGate(createGovernanceTool());             // ownerOnly: true (on-chain voting + delegation)
    registerToolWithReadonlyGate(createFarcasterTool());              // ownerOnly: true (social posting)
    registerToolWithReadonlyGate(createSafeTool());                   // ownerOnly: true (multisig management)
    registerToolWithReadonlyGate(createAirdropTool());                // ownerOnly: true (claim airdrops)

    // Phase 11 tools — External Integrations
    registerToolWithReadonlyGate(createPrivacyTool());               // ownerOnly: true (financial write, ZK deposits)
    registerToolWithReadonlyGate(createBrowserTool());               // ownerOnly: true (browser automation, can interact with dApps)

    // V3 tools — Fiat & Traditional Finance Rails
    registerToolWithReadonlyGate(createFiatPaymentTool());           // ownerOnly: true (fiat on/off-ramp)

    // V5 tools — Multi-agent orchestration
    // The dispatcher and registeredTools closures are filled at gateway_start
    // when the runtime is available. Pre-registration ensures the tool is
    // in the registry for count assertions.
    let agentDispatcher: ToolDispatcher = { call: async () => { throw new Error('Agent dispatcher not ready'); } };
    let registeredToolsList: Array<{ name: string; description: string; parameters: any }> = [];
    registerToolWithReadonlyGate(createAgentDelegateTool(
      () => agentDispatcher,
      () => registeredToolsList,
    ));                                                               // ownerOnly: false (read-only delegation)

    // Sprint 4 tools (3) — Self-improvement (agent memory, skill evolution, session recall)
    // These tools have an evolution mode gate: write actions are blocked in stable mode.
    {
      const memoryTool = createAgentMemoryTool();
      const skillTool = createSkillEvolveTool();
      const recallTool = createSessionRecallTool();

      // Wrap memory + skill tools with evolution mode gate for write actions
      const WRITE_ACTIONS_MEMORY = new Set(['add', 'replace', 'remove', 'user_add', 'user_remove']);
      const WRITE_ACTIONS_SKILL = new Set(['create', 'patch', 'delete']);

      const wrapWithEvoGate = (tool: any, writeActions: Set<string>) => {
        const originalExecute = tool.execute;
        tool.execute = async (toolCallId: string, args: unknown, ctx?: any) => {
          const params = args as Record<string, unknown>;
          const action = (params?.action as string) ?? '';
          if (writeActions.has(action)) {
            const userId = ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId;
            if (userId && !getEvolutionMode().isEvolving(userId)) {
              return {
                content: [{ type: 'text', text: `Self-improvement is in stable mode. The "${action}" action requires evolving mode. Use /evolve to enable self-improvement.` }],
                isError: true,
              };
            }
          }
          return originalExecute.call(tool, toolCallId, args, ctx);
        };
        return tool;
      };

      api.registerTool(wrapWithEvoGate(memoryTool, WRITE_ACTIONS_MEMORY));
      api.registerTool(wrapWithEvoGate(skillTool, WRITE_ACTIONS_SKILL));
      api.registerTool(recallTool); // session_recall is always read-only
    }

    // V6 tools — Policy engine (spending policies, approval rules, autonomy bounds)
    api.registerTool(createPolicyManageTool());                      // ownerOnly: true (policy management)

    // ─── Register Chat Commands ────────────────────────────────────
    api.registerCommand(walletCommand);
    api.registerCommand(policyCommand);
    api.registerCommand(txCommand);
    api.registerCommand(resetCommand);
    api.registerCommand(resetConfirmCommand);

    // Onboarding: persona selection
    api.registerCommand(professionalCommand);
    api.registerCommand(degenCommand);
    api.registerCommand(chillCommand);
    api.registerCommand(technicalCommand);
    api.registerCommand(mentorCommand);

    // Onboarding: capability selection
    api.registerCommand(capAllCommand);
    for (const cmd of capCommands) {
      api.registerCommand(cmd);
    }

    // Onboarding: skip, back, wallet creation
    api.registerCommand(skipCommand);
    api.registerCommand(backCommand);
    api.registerCommand(createWalletCommand);
    api.registerCommand(importWalletCommand);

    // Wallet management: recover, export, backup
    api.registerCommand(recoverCommand);
    api.registerCommand(exportWalletCommand);
    api.registerCommand(walletBackupCommand);

    // Mode: safety and signing
    api.registerCommand(safemodeCommand);
    api.registerCommand(dangermodeCommand);
    api.registerCommand(readonlyCommand);
    api.registerCommand(walletsignCommand);
    api.registerCommand(autosignCommand);
    api.registerCommand(modeCommand);

    // Wallet connect (direct slash commands, not routed through LLM)
    // /connect shows menu, /connect_metamask etc. initiate pairing
    setConnectCommandApi(api);
    api.registerCommand(connectCommand);
    for (const cmd of walletConnectCommands) {
      api.registerCommand(cmd);
    }

    // Disconnect
    api.registerCommand(disconnectCommand);

    // Model switching
    api.registerCommand(modelCommand);
    for (const cmd of llmShortcutCommands) {
      api.registerCommand(cmd);
    }

    // Molten status
    api.registerCommand(moltenCommand);

    // Bankr LLM Gateway + Agent API
    api.registerCommand(creditsCommand);
    api.registerCommand(usageCommand);
    api.registerCommand(connectBankrCommand);
    api.registerCommand(automationsCommand);
    api.registerCommand(topupCommand);
    api.registerCommand(autotopupCommand);

    // Fly.io runtime control (provider switching, secrets, restart)
    api.registerCommand(providerCommand);
    api.registerCommand(providerAnthropicCommand);
    api.registerCommand(providerBankrCommand);
    api.registerCommand(providerOpenrouterCommand);
    api.registerCommand(providerOpenaiCommand);
    api.registerCommand(flykeysCommand);
    api.registerCommand(flystatusCommand);
    api.registerCommand(flyrestartCommand);

    // Setup / configuration status
    api.registerCommand(setupCommand);

    // Plans management
    api.registerCommand(plansCommand);
    api.registerCommand(plansActiveCommand);
    api.registerCommand(plansCancelCommand);
    api.registerCommand(plansClearCommand);
    api.registerCommand(approveCommand);
    api.registerCommand(denyCommand);

    // Trigger management
    api.registerCommand(triggersCommand);
    api.registerCommand(triggersPriceCommand);
    api.registerCommand(triggersCronCommand);
    api.registerCommand(deadLetterCommand);

    // Help, portfolio, balance, chain, diagnostics
    api.registerCommand(helpCommand);
    api.registerCommand(portfolioCommand);
    api.registerCommand(balanceCommand);
    api.registerCommand(chainCommand);
    api.registerCommand(doctorCommand);
    api.registerCommand(rpcCommand);

    // Self-improvement mode
    api.registerCommand(evolveCommand);
    api.registerCommand(stableCommand);
    api.registerCommand(evolutionCommand);

    // Forum topics + thread bindings
    api.registerCommand(topicsCommand);
    api.registerCommand(topicsSetupCommand);
    api.registerCommand(topicBindCommand);
    api.registerCommand(topicUnbindCommand);

    // V3: Fiat rails
    api.registerCommand(fiatCommand);

    // V4: User-defined tool management
    api.registerCommand(toolsCommand);

    // V5: Multi-agent + Webhooks
    api.registerCommand(agentsCommand);
    api.registerCommand(webhooksCommand);

    // Skill registry
    api.registerCommand(skillsCommand);

    // Interrupt
    api.registerCommand(interruptCommand);
    api.registerCommand(interruptPlanCommand);

    // Issue reporting
    api.registerCommand(reportCommand);
    api.registerCommand(reportOptInCommand);
    api.registerCommand(reportOptOutCommand);

    // API key management
    api.registerCommand(apiCommand);

    // Usage reporting
    api.registerCommand(usageNewCommand);

    // Update + restart from Telegram
    api.registerCommand(updateCommand);
    api.registerCommand(restartCommand);

    // File pull
    api.registerCommand(pullCommand);

    // V6: Policy engine
    api.registerCommand(policiesCommand);

    // V7: On-chain delegation (EIP-7710)
    api.registerCommand(delegateCommand);
    api.registerCommand(policymodeCommand);
    api.registerCommand(profileCommand);
    api.registerCommand(upgradeCommand);
    api.registerCommand(agentAccountCommand);
    api.registerCommand(commandsAllCommand);

    // ─── Gateway Startup Hook ──────────────────────────────────────
    // Only init wallet at boot for private key mode (headless).
    // WalletConnect init is deferred to the clawnchconnect tool to avoid
    // double-init of WC Core which breaks the pairing handshake.
    api.on('gateway_start', async () => {
      // ─── Hydrate API Keys from Keychain ───────────────────────────
      try {
        const { hydrateApiKeys } = await import('./src/services/keychain-secrets.js');
        const { loaded, skipped } = hydrateApiKeys();
        if (loaded.length > 0) {
          api.logger?.info?.(`[crypto] Loaded API keys from Keychain: ${loaded.join(', ')}`);
        }
        if (skipped.length > 0) {
          api.logger?.info?.(`[crypto] API keys already in env (skipped Keychain): ${skipped.join(', ')}`);
        }
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Failed to hydrate API keys from Keychain: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const projectId = process.env.WALLETCONNECT_PROJECT_ID;
      const privateKey = process.env.CLAWNCHER_PRIVATE_KEY;

      const bankrApiKey = process.env.BANKR_API_KEY;

      // ── Wallet initialization (runs before scheduler) ──────────
      if (!projectId && !privateKey && !bankrApiKey) {
        api.logger?.info?.(
          '[crypto] No wallet configured. Set WALLETCONNECT_PROJECT_ID, CLAWNCHER_PRIVATE_KEY, or BANKR_API_KEY to enable write operations.'
        );
      } else if (privateKey) {
        // C6 FIX: Gate private key mode behind explicit opt-in flag
        if (process.env.ALLOW_PRIVATE_KEY_MODE !== 'true') {
          api.logger?.warn?.(
            '[crypto] CLAWNCHER_PRIVATE_KEY is set but ALLOW_PRIVATE_KEY_MODE is not "true". ' +
            'Private key mode is disabled for safety. Set ALLOW_PRIVATE_KEY_MODE=true to enable.'
          );
        } else {
          try {
            const result = await initWalletService({
              privateKey,
              rpcUrl: process.env.CLAWNCHER_RPC_URL,
              network: (process.env.CLAWNCHER_NETWORK as 'mainnet' | 'sepolia') || 'mainnet',
            });
            api.logger?.warn?.(`[crypto] WARNING: Wallet running in PRIVATE KEY mode (auto-sign). Address: ${result.address}`);
          } catch (err) {
            api.logger?.warn?.(
              `[crypto] Private key wallet init failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }

      if (projectId && !privateKey && !bankrApiKey) {
        api.logger?.info?.(
          `[crypto] WalletConnect available (project ID configured). ` +
          `Use the clawnchconnect tool to pair a wallet.`
        );
      }

      // Mode 3: Bankr (auto-connect at boot when no other wallet is configured)
      if (bankrApiKey && !privateKey) {
        try {
          const result = await initWalletService({ bankrApiKey });
          if (result.mode === 'bankr') {
            api.logger?.info?.(
              `[crypto] Bankr wallet ready: ${result.address}${result.solAddress ? ` (+ Solana: ${result.solAddress})` : ''}`
            );
          } else {
            api.logger?.warn?.('[crypto] Bankr wallet init returned unexpected mode');
          }
        } catch (err) {
          api.logger?.warn?.(
            `[crypto] Bankr wallet init failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // ─── Restore Persisted State ─────────────────────────────────
      // Reload forum topics, thread bindings, and orders from disk.
      try {
        restoreForumTopics();
        restoreThreadBindings();
        restoreOrders();
        api.logger?.info?.('[crypto] Restored persisted state (forum topics, thread bindings, orders)');
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Failed to restore some persisted state: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ─── V4: Register User-Defined Tools ─────────────────────────
      // Compile all enabled user tools and register them dynamically.
      // User tools don't affect the static count assertions (43 tools) —
      // they are additive and loaded from ~/.openclawnch/user-tools/.
      try {
        // Build a lightweight dispatcher for user tools to call built-in tools.
        // This uses the same api.runtime.tools.getAll() pattern as the plan executor.
        const runtimeRef = api.runtime as any;
        const userToolDispatcher: ToolDispatcher = {
          call: async (toolName: string, args: Record<string, unknown>): Promise<any> => {
            const tools = runtimeRef?.tools?.getAll?.() ?? [];
            const tool = tools.find((t: any) => t.name === toolName);
            if (!tool) throw new Error(`Tool "${toolName}" not found in registry`);
            const toolCallId = `user-tool-${Date.now()}-${toolName}`;
            return tool.execute(toolCallId, args, {});
          },
        };

        const compiledUserTools = compileAllEnabledTools(userToolDispatcher);
        for (const userTool of compiledUserTools) {
          // Apply the same readonly gate as built-in tools
          registerToolWithReadonlyGate(userTool);
        }
        if (compiledUserTools.length > 0) {
          api.logger?.info?.(
            `[crypto] Registered ${compiledUserTools.length} user-defined tool(s): ${compiledUserTools.map(t => t.name).join(', ')}`
          );
        }
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Failed to load user-defined tools: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ─── V5: Wire Agent Dispatcher + Start Webhook Server ────────
      // Fill in the agent_delegate tool's closures now that runtime is available.
      try {
        const runtimeForAgents = api.runtime as any;
        agentDispatcher = {
          call: async (toolName: string, args: Record<string, unknown>): Promise<any> => {
            const tools = runtimeForAgents?.tools?.getAll?.() ?? [];
            const tool = tools.find((t: any) => t.name === toolName);
            if (!tool) throw new Error(`Tool "${toolName}" not found in registry`);
            const toolCallId = `agent-${Date.now()}-${toolName}`;
            return tool.execute(toolCallId, args, {});
          },
        };
        registeredToolsList = (runtimeForAgents?.tools?.getAll?.() ?? []).map((t: any) => ({
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters ?? { type: 'object', properties: {} },
        }));
        api.logger?.info?.(`[crypto] Agent delegate ready: ${registeredToolsList.length} tools available for sub-agents`);
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Agent dispatcher setup failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Start webhook server if configured
      try {
        const { getWebhookServer } = await import('./src/services/webhook-server.js');
        const { getEventBus } = await import('./src/services/event-bus.js');

        const webhookServer = getWebhookServer();
        webhookServer.onEvent(async (event) => {
          // Emit on event bus for plan triggers to pick up
          const bus = getEventBus();
          bus.emit('webhook_received', {
            type: 'webhook_received',
            route: event.route,
            source: event.source,
            payload: event.payload,
            headers: event.headers,
            receivedAt: event.receivedAt,
            timestamp: Date.now(),
          });
          api.logger?.info?.(`[crypto] Webhook received: ${event.route} from ${event.source}`);
        });

        const started = await webhookServer.start();
        if (started) {
          const config = webhookServer.getConfig();
          api.logger?.info?.(
            `[crypto] Webhook server listening on ${config.host}:${config.port}`
          );
        }
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Webhook server failed to start: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ─── Start Plan Scheduler + Executor ─────────────────────────
      // Wire real resolvers, tool dispatcher, and Telegram notifications.
      try {
        const { getScheduler } = await import('./src/services/plan-scheduler.js');
        const { PlanExecutor, formatExecutionSummary } = await import('./src/services/plan-executor.js');
        const { getPrice } = await import('./src/services/price-service.js');
        const { getGasEstimator } = await import('./src/services/gas-estimator.js');
        const { getRpcManager } = await import('./src/services/rpc-provider.js');

        // ── Runtime Resolver: real service calls ─────────────────
        const scheduler = getScheduler({
          resolver: {
            price: async (token: string) => {
              try {
                const data = await getPrice(token);
                if (!data?.priceUsd) return NaN; // NaN signals "unknown" — conditions won't fire
                return data.priceUsd;
              } catch (err) {
                api.logger?.warn?.(`[plan-resolver] price fetch failed for ${token}: ${err}`);
                return NaN;
              }
            },
            balance: async (token: string, chainId?: number) => {
              try {
                const cid = chainId ?? 8453; // Default to Base
                const rpc = getRpcManager();
                const client = await rpc.getClient(cid);
                const walletState = getWalletStateFn();
                if (!walletState.address) return NaN;
                if (!token || token.toUpperCase() === 'ETH') {
                  const balance = await client.getBalance({ address: walletState.address as `0x${string}` });
                  return Number(balance) / 1e18;
                }
                // ERC-20: resolve decimals via shared utility, then read balanceOf
                const { resolveTokenDecimals } = await import('./src/lib/token-decimals.js');
                const decimals = await resolveTokenDecimals(token, client);
                const balanceOfAbi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const;
                const data = await client.readContract({
                  address: token as `0x${string}`,
                  abi: balanceOfAbi,
                  functionName: 'balanceOf',
                  args: [walletState.address as `0x${string}`],
                });
                return Number(data) / (10 ** decimals);
              } catch (err) {
                api.logger?.warn?.(`[plan-resolver] balance fetch failed for ${token} on chain ${chainId ?? 8453}: ${err}`);
                return NaN;
              }
            },
            gasPrice: async (chainId?: number) => {
              try {
                const estimator = getGasEstimator();
                const gas = await estimator.getGasPrice(chainId ?? 8453);
                return gas.totalStandard; // baseFee + standard priority fee
              } catch (err) {
                api.logger?.warn?.(`[plan-resolver] gas price fetch failed for chain ${chainId ?? 8453}: ${err}`);
                return NaN;
              }
            },
            timestamp: () => Math.floor(Date.now() / 1000),
            blockNumber: async (chainId?: number) => {
              try {
                const rpc = getRpcManager();
                const client = await rpc.getClient(chainId ?? 8453);
                const block = await client.getBlockNumber();
                return Number(block);
              } catch (err) {
                api.logger?.warn?.(`[plan-resolver] block number fetch failed for chain ${chainId ?? 8453}: ${err}`);
                return NaN;
              }
            },
          },
        });

        // ── Tool Dispatcher: calls real registered tools ──────────
        // We build a dispatcher that invokes tools through the plugin API.
        //
        // NOTE: api.runtime.tools.getAll() is an internal OpenClaw API not
        // exposed in the plugin SDK types. We access it via type assertion.
        // If upstream removes/renames it, we need an alternative dispatch path.
        // Track: FEATURE_PARITY.md — "Needs verification each release".
        const runtimeInternal = api.runtime as any;
        const toolDispatcher = {
          call: async (toolName: string, params: Record<string, unknown>, userId?: string): Promise<unknown> => {
            // Find the tool in the registered tools
            const tools = runtimeInternal?.tools?.getAll?.() ?? [];
            const tool = tools.find((t: any) => t.name === toolName);
            if (!tool) throw new Error(`Tool "${toolName}" not found in registry`);

            // Execute the tool with correct signature: (toolCallId, args, ctx)
            // Pass userId in ctx so readonly gate and evolution gate can check it.
            const toolCallId = `plan-${Date.now()}-${toolName}`;
            const ctx = userId ? { senderId: userId } : {};
            const result = await tool.execute(toolCallId, params, ctx);
            // Extract the meaningful result
            if (result && typeof result === 'object') {
              const r = result as Record<string, unknown>;
              return r.details ?? r.text ?? result;
            }
            return result;
          },
          exists: (toolName: string): boolean => {
            const tools = runtimeInternal?.tools?.getAll?.() ?? [];
            return tools.some((t: any) => t.name === toolName);
          },
        };

        // ── Executor: wired to real dispatcher and scheduler ─────
        const executor = new PlanExecutor({
          dispatcher: toolDispatcher,
          scheduler,
          onConfirmRequired: async (step, resolvedParams, planUserId) => {

            // Send confirmation request to user
            if (planUserId && planUserId !== 'owner') {
              try {
                const parsed = parseSessionKey(planUserId);
                const paramLines = Object.entries(resolvedParams)
                  .filter(([, v]) => v !== undefined && v !== null)
                  .slice(0, 6)
                  .map(([k, v]) => `  ${k}: ${String(v)}`)
                  .join('\n');

                const msg = `**Confirmation required**\n\n` +
                  `Step: **${step.label}**\n` +
                  `Tool: ${step.tool}\n` +
                  (paramLines ? `Params:\n${paramLines}\n\n` : '\n') +
                  `Reply /approve to continue or /deny to skip.`;

                if (parsed) {
                  await sender.send(parsed.channel, parsed.userId, msg);
                } else {
                  await sender.send('telegram', planUserId, msg);
                }
              } catch { /* best effort */ }
            }

            // Wait for user response (or timeout after 5 min)
            return createPendingConfirmation({
              executionId: `${step.id}-${Date.now()}`,
              planName: step.label,
              stepLabel: step.label,
              tool: step.tool,
              params: resolvedParams,
              userId: planUserId,
            });
          },
          onDeadLetter: (entry) => {
            // Persist terminal failure to disk
            scheduler.saveDeadLetter(entry);
            api.logger?.warn?.(`[crypto] Dead-letter: plan=${entry.planId} node=${entry.nodeId} error=${entry.error}`);

            // Notify user
            if (entry.userId && entry.userId !== 'owner') {
              const parsed = parseSessionKey(entry.userId);
              const msg = `**Plan step failed permanently**\n` +
                `Plan: \`${entry.planId}\`\n` +
                `Step: \`${entry.nodeId}\`${entry.tool ? ` (${entry.tool})` : ''}\n` +
                `Error: ${entry.error}\n` +
                `Retries: ${entry.retryCount}\n` +
                `Use \`/plans dead_letter\` to view all failures.`;
              try {
                if (parsed) {
                  sender.send(parsed.channel, parsed.userId, msg).catch(() => {});
                } else {
                  sender.send('telegram', entry.userId, msg).catch(() => {});
                }
              } catch { /* best effort */ }
            }
          },
        });

        // ── Scheduler Event Handler: channel-agnostic notifications ──
        // Plans store userId as "<channel>-<id>" (e.g. "telegram-123456",
        // "discord-789") so we can route notifications to any channel.
        // Legacy plans with bare numeric IDs default to Telegram.
        const sender = createChannelSender(api);

        scheduler.on(async (event: any) => {
          if (event.type === 'trigger_fired') {
            const plan = event.plan;
            api.logger?.info?.(`[crypto] Plan trigger fired: ${plan.name} (${plan.id})`);

            // Notify user that the plan is executing
            const planUserId = plan.userId;
            if (planUserId && planUserId !== 'owner') {
              try {
                const parsed = parseSessionKey(planUserId);
                if (parsed) {
                  await sender.send(parsed.channel, parsed.userId, `**Plan executing:** ${plan.name}\nTrigger fired — running steps now...`);
                } else {
                  // Legacy: bare numeric ID assumed Telegram
                  await sender.send('telegram', planUserId, `**Plan executing:** ${plan.name}\nTrigger fired — running steps now...`);
                }
              } catch { /* best effort notification */ }
            }

            // Execute the plan
            try {
              const execution = await executor.execute(plan, event.executionId);
              const summary = formatExecutionSummary(execution, plan);
              api.logger?.info?.(`[crypto] Plan execution complete: ${plan.name} — ${execution.status}`);

              // Notify user of result
              if (planUserId && planUserId !== 'owner') {
                try {
                  const parsed = parseSessionKey(planUserId);
                  if (parsed) {
                    await sender.send(parsed.channel, parsed.userId, summary);
                  } else {
                    await sender.send('telegram', planUserId, summary);
                  }
                } catch { /* best effort notification */ }
              }
            } catch (execErr) {
              api.logger?.warn?.(
                `[crypto] Plan execution failed: ${plan.name} — ${execErr instanceof Error ? execErr.message : String(execErr)}`
              );
            }
          } else if (event.type === 'plan_expired') {
            api.logger?.info?.(`[crypto] Plan expired: ${event.plan.name} — ${event.reason}`);
            const planUserId = event.plan.userId;
            if (planUserId && planUserId !== 'owner') {
              try {
                const parsed = parseSessionKey(planUserId);
                if (parsed) {
                  await sender.send(parsed.channel, parsed.userId, `**Plan expired:** ${event.plan.name}\nReason: ${event.reason}`);
                } else {
                  await sender.send('telegram', planUserId, `**Plan expired:** ${event.plan.name}\nReason: ${event.reason}`);
                }
              } catch { /* best effort */ }
            }
          } else if (event.type === 'condition_check_error') {
            api.logger?.warn?.(`[crypto] Condition check error for plan ${event.planId}: ${event.error}`);
          }
        });

        scheduler.start();
        api.logger?.info?.(`[crypto] Plan scheduler started (${scheduler.activeCount} active plans)`);

        // ── Price Watcher + Event Bus Wiring ─────────────────────
        // Start the PriceWatcher, register watches for price-triggered plans,
        // and subscribe to price_crossed events to fire plan triggers.
        try {
          const { getPriceWatcher } = await import('./src/services/price-watcher.js');
          const { getEventBus } = await import('./src/services/event-bus.js');

          const priceWatcher = getPriceWatcher();
          const eventBus = getEventBus();

          // Scan active plans for price triggers and register watches
          const activePlans = scheduler.getActivePlans();
          let priceWatchCount = 0;
          for (const plan of activePlans) {
            if (plan.trigger?.type === 'price') {
              priceWatcher.addFromTrigger(plan.id, plan.trigger);
              priceWatchCount++;
            }
          }

          // Subscribe: when PriceWatcher detects a threshold cross, fire the plan
          eventBus.on('price_crossed', async (event) => {
            // Find which watch(es) this event corresponds to
            // PriceWatcher emits with the watch ID = planId, but the event
            // contains token + condition + threshold. We iterate active watches
            // and match by token.
            for (const watch of priceWatcher.getWatches()) {
              if (
                watch.token.toUpperCase() === event.token.toUpperCase() &&
                watch.condition === event.condition &&
                watch.threshold === event.threshold
              ) {
                try {
                  await scheduler.firePriceTrigger(watch.id);
                  api.logger?.info?.(
                    `[crypto] Price trigger fired: plan=${watch.id} token=${event.token} ` +
                    `price=$${event.currentPrice.toFixed(2)} condition=${event.condition} threshold=$${event.threshold}`
                  );
                } catch (err) {
                  api.logger?.warn?.(
                    `[crypto] Failed to fire price trigger for plan ${watch.id}: ${err instanceof Error ? err.message : String(err)}`
                  );
                }
              }
            }
          });

          // Subscribe: when plans are added/cancelled, manage watches dynamically
          scheduler.on(async (event: any) => {
            if (event.type === 'plan_added' && event.plan?.trigger?.type === 'price') {
              priceWatcher.addFromTrigger(event.plan.id, event.plan.trigger);
              // Auto-start watcher if it's not running and we now have watches
              if (!priceWatcher.isRunning && priceWatcher.watchCount > 0) {
                priceWatcher.start();
                api.logger?.info?.(`[crypto] Price watcher auto-started for plan ${event.plan.id}`);
              }
            } else if (event.type === 'plan_cancelled') {
              priceWatcher.removeWatch(event.planId);
              // Auto-stop if no more watches (save resources)
              if (priceWatcher.isRunning && priceWatcher.watchCount === 0) {
                priceWatcher.stop();
                api.logger?.info?.('[crypto] Price watcher stopped (no active watches)');
              }
            }
          });

          // Start the watcher (30s tick by default)
          if (priceWatchCount > 0) {
            priceWatcher.start();
            api.logger?.info?.(`[crypto] Price watcher started (${priceWatchCount} active watches)`);
          } else {
            api.logger?.info?.('[crypto] Price watcher ready (no active price triggers — will start on first price-triggered plan)');
          }
        } catch (err) {
          api.logger?.warn?.(
            `[crypto] Price watcher/event bus failed to start: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // Register as a managed service so OpenClaw can stop it on shutdown
        api.registerService?.({
          id: 'crypto-plan-scheduler',
          start: () => { /* already started above */ },
          stop: () => {
            scheduler.stop();
            // Also stop price watcher
            import('./src/services/price-watcher.js')
              .then(({ getPriceWatcher }) => getPriceWatcher().stop())
              .catch(() => {});
          },
        });
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Plan scheduler failed to start: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ─── Start Heartbeat Position Monitor ──────────────────────────
      try {
        const heartbeat = getHeartbeatMonitor({
          intervalMs: parseInt(process.env.OPENCLAWNCH_HEARTBEAT_INTERVAL_MS ?? '300000', 10),
          priceDropAlertPercent: parseFloat(process.env.OPENCLAWNCH_HEARTBEAT_DROP_PCT ?? '10'),
          priceGainAlertPercent: parseFloat(process.env.OPENCLAWNCH_HEARTBEAT_GAIN_PCT ?? '20'),
          portfolioDropAlertUsd: parseFloat(process.env.OPENCLAWNCH_HEARTBEAT_DROP_USD ?? '100'),
          enabled: process.env.OPENCLAWNCH_HEARTBEAT_ENABLED !== 'false',
        });

        const hbSender = createChannelSender(api);

        // Resolve the owner's chat ID for heartbeat alerts.
        // Try OPENCLAWNCH_OWNER_CHAT_ID first, then fall back to config allowFrom.
        const ownerChatId = process.env.OPENCLAWNCH_OWNER_CHAT_ID
          ?? (api.config as any)?.channels?.telegram?.allowFrom?.[0]
          ?? null;

        heartbeat.onAlert(async (alert) => {
          if (!ownerChatId) return; // No known owner to alert

          const severity = alert.severity === 'critical' ? '**CRITICAL**' : alert.severity === 'warning' ? '**WARNING**' : 'INFO';
          const message = `${severity} [Heartbeat] ${alert.message}`;

          // Send to all available channels that have the owner configured
          const availableChannels = hbSender.availableChannels();
          for (const ch of availableChannels) {
            try {
              await hbSender.send(ch, ownerChatId, message);
              break; // Sent successfully to one channel — don't spam all
            } catch { /* try next channel */ }
          }
        });

        heartbeat.start();
        api.logger?.info?.('[crypto] Heartbeat position monitor started');

        // Register as a managed service so OpenClaw can stop it on shutdown
        api.registerService?.({
          id: 'crypto-heartbeat-monitor',
          start: () => { /* already started above */ },
          stop: () => { heartbeat.stop(); },
        });
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Heartbeat monitor failed to start: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ─── Start LLM Credit Monitor ─────────────────────────────────────
      if (process.env.BANKR_LLM_KEY) {
        try {
          const { getCreditMonitor } = await import('./src/services/credit-monitor.js');
          const creditMonitor = getCreditMonitor({
            intervalMs: parseInt(process.env.OPENCLAWNCH_CREDIT_CHECK_INTERVAL_MS ?? '300000', 10),
            warningThresholdUsd: parseFloat(process.env.OPENCLAWNCH_CREDIT_WARNING_USD ?? '5'),
            criticalThresholdUsd: parseFloat(process.env.OPENCLAWNCH_CREDIT_CRITICAL_USD ?? '1'),
          });

          const creditSender = createChannelSender(api);
          const creditOwnerChatId = process.env.OPENCLAWNCH_OWNER_CHAT_ID
            ?? (api.config as any)?.channels?.telegram?.allowFrom?.[0]
            ?? null;

          creditMonitor.onAlert(async (alert) => {
            if (!creditOwnerChatId) return;
            const severity = alert.severity === 'critical' ? '**CRITICAL**' : '**WARNING**';
            const message = `${severity} ${alert.message}`;

            const availableChannels = creditSender.availableChannels();
            for (const ch of availableChannels) {
              try {
                await creditSender.send(ch, creditOwnerChatId, message);
                break;
              } catch { /* try next channel */ }
            }
          });

          creditMonitor.start();
          api.logger?.info?.('[crypto] LLM credit monitor started');

          api.registerService?.({
            id: 'crypto-credit-monitor',
            start: () => { /* already started */ },
            stop: () => { creditMonitor.stop(); },
          });
        } catch (err) {
          api.logger?.warn?.(
            `[crypto] Credit monitor failed to start: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // ─── Graceful Shutdown Handler ──────────────────────────────────
      // The host process (openclaw gateway) receives SIGTERM from Docker/Fly.
      // registerService uses optional chaining — if the host doesn't support
      // managed services, these intervals leak. Install process-level handlers
      // as a safety net to ensure clean shutdown.
      const shutdownServices = (): void => {
        try { getScheduler().stop(); } catch { /* already stopped or never started */ }
        try { getHeartbeatMonitor().stop(); } catch { /* already stopped or never started */ }
        try {
          import('./src/services/credit-monitor.js')
            .then(({ getCreditMonitor }) => getCreditMonitor().stop())
            .catch(() => {});
        } catch { /* already stopped */ }
        // Persist in-memory forum topics and thread bindings
        try { persistForumTopics(); } catch { /* best effort */ }
        try { persistThreadBindings(); } catch { /* best effort */ }
        try { persistOrders(); } catch { /* best effort */ }
        api.logger?.info?.('[crypto] Graceful shutdown: services stopped, state persisted');
      };

      let shutdownCalled = false;
      const onShutdownSignal = (signal: string): void => {
        if (shutdownCalled) return; // Prevent double-shutdown
        shutdownCalled = true;
        api.logger?.info?.(`[crypto] Received ${signal}, shutting down...`);
        shutdownServices();
        // Don't call process.exit — let the host process handle that
      };

      process.on('SIGTERM', () => onShutdownSignal('SIGTERM'));
      process.on('SIGINT', () => onShutdownSignal('SIGINT'));

      // Also handle 'beforeExit' for non-signal shutdowns
      process.on('beforeExit', () => {
        if (!shutdownCalled) {
          shutdownCalled = true;
          shutdownServices();
        }
      });
    });

    // ─── Onboarding State Tracking ──────────────────────────────────────
    // Track which conversations are currently being handled by onboarding
    // so the message_sending hook can cancel the LLM response.
    //
    // Uses a Map<chatId, timestamp> with a 30-second TTL instead of a bare
    // Set to prevent stale entries from permanently silencing the agent.
    const ONBOARDING_FLAG_TTL_MS = 30_000;
    const onboardingHandledConversations = new Map<string, number>();

    /** Add a chatId flag with a TTL. */
    function markConversationHandled(chatId: string): void {
      onboardingHandledConversations.set(chatId, Date.now());
    }

    /** Check and consume a flag, returning true if valid (not expired). */
    function consumeConversationFlag(chatId: string): boolean {
      const ts = onboardingHandledConversations.get(chatId);
      if (ts == null) return false;
      onboardingHandledConversations.delete(chatId);
      // Expired entries are stale — don't cancel the response
      if (Date.now() - ts > ONBOARDING_FLAG_TTL_MS) return false;
      return true;
    }

    /** Periodic sweep: purge expired entries to prevent unbounded Map growth. */
    setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of onboardingHandledConversations) {
        if (now - ts > ONBOARDING_FLAG_TTL_MS) {
          onboardingHandledConversations.delete(key);
        }
      }
    }, 60_000); // Every 60 seconds

    // ── Channel-agnostic sender for onboarding + notifications ────────
    const channelSender = createChannelSender(api);

    // Wire channel sender to /update command for progress messages
    setUpdateCommandSender(channelSender);

    /** Send an onboarding message to a chat on the given channel. */
    async function sendOnboardingMessage(channel: ChannelId, chatId: string, msg: OnboardingMessage): Promise<void> {
      try {
        const ok = await channelSender.send(channel, chatId, msg.text);
        if (!ok) {
          api.logger?.warn?.(`[crypto] sendMessage for ${channel} not available on runtime`);
        }
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Failed to send onboarding message via ${channel}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // ─── Onboarding: Message Received Hook ─────────────────────────────
    // Detects new/in-progress onboarding users and sends the onboarding
    // response directly via the channel's API (bypassing the LLM). Sets a
    // flag so message_sending can cancel the LLM's response.
    //
    // Works on ALL channels (Telegram, Discord, Slack, etc.).
    //
    // Hook signature: (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => void
    // event.from = sender ID, event.content = message text
    // ctx.channelId = channel name, ctx.conversationId = chat ID
    api.on('message_received', async (event: any, ctx: any) => {
      try {
        const channel = extractChannelId(ctx);
        if (!channel) return; // Unknown channel — skip

        // The sender's user ID (channel-agnostic)
        const userId = extractSenderId(event, ctx);
        if (!userId) return;

        // The chat ID to send replies to (same as user ID in DMs)
        const chatId = ctx?.conversationId ?? String(userId);

        // ── Typing indicator: start immediately so user knows agent is alive ──
        if (channel === 'telegram') {
          try { getTypingIndicator().start(String(chatId)); } catch { /* non-critical */ }
        }

        const message = event?.content ?? '';

        // Don't intercept slash commands — let OpenClaw's command system handle them.
        // Our onboarding slash commands (like /professional, /degen) are registered
        // as proper commands and will call back into the onboarding flow themselves.
        // EXCEPTION: /start is Telegram's auto-sent command when a user first opens
        // the bot. We need to intercept it to trigger onboarding.
        const msgStr = String(message);
        if (msgStr.startsWith('/') && msgStr !== '/start') return;

        const flow = getOnboardingFlow(String(userId));
        if (!flow.isActive) return;

        const response = await flow.processMessage(String(message));

        if (response) {
          // Mark this conversation as handled by onboarding
          markConversationHandled(chatId);

          // Send the onboarding response directly via the detected channel
          await sendOnboardingMessage(channel, chatId, response);

          api.logger?.info?.(
            `[crypto] Onboarding step for user ${userId} on ${channel}: ${flow.currentStep}`
          );
        }

        // ── Session recall: index inbound messages ─────────────────
        try {
          const sessionKey = ctx?.sessionKey ?? `${channel}-${chatId}`;
          getSessionRecall().recordTurn({
            sessionKey,
            role: 'user',
            content: String(message).slice(0, 2000),
            userId: String(userId),
            timestamp: Date.now(),
          });
        } catch {
          // Non-critical
        }
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Onboarding message hook error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    // ─── Onboarding: Cancel LLM Response ───────────────────────────────
    // When onboarding handled the inbound message, suppress the LLM's reply.
    //
    // Hook signature: (event: PluginHookMessageSendingEvent, ctx: PluginHookMessageContext)
    //   => { cancel?: boolean, content?: string } | void
    api.on('message_sending', (event: any, ctx: any) => {
      try {
        const chatId = ctx?.conversationId ?? event?.to;
        if (!chatId) return;

        // ── Typing indicator: stop — response is being sent ──────────
        try { getTypingIndicator().stop(String(chatId)); } catch { /* non-critical */ }

        if (consumeConversationFlag(String(chatId))) {
          api.logger?.info?.(`[crypto] Suppressing LLM response for onboarding chat ${chatId}`);
          return { cancel: true };
        }

        // ── Interrupt check ──────────────────────────────────────────
        // If /interrupt was called, suppress the LLM response.
        try {
          const sessionKey = ctx?.sessionKey ?? String(chatId);
          if (getInterruptService().consume(sessionKey)) {
            api.logger?.info?.(`[crypto] Response interrupted for session ${sessionKey}`);
            return { cancel: true };
          }
        } catch { /* Non-critical */ }

        // ── Credential leak scanning ─────────────────────────────────
        // Scan outbound messages for accidentally leaked secrets before
        // they reach the user (and potentially logs, channel histories, etc.)
        const content = event?.content ?? event?.text ?? '';
        if (typeof content === 'string' && content.length > 0) {
          const vault = getCredentialVault();
          const scan = vault.scanForLeaks(content);
          if (!scan.clean) {
            api.logger?.warn?.(
              `[crypto] Credential leak detected in outbound message! ` +
              `${scan.leaks.length} leak(s): ${scan.leaks.map(l => l.type).join(', ')}. Redacting.`
            );
            // Return the redacted version
            return { content: scan.redactedText };
          }
        }
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] message_sending hook error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    // ─── System Prompt Injection ──────────────────────────────────────
    // Extracted to src/hooks/prompt-builder.ts for maintainability.
    // Uses prependSystemContext for static/cacheable content and
    // prependContext for dynamic per-user content.
    api.on('before_prompt_build', (event: any, ctx: any) => {
      return buildPromptContext(event, ctx, {
        getWalletState: getWalletStateFn,
        logger: api.logger,
      });
    });

    // ─── After Tool Call Hook ────────────────────────────────────────
    // Extracted to src/hooks/after-tool-call.ts for maintainability.
    // Handles: onboarding progression, config hints, cost basis,
    // tx ledger, budget tracking, session recall, evolution nudges.
    api.on('after_tool_call', async (event: any, ctx: any) => {
      await handleAfterToolCall(event, ctx, {
        writeToolNames: WRITE_TOOL_NAMES,
        sendOnboardingMessage,
        markOnboardingHandled: markConversationHandled,
        getWalletState: getWalletStateFn,
        logger: api.logger,
      });
    });
  },
};

export default plugin;
