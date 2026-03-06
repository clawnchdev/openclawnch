/**
 * /help — Show all available commands grouped by category.
 * /portfolio — Show wallet balances and token holdings.
 *
 * Both are referenced in onboarding messages and expected by users.
 */

import { getWalletState } from '../services/walletconnect-service.js';

// ── /help ───────────────────────────────────────────────────────────────────

export const helpCommand = {
  name: 'help',
  description: 'Show all available commands',
  acceptsArgs: false,
  requireAuth: false, // Anyone can see help
  handler: async (_ctx: any) => {
    return {
      text: `**OpenClawnch Commands**

**Wallet**
  /connect — Connect mobile wallet
  /connect_bankr — Connect Bankr (custodial)
  /wallet — Wallet status and balance
  /portfolio — Token holdings
  /tx — Transaction history

**Safety & Signing**
  /mode — Show current mode
  /safemode — Confirm before acting
  /dangermode — Act immediately
  /walletsign — Phone approval (default)
  /autosign — Auto-sign with private key

**Spending**
  /policy — Manage auto-approval rules

**LLM**
  /llm — View or switch model
  /llm_opus — Switch to Claude Opus
  /llm_sonnet — Switch to Claude Sonnet
  /provider — View or switch LLM provider

**Persona**
  /professional /degen /chill /technical /mentor

**Scheduled Operations**
  /plans — List all plans
  /plans_active — Active plans only
  /plans_cancel — Cancel a plan
  /plans_clear — Cancel all plans

**Bankr**
  /connect_bankr — Connect Bankr wallet
  /llmcredits — LLM credit balance
  /llmcost — LLM cost tracking
  /automations — Automation status

**Deploy Control** (Fly.io only)
  /flykeys — Manage API keys
  /flystatus — Machine status
  /flyrestart — Restart bot
  /provider_anthropic /provider_bankr /provider_openrouter

**Other**
  /setup — Configuration status
  /molten — Molten agent profile
  /factoryreset — Wipe all data
  /skip — Skip onboarding

Talk to me naturally — I understand freeform requests like "What's the price of ETH?", "Show my portfolio", "Swap 0.1 ETH for USDC", etc.`,
    };
  },
};

// ── /portfolio ──────────────────────────────────────────────────────────────

export const portfolioCommand = {
  name: 'portfolio',
  description: 'Show wallet balances and token holdings',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    const state = getWalletState();

    if (!state.connected || !state.address) {
      return {
        text: `No wallet connected.\n\nUse /connect to pair your mobile wallet, or /connect_bankr for Bankr (custodial).\n\nOnce connected, ask me "Show my portfolio" or "What are my balances?" for a detailed breakdown.`,
      };
    }

    // We don't do RPC calls from commands (keep them fast/synchronous).
    // Instead, tell the LLM to use the defi_balance tool for a full breakdown.
    const addr = state.address;
    const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    const mode = state.mode === 'bankr' ? 'Bankr (custodial)' : state.mode === 'private_key' ? 'Private key' : 'WalletConnect';

    return {
      text: `**Wallet:** ${short}\n**Mode:** ${mode}${state.chainId ? `\n**Chain:** ${state.chainId}` : ''}${state.bankrSolAddress ? `\n**Solana:** ${state.bankrSolAddress.slice(0, 6)}...${state.bankrSolAddress.slice(-4)}` : ''}\n\nFor a full token breakdown with USD values, ask me:\n"Show my portfolio" or "What are my balances on Base?"`,
    };
  },
};
