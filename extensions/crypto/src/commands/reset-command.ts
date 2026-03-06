/**
 * /reset command — wipe onboarding state, sessions, WC pairing, and credentials.
 * Requires double confirmation: /reset → /reset confirm
 *
 * After reset, the next message from any user triggers pairing + onboarding again.
 */

import { existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resetOnboardingFlows } from '../services/onboarding-flow.js';
import { resetModes } from '../services/mode-service.js';

/** Track pending confirmations by sender (expire after 60s). */
const pendingConfirmations = new Map<string, number>();

/** Resolve persistent state dir (volume mount). Checks both old and new names. */
function getStateRoot(): string {
  return '/workspace/.openclaw-state';
}

/** Resolve OpenClaw/OpenClawnch home state dir. */
function getOpenClawHome(): string {
  const base = process.env.HOME ?? '/root';
  // Check both old (.openclaw) and new (.openclawnch) directory names
  const newPath = join(base, '.openclawnch');
  const oldPath = join(base, '.openclaw');
  try {
    const { existsSync } = require('node:fs');
    if (existsSync(newPath)) return newPath;
  } catch {}
  return oldPath; // fallback to legacy path
}

export const resetCommand = {
  name: 'factoryreset',
  description: 'Factory reset: wipe all state. Tap /factoryreset_confirm after.',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx: any) => {
    const senderId = ctx?.senderId ?? ctx?.from ?? 'unknown';
    const args = (ctx?.args ?? ctx?.commandBody ?? '').trim().toLowerCase();

    // ── Step 2: Confirm (via /factoryreset confirm or /factoryreset_confirm) ──
    if (args === 'confirm') {
      const pending = pendingConfirmations.get(senderId);
      if (!pending || Date.now() - pending > 60_000) {
      return {
        text: 'No pending reset. Run /factoryreset first, then /factoryreset_confirm within 60 seconds.',
      };
      }

      pendingConfirmations.delete(senderId);

      const wiped: string[] = [];
      const errors: string[] = [];
      const stateRoot = getStateRoot();
      const openclawHome = getOpenClawHome();

      // 1. Wipe onboarding state (volume)
      const onboardingDir = join(stateRoot, 'onboarding');
      if (existsSync(onboardingDir)) {
        try {
          rmSync(onboardingDir, { recursive: true, force: true });
          wiped.push('onboarding state');
        } catch (e) {
          errors.push(`onboarding: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 2. Wipe WalletConnect session (volume)
      const wcDir = join(stateRoot, 'wc');
      if (existsSync(wcDir)) {
        try {
          rmSync(wcDir, { recursive: true, force: true });
          wiped.push('WalletConnect session');
        } catch (e) {
          errors.push(`wc: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 3. Wipe sessions (volume)
      const sessionsDir = join(stateRoot, 'sessions');
      if (existsSync(sessionsDir)) {
        try {
          // Remove contents but keep the directory (symlink target)
          for (const f of readdirSync(sessionsDir)) {
            rmSync(join(sessionsDir, f), { recursive: true, force: true });
          }
          wiped.push('conversation sessions');
        } catch (e) {
          errors.push(`sessions: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 4. Wipe credentials (volume) — this removes pairing approvals
      const credsDir = join(stateRoot, 'credentials');
      if (existsSync(credsDir)) {
        try {
          for (const f of readdirSync(credsDir)) {
            rmSync(join(credsDir, f), { force: true });
          }
          wiped.push('credentials/pairing');
        } catch (e) {
          errors.push(`credentials: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 5. Also wipe the OpenClaw home copies (symlinked, but just in case)
      for (const sub of ['credentials', 'agents/main/sessions']) {
        const dir = join(openclawHome, sub);
        if (existsSync(dir)) {
          try {
            for (const f of readdirSync(dir)) {
              rmSync(join(dir, f), { recursive: true, force: true });
            }
          } catch {
            // Best effort — volume wipe is primary
          }
        }
      }

      // 6. Reset in-memory caches
      resetOnboardingFlows();
      resetModes();

      // 6b. Wipe mode state (volume)
      const modesDir = join(stateRoot, 'modes');
      if (existsSync(modesDir)) {
        try {
          rmSync(modesDir, { recursive: true, force: true });
          wiped.push('mode preferences');
        } catch (e) {
          errors.push(`modes: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 7. Wipe tx history (volume)
      const txDir = join(stateRoot, 'tx');
      if (existsSync(txDir)) {
        try {
          rmSync(txDir, { recursive: true, force: true });
          wiped.push('transaction history');
        } catch (e) {
          errors.push(`tx: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      let msg = `Factory reset complete.\n\nWiped: ${wiped.length > 0 ? wiped.join(', ') : 'nothing found'}`;
      if (errors.length > 0) {
        msg += `\n\nErrors:\n${errors.map(e => `  - ${e}`).join('\n')}`;
      }
      msg += '\n\nYour next message will require re-pairing. Send any message to start fresh.';

      return { text: msg };
    }

    // ── Step 1: Warn ───────────────────────────────────────────────
    pendingConfirmations.set(senderId, Date.now());

    return {
      text: `WARNING: This will permanently delete:

  - Onboarding preferences (persona, capabilities)
  - Conversation history (all sessions)
  - WalletConnect wallet pairing
  - Sender credentials (you'll need to re-pair)
  - Transaction history

This cannot be undone.

To confirm, tap /factoryreset_confirm within 60 seconds.`,
    };
  },
};

/** Tappable alias for /factoryreset confirm. */
export const resetConfirmCommand = {
  name: 'factoryreset_confirm',
  description: 'Confirm a pending factory reset',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    // Delegate to the main handler with args='confirm'
    return resetCommand.handler({ ...ctx, args: 'confirm', commandBody: 'confirm' });
  },
};
