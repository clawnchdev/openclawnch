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
  /disconnect — Disconnect wallet
  /wallet — Wallet status
  /balance — ETH balance
  /portfolio — Token holdings
  /chain — Current chain
  /tx — Transaction history

**Safety & Signing**
  /mode — Show current mode
  /safemode — Confirm before acting
  /dangermode — Act immediately
  /walletsign — Phone approval (default)
  /autosign — Auto-sign with private key
  /policy — Auto-approval rules

**LLM**
  /llm — View or switch model
  /llm_opus — Claude Opus
  /llm_sonnet — Claude Sonnet
  /provider — View or switch provider
  /provider_anthropic /provider_bankr
  /provider_openrouter /provider_openai

**Persona**
  /professional /degen /chill /technical /mentor

**Plans**
  /plans — List all
  /plans_active — Active only
  /plans_cancel — Cancel a plan
  /plans_clear — Cancel all

**Bankr**
  /connect_bankr — Bankr wallet
  /llmcredits — Credit balance
  /llmcost — Cost tracking
  /automations — Automation status

**Deploy** (Fly.io)
  /flykeys — API keys
  /flystatus — Machine status
  /flyrestart — Restart bot

**Other**
  /setup — Config status
  /molten — Molten agent
  /factoryreset — Wipe all data
  /skip — Skip onboarding

Just talk to me — "What's the price of ETH?", "Show my portfolio", "Swap 0.1 ETH for USDC", etc.`,
    };
  },
};

// ── /balance ────────────────────────────────────────────────────────────────

export const balanceCommand = {
  name: 'balance',
  description: 'Show ETH balance and wallet address',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    const state = getWalletState();

    if (!state.connected || !state.address) {
      return {
        text: 'No wallet connected.\n\nUse /connect to pair your mobile wallet, or /connect_bankr for Bankr (custodial).',
      };
    }

    const addr = state.address;
    const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    const mode = state.mode === 'bankr' ? 'Bankr (custodial)' : state.mode === 'private_key' ? 'Private key' : 'WalletConnect';

    return {
      text: `**Wallet:** ${short}\n**Mode:** ${mode}${state.chainId ? `\n**Chain:** ${state.chainId}` : ''}\n\nFor token balances with USD values, ask me:\n"What are my balances?" or "Show my balance on Base"`,
    };
  },
};

// ── /chain ──────────────────────────────────────────────────────────────────

export const chainCommand = {
  name: 'chain',
  description: 'Show current chain',
  acceptsArgs: false,
  requireAuth: false,
  handler: async (_ctx: any) => {
    const state = getWalletState();

    const CHAIN_NAMES: Record<number, string> = {
      1: 'Ethereum Mainnet',
      8453: 'Base',
      42161: 'Arbitrum One',
      10: 'Optimism',
      137: 'Polygon',
      84532: 'Base Sepolia',
      11155111: 'Ethereum Sepolia',
    };

    if (!state.connected) {
      return {
        text: 'No wallet connected. Default chain: **Base (8453)**\n\nConnect a wallet to interact with a specific chain: /connect',
      };
    }

    const chainId = state.chainId ?? 8453;
    const name = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;

    return {
      text: `**Current chain:** ${name} (${chainId})\n\nTo switch chains, ask me: "Switch to Arbitrum" or use the clawnchconnect tool.`,
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
