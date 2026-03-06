/**
 * OpenClawnch Onboarding Flow — first-run tutorial state machine.
 *
 * Detects new users and walks them through:
 * 1. Welcome — professional greeting with capabilities overview
 * 2. Persona selection — choose communication style (professional, degen, chill, etc.)
 * 3. Capabilities overview — show what's available, note what needs deploy-time config
 * 4. Wallet connect — pair a mobile wallet via deep link
 * 5. First read action — try a read-only query
 * 6. First write action — try a transaction (user approves on phone)
 * 7. Complete — command reference card
 *
 * All infrastructure config (LLM keys, WalletConnect project ID, etc.) is handled
 * at deploy time via `openclawnch deploy`. This flow only handles user preferences
 * and wallet pairing.
 *
 * State persists on volume so interrupted tutorials resume.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────

export type OnboardingStep =
  | 'welcome'
  | 'choose_persona'
  | 'choose_capabilities'
  | 'connect_wallet'
  | 'wallet_connected'
  | 'first_read'
  | 'first_write'
  | 'complete'
  | 'skipped';

/** Preset personas the user can choose from. */
export type PersonaId = 'professional' | 'degen' | 'chill' | 'technical' | 'mentor' | 'custom';

export interface PersonaOption {
  id: PersonaId;
  label: string;
  description: string;
  /** Short example of how the bot would talk in this persona. */
  example: string;
}

/** Capability categories that map to groups of tools. */
export interface CapabilityCategory {
  id: string;
  name: string;
  description: string;
  tools: string[];
  /** Env var that must be set at deploy time for this to work. Empty = works out of the box. */
  deployRequirement?: string;
  /** Whether this capability requires a connected wallet. */
  needsWallet: boolean;
}

export interface OnboardingState {
  userId: string;
  step: OnboardingStep;
  /** Selected persona ID, or 'custom' with customPersona text. */
  persona?: PersonaId;
  customPersona?: string;
  /** Selected capability category IDs. */
  selectedCapabilities?: string[];
  walletConnected: boolean;
  walletAddress?: string;
  firstReadDone: boolean;
  firstWriteDone: boolean;
  startedAt: number;
  completedAt?: number;
  lastInteraction: number;
}

export interface OnboardingMessage {
  text: string;
  /** Telegram parse mode */
  parseMode?: 'HTML' | 'Markdown';
  /** If true, include WalletConnect deep link */
  showConnectLink?: boolean;
  /** Suggested next action for the user */
  suggestion?: string;
  /** If true, this is the last onboarding message */
  final?: boolean;
}

// ── Personas ────────────────────────────────────────────────────────────────

export const PERSONAS: PersonaOption[] = [
  {
    id: 'professional',
    label: '1. Professional',
    description: 'Clear, concise, business-like. Sticks to facts and figures.',
    example: '"Your portfolio is up 3.2% today. ETH is at $3,847. Shall I proceed with the swap?"',
  },
  {
    id: 'degen',
    label: '2. Degen',
    description: 'CT native. Speaks the language of crypto twitter.',
    example: '"ser that token is absolutely ripping rn 🚀 ape in or stay poor, your call anon"',
  },
  {
    id: 'chill',
    label: '3. Chill',
    description: 'Relaxed, friendly, no pressure. Like texting a knowledgeable friend.',
    example: '"hey so ETH is looking pretty good today, up about 3%. want me to grab some?"',
  },
  {
    id: 'technical',
    label: '4. Technical',
    description: 'Detailed, data-heavy. Includes on-chain metrics and technical analysis.',
    example: '"ETH/USD at $3,847.32, 24h vol $18.2B, RSI 62.4. Gas at 12 gwei. The 0.3% Uniswap V3 pool has $142M TVL with concentrated liquidity at 3800-3900."',
  },
  {
    id: 'mentor',
    label: '5. Mentor',
    description: 'Educational. Explains concepts as it goes, good for DeFi newcomers.',
    example: '"I\'ll swap your ETH for USDC. Quick explainer: this goes through a DEX (decentralized exchange), which means no middleman — just a smart contract matching your trade. You\'ll approve it on your phone."',
  },
];

