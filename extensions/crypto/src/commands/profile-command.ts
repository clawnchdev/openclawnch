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
import {
  prepareDelegation,
  signDelegation,
  storeDelegation,
} from '../services/delegation-service.js';

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
    lines.push('Delegations are auto-signed when you activate a profile.');
  }

  return { text: lines.join('\n') };
}

async function handleActivate(userId: string, profileId: ProfileId) {
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

      // Auto-create and sign delegations when in delegation mode
      if (isDelegationMode()) {
        const delegationResults = await autoDelegateForPolicies(policies, userId);
        if (delegationResults.signed > 0) {
          lines.push('');
          lines.push(`Signed ${delegationResults.signed} on-chain delegation${delegationResults.signed === 1 ? '' : 's'} automatically.`);
          for (const detail of delegationResults.details) {
            lines.push(`  ${detail}`);
          }
        }
        if (delegationResults.failed > 0) {
          lines.push('');
          lines.push(`Failed to sign ${delegationResults.failed} delegation${delegationResults.failed === 1 ? '' : 's'}:`);
          for (const err of delegationResults.errors) {
            lines.push(`  ${err}`);
          }
          lines.push('You can retry manually with `/delegate create <policy-name>`.');
        }
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

// ─── Auto-Delegation Helper ─────────────────────────────────────────────

interface AutoDelegationResults {
  signed: number;
  failed: number;
  details: string[];
  errors: string[];
}

/**
 * Auto-create and sign delegations for newly created profile policies.
 * Calls prepareDelegation → signDelegation → storeDelegation for each policy.
 * Non-throwing: captures errors per-policy so partial success is reported.
 */
async function autoDelegateForPolicies(
  policies: import('../services/policy-types.js').Policy[],
  userId: string,
): Promise<AutoDelegationResults> {
  const results: AutoDelegationResults = { signed: 0, failed: 0, details: [], errors: [] };

  for (const policy of policies) {
    try {
      // Step 1: Compile policy to delegation
      const prepResult = await prepareDelegation({ policy });
      if ('error' in prepResult) {
        results.failed++;
        results.errors.push(`${policy.name}: ${prepResult.error}`);
        continue;
      }

      const { compilation, chainId } = prepResult;

      // Step 2: Sign the delegation
      const signResult = await signDelegation(compilation.delegation, chainId);
      if ('error' in signResult) {
        results.failed++;
        results.errors.push(`${policy.name}: ${signResult.error}`);
        continue;
      }

      // Step 3: Store the signed delegation
      const unmappedRules = compilation.unmappedRules.map(r => r.rule.type);
      await storeDelegation(policy, userId, signResult.signed, chainId, unmappedRules);

      results.signed++;
      results.details.push(`${policy.name} — chain ${chainId}, ${compilation.mappedRules.length} caveat${compilation.mappedRules.length === 1 ? '' : 's'}`);
    } catch (err: any) {
      results.failed++;
      results.errors.push(`${policy.name}: ${err.message}`);
    }
  }

  return results;
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
