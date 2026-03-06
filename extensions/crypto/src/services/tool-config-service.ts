/**
 * Tool Configuration Service — Centralized registry of what each tool needs.
 *
 * Maps tool names to their requirements (env vars, wallet, services).
 * Used by:
 *   - Tools themselves (early return with clean guidance when not configured)
 *   - /setup command (shows what's configured vs missing)
 *   - System prompt injection (tells the LLM what's available)
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface ToolRequirement {
  /** Tool name (matches the tool's `name` field) */
  tool: string;
  /** Human-readable label */
  label: string;
  /** Short description of what the tool does */
  description: string;
  /** Env vars required (ALL must be set for tool to work) */
  requiredKeys: string[];
  /** Env vars that add optional functionality */
  optionalKeys?: string[];
  /** Whether a connected wallet is required */
  walletRequired?: boolean;
  /** Whether the tool works without any keys (public APIs) */
  worksWithoutKeys?: boolean;
  /** Where to get the key(s) */
  keySource?: string;
  /** flykeys set example */
  setupHint?: string;
}

// ─── Registry ────────────────────────────────────────────────────────────

export const TOOL_REQUIREMENTS: ToolRequirement[] = [
  // ── Always works (public APIs) ─────────────────────────────────────
  {
    tool: 'defi_price',
    label: 'Price Lookup',
    description: 'Token prices via DexScreener (free)',
    requiredKeys: [],
    optionalKeys: ['COINGECKO_API_KEY', 'CMC_API_KEY'],
    worksWithoutKeys: true,
  },
  {
    tool: 'analytics',
    label: 'Technical Analysis',
    description: 'RSI, MACD, Bollinger Bands via DexScreener (free)',
    requiredKeys: [],
    worksWithoutKeys: true,
  },
  {
    tool: 'market_intel',
    label: 'Market Intelligence',
    description: 'Buys/sells, timeframe changes via DexScreener (free)',
    requiredKeys: [],
    worksWithoutKeys: true,
  },
  {
    tool: 'clawnch_info',
    label: 'Clawnch Platform',
    description: 'Platform stats, top tokens (free)',
    requiredKeys: [],
    worksWithoutKeys: true,
  },
  {
    tool: 'clawnch_fees',
    label: 'Clawnch Fees',
    description: 'Fee estimates and claim info (free)',
    requiredKeys: [],
    worksWithoutKeys: true,
  },
  {
    tool: 'cost_basis',
    label: 'Cost Basis',
    description: 'Token cost basis tracking (free)',
    requiredKeys: [],
    worksWithoutKeys: true,
  },
  {
    tool: 'crypto_workflow',
    label: 'Workflow Planner',
    description: 'Multi-step DeFi operation planner (free)',
    requiredKeys: [],
    worksWithoutKeys: true,
  },

  // ── Wallet required ────────────────────────────────────────────────
  {
    tool: 'defi_swap',
    label: 'DEX Swap',
    description: 'Swap tokens via DEX aggregators',
    requiredKeys: [],
    optionalKeys: ['ZEROX_API_KEY', 'ONEINCH_API_KEY'],
    walletRequired: true,
    worksWithoutKeys: false,
  },
  {
    tool: 'defi_balance',
    label: 'Balance Check',
    description: 'Check wallet token balances',
    requiredKeys: [],
    walletRequired: true,
    worksWithoutKeys: false,
  },
  {
    tool: 'transfer',
    label: 'Token Transfer',
    description: 'Send tokens to another address',
    requiredKeys: [],
    walletRequired: true,
  },
  {
    tool: 'permit2',
    label: 'Permit2 Approvals',
    description: 'Gasless token approvals via Permit2',
    requiredKeys: [],
    walletRequired: true,
  },
  {
    tool: 'clawnch_launch',
    label: 'Token Launch',
    description: 'Launch tokens on Clawnch',
    requiredKeys: [],
    walletRequired: true,
  },
  {
    tool: 'liquidity',
    label: 'Liquidity Management',
    description: 'Add/remove liquidity positions',
    requiredKeys: [],
    walletRequired: true,
  },
  {
    tool: 'manage_orders',
    label: 'Order Management',
    description: 'Limit orders and DCA',
    requiredKeys: [],
    walletRequired: true,
  },
  {
    tool: 'clawnchconnect',
    label: 'Wallet Connect',
    description: 'Connect wallet (WalletConnect, private key, or Bankr)',
    requiredKeys: [],
    worksWithoutKeys: true,
  },

  // ── Bridge (works without key but better with) ─────────────────────
  {
    tool: 'bridge',
    label: 'Cross-chain Bridge',
    description: 'Bridge tokens via LI.FI aggregator',
    requiredKeys: [],
    optionalKeys: ['LIFI_API_KEY'],
    walletRequired: true,
    worksWithoutKeys: true,
    keySource: 'https://li.fi',
    setupHint: '`/flykeys set LIFI_API_KEY your_key`',
  },

  // ── Requires specific API keys ─────────────────────────────────────
  {
    tool: 'herd_intelligence',
    label: 'Herd Intelligence',
    description: 'On-chain investigation, token safety audits, contract analysis',
    requiredKeys: ['HERD_ACCESS_TOKEN'],
    keySource: 'https://herdintelligence.com',
    setupHint: '`/flykeys set HERD_ACCESS_TOKEN your_token`',
  },
  {
    tool: 'block_explorer',
    label: 'Block Explorer',
    description: 'Etherscan/Basescan lookups (tx, contract source, holders)',
    requiredKeys: ['BASESCAN_API_KEY'],
    optionalKeys: ['ETHERSCAN_API_KEY'],
    keySource: 'https://basescan.org/apis (free tier available)',
    setupHint: '`/flykeys set BASESCAN_API_KEY your_key`',
  },
  {
    tool: 'watch_activity',
    label: 'On-chain Monitor',
    description: 'Monitor swaps, transfers, deployments on Base',
    requiredKeys: [],
    walletRequired: false,
    worksWithoutKeys: false,
    // Needs RPC client initialized — this happens via wallet service init
    setupHint: 'Connect a wallet first (/connect) or set a custom RPC (`/flykeys set CLAWNCHER_RPC_URL your_rpc_url`)',
  },
  {
    tool: 'clawnx',
    label: 'X/Twitter (ClawnX)',
    description: 'Post tweets, engage, manage followers, DMs, lists',
    requiredKeys: ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'],
    optionalKeys: ['X_BEARER_TOKEN'],
    keySource: 'https://developer.x.com',
    setupHint: '`/flykeys set X_API_KEY your_key` (+ 3 more keys)',
  },
  {
    tool: 'hummingbot',
    label: 'Hummingbot',
    description: 'Market-making bot control',
    requiredKeys: ['HUMMINGBOT_API_URL'],
    optionalKeys: ['HUMMINGBOT_USERNAME', 'HUMMINGBOT_PASSWORD'],
    keySource: 'Self-hosted Hummingbot instance',
    setupHint: '`/flykeys set HUMMINGBOT_API_URL http://your-hummingbot:15888`',
  },
  {
    tool: 'molten',
    label: 'Molten (Agent Matching)',
    description: 'Agent-to-agent intent matching on molten.gg',
    requiredKeys: ['MOLTEN_API_KEY'],
    keySource: 'Use the tool\'s "register" action to get a key',
    setupHint: '`/flykeys set MOLTEN_API_KEY your_key`',
  },
  {
    tool: 'wayfinder',
    label: 'Wayfinder',
    description: 'Cross-chain routing and pathfinding',
    requiredKeys: [],
    worksWithoutKeys: true,
  },

  // ── Bankr tools ────────────────────────────────────────────────────
  {
    tool: 'bankr_launch',
    label: 'Bankr Token Launch',
    description: 'Launch tokens via Bankr Agent API',
    requiredKeys: ['BANKR_API_KEY'],
    keySource: 'https://bankr.bot',
    setupHint: '`/flykeys set BANKR_API_KEY bk_your_key`',
  },
  {
    tool: 'bankr_automate',
    label: 'Bankr Automations',
    description: 'DCA, limit orders, portfolio rebalancing via Bankr',
    requiredKeys: ['BANKR_API_KEY'],
    keySource: 'https://bankr.bot',
    setupHint: '`/flykeys set BANKR_API_KEY bk_your_key`',
  },
  {
    tool: 'bankr_polymarket',
    label: 'Bankr Polymarket',
    description: 'Prediction market trading via Bankr',
    requiredKeys: ['BANKR_API_KEY'],
    keySource: 'https://bankr.bot',
    setupHint: '`/flykeys set BANKR_API_KEY bk_your_key`',
  },
  {
    tool: 'bankr_leverage',
    label: 'Bankr Leverage',
    description: 'Leveraged trading via Bankr',
    requiredKeys: ['BANKR_API_KEY'],
    keySource: 'https://bankr.bot',
    setupHint: '`/flykeys set BANKR_API_KEY bk_your_key`',
  },

  // ── Phase 7: Compound operations ───────────────────────────────────
  {
    tool: 'compound_action',
    label: 'Compound Actions',
    description: 'Multi-step DeFi operations with scheduling, conditions, and sequencing',
    requiredKeys: [],
    walletRequired: true,
    worksWithoutKeys: true,
  },
];

