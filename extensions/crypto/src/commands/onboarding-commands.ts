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

// Individual capability commands
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
