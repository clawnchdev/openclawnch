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
import {
  generateWallet,
  encryptAndStore,
  getConfirmationWords,
  validateConfirmation,
  getStorageInfo,
} from './keychain-wallet.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type OnboardingStep =
  | 'welcome'
  | 'choose_persona'
  | 'choose_capabilities'
  | 'connect_wallet'
  | 'create_wallet_confirm'   // Show mnemonic, await 3-word confirmation
  | 'create_wallet_password'  // Await password for encryption
  | 'import_wallet_mnemonic'  // Await mnemonic paste
  | 'import_wallet_password'  // Await password for encryption
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
  /** Transient: mnemonic during wallet creation (never persisted to disk). */
  _pendingMnemonic?: string;
  /** Transient: confirmation words the user must verify. */
  _pendingConfirmation?: Array<{ index: number; word: string }>;
  /** Transient: imported mnemonic awaiting password. */
  _pendingImportMnemonic?: string;
}

export interface OnboardingMessage {
  text: string;
  /** Markdown format hint (channels that support it will render accordingly) */
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
    deployRequirement: 'HUMMINGBOT_API_URL',
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
  // Strip transient fields (mnemonics) — NEVER persist to disk
  const { _pendingMnemonic, _pendingConfirmation, _pendingImportMnemonic, ...persistable } = state;
  writeFileSync(statePath(state.userId), JSON.stringify(persistable, null, 2), 'utf8');
}

// ── Messages ────────────────────────────────────────────────────────────────

const WELCOME_MESSAGE = `OpenClawnch — personal DeFi agent. I handle real money on-chain, connected to your mobile wallet for approval on every transaction.

Pick a communication style to get started:

  /professional — Clear and business-like
  /degen — CT native energy
  /chill — Like texting a friend
  /technical — Data-heavy, on-chain metrics
  /mentor — Educational, explains as it goes

Or type your own preferred tone (10+ characters).

Explore what I can do:
  /help trading — Swaps, limit orders, DCA, leverage
  /help defi — Lending, staking, yield, liquidity
  /help portfolio — Balances, cost basis, tracking
  /help tools — User-defined tools, API connectors
  /help agents — Multi-agent delegation
  /help — Full command list

/skip — Jump straight in`;

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
  if (!c.deployRequirement) return '';
  const envVal = process.env[c.deployRequirement];
  if (envVal && envVal.length > 0) return '';
  return `(needs ${c.deployRequirement} — see /setup)`;
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
      `  - ${c.name} — requires ${c.deployRequirement}\n    Set this environment variable in your deploy config.`
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

const FIRST_WRITE_DONE_MESSAGE = `Transaction confirmed. Every write operation goes to your wallet for approval.

Setup complete. Explore what I can do:
  /help trading — Swaps, orders, DCA, leverage
  /help defi — Lending, staking, yield, bridging
  /help portfolio — Balances, prices, tracking
  /help — Full command list

Or just talk to me — "What's the price of ETH?", "Show my portfolio", "Send 10 USDC to 0x..."`;


