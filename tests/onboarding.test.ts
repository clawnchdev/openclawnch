/**
 * Tests for the OpenClawnch Onboarding Flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OnboardingFlow,
  isNewUser,
  PERSONAS,
  CAPABILITIES,
  type OnboardingStep,
} from '../extensions/crypto/src/services/onboarding-flow.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Use a temp directory for test state
const TEST_DIR = join(__dirname, '..', '.test-onboarding');

beforeEach(() => {
  // Set env so onboarding state goes to test dir
  process.env.OPENCLAWNCH_TX_DIR = join(TEST_DIR, 'tx');
  mkdirSync(join(TEST_DIR, 'tx'), { recursive: true });
});

afterEach(() => {
  // Clean up test state
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  delete process.env.OPENCLAWNCH_TX_DIR;
});

// ── Helper: advance flow through persona + capabilities to reach connect_wallet ──
function advanceToConnectWallet(flow: OnboardingFlow): void {
  flow.getWelcomeMessage(); // welcome → choose_persona
  flow.onPersonaSelected('1'); // choose_persona → choose_capabilities
  flow.onCapabilitiesSelected('1, 2, 3'); // wallet selected → connect_wallet (no guided_setup)
}

// ── Helper: advance flow through persona + capabilities to reach first_read (no wallet) ──
function advanceToFirstRead(flow: OnboardingFlow): void {
  flow.getWelcomeMessage();
  flow.onPersonaSelected('3'); // chill
  flow.onCapabilitiesSelected('2'); // prices only, no wallet needed → first_read
}

describe('OnboardingFlow', () => {
  // ── Welcome Step ──────────────────────────────────────────────────────

  it('starts at welcome step for new users', () => {
    const flow = new OnboardingFlow('test-user-1');
    expect(flow.currentStep).toBe('welcome');
    expect(flow.isActive).toBe(true);
  });

  it('sends welcome message on first interaction', () => {
    const flow = new OnboardingFlow('test-user-2');
    const msg = flow.getWelcomeMessage();

    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('DeFi agent');
    expect(msg!.text).toContain('/professional');
    expect(msg!.text).toContain('/degen');
    expect(msg!.text).toContain('/chill');
    expect(flow.currentStep).toBe('choose_persona');
  });

  it('only sends welcome once', () => {
    const flow = new OnboardingFlow('test-user-3');
    flow.getWelcomeMessage();
    const msg2 = flow.getWelcomeMessage();
    expect(msg2).toBeNull();
  });

  // ── Persona Selection ─────────────────────────────────────────────────

  it('accepts persona by number', () => {
    const flow = new OnboardingFlow('test-persona-num');
    flow.getWelcomeMessage();

    const msg = flow.onPersonaSelected('1');
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('Professional');
    expect(msg!.text).toContain('capabilities');
    expect(flow.currentStep).toBe('choose_capabilities');
    expect(flow.getState().persona).toBe('professional');
  });

  it('accepts persona by name', () => {
    const flow = new OnboardingFlow('test-persona-name');
    flow.getWelcomeMessage();

    const msg = flow.onPersonaSelected('degen');
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('Degen');
    expect(flow.getState().persona).toBe('degen');
  });

  it('accepts custom persona description', () => {
    const flow = new OnboardingFlow('test-persona-custom');
    flow.getWelcomeMessage();

    const msg = flow.onPersonaSelected('Talk like a pirate who knows DeFi');
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('preferred style');
    expect(flow.getState().persona).toBe('custom');
    expect(flow.getState().customPersona).toBe('Talk like a pirate who knows DeFi');
  });

  it('rejects too-short persona input', () => {
    const flow = new OnboardingFlow('test-persona-short');
    flow.getWelcomeMessage();

    const msg = flow.onPersonaSelected('hi');
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('Pick a communication style');
    expect(flow.currentStep).toBe('choose_persona');
  });

  it('does nothing if not on choose_persona step', () => {
    const flow = new OnboardingFlow('test-persona-wrong-step');
    // Still on welcome, not choose_persona
    const msg = flow.onPersonaSelected('1');
    expect(msg).toBeNull();
  });

  // ── Capability Selection ──────────────────────────────────────────────

  it('accepts capabilities by numbers', () => {
    const flow = new OnboardingFlow('test-caps-nums');
    flow.getWelcomeMessage();
    flow.onPersonaSelected('1');

    const msg = flow.onCapabilitiesSelected('1, 2, 3');
    expect(msg).not.toBeNull();
    expect(flow.getState().selectedCapabilities).toEqual(['wallet', 'prices', 'portfolio']);
  });

  it('accepts "all" for all capabilities', () => {
    const flow = new OnboardingFlow('test-caps-all');
    flow.getWelcomeMessage();
    flow.onPersonaSelected('1');

    const msg = flow.onCapabilitiesSelected('all');
    expect(msg).not.toBeNull();
    expect(flow.getState().selectedCapabilities).toHaveLength(CAPABILITIES.length);
  });

  it('goes to connect_wallet when wallet capability selected', () => {
    const flow = new OnboardingFlow('test-caps-wallet');
    flow.getWelcomeMessage();
    flow.onPersonaSelected('1');

    const msg = flow.onCapabilitiesSelected('1');
    expect(msg).not.toBeNull();
    // Wallet is needsWallet: true → goes directly to connect_wallet (no guided_setup)
    expect(flow.currentStep).toBe('connect_wallet');
  });

  it('goes to connect_wallet when trading capability selected (needs wallet)', () => {
    const flow = new OnboardingFlow('test-caps-trading');
    flow.getWelcomeMessage();
    flow.onPersonaSelected('1');

    const msg = flow.onCapabilitiesSelected('4'); // trading
    expect(msg).not.toBeNull();
    expect(flow.currentStep).toBe('connect_wallet');
  });

  it('goes to first_read when no wallet capabilities selected', () => {
    const flow = new OnboardingFlow('test-caps-no-wallet');
    flow.getWelcomeMessage();
    flow.onPersonaSelected('1');

    // Select only prices (no wallet needed)
    const msg = flow.onCapabilitiesSelected('2');
    expect(msg).not.toBeNull();
    expect(flow.currentStep).toBe('first_read');
  });

  it('deduplicates capability selections', () => {
    const flow = new OnboardingFlow('test-caps-dedup');
    flow.getWelcomeMessage();
    flow.onPersonaSelected('1');

    flow.onCapabilitiesSelected('2, 2, 3, 3');
    expect(flow.getState().selectedCapabilities).toEqual(['prices', 'portfolio']);
  });

  it('rejects invalid capability input', () => {
    const flow = new OnboardingFlow('test-caps-invalid');
    flow.getWelcomeMessage();
    flow.onPersonaSelected('1');

    const msg = flow.onCapabilitiesSelected('xyz');
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('Tap a capability to select it');
    expect(flow.currentStep).toBe('choose_capabilities');
  });

  it('shows deploy config info for unconfigured capabilities', () => {
    const flow = new OnboardingFlow('test-caps-deploy-info');
    flow.getWelcomeMessage();
    flow.onPersonaSelected('1');

    // Hummingbot needs HUMMINGBOT_API_URL which is not set in test env
    const msg = flow.onCapabilitiesSelected('10');
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('environment variable');
    expect(msg!.text).toContain('HUMMINGBOT_API_URL');
  });

  // ── Wallet Connection ─────────────────────────────────────────────────

  it('advances to first_read after wallet connect', () => {
    const flow = new OnboardingFlow('test-wallet');
    advanceToConnectWallet(flow);

    const msg = flow.onWalletConnected('0xABC123', '1.5 ETH ($3,750)');

    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('0xABC1...C123');
    expect(msg!.text).toContain('trending');
    expect(flow.currentStep).toBe('first_read');
  });

  // ── Read / Write Progression ──────────────────────────────────────────

  it('advances to first_write after read completes', () => {
    const flow = new OnboardingFlow('test-read');
    advanceToFirstRead(flow);

    const msg = flow.onReadComplete();

    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('write operation');
    expect(msg!.text).toContain('Swap');
    expect(flow.currentStep).toBe('first_write');
  });

  it('completes after write operation', () => {
    const flow = new OnboardingFlow('test-write');
    advanceToFirstRead(flow);
    flow.onReadComplete();

    const msg = flow.onWriteComplete();

    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('Setup complete');
    expect(msg!.final).toBe(true);
    expect(flow.currentStep).toBe('complete');
    expect(flow.isActive).toBe(false);
  });

  // ── Skip ──────────────────────────────────────────────────────────────

  it('skip jumps to skipped state', () => {
    const flow = new OnboardingFlow('test-skip');
    const msg = flow.skip();

    expect(msg.text).toContain('skipped');
    expect(msg.final).toBe(true);
    expect(flow.currentStep).toBe('skipped');
    expect(flow.isActive).toBe(false);
  });

  it('skip() sets state to skipped', () => {
    const flow = new OnboardingFlow('test-skip-tutorial');
    flow.getWelcomeMessage();

    const msg = flow.skip();
    expect(msg).not.toBeNull();
    expect(flow.isActive).toBe(false);
  });

  it('processMessage returns null for slash commands (handled by registered commands)', () => {
    const flow = new OnboardingFlow('test-skip-cmd');
    flow.getWelcomeMessage();

    // processMessage now returns null for slash commands — they go through
    // OpenClaw's command system and call flow.skip() etc. directly
    const msg = flow.processMessage('/skip');
    expect(msg).toBeNull();
  });

  it('processMessage returns null for completed users', () => {
    const flow = new OnboardingFlow('test-skip-done');
    flow.skip();

    const msg = flow.processMessage('hello');
    expect(msg).toBeNull();
  });

  // ── processMessage routing ────────────────────────────────────────────

  it('processMessage returns null after welcome step (persona selection is via slash commands)', () => {
    const flow = new OnboardingFlow('test-msg-persona');
    flow.getWelcomeMessage(); // → choose_persona

    // Free-form text during choose_persona passes through to LLM
    const msg = flow.processMessage('2');
    expect(msg).toBeNull();
    // Persona selection happens via /professional, /degen etc. commands
    // which call flow.onPersonaSelected() directly
  });

  it('onPersonaSelected routes to capability selection', () => {
    const flow = new OnboardingFlow('test-msg-caps');
    flow.getWelcomeMessage();

    // Direct call simulating /degen command
    const msg = flow.onPersonaSelected('degen');
    expect(msg).not.toBeNull();
    expect(flow.currentStep).toBe('choose_capabilities');
  });

  it('processMessage returns null for non-welcome steps (handled by LLM or commands)', () => {
    const flow = new OnboardingFlow('test-msg-nudge');
    advanceToConnectWallet(flow);

    // Non-welcome-step messages pass through to LLM
    const msg = flow.processMessage('What is the price of ETH?');
    expect(msg).toBeNull();
  });

  // ── processToolResult ─────────────────────────────────────────────────

  it('processToolResult advances read step', () => {
    const flow = new OnboardingFlow('test-tool-read');
    advanceToFirstRead(flow);

    const msg = flow.processToolResult('defi_price', true);
    expect(msg).not.toBeNull();
    expect(flow.currentStep).toBe('first_write');
  });

  it('processToolResult advances write step', () => {
    const flow = new OnboardingFlow('test-tool-write');
    advanceToFirstRead(flow);
    flow.onReadComplete();

    const msg = flow.processToolResult('defi_swap', true);
    expect(msg).not.toBeNull();
    expect(flow.currentStep).toBe('complete');
  });

  it('processToolResult ignores failed tool calls', () => {
    const flow = new OnboardingFlow('test-tool-fail');
    advanceToFirstRead(flow);

    const msg = flow.processToolResult('defi_price', false);
    expect(msg).toBeNull();
    expect(flow.currentStep).toBe('first_read');
  });

  it('processToolResult ignores irrelevant tools', () => {
    const flow = new OnboardingFlow('test-tool-irrelevant');
    advanceToFirstRead(flow);

    const msg = flow.processToolResult('clawnx', true);
    expect(msg).toBeNull();
    expect(flow.currentStep).toBe('first_read');
  });

  // ── Persistence ───────────────────────────────────────────────────────

  it('persists and restores state', () => {
    const flow1 = new OnboardingFlow('test-persist');
    flow1.getWelcomeMessage();
    flow1.onPersonaSelected('degen');

    // Create a new flow instance for the same user
    const flow2 = new OnboardingFlow('test-persist');
    expect(flow2.currentStep).toBe('choose_capabilities');
    expect(flow2.getState().persona).toBe('degen');
  });

  it('getState returns immutable copy', () => {
    const flow = new OnboardingFlow('test-immutable');
    const state = flow.getState();
    expect(state.step).toBe('welcome');

    // Mutating the returned state should not affect the flow
    (state as any).step = 'complete';
    expect(flow.currentStep).toBe('welcome');
  });
});

describe('Persona definitions', () => {
  it('has 5 preset personas', () => {
    expect(PERSONAS).toHaveLength(5);
  });

  it('all personas have required fields', () => {
    for (const p of PERSONAS) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.example).toBeTruthy();
    }
  });

  it('persona IDs are unique', () => {
    const ids = PERSONAS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Capability definitions', () => {
  it('has 10 capability categories', () => {
    expect(CAPABILITIES).toHaveLength(10);
  });

  it('all capabilities have required fields', () => {
    for (const c of CAPABILITIES) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(c.tools.length).toBeGreaterThan(0);
      expect(typeof c.needsWallet).toBe('boolean');
    }
  });

  it('capability IDs are unique', () => {
    const ids = CAPABILITIES.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('wallet and hummingbot categories have deploy requirements', () => {
    const wallet = CAPABILITIES.find(c => c.id === 'wallet');
    const hummingbot = CAPABILITIES.find(c => c.id === 'hummingbot');
    expect(wallet?.deployRequirement).toBeTruthy();
    expect(hummingbot?.deployRequirement).toBeTruthy();
  });

  it('prices category works out of the box (no deploy requirement)', () => {
    const prices = CAPABILITIES.find(c => c.id === 'prices');
    expect(prices?.deployRequirement).toBeUndefined();
  });

  it('wallet-requiring capabilities are correctly flagged', () => {
    const walletCaps = CAPABILITIES.filter(c => c.needsWallet);
    const walletIds = walletCaps.map(c => c.id);
    expect(walletIds).toContain('wallet');
    expect(walletIds).toContain('trading');
    expect(walletIds).toContain('liquidity');
    expect(walletIds).toContain('launchpad');
    expect(walletIds).toContain('bridge');
    expect(walletIds).toContain('clawnx');
  });

  it('non-wallet capabilities are correctly flagged', () => {
    const nonWalletCaps = CAPABILITIES.filter(c => !c.needsWallet);
    const nonWalletIds = nonWalletCaps.map(c => c.id);
    expect(nonWalletIds).toContain('prices');
    expect(nonWalletIds).toContain('portfolio');
    expect(nonWalletIds).toContain('routing');
    expect(nonWalletIds).toContain('hummingbot');
  });
});

describe('isNewUser', () => {
  it('returns true for unknown users', () => {
    expect(isNewUser('never-seen-before')).toBe(true);
  });

  it('returns false after flow is created', () => {
    const flow = new OnboardingFlow('known-user');
    // State is saved in constructor
    expect(isNewUser('known-user')).toBe(false);
  });
});
