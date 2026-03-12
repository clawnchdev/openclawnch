/**
 * Onboarding slash commands — tappable options for persona, capabilities, and skip.
 *
 * These let users tap instead of type during the onboarding flow.
 * Each command calls into the OnboardingFlow state machine and returns
 * the response text. OpenClaw's command system handles sending it.
 */

import { getOnboardingFlow, type PersonaId, CAPABILITIES } from '../services/onboarding-flow.js';

/** Helper: extract sender ID from command context. */
function getSenderId(ctx: any): string {
  return ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'unknown';
}

// ── Persona Commands ────────────────────────────────────────────────────────

function makePersonaCommand(id: PersonaId, label: string, description: string) {
  return {
    name: id,
    description: `Set communication style: ${description}`,
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx: any) => {
      const userId = getSenderId(ctx);
      const flow = getOnboardingFlow(userId);
      const response = flow.onPersonaSelected(id);
      if (response) {
        return { text: response.text };
      }
      return { text: `${label} persona noted. (You can change this anytime with /${id})` };
    },
  };
}

export const professionalCommand = makePersonaCommand('professional', 'Professional', 'Clear, concise, business-like');
export const degenCommand = makePersonaCommand('degen', 'Degen', 'CT native, crypto twitter energy');
export const chillCommand = makePersonaCommand('chill', 'Chill', 'Relaxed, like texting a friend');
export const technicalCommand = makePersonaCommand('technical', 'Technical', 'Data-heavy, on-chain metrics');
export const mentorCommand = makePersonaCommand('mentor', 'Mentor', 'Educational, explains as it goes');

// ── Capability Commands ─────────────────────────────────────────────────────

export const capAllCommand = {
  name: 'all',
  description: 'Select all capabilities during onboarding',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const flow = getOnboardingFlow(userId);
    const response = flow.onCapabilitiesSelected('all');
    if (response) {
      return { text: response.text };
    }
    return { text: 'All capabilities enabled.' };
  },
};

// Individual capability commands — tapping /cap_X selects that ONE capability and advances.
// Users can also type multiple numbers ("1, 2, 3") or /all instead of tapping individual caps.
function makeCapCommand(capId: string, name: string) {
  return {
    name: `cap_${capId}`,
    description: `Select capability: ${name}`,
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx: any) => {
      const userId = getSenderId(ctx);
      const flow = getOnboardingFlow(userId);
      const idx = CAPABILITIES.findIndex(c => c.id === capId);
      if (idx < 0) return { text: `Unknown capability: ${capId}` };
      const response = flow.onCapabilitiesSelected(String(idx + 1));
      if (response) {
        return { text: response.text };
      }
      return { text: `${name} enabled.` };
    },
  };
}

export const capCommands = CAPABILITIES.map(c => makeCapCommand(c.id, c.name));

// ── Wallet Creation Commands ────────────────────────────────────────────────

export const createWalletCommand = {
  name: 'create_wallet',
  description: 'Generate a new encrypted wallet (stored locally)',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const flow = getOnboardingFlow(userId);
    const response = await flow.onCreateWallet();
    if (response) {
      return { text: response.text };
    }
    return { text: 'Wallet creation is only available during the wallet connection step. Use /connect for other wallet options.' };
  },
};

export const importWalletCommand = {
  name: 'import_wallet',
  description: 'Import wallet from a 12/24-word seed phrase',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const flow = getOnboardingFlow(userId);
    const response = flow.onImportWallet();
    if (response) {
      return { text: response.text };
    }
    return { text: 'Wallet import is only available during the wallet connection step. Use /connect for other wallet options.' };
  },
};

// ── Back Command ────────────────────────────────────────────────────────────

export const backCommand = {
  name: 'back',
  description: 'Go back one step during onboarding',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const flow = getOnboardingFlow(userId);
    if (flow.isActive) {
      const response = flow.back();
      if (response) {
        return { text: response.text };
      }
      return { text: "Can't go back from the current step." };
    }
    return { text: 'No active onboarding. Use /help to see available commands.' };
  },
};

// ── Skip Command ────────────────────────────────────────────────────────────

export const skipCommand = {
  name: 'skip',
  description: 'Skip the onboarding tutorial',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const flow = getOnboardingFlow(userId);
    if (flow.isActive) {
      const response = flow.skip();
      return { text: response.text };
    }
    return { text: 'No active onboarding to skip.' };
  },
};
