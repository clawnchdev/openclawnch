/**
 * Tests for the Teleost Bot Onboarding Flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OnboardingFlow, isNewUser, type OnboardingStep } from '../extensions/crypto/src/services/onboarding-flow.js';
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

describe('OnboardingFlow', () => {
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
    expect(msg!.showQr).toBe(true);
    expect(flow.currentStep).toBe('connect_wallet');
  });

  it('only sends welcome once', () => {
    const flow = new OnboardingFlow('test-user-3');
    flow.getWelcomeMessage();
    const msg2 = flow.getWelcomeMessage();
    expect(msg2).toBeNull();
  });

  it('advances to first_read after wallet connect', () => {
    const flow = new OnboardingFlow('test-user-4');
    flow.getWelcomeMessage(); // welcome → connect_wallet

    const msg = flow.onWalletConnected('0xABC123', '1.5 ETH ($3,750)');

    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('0xABC1...C123');
    expect(msg!.text).toContain('trending');
    expect(flow.currentStep).toBe('first_read');
  });

  it('advances to first_write after read completes', () => {
    const flow = new OnboardingFlow('test-user-5');
    flow.getWelcomeMessage();
    flow.onWalletConnected('0xABC', '1 ETH');

    const msg = flow.onReadComplete();

    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('write operation');
    expect(msg!.text).toContain('Swap');
    expect(flow.currentStep).toBe('first_write');
  });

  it('completes after write operation', () => {
    const flow = new OnboardingFlow('test-user-6');
    flow.getWelcomeMessage();
    flow.onWalletConnected('0xABC', '1 ETH');
    flow.onReadComplete();

    const msg = flow.onWriteComplete();

    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('command reference');
    expect(msg!.final).toBe(true);
    expect(flow.currentStep).toBe('complete');
    expect(flow.isActive).toBe(false);
  });

  it('skip jumps to skipped state', () => {
    const flow = new OnboardingFlow('test-user-7');
    const msg = flow.skip();

    expect(msg.text).toContain('skipped');
    expect(msg.final).toBe(true);
    expect(flow.currentStep).toBe('skipped');
    expect(flow.isActive).toBe(false);
  });

  it('processMessage handles /skip-tutorial', () => {
    const flow = new OnboardingFlow('test-user-8');
    flow.getWelcomeMessage();

    const msg = flow.processMessage('/skip-tutorial');
    expect(msg).not.toBeNull();
    expect(flow.isActive).toBe(false);
  });

  it('processMessage handles /skip', () => {
    const flow = new OnboardingFlow('test-user-9');
    flow.getWelcomeMessage();

    const msg = flow.processMessage('/skip');
    expect(msg).not.toBeNull();
    expect(flow.isActive).toBe(false);
  });

  it('processMessage returns null for completed users', () => {
    const flow = new OnboardingFlow('test-user-10');
    flow.skip();

    const msg = flow.processMessage('hello');
    expect(msg).toBeNull();
  });

  it('processMessage nudges wallet connect when waiting', () => {
    const flow = new OnboardingFlow('test-user-11');
    flow.getWelcomeMessage(); // now at connect_wallet

    const msg = flow.processMessage('What is the price of ETH?');
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('wallet');
    expect(msg!.showQr).toBe(true);
  });

  it('processToolResult advances read step', () => {
    const flow = new OnboardingFlow('test-user-12');
    flow.getWelcomeMessage();
    flow.onWalletConnected('0xABC', '1 ETH');

    const msg = flow.processToolResult('defi_price', true);
    expect(msg).not.toBeNull();
    expect(flow.currentStep).toBe('first_write');
  });

  it('processToolResult advances write step', () => {
    const flow = new OnboardingFlow('test-user-13');
    flow.getWelcomeMessage();
    flow.onWalletConnected('0xABC', '1 ETH');
    flow.onReadComplete();

    const msg = flow.processToolResult('defi_swap', true);
    expect(msg).not.toBeNull();
    expect(flow.currentStep).toBe('complete');
  });

  it('processToolResult ignores failed tool calls', () => {
    const flow = new OnboardingFlow('test-user-14');
    flow.getWelcomeMessage();
    flow.onWalletConnected('0xABC', '1 ETH');

    const msg = flow.processToolResult('defi_price', false);
    expect(msg).toBeNull();
    expect(flow.currentStep).toBe('first_read');
  });

  it('processToolResult ignores irrelevant tools', () => {
    const flow = new OnboardingFlow('test-user-15');
    flow.getWelcomeMessage();
    flow.onWalletConnected('0xABC', '1 ETH');

    const msg = flow.processToolResult('clawnx', true);
    expect(msg).toBeNull();
    expect(flow.currentStep).toBe('first_read');
  });

  it('persists and restores state', () => {
    const flow1 = new OnboardingFlow('test-persist');
    flow1.getWelcomeMessage();
    flow1.onWalletConnected('0xABC', '1 ETH');

    // Create a new flow instance for the same user
    const flow2 = new OnboardingFlow('test-persist');
    expect(flow2.currentStep).toBe('first_read');
    expect(flow2.getState().walletConnected).toBe(true);
    expect(flow2.getState().walletAddress).toBe('0xABC');
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
