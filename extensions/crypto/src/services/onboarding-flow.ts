/**
 * Teleost Bot Onboarding Flow — first-run tutorial state machine.
 *
 * Detects new users and walks them through:
 * 1. Welcome + wallet connect (WalletConnect link)
 * 2. Show balance, explain capabilities
 * 3. Guided first read action ("What's trending?")
 * 4. Guided first write action ("Swap 0.001 ETH for USDC") + explain approval
 * 5. Command reference card
 *
 * State persists on volume so interrupted tutorials resume.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────

export type OnboardingStep =
  | 'welcome'
  | 'connect_wallet'
  | 'wallet_connected'
  | 'first_read'
  | 'first_write'
  | 'complete'
  | 'skipped';

export interface OnboardingState {
  userId: string;
  step: OnboardingStep;
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
  /** If true, include WalletConnect link */
  showQr?: boolean;
  /** Suggested next action for the user */
  suggestion?: string;
  /** If true, this is the last onboarding message */
  final?: boolean;
}

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

// ── Welcome Messages ────────────────────────────────────────────────────────

const WELCOME_MESSAGE = `Hey! I'm your personal DeFi agent.

I can check token prices, track your portfolio, execute swaps, manage liquidity positions, and monitor the market — all from this chat.

But first, let's connect your wallet so I can see your balances and propose transactions for you to approve.

Tap the link below to connect your wallet app (MetaMask, Rainbow, Coinbase Wallet, etc.)`;

const WALLET_CONNECTED_MESSAGE = (address: string, balance: string) =>
  `Wallet connected! ${address.slice(0, 6)}...${address.slice(-4)}
Balance: ${balance}

Here's what I can do:

  - Check token prices and trending coins
  - Show your full portfolio
  - Execute swaps (you approve on your phone)
  - Track on-chain activity
  - Set conditional orders and alerts

Let's try something. Ask me:
"What's trending on Base?"`;

const FIRST_READ_DONE_MESSAGE = `Nice! That's how read operations work — instant, no wallet approval needed.

Now let's try a write operation. Say:
"Swap 0.001 ETH for USDC"

I'll show you the quote, then you'll get a notification on your phone wallet to approve (or reject) the transaction. You're always in control.`;

const FIRST_WRITE_DONE_MESSAGE = `You've got it! Every transaction needs your explicit approval on your wallet app. I propose, you decide.

Here's your command reference:

/connect    — Reconnect your wallet
/wallet     — Balance and wallet info
/portfolio  — Full token portfolio
/tx         — Recent transactions
/policy     — Manage spending policies
/help       — All available commands

You're all set. Just talk to me naturally — "What's the price of ETH?", "Show my portfolio", "Send 10 USDC to 0x...", or anything else.`;

const SKIP_MESSAGE = `Tutorial skipped. You can use /connect to pair your wallet anytime.

Quick reference:
/connect — Pair wallet  |  /wallet — Balances
/portfolio — Holdings   |  /tx — History
/policy — Auto-approve  |  /help — All commands`;

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

    this.state.step = 'connect_wallet';
    this.state.lastInteraction = Date.now();
    saveState(this.state);

    return {
      text: WELCOME_MESSAGE,
      showQr: true,
      suggestion: 'Tap the wallet connect link',
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

    // If waiting for wallet connect, nudge
    if (this.state.step === 'connect_wallet') {
      if (lower.includes('/connect')) {
        return null; // let the connect command handle it
      }
      return {
        text: "Let's connect your wallet first. Tap the link above, or type /connect for a new one.",
        showQr: true,
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