const SKIP_MESSAGE = `Onboarding skipped. Use /help to explore commands, or /help <category> for specifics:
  trading, defi, portfolio, automation, wallet, fiat, tools, agents

  /connect — Pair wallet  |  /help — Full command list`;

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
  if (message.trim().length >= 10) {
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
    if (this.state.step === 'complete' || this.state.step === 'skipped') return false;

    // Auto-skip onboarding if the user has been stuck for more than 7 days.
    // Prevents permanently "active" onboarding from interfering with normal
    // agent operation (e.g., the after_tool_call hook suppressing LLM responses).
    const ONBOARDING_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    if (Date.now() - this.state.startedAt > ONBOARDING_TIMEOUT_MS) {
      this.state.step = 'skipped';
      this.state.lastInteraction = Date.now();
      saveState(this.state);
      return false;
    }

    return true;
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

  /**
   * Navigate back one step during onboarding.
   * choose_capabilities → choose_persona
   * connect_wallet → choose_capabilities
   * first_read → connect_wallet
   * Returns null if /back isn't applicable at the current step.
   */
  back(): OnboardingMessage | null {
    const step = this.state.step;

    if (step === 'choose_capabilities') {
      this.state.step = 'choose_persona';
      this.state.lastInteraction = Date.now();
      saveState(this.state);
      return {
        text: 'Pick a communication style:\n\n  /professional — Clear and business-like\n  /degen — CT native energy\n  /chill — Like texting a friend\n  /technical — Data-heavy, on-chain metrics\n  /mentor — Educational, explains as it goes\n\nOr type your own preferred tone (10+ characters).',
        suggestion: 'Tap a style or describe your own',
      };
    }

    if (step === 'connect_wallet') {
      this.state.step = 'choose_capabilities';
      this.state.selectedCapabilities = undefined;
      this.state.lastInteraction = Date.now();
      saveState(this.state);
      return {
        text: buildPersonaConfirmation(this.state.persona ?? 'professional', this.state.customPersona),
        suggestion: 'Reply with numbers (e.g. "1, 2, 3") or "all"',
      };
    }

    if (step === 'first_read') {
      this.state.step = 'connect_wallet';
      this.state.lastInteraction = Date.now();
      saveState(this.state);
      return {
        text: 'Choose how to connect a wallet:\n\n  /create_wallet — Generate a new wallet (stored locally, encrypted)\n  /import_wallet — Import from a 12/24-word seed phrase\n  /connect — Connect MetaMask, Rainbow, Coinbase Wallet, etc. via WalletConnect\n  /connect_bankr — Use Bankr custodial wallet (zero setup)',
        suggestion: 'Tap /create_wallet to get started or /connect for an existing wallet',
      };
    }

    return null;
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

      const walletOptions = `\n\nChoose how to connect a wallet:\n\n  /create_wallet — Generate a new wallet (stored locally, encrypted)\n  /import_wallet — Import from a 12/24-word seed phrase\n  /connect — Connect MetaMask, Rainbow, Coinbase Wallet, etc. via WalletConnect\n  /connect_bankr — Use Bankr custodial wallet (zero setup)`;

      return {
        text: buildCapabilitiesConfirmation(ids) + walletOptions,
        showConnectLink: true,
        suggestion: 'Tap /create_wallet to get started or /connect for an existing wallet',
      };
    }

    this.state.step = 'first_read';
    saveState(this.state);

    return {
      text: buildCapabilitiesConfirmation(ids),
      suggestion: "What's the price of ETH?",
    };
  }

  // ── Local Wallet Creation Flow ────────────────────────────────────────

  /**
   * Start the "Create new wallet" flow. Generates a mnemonic and shows it.
   */
  async onCreateWallet(): Promise<OnboardingMessage | null> {
    if (this.state.step !== 'connect_wallet') return null;

    const wallet = await generateWallet();
    const confirmWords = getConfirmationWords(wallet.mnemonic);

    // Store transiently in memory (never persisted to disk)
    this.state._pendingMnemonic = wallet.mnemonic;
    this.state._pendingConfirmation = confirmWords;
    this.state.step = 'create_wallet_confirm';
    this.state.lastInteraction = Date.now();
    // Save step but NOT the mnemonic (strip transient fields)
    saveState(this.state);

    const words = wallet.mnemonic.split(' ');
    const wordGrid = words.map((w, i) => `  ${String(i + 1).padStart(2, ' ')}. ${w}`).join('\n');

    const confirmPrompt = confirmWords
      .map(c => `Word #${c.index}`)
      .join(', ');

    return {
      text: `New wallet generated.\n\nAddress: \`${wallet.address}\`\n\nWrite down these 12 words — this is your only chance:\n\n${wordGrid}\n\nTo confirm you've saved them, type the following words separated by spaces:\n${confirmPrompt}`,
    };
  }

  /**
   * Process mnemonic confirmation words during wallet creation.
   */
  async onConfirmMnemonic(message: string): Promise<OnboardingMessage | null> {
    if (this.state.step !== 'create_wallet_confirm') return null;
    if (!this.state._pendingMnemonic || !this.state._pendingConfirmation) {
      // Lost transient state (e.g. process restart) — restart creation
      this.state.step = 'connect_wallet';
      saveState(this.state);
      return {
        text: 'Wallet creation was interrupted (the previous mnemonic is no longer available). Run /create_wallet to generate a new wallet.',
      };
    }

    // Parse user's confirmation words
    const userWords = message.trim().split(/\s+/);
    const expected = this.state._pendingConfirmation;

    // Build confirmation array matching expected format
    const confirmations = expected.map((exp, i) => ({
      index: exp.index,
      word: userWords[i] ?? '',
    }));

    if (!validateConfirmation(this.state._pendingMnemonic, confirmations)) {
      const retryPrompt = expected.map(c => `Word #${c.index}`).join(', ');
      return {
        text: `Incorrect. Please type the correct words for: ${retryPrompt}`,
      };
    }

    // Confirmed — ask for password
    this.state.step = 'create_wallet_password';
    this.state.lastInteraction = Date.now();
    saveState(this.state);

    return {
      text: 'Mnemonic confirmed. Now set a password to encrypt your wallet (minimum 8 characters).\n\nThis password will be required to unlock your wallet each session.\n\n⚠️ Your password will be visible in chat history. Delete the message after sending.',
    };
  }

  /**
   * Process password during wallet creation — encrypt and store.
   */
  async onSetWalletPassword(password: string): Promise<OnboardingMessage | null> {
    if (this.state.step !== 'create_wallet_password') return null;
    if (!this.state._pendingMnemonic) {
      this.state.step = 'connect_wallet';
      saveState(this.state);
      return { text: 'Wallet creation was interrupted (the previous mnemonic is no longer available). Run /create_wallet to generate a new wallet.' };
    }

    if (password.length < 8) {
      return { text: 'Password must be at least 8 characters. Try again.' };
    }

    try {
      await encryptAndStore(this.state._pendingMnemonic, password);
      const { mnemonicToAccount } = await import('viem/accounts');
      const account = mnemonicToAccount(this.state._pendingMnemonic);
      const address = account.address;
      const storage = getStorageInfo();

      // Clear transient mnemonic from memory
      this.state._pendingMnemonic = undefined;
      this.state._pendingConfirmation = undefined;
      this.state.step = 'first_read';
      this.state.walletConnected = true;
      this.state.walletAddress = address;
      this.state.lastInteraction = Date.now();
      saveState(this.state);

      const storageDesc = storage.backend === 'keychain'
        ? 'macOS Keychain'
        : `encrypted file (${storage.path})`;

      return {
        text: `Wallet created and encrypted.\n\nAddress: \`${address}\`\nStorage: ${storageDesc}\n\nSend ETH or USDC to this address to get started.\n\nTry a read operation: "What's the price of ETH?"`,
        suggestion: "What's the price of ETH?",
      };
    } catch (err) {
      return {
        text: `Failed to encrypt wallet: ${err instanceof Error ? err.message : String(err)}. Try again.`,
      };
    }
  }

  /**
   * Start the "Import existing wallet" flow — prompt for mnemonic.
   */
  onImportWallet(): OnboardingMessage | null {
    if (this.state.step !== 'connect_wallet') return null;

    this.state.step = 'import_wallet_mnemonic';
    this.state.lastInteraction = Date.now();
    saveState(this.state);

    return {
      text: 'Paste your 12 or 24-word seed phrase (BIP-39 mnemonic).\n\nThe phrase is processed locally and never stored in plaintext.\n\n⚠️ Your seed phrase will be visible in chat history. Delete the message immediately after sending.',
    };
  }

  /**
   * Process imported mnemonic — validate and ask for password.
   */
  async onImportMnemonic(message: string): Promise<OnboardingMessage | null> {
    if (this.state.step !== 'import_wallet_mnemonic') return null;

    const words = message.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      return {
        text: `Expected 12 or 24 words, got ${words.length}. Please paste a valid BIP-39 mnemonic.`,
      };
    }

    // Validate by deriving an account
    try {
      const { mnemonicToAccount } = await import('viem/accounts');
      const account = mnemonicToAccount(words.join(' '));

      this.state._pendingImportMnemonic = words.join(' ');
      this.state.step = 'import_wallet_password';
      this.state.lastInteraction = Date.now();
      saveState(this.state);

      return {
        text: `Valid mnemonic. Derived address: \`${account.address}\`\n\nSet a password to encrypt this wallet (minimum 8 characters).`,
        suggestion: 'Type a strong password',
      };
    } catch (err) {
      return {
        text: `Invalid mnemonic: ${err instanceof Error ? err.message : String(err)}. Please try again.`,
      };
    }
  }

  /**
   * Process password during import — encrypt and store.
   */
  async onImportPassword(password: string): Promise<OnboardingMessage | null> {
    if (this.state.step !== 'import_wallet_password') return null;
    if (!this.state._pendingImportMnemonic) {
      this.state.step = 'connect_wallet';
      saveState(this.state);
      return { text: 'Import was interrupted. Please try /import_wallet again.' };
    }

    if (password.length < 8) {
      return { text: 'Password must be at least 8 characters. Try again.' };
    }

    try {
      await encryptAndStore(this.state._pendingImportMnemonic, password);
      const { mnemonicToAccount } = await import('viem/accounts');
      const account = mnemonicToAccount(this.state._pendingImportMnemonic);
      const address = account.address;
      const storage = getStorageInfo();

      // Clear transient mnemonic from memory
      this.state._pendingImportMnemonic = undefined;
      this.state.step = 'first_read';
      this.state.walletConnected = true;
      this.state.walletAddress = address;
      this.state.lastInteraction = Date.now();
      saveState(this.state);

      const storageDesc = storage.backend === 'keychain'
        ? 'macOS Keychain'
        : `encrypted file (${storage.path})`;

      return {
        text: `Wallet imported and encrypted.\n\nAddress: \`${address}\`\nStorage: ${storageDesc}\n\nTry a read operation: "What's the price of ETH?"`,
        suggestion: "What's the price of ETH?",
      };
    } catch (err) {
      return {
        text: `Failed to encrypt wallet: ${err instanceof Error ? err.message : String(err)}. Try again.`,
      };
    }
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
  processMessage(message: string): OnboardingMessage | null | Promise<OnboardingMessage | null> {
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

    // Wallet creation steps intercept free-form text (password, mnemonic, confirmation)
    if (this.state.step === 'create_wallet_confirm') {
      return this.onConfirmMnemonic(message);
    }
    if (this.state.step === 'create_wallet_password') {
      return this.onSetWalletPassword(message);
    }
    if (this.state.step === 'import_wallet_mnemonic') {
      return this.onImportMnemonic(message);
    }
    if (this.state.step === 'import_wallet_password') {
      return this.onImportPassword(message);
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
    const readTools = [
      'defi_price', 'market_intel', 'defi_balance', 'clawnch_info',
      'analytics', 'herd_intelligence', 'block_explorer', 'watch_activity',
      'cost_basis', 'clawnch_fees',
    ];
    if (this.state.step === 'first_read' && readTools.includes(toolName)) {
      return this.onReadComplete();
    }

    // Write tools advance from first_write → complete
    const writeTools = [
      'defi_swap', 'transfer', 'liquidity', 'clawnch_launch',
      'bridge', 'permit2', 'defi_lend', 'defi_stake',
      'compound_action', 'manage_orders',
    ];
    if (this.state.step === 'first_write' && writeTools.includes(toolName)) {
      return this.onWriteComplete();
    }

    return null;
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

const flows = new Map<string, OnboardingFlow>();
const MAX_FLOWS = 500; // Prevent unbounded memory growth

/**
 * Get (or create) the onboarding flow for a user.
 * The userId should be the sender ID from any channel (Telegram, Discord, etc.).
 */
export function getOnboardingFlow(userId: string): OnboardingFlow {
  let flow = flows.get(userId);
  if (!flow) {
    // Evict completed/inactive flows when approaching limit
    if (flows.size >= MAX_FLOWS) {
      for (const [id, f] of flows) {
        if (!f.isActive) flows.delete(id);
      }
      // If still over limit, evict oldest entries
      if (flows.size >= MAX_FLOWS) {
        const toDelete = flows.size - MAX_FLOWS + 50; // free 50 slots
        let deleted = 0;
        for (const id of flows.keys()) {
          if (deleted >= toDelete) break;
          flows.delete(id);
          deleted++;
        }
      }
    }
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
