/**
 * /help — Show all available commands grouped by category.
 * /portfolio — Show wallet balances and token holdings.
 *
 * Both are referenced in onboarding messages and expected by users.
 */

import { getWalletState } from '../services/walletconnect-service.js';

// ── /help ───────────────────────────────────────────────────────────────────

// ── Category help pages ─────────────────────────────────────────────────────

const HELP_CATEGORIES: Record<string, string> = {
  trading: `**Trading**
  Swaps, orders, and leveraged positions.

  **Tools:** defi_swap, manage_orders, crypto_workflow, bankr_leverage, bankr_polymarket
  **Commands:** /plans, /plans_active, /plans_cancel

  **Try:**
  "Swap 0.1 ETH for USDC"
  "Set a limit buy for ETH at $3500"
  "DCA $100 into ETH every Monday"
  "Open 3x long on ETH"
  "What are the top Polymarket predictions?"`,

  defi: `**DeFi**
  Lending, staking, yield, liquidity, and bridging.

  **Tools:** lending, staking, yield, liquidity, bridge, governance
  **Commands:** /chain

  **Try:**
  "Supply 1 ETH as collateral on Aave"
  "What's my health factor?"
  "Bridge 100 USDC from Ethereum to Base"
  "Show yield opportunities for USDC"
  "Stake 0.5 ETH"`,

  portfolio: `**Portfolio & Market Data**
  Balances, tracking, prices, and market intelligence.

  **Tools:** defi_balance, defi_price, cost_basis, analytics, market_intel, block_explorer, watch_activity
  **Commands:** /wallet, /balance, /portfolio, /chain, /tx

  **Try:**
  "Show my portfolio"
  "What's the price of ETH?"
  "What's trending on Base?"
  "Show cost basis for my USDC"
  "Track whale activity"`,

  tools: `**User-Defined Tools & Extensions**
  Create custom tools at runtime — API connectors, composed chains, natural language definitions.

  **Commands:** /tools

  **Try:**
  "Create a tool that checks Hetzner server status"
  "Create a rebalance tool that checks portfolio and swaps to target weights"
  "List my custom tools"`,

  agents: `**Multi-Agent Orchestration**
  Delegate tasks to specialized sub-agents with restricted tool access.

  **Preset agents:** strategist, analyst, accountant, risk_manager
  **Commands:** /agents, /agents info <name>, /agents enable/disable <name>

  **Try:**
  "Ask the analyst to evaluate ETH price trends"
  "Have the risk manager assess my portfolio exposure"
  "List available sub-agents"`,

  automation: `**Automation & Triggers**
  Scheduled plans, price triggers, cron jobs, and webhook ingestion.

  **Tools:** compound_action
  **Commands:** /plans, /triggers, /webhooks

  **Try:**
  "Every Monday at 9am, buy $50 of ETH"
  "If ETH drops below $3000, sell half my position"
  "Set up a webhook for GitHub push events"`,

  wallet: `**Wallet & Security**
  Connect wallets, manage keys, set spending policies.

  **Commands:**
  /connect — Mobile wallet (MetaMask, Rainbow, etc.)
  /create_wallet — New local wallet (BIP-39)
  /import_wallet — Import from seed phrase
  /connect_bankr — Bankr custodial wallet
  /disconnect — Disconnect
  /mode — Safety mode (safe/danger/readonly)
  /policy — Spending auto-approval rules
  /autosign — Auto-sign with local key
  /walletsign — Phone approval (default)`,

  fiat: `**Fiat & Payments**
  On-ramp, off-ramp, recurring payments, invoices.

  **Tools:** fiat_payment
  **Commands:** /fiat

  **Try:**
  "Cash out $500 USDC to my bank"
  "Buy $200 of ETH from my bank account"
  "Set up a $50/month recurring payment to 0x..."`,
};

const HELP_OVERVIEW = `**OpenClawnch — Command Reference**

  /help trading — Swaps, orders, DCA, leverage
  /help defi — Lending, staking, yield, bridging
  /help portfolio — Balances, prices, tracking
  /help automation — Triggers, schedules, webhooks
  /help wallet — Wallets, keys, security
  /help fiat — On/off-ramp, payments
  /help tools — Custom tools, API connectors
  /help agents — Sub-agent delegation

**Quick commands:**
  /connect — Connect wallet
  /wallet — Status
  /portfolio — Holdings
  /balance — ETH balance
  /plans — Scheduled plans
  /setup — Config check
  /doctor — Diagnostics

Or just talk to me — "What's the price of ETH?", "Show my portfolio", "Swap 0.1 ETH for USDC"`;

export const helpCommand = {
  name: 'help',
  description: 'Show commands — /help <category> for details (trading, defi, portfolio, tools, agents, etc.)',
  acceptsArgs: true,
  requireAuth: false,
  handler: async (ctx?: any) => {
    const arg = (ctx?.args ?? '').trim().toLowerCase();

    if (!arg || arg === 'all') {
      return { text: HELP_OVERVIEW };
    }

    const page = HELP_CATEGORIES[arg];
    if (page) {
      return { text: page };
    }

    // Fuzzy match — try partial match
    const match = Object.keys(HELP_CATEGORIES).find(k => k.startsWith(arg));
    if (match) {
      return { text: HELP_CATEGORIES[match]! };
    }

    return {
      text: `No help category "${arg}".\n\nAvailable: ${Object.keys(HELP_CATEGORIES).join(', ')}\n\nUse /help for the full overview.`,
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
    const chainName = state.chainId ? (CHAIN_NAMES[state.chainId] ?? `Chain ${state.chainId}`) : null;

    return {
      text: `**Wallet:** ${short}\n**Mode:** ${mode}${chainName ? `\n**Chain:** ${chainName}` : ''}\n\nFull balances require an on-chain lookup. Ask me: "Show my balances" for a detailed breakdown with USD values.`,
    };
  },
};

// ── Shared chain lookup ─────────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum Mainnet',
  8453: 'Base',
  42161: 'Arbitrum One',
  10: 'Optimism',
  137: 'Polygon',
  84532: 'Base Sepolia',
  11155111: 'Ethereum Sepolia',
};

// ── /chain ──────────────────────────────────────────────────────────────────

export const chainCommand = {
  name: 'chain',
  description: 'Show current chain',
  acceptsArgs: false,
  requireAuth: false,
  handler: async (_ctx: any) => {
    const state = getWalletState();

    if (!state.connected) {
      return {
        text: 'No wallet connected. Default chain: **Base (8453)**\n\nConnect a wallet to interact with a specific chain: /connect',
      };
    }

    const chainId = state.chainId ?? 8453;
    const name = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;

    return {
      text: `**Current chain:** ${name} (${chainId})\n\nTo switch chains, ask me: "Switch to Arbitrum"`,
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
      text: `**Wallet:** ${short}\n**Mode:** ${mode}${state.chainId ? `\n**Chain:** ${CHAIN_NAMES[state.chainId] ?? `Chain ${state.chainId}`}` : ''}${state.bankrSolAddress ? `\n**Solana:** ${state.bankrSolAddress.slice(0, 6)}...${state.bankrSolAddress.slice(-4)}` : ''}\n\nFor a full token breakdown with USD values, ask me: "Show my portfolio" or "What are my balances on Base?"`,
    };
  },
};