// ─── Lookup Helpers ──────────────────────────────────────────────────────

const _byTool = new Map<string, ToolRequirement>();
for (const req of TOOL_REQUIREMENTS) {
  _byTool.set(req.tool, req);
}

/** Get requirements for a specific tool */
export function getToolRequirement(toolName: string): ToolRequirement | undefined {
  return _byTool.get(toolName);
}

/** Check if a tool has all its required keys configured */
export function isToolConfigured(toolName: string): boolean {
  const req = _byTool.get(toolName);
  if (!req) return true; // Unknown tool — assume configured
  if (req.worksWithoutKeys) return true;
  if (req.requiredKeys.length === 0 && !req.walletRequired) return true;
  return req.requiredKeys.every(k => !!process.env[k]);
}

/** Get missing keys for a tool */
export function getMissingKeys(toolName: string): string[] {
  const req = _byTool.get(toolName);
  if (!req) return [];
  return req.requiredKeys.filter(k => !process.env[k]);
}

/**
 * Check tool configuration and return a clean guidance message if not configured.
 * Returns null if the tool is ready to use.
 *
 * Usage in tools:
 * ```ts
 * const notReady = checkToolConfig('block_explorer');
 * if (notReady) return notReady;
 * ```
 */
export function checkToolConfig(toolName: string): {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown;
  isError: true;
} | null {
  const req = _byTool.get(toolName);
  if (!req) return null;

  // Check required keys
  const missing = req.requiredKeys.filter(k => !process.env[k]);
  if (missing.length > 0) {
    const lines = [
      `${req.label} is not configured.`,
      '',
      `Missing: ${missing.map(k => `\`${k}\``).join(', ')}`,
    ];

    if (req.keySource) {
      lines.push(`Get keys at: ${req.keySource}`);
    }

    if (req.setupHint) {
      lines.push('', `Setup: ${req.setupHint}`);
    }

    lines.push('', 'Use /setup to see all tool requirements.');

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      details: {
        configured: false,
        tool: toolName,
        missingKeys: missing,
        setupHint: req.setupHint,
      },
      isError: true as const,
    };
  }

  return null;
}

// ─── Setup Summary ───────────────────────────────────────────────────────

export interface ToolStatus {
  tool: string;
  label: string;
  description: string;
  configured: boolean;
  missingKeys: string[];
  setupHint?: string;
  keySource?: string;
  walletRequired?: boolean;
}

/** Get status of all tools */
export function getAllToolStatus(): ToolStatus[] {
  return TOOL_REQUIREMENTS.map(req => {
    const missing = req.requiredKeys.filter(k => !process.env[k]);
    const configured = req.worksWithoutKeys
      || (req.requiredKeys.length === 0 && !req.walletRequired)
      || missing.length === 0;

    return {
      tool: req.tool,
      label: req.label,
      description: req.description,
      configured,
      missingKeys: missing,
      setupHint: req.setupHint,
      keySource: req.keySource,
      walletRequired: req.walletRequired,
    };
  });
}