// ── Capability Categories ───────────────────────────────────────────────────

export const CAPABILITIES: CapabilityCategory[] = [
  {
    id: 'wallet',
    name: 'Wallet & Transactions',
    description: 'Connect your wallet, send tokens, approve transactions from your phone.',
    tools: ['clawnchconnect', 'transfer', 'permit2'],
    deployRequirement: 'WALLETCONNECT_PROJECT_ID',
    needsWallet: true,
  },
  {
    id: 'prices',
    name: 'Prices & Market Data',
    description: 'Real-time token prices, trending coins, market intelligence.',
    tools: ['defi_price', 'market_intel', 'herd_intelligence', 'analytics'],
    needsWallet: false,
  },
  {
    id: 'portfolio',
    name: 'Portfolio & Balance Tracking',
    description: 'View balances, track cost basis, and monitor your positions.',
    tools: ['defi_balance', 'cost_basis', 'watch_activity', 'block_explorer'],
    needsWallet: false,
  },
  {
    id: 'trading',
    name: 'DEX Trading & Swaps',
    description: 'Execute token swaps via DEX aggregators with best-price routing.',
    tools: ['defi_swap', 'manage_orders', 'crypto_workflow'],
    needsWallet: true,
  },
  {
    id: 'liquidity',
    name: 'Liquidity Provision',
    description: 'Manage Uniswap V3/V4 liquidity positions, add/remove liquidity.',
    tools: ['liquidity'],
    needsWallet: true,
  },
  {
    id: 'launchpad',
    name: 'Token Launchpad (Clawnch)',
    description: 'Launch new tokens on Base with Uniswap V4 pools and manage fee revenue.',
    tools: ['clawnch_launch', 'clawnch_fees', 'clawnch_info'],
    needsWallet: true,
  },
  {
    id: 'bridge',
    name: 'Cross-Chain Bridge',
    description: 'Bridge tokens across Ethereum, Base, Arbitrum, Optimism, and other chains.',
    tools: ['bridge'],
    needsWallet: true,
  },
  {
    id: 'routing',
    name: 'Smart Routing (Wayfinder)',
    description: 'AI-powered route optimization across chains and protocols.',
    tools: ['wayfinder'],
    needsWallet: false,
  },
  {
    id: 'clawnx',
    name: 'ClawnX Protocol',
    description: 'Interact with the ClawnX decentralized exchange protocol.',
    tools: ['clawnx'],
    needsWallet: true,
  },
  {
    id: 'hummingbot',
    name: 'Market Making (Hummingbot)',
    description: 'Automated market making and trading bot management.',
    tools: ['hummingbot'],
    deployRequirement: 'HUMMINGBOT_URL',
    needsWallet: false,
  },
];

// ── Persistence ─────────────────────────────────────────────────────────────

/** Resolve the state dir at call time so env changes (e.g. in tests) are respected. */
function getStateDir(): string {
  return process.env.OPENCLAWNCH_TX_DIR
    ? join(process.env.OPENCLAWNCH_TX_DIR, '..', 'onboarding')
    : join(process.env.HOME ?? '/tmp', '.openclawnch', 'onboarding');
}

