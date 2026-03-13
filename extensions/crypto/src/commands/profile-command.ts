/**
 * /profile — Graduated autonomy profiles.
 *
 * Usage:
 *   /profile                    — show current profile + list available
 *   /profile <name>             — activate a profile (supervised|training|autonomous|custom)
 *   /profile off                — deactivate profile, revert to supervised
 *
 * Profiles are preset delegation configurations:
 *   supervised  — all actions require wallet approval (default)
 *   training    — $50/tx, $200/day, 10 actions/day, 24h expiry
 *   autonomous  — $500/tx, $2k/week, 50 actions/day, 30d expiry
 *   custom      — user-defined policies (no preset rules)
 */

import {
  listProfiles,
  getProfile,
  getActiveProfile,
  activateProfile,
  deactivateProfile,
  formatProfileDisplay,
  type ProfileId,
} from '../services/autonomy-profiles.js';
import { getPolicyMode, isDelegationMode } from '../services/policy-types.js';

const VALID_PROFILES = new Set(['supervised', 'training', 'autonomous', 'custom']);

export const profileCommand = {
  name: 'profile',
  description: 'Autonomy profile: /profile [supervised|training|autonomous|custom|off]',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx?: any) => {
    const args = (ctx?.args ?? '').trim().toLowerCase();
    const userId = ctx?.senderId ?? ctx?.userId ?? 'default';

    // No args: show current profile + list
    if (!args) {
      return showProfiles(userId);
    }

    // Deactivate
    if (args === 'off' || args === 'reset' || args === 'none') {
      return handleDeactivate(userId);
    }

    // Activate a profile
    if (VALID_PROFILES.has(args)) {
      return handleActivate(userId, args as ProfileId);
    }

    return {
      text: [
        'Unknown profile. Available profiles:',
        '',
        '  `/profile supervised` — all actions need wallet approval',
        '  `/profile training` — small limits, 24h expiry',
        '  `/profile autonomous` — production limits, 30d expiry',
        '  `/profile custom` — define your own rules',
        '  `/profile off` — deactivate and revert to supervised',
        '',
        'Use `/profile` with no args to see details.',
      ].join('\n'),
    };
  },
};

function showProfiles(userId: string) {
  const activeId = getActiveProfile(userId);
  const profiles = listProfiles();
  const mode = getPolicyMode();
  const modeLabel = mode === 'delegation' ? 'delegation (on-chain)' : 'simple (app-layer)';

  const lines: string[] = [];
  lines.push('**Autonomy Profiles**');
  lines.push(`Policy mode: ${modeLabel}`);
  lines.push('');

  for (const p of profiles) {
    const isActive = p.id === activeId;
    lines.push(formatProfileDisplay(p, isActive));
    lines.push('');
  }

  lines.push('---');
  lines.push('Activate: `/profile <name>` — Deactivate: `/profile off`');

  if (isDelegationMode()) {
    lines.push('After activating, use `/delegate create profile:<name>` to sign on-chain.');
  }

  return { text: lines.join('\n') };
}

function handleActivate(userId: string, profileId: ProfileId) {
  const lines: string[] = [];

  try {
    const { profile, policies } = activateProfile(userId, profileId);

    lines.push(`**Profile activated: ${profile.name}**`);
    lines.push('');

    for (const s of profile.summary) {
      lines.push(`  ${s}`);
    }

    if (policies.length > 0) {
      lines.push('');
      lines.push(`Created ${policies.length} polic${policies.length === 1 ? 'y' : 'ies'} from template.`);

      if (isDelegationMode() && policies[0]) {
        lines.push('');
        lines.push('To compile to on-chain delegation:');
        lines.push(`  \`/delegate create ${policies[0].name}\``);
      }
    }

    if (profileId === 'supervised') {
      lines.push('');
      lines.push('No policies created. All actions require wallet approval.');
    }

    if (profileId === 'custom') {
      lines.push('');
      lines.push('Use natural language to create policies:');
      lines.push('  "Never spend more than $500/day on swaps"');
      lines.push('  "Only interact with Uniswap and Aave"');
    }
  } catch (err: any) {
    lines.push(`Failed to activate profile: ${err.message}`);
  }

  return { text: lines.join('\n') };
}

function handleDeactivate(userId: string) {
  deactivateProfile(userId);

  return {
    text: [
      '**Profile deactivated**',
      '',
      'Reverted to supervised mode. All actions require wallet approval.',
      'Any profile-generated policies have been removed.',
      '',
      'Note: existing on-chain delegations are NOT automatically revoked.',
      'Use `/delegate revoke <name>` to revoke on-chain delegations.',
    ].join('\n'),
  };
}
