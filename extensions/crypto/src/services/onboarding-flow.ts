/**
 * OpenClawnch Onboarding Flow — first-run tutorial state machine.
 *
 * Detects new users and walks them through:
 * 1. Welcome — professional greeting with capabilities overview
 * 2. Persona selection — choose communication style (professional, degen, chill, etc.)
 * 3. Capabilities selection — pick which features to enable, see requirements
 * 4. Guided setup — walk through API key / config for selected capabilities
 * 5. Wallet connect — pair a mobile wallet via deep link
 * 6. First read action — try a read-only query
 * 7. First write action — try a transaction (user approves on phone)
 * 8. Complete — command reference card
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
  | 'guided_setup'
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
  /** Env vars or config needed. Empty = works out of the box. */
  requirements: { name: string; description: string; howToGet: string }[];
}

export interface OnboardingState {
  userId: string;
  step: OnboardingStep;
  /** Selected persona ID, or 'custom' with customPersona text. */
  persona?: PersonaId;
  customPersona?: string;
  /** Selected capability category IDs. */
  selectedCapabilities?: string[];
  /** Tracks which capability setups have been completed. */
  completedSetups?: string[];
  /** Index into selectedCapabilities for guided_setup step. */
  setupIndex?: number;
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
    requirements: [
      {
        name: 'WALLETCONNECT_PROJECT_ID',
        description: 'WalletConnect cloud project ID for mobile wallet pairing',
        howToGet: 'Sign up at cloud.walletconnect.com, create a project, and copy the Project ID.',
      },
    ],
  },
  {
    id: 'prices',
    name: 'Prices & Market Data',
    description: 'Real-time token prices, trending coins, market intelligence.',
    tools: ['defi_price', 'market_intel', 'herd_intelligence', 'analytics'],
    requirements: [], // Works out of the box
  },
  {
    id: 'portfolio',
    name: 'Portfolio & Balance Tracking',
    description: 'View balances, track cost basis, and monitor your positions.',
    tools: ['defi_balance', 'cost_basis', 'watch_activity', 'block_explorer'],
    requirements: [], // Works with wallet connection
  },
  {
    id: 'trading',
    name: 'DEX Trading & Swaps',
    description: 'Execute token swaps via DEX aggregators with best-price routing.',
    tools: ['defi_swap', 'manage_orders', 'crypto_workflow'],
    requirements: [], // Needs wallet (covered by wallet category)
  },
  {
    id: 'liquidity',
    name: 'Liquidity Provision',
    description: 'Manage Uniswap V3/V4 liquidity positions, add/remove liquidity.',
    tools: ['liquidity'],
    requirements: [], // Needs wallet
  },
  {
    id: 'launchpad',
    name: 'Token Launchpad (Clawnch)',
    description: 'Launch new tokens on Base with Uniswap V4 pools and manage fee revenue.',
    tools: ['clawnch_launch', 'clawnch_fees', 'clawnch_info'],
    requirements: [], // Needs wallet
  },
  {
    id: 'bridge',
    name: 'Cross-Chain Bridge',
    description: 'Bridge tokens across Ethereum, Base, Arbitrum, Optimism, and other chains.',
    tools: ['bridge'],
    requirements: [], // Needs wallet
  },
  {
    id: 'routing',
    name: 'Smart Routing (Wayfinder)',
    description: 'AI-powered route optimization across chains and protocols.',
    tools: ['wayfinder'],
    requirements: [], // Works out of the box
  },
  {
    id: 'clawnx',
    name: 'ClawnX Protocol',
    description: 'Interact with the ClawnX decentralized exchange protocol.',
    tools: ['clawnx'],
    requirements: [], // Needs wallet
  },
  {
    id: 'hummingbot',
    name: 'Market Making (Hummingbot)',
    description: 'Automated market making and trading bot management.',
    tools: ['hummingbot'],
    requirements: [
      {
        name: 'HUMMINGBOT_URL',
        description: 'URL of your running Hummingbot instance',
        howToGet: 'Install Hummingbot (hummingbot.org), start it, and use the API URL (typically http://localhost:15888).',
      },
    ],
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

function statePath(userId: string): string {
  return join(getStateDir(), `${userId}.json`);
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

const WELCOME_MESSAGE = `Welcome. I'm your personal DeFi agent — an AI assistant with direct access to blockchain protocols, market data, and transaction execution.

Here's what I can do:

  Wallet & Transactions — Connect your phone wallet, send tokens, approve txs
  Prices & Market Data — Real-time prices, trending tokens, market analysis
  Portfolio Tracking — Balances, cost basis, on-chain activity
  DEX Trading — Token swaps via aggregators with best-price routing
  Liquidity — Manage Uniswap V3/V4 positions
  Token Launchpad — Deploy new tokens on Base
  Cross-Chain Bridge — Move assets between chains
  Smart Routing — AI-optimized multi-chain routes
  Market Making — Automated trading via Hummingbot

Before we begin, I'd like to know how you prefer me to communicate.

Pick a style (reply with the number, name, or describe your own):

  1. Professional — Clear, concise, business-like
  2. Degen — CT native, crypto twitter energy
  3. Chill — Relaxed, like texting a friend
  4. Technical — Data-heavy, on-chain metrics
  5. Mentor — Educational, explains as it goes

Or just describe the tone you want in your own words.`;

function buildPersonaConfirmation(persona: PersonaId, customText?: string): string {
  if (persona === 'custom') {
    return `Got it. I'll communicate in your preferred style: "${customText}"

Now let's set up your capabilities. Which of these would you like to enable?

Reply with the numbers (e.g. "1, 2, 3, 5") or "all" for everything:

${buildCapabilitiesList()}`;
  }

  const p = PERSONAS.find(p => p.id === persona);
  const label = p?.label.replace(/^\d+\.\s*/, '') ?? persona;
  return `${label} mode selected.

Now let's set up your capabilities. Which of these would you like to enable?

Reply with the numbers (e.g. "1, 2, 3, 5") or "all" for everything:

${buildCapabilitiesList()}`;
}

function buildCapabilitiesList(): string {
  return CAPABILITIES.map((c, i) => {
    const reqs = c.requirements.length > 0
      ? ` (requires setup)`
      : ` (works immediately)`;
    return `  ${i + 1}. ${c.name}${reqs}\n     ${c.description}`;
  }).join('\n\n');
}

function buildSetupMessage(category: CapabilityCategory): string {
  if (category.requirements.length === 0) {
    return `${category.name} — No setup needed. This works out of the box.`;
  }

  const reqs = category.requirements.map(r =>
    `  ${r.name}\n  ${r.description}\n  How to get it: ${r.howToGet}`
  ).join('\n\n');

  return `Setting up: ${category.name}

This feature requires the following:

${reqs}

If you have the value ready, paste it now. If not, reply "skip" to set this up later, or "done" if it's already configured.`;
}

function buildSetupCompleteMessage(selectedIds: string[]): string {
  const walletNeeded = selectedIds.some(id =>
    ['wallet', 'trading', 'liquidity', 'launchpad', 'bridge', 'clawnx'].includes(id)
  );

  if (walletNeeded) {
    return `Configuration complete. Your selected capabilities are ready.

Next step: connect your wallet. This lets me see your balances and propose transactions for you to approve on your phone.

Tap the link below to connect your wallet app (MetaMask, Rainbow, Coinbase Wallet, etc.), or type /connect.`;
  }

  return `Configuration complete. Your selected capabilities are ready.

You can connect a wallet later with /connect if you want transaction capabilities.

Try asking me something — for example: "What's the price of ETH?" or "What's trending on Base?"`;
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
  /connect    — Reconnect wallet
  /wallet     — Balance and wallet info
  /portfolio  — Full token portfolio
  /tx         — Recent transactions
  /policy     — Manage spending policies
  /help       — All available commands

Setup complete. Talk to me naturally — "What's the price of ETH?", "Show my portfolio", "Send 10 USDC to 0x...", or anything else.`;

const SKIP_MESSAGE = `Onboarding skipped. You can configure everything later:
  /connect — Pair wallet  |  /wallet — Balances
  /portfolio — Holdings   |  /tx — History
  /policy — Auto-approve  |  /help — All commands`;

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
        text: 'Please pick a communication style (1-5) or describe the tone you want in your own words.',
        suggestion: 'Reply with a number or describe your preferred style',
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
   */
  onCapabilitiesSelected(message: string): OnboardingMessage | null {
    if (this.state.step !== 'choose_capabilities') return null;

    const ids = parseCapabilityChoice(message);
    if (!ids) {
      return {
        text: `Reply with the numbers of the capabilities you want (e.g. "1, 2, 3, 5") or "all" for everything.\n\n${buildCapabilitiesList()}`,
        suggestion: 'Reply with numbers or "all"',
      };
    }

    this.state.selectedCapabilities = ids;
    this.state.completedSetups = [];
    this.state.lastInteraction = Date.now();

    // Find capabilities that need setup
    const needsSetup = ids
      .map(id => CAPABILITIES.find(c => c.id === id))
      .filter((c): c is CapabilityCategory => c != null && c.requirements.length > 0);

    if (needsSetup.length > 0) {
      this.state.step = 'guided_setup';
      this.state.setupIndex = 0;
      saveState(this.state);

      const first = needsSetup[0]!;
      return {
        text: `Selected ${ids.length} capabilities. ${needsSetup.length} need configuration.\n\n${buildSetupMessage(first)}`,
        suggestion: 'Paste the value, or reply "skip" to set up later',
      };
    }

    // No setup needed — go straight to wallet connect or complete
    const walletNeeded = ids.some(id =>
      ['wallet', 'trading', 'liquidity', 'launchpad', 'bridge', 'clawnx'].includes(id)
    );

    if (walletNeeded) {
      this.state.step = 'connect_wallet';
      saveState(this.state);

      return {
        text: buildSetupCompleteMessage(ids),
        showConnectLink: true,
        suggestion: 'Tap the link to connect your wallet',
      };
    }

    this.state.step = 'first_read';
    saveState(this.state);

    return {
      text: buildSetupCompleteMessage(ids),
      suggestion: "What's the price of ETH?",
    };
  }

  /**
   * Process a guided setup response (API key paste, "skip", or "done").
   */
  onSetupResponse(message: string): OnboardingMessage | null {
    if (this.state.step !== 'guided_setup') return null;

    const lower = message.toLowerCase().trim();
    const selectedIds = this.state.selectedCapabilities ?? [];
    const needsSetup = selectedIds
      .map(id => CAPABILITIES.find(c => c.id === id))
      .filter((c): c is CapabilityCategory => c != null && c.requirements.length > 0);

    const currentIndex = this.state.setupIndex ?? 0;

    // Record completion (skip or done or pasted value)
    if (currentIndex < needsSetup.length) {
      const current = needsSetup[currentIndex]!;
      if (lower !== 'skip') {
        this.state.completedSetups = [...(this.state.completedSetups ?? []), current.id];
      }
    }

    // Move to next capability that needs setup
    const nextIndex = currentIndex + 1;
    if (nextIndex < needsSetup.length) {
      this.state.setupIndex = nextIndex;
      this.state.lastInteraction = Date.now();
      saveState(this.state);

      return {
        text: buildSetupMessage(needsSetup[nextIndex]!),
        suggestion: 'Paste the value, or reply "skip"',
      };
    }

    // All setups done — move to wallet connect or first read
    this.state.lastInteraction = Date.now();

    const walletNeeded = selectedIds.some(id =>
      ['wallet', 'trading', 'liquidity', 'launchpad', 'bridge', 'clawnx'].includes(id)
    );

    if (walletNeeded) {
      this.state.step = 'connect_wallet';
      saveState(this.state);

      return {
        text: buildSetupCompleteMessage(selectedIds),
        showConnectLink: true,
        suggestion: 'Tap the link to connect your wallet',
      };
    }

    this.state.step = 'first_read';
    saveState(this.state);

    return {
      text: buildSetupCompleteMessage(selectedIds),
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
    const lower = message.toLowerCase().trim();

    // Handle skip at any point
    if (lower === '/skip-tutorial' || lower === '/skip') {
      return this.skip();
    }

    // Only intervene during active onboarding
    if (!this.isActive) return null;

    // If still on welcome step, send the welcome
    if (this.state.step === 'welcome') {
      return this.getWelcomeMessage();
    }

    // Persona selection step
    if (this.state.step === 'choose_persona') {
      return this.onPersonaSelected(message);
    }

    // Capability selection step
    if (this.state.step === 'choose_capabilities') {
      return this.onCapabilitiesSelected(message);
    }

    // Guided setup step
    if (this.state.step === 'guided_setup') {
      return this.onSetupResponse(message);
    }

    // If waiting for wallet connect, nudge
    if (this.state.step === 'connect_wallet') {
      if (lower.includes('/connect')) {
        return null; // let the connect command handle it
      }
      return {
        text: "Let's connect your wallet first. Tap the link above, or type /connect for a new one.",
        showConnectLink: true,
      };
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