function ensureStateDir(): void {
  const dir = getStateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// M5: Sanitize userId to prevent path traversal
function sanitizeUserId(userId: string): string {
  // Only allow alphanumeric, underscores, hyphens, dots
  const safe = userId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  // Prevent directory traversal
  if (safe.includes('..') || safe.includes('/') || safe.includes('\\')) {
    return 'invalid_user';
  }
  return safe.slice(0, 64); // Cap length
}

function statePath(userId: string): string {
  return join(getStateDir(), `${sanitizeUserId(userId)}.json`);
}

export function loadState(userId: string): OnboardingState | null {
  try {
    const path = statePath(userId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as OnboardingState;
  } catch {
    return null;
  }
}

export function saveState(state: OnboardingState): void {
  ensureStateDir();
  writeFileSync(statePath(state.userId), JSON.stringify(state, null, 2), 'utf8');
}

// ── Messages ────────────────────────────────────────────────────────────────

const WELCOME_MESSAGE = `Welcome. I'm OpenClawnch, your personal crypto assistant — an AI agent with direct, open-ended access to blockchain protocols, market data, and transaction execution.

Here's what I can do:

  Wallet
    Connect your phone wallet (MetaMask, Rainbow, Coinbase, Trust, Zerion, Uniswap)
    Send tokens and ETH to any address
    Gasless token approvals via Permit2
    Every transaction goes to your phone for approval (or auto-sign in danger mode)

  Prices & Market Intelligence
    Real-time token prices from DexScreener and CoinGecko
    Trending tokens, new pairs, and volume leaders
    Whale activity tracking and smart money flows
    Clawnch agent leaderboard and herd intelligence

  Portfolio & On-Chain Analytics
    ETH and ERC-20 balances with USD valuations
    Cost basis tracking (auto-records your swaps)
    On-chain activity monitoring for any address
    Block explorer lookups (tx details, contract info)
    Protocol-level analytics (TVL, volume, fees)

  Trading
    Token swaps via DEX aggregators with best-price routing
    Limit orders and order management
    Multi-step workflows (e.g. "buy X, set stop-loss, monitor")

  Liquidity
    Add/remove liquidity on Uniswap V3 and V4 pools
    Manage concentrated liquidity positions and ranges

  Token Launchpad
    Deploy new ERC-20 tokens on Base via the Clawnch launchpad
    Auto-create Uniswap V4 pool with dev buy
    Claim LP trading fee revenue from launched tokens
    Token info lookup for any Clawnch-launched token

  Cross-Chain
    Bridge tokens across Ethereum, Base, Arbitrum, Optimism, Polygon, and more
    AI-optimized route planning across chains and protocols (Wayfinder)

  Advanced
    ClawnX protocol interaction
    Automated market making via Hummingbot
    Custom multi-step crypto workflows

Before we begin, I'd like to know how you prefer me to communicate.

Pick a style:

  /professional — Clear, concise, business-like
  /degen — CT native, crypto twitter energy
  /chill — Relaxed, like texting a friend
  /technical — Data-heavy, on-chain metrics
  /mentor — Educational, explains as it goes

Or just type your own preferred tone.

/skip — Skip onboarding`;

function buildPersonaConfirmation(persona: PersonaId, customText?: string): string {
  const intro = persona === 'custom'
    ? `Got it. I'll communicate in your preferred style: "${customText}"`
    : `${(PERSONAS.find(p => p.id === persona)?.label.replace(/^\d+\.\s*/, '') ?? persona)} mode selected.`;

  return `${intro}

Now pick your capabilities:

${buildCapabilitiesList()}

/all — Enable everything

Or type numbers (e.g. "1, 2, 3, 5")

/skip — Skip and use defaults`;
}

function buildCapabilitiesList(): string {
  return CAPABILITIES.map((c, i) => {
    const status = getCapabilityStatus(c);
    return `  ${i + 1}. /cap_${c.id} — ${c.name} ${status}\n     ${c.description}`;
  }).join('\n\n');
}

/** Check if a capability's deploy-time requirement is satisfied. */
function getCapabilityStatus(c: CapabilityCategory): string {
  if (!c.deployRequirement) return '(ready)';
  const envVal = process.env[c.deployRequirement];
  if (envVal && envVal.length > 0) return '(ready)';
  return '(needs deploy config)';
}

function buildCapabilitiesConfirmation(selectedIds: string[]): string {
  const selected = selectedIds
    .map(id => CAPABILITIES.find(c => c.id === id))
    .filter((c): c is CapabilityCategory => c != null);

  const ready = selected.filter(c => !c.deployRequirement || (process.env[c.deployRequirement] ?? '').length > 0);
  const notConfigured = selected.filter(c => c.deployRequirement && !(process.env[c.deployRequirement] ?? '').length);
  const walletNeeded = selected.some(c => c.needsWallet);

  let msg = `Selected ${selected.length} capabilities.`;

  if (ready.length > 0) {
    msg += `\n\nReady to use now:\n${ready.map(c => `  - ${c.name}`).join('\n')}`;
  }

  if (notConfigured.length > 0) {
    msg += `\n\nNeeds deploy-time configuration:\n${notConfigured.map(c =>
      `  - ${c.name} — requires ${c.deployRequirement}\n    (set via: fly secrets set ${c.deployRequirement}="..." -a <your-app>)`
    ).join('\n')}`;
  }

  if (walletNeeded) {
    msg += `\n\nNext step: connect your wallet. This lets me see your balances and propose transactions for you to approve on your phone.\n\nTap the link below to connect your wallet app (MetaMask, Rainbow, Coinbase Wallet, etc.), or type /connect.`;
  } else {
    msg += `\n\nYou can connect a wallet later with /connect if you want transaction capabilities.\n\nTry asking me something — for example: "What's the price of ETH?" or "What's trending on Base?"`;
  }

  return msg;
}

const WALLET_CONNECTED_MESSAGE = (address: string, balance: string) =>
  `Wallet connected: ${address.slice(0, 6)}...${address.slice(-4)}
Balance: ${balance}

Let's verify everything works. Try a read operation — ask me:
"What's trending on Base?"`;

const FIRST_READ_DONE_MESSAGE = `That's a read operation — instant, no wallet approval needed.

Now let's try a write operation. Say:
"Swap 0.001 ETH for USDC"

I'll prepare the transaction and send it to your phone wallet for approval. You always have final say.`;

const FIRST_WRITE_DONE_MESSAGE = `Transaction confirmed. Every write operation goes to your wallet for approval. You propose, you decide.

Command reference:
  /connect        — Reconnect wallet
  /wallet         — Balance and wallet info
  /portfolio      — Full token portfolio
  /tx             — Recent transactions
  /policy         — Manage spending policies
  /factoryreset   — Wipe all data and start over
  /help           — All available commands

Setup complete. Talk to me naturally — "What's the price of ETH?", "Show my portfolio", "Send 10 USDC to 0x...", or anything else.`;

const SKIP_MESSAGE = `Onboarding skipped. You can configure everything later:
  /connect — Pair wallet      |  /wallet — Balances
  /portfolio — Holdings       |  /tx — History
  /policy — Auto-approve      |  /factoryreset — Start over
  /help — All commands`;

// ── Persona Parsing ─────────────────────────────────────────────────────────

function parsePersonaChoice(message: string): { persona: PersonaId; customText?: string } | null {
  const lower = message.toLowerCase().trim();

  // Number-based selection
  if (/^1\b/.test(lower) || lower === 'professional') return { persona: 'professional' };
  if (/^2\b/.test(lower) || lower === 'degen') return { persona: 'degen' };
  if (/^3\b/.test(lower) || lower === 'chill') return { persona: 'chill' };
  if (/^4\b/.test(lower) || lower === 'technical') return { persona: 'technical' };
  if (/^5\b/.test(lower) || lower === 'mentor') return { persona: 'mentor' };

  // If the message is long enough, treat it as a custom persona description
  if (message.trim().length >= 5) {
    return { persona: 'custom', customText: message.trim() };
  }

  return null;
}

// ── Capability Parsing ──────────────────────────────────────────────────────

function parseCapabilityChoice(message: string): string[] | null {
  const lower = message.toLowerCase().trim();

  if (lower === 'all' || lower === 'everything') {
    return CAPABILITIES.map(c => c.id);
  }

  // Parse numbers like "1, 2, 3, 5" or "1 2 3 5" or "1,2,3,5"
  const numbers = message.match(/\d+/g);
  if (numbers && numbers.length > 0) {
    const ids: string[] = [];
    for (const n of numbers) {
      const idx = parseInt(n, 10) - 1;
      const cap = CAPABILITIES[idx];
      if (idx >= 0 && idx < CAPABILITIES.length && cap) {
        ids.push(cap.id);
      }
    }
    if (ids.length > 0) return [...new Set(ids)]; // dedupe
  }

  // Try matching by name
  const ids: string[] = [];
  for (const cap of CAPABILITIES) {
    if (lower.includes(cap.id) || lower.includes(cap.name.toLowerCase())) {
      ids.push(cap.id);
    }
  }
  if (ids.length > 0) return [...new Set(ids)];

  return null;
}

// ── State Machine ───────────────────────────────────────────────────────────

export class OnboardingFlow {
  private state: OnboardingState;

  constructor(userId: string) {
    const existing = loadState(userId);
    if (existing) {
      this.state = existing;
    } else {
      this.state = {
        userId,
        step: 'welcome',
        walletConnected: false,
        firstReadDone: false,
        firstWriteDone: false,
        startedAt: Date.now(),
        lastInteraction: Date.now(),
      };
      saveState(this.state);
    }
  }

  /** Is this user still in the onboarding flow? */
  get isActive(): boolean {
    return this.state.step !== 'complete' && this.state.step !== 'skipped';
  }

  /** Current step name. */
  get currentStep(): OnboardingStep {
    return this.state.step;
  }

  /** Get the current state (read-only). */
  getState(): Readonly<OnboardingState> {
    return { ...this.state };
  }

  /**
   * Check if an incoming message is the user's first-ever message.
   * If so, return the welcome message. Otherwise return null.
   */
  getWelcomeMessage(): OnboardingMessage | null {
    if (this.state.step !== 'welcome') return null;

    this.state.step = 'choose_persona';
    this.state.lastInteraction = Date.now();
    saveState(this.state);

    return {
      text: WELCOME_MESSAGE,
      suggestion: 'Reply with a number (1-5) or describe your preferred tone',
    };
  }

  /** Call when the user sends /skip-tutorial or /skip. */
  skip(): OnboardingMessage {
    this.state.step = 'skipped';
    this.state.completedAt = Date.now();
    this.state.lastInteraction = Date.now();
    saveState(this.state);

    return { text: SKIP_MESSAGE, final: true };
  }

  /**
   * Process a persona selection from the user.
   */
  onPersonaSelected(message: string): OnboardingMessage | null {
    if (this.state.step !== 'choose_persona') return null;

    const choice = parsePersonaChoice(message);
    if (!choice) {
      return {
        text: 'Pick a communication style:\n\n  /professional  /degen  /chill  /technical  /mentor\n\nOr type your own preferred tone.',
        suggestion: 'Tap a style or describe your own',
      };
    }

    this.state.persona = choice.persona;
    if (choice.customText) this.state.customPersona = choice.customText;
    this.state.step = 'choose_capabilities';
    this.state.lastInteraction = Date.now();
    saveState(this.state);

    return {
      text: buildPersonaConfirmation(choice.persona, choice.customText),
      suggestion: 'Reply with numbers (e.g. "1, 2, 3") or "all"',
    };
  }

  /**
   * Process a capability selection from the user.
   * After selection, goes directly to wallet connect (if wallet capabilities selected)
   * or first_read (if no wallet needed). No guided setup step — all infrastructure
   * config is handled at deploy time.
   */
  onCapabilitiesSelected(message: string): OnboardingMessage | null {
    if (this.state.step !== 'choose_capabilities') return null;

    const ids = parseCapabilityChoice(message);
    if (!ids) {
      return {
        text: `Tap a capability to select it, or type numbers (e.g. "1, 2, 3, 5"):\n\n${buildCapabilitiesList()}\n\n/all — Enable everything`,
        suggestion: 'Tap a capability or type numbers',
      };
    }

    this.state.selectedCapabilities = ids;
    this.state.lastInteraction = Date.now();

    const walletNeeded = ids.some(id => {
      const cap = CAPABILITIES.find(c => c.id === id);
      return cap?.needsWallet ?? false;
    });

    if (walletNeeded) {
      this.state.step = 'connect_wallet';
      saveState(this.state);

      return {
        text: buildCapabilitiesConfirmation(ids),
        showConnectLink: true,
        suggestion: 'Tap the link to connect your wallet',
      };
    }

    this.state.step = 'first_read';
    saveState(this.state);

    return {
      text: buildCapabilitiesConfirmation(ids),
      suggestion: "What's the price of ETH?",
    };
  }

  /**
   * Call when wallet connection succeeds.
   * Returns the "wallet connected" message with balance info.
   */
  onWalletConnected(address: string, balance: string): OnboardingMessage | null {
    if (this.state.step !== 'connect_wallet') return null;

    this.state.step = 'first_read';
    this.state.walletConnected = true;
    this.state.walletAddress = address;
    this.state.lastInteraction = Date.now();
    saveState(this.state);

    return {
      text: WALLET_CONNECTED_MESSAGE(address, balance),
      suggestion: "What's trending on Base?",
    };
  }

  /**
   * Call after the agent successfully completes a read operation.
   * Returns the "try a write" message if we're on that step.
   */
  onReadComplete(): OnboardingMessage | null {
    if (this.state.step !== 'first_read') return null;

    this.state.step = 'first_write';
    this.state.firstReadDone = true;
    this.state.lastInteraction = Date.now();
    saveState(this.state);

    return {
      text: FIRST_READ_DONE_MESSAGE,
      suggestion: 'Swap 0.001 ETH for USDC',
    };
  }

  /**
   * Call after the agent successfully completes a write operation
   * (user approved the transaction).
   */
  onWriteComplete(): OnboardingMessage | null {
    if (this.state.step !== 'first_write') return null;

    this.state.step = 'complete';
    this.state.firstWriteDone = true;
    this.state.completedAt = Date.now();
    this.state.lastInteraction = Date.now();
    saveState(this.state);

    return {
      text: FIRST_WRITE_DONE_MESSAGE,
      final: true,
    };
  }

  /**
   * Process an incoming message and return any onboarding-specific
   * response. Returns null if no onboarding action is needed.
   */
  processMessage(message: string): OnboardingMessage | null {
    // Only intervene during active onboarding
    if (!this.isActive) return null;

    // Only intercept on the welcome step (first-ever message triggers the welcome).
    // All other onboarding steps are driven by slash commands
    // (/professional, /degen, /all, /skip, etc.) which are registered as
    // OpenClaw commands and call back into this flow directly.
    // Free-form text during onboarding passes through to the LLM normally.
    if (this.state.step === 'welcome') {
      return this.getWelcomeMessage();
    }

    return null;
  }

  /**
   * Determine if the agent should trigger an onboarding response
   * after a tool call completes. Hook into after_tool_call.
   */
  processToolResult(toolName: string, success: boolean): OnboardingMessage | null {
    if (!this.isActive || !success) return null;

    // Read tools advance from first_read → first_write
    const readTools = ['defi_price', 'market_intel', 'defi_balance', 'clawnch_info'];
    if (this.state.step === 'first_read' && readTools.includes(toolName)) {
      return this.onReadComplete();
    }

    // Write tools advance from first_write → complete
    const writeTools = ['defi_swap', 'transfer', 'liquidity', 'clawnch_launch'];
    if (this.state.step === 'first_write' && writeTools.includes(toolName)) {
      return this.onWriteComplete();
    }

    return null;
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

const flows = new Map<string, OnboardingFlow>();

/**
 * Get (or create) the onboarding flow for a user.
 * The userId should be the Telegram user ID.
 */
export function getOnboardingFlow(userId: string): OnboardingFlow {
  let flow = flows.get(userId);
  if (!flow) {
    flow = new OnboardingFlow(userId);
    flows.set(userId, flow);
  }
  return flow;
}

/**
 * Check if a user is new (no persisted state).
 */
export function isNewUser(userId: string): boolean {
  return loadState(userId) === null;
}

/**
 * Clear in-memory flow cache. Used in tests.
 */
export function resetOnboardingFlows(): void {
  flows.clear();
}
