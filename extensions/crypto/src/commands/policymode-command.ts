/**
 * /policymode — Switch between delegation and simple policy enforcement modes.
 *
 * Usage:
 *   /policymode                — show current mode
 *   /policymode delegation     — switch to delegation mode (on-chain, default)
 *   /policymode simple         — switch to simple mode (app-layer only)
 *
 * Delegation mode: policies compile to EIP-7710 on-chain delegations.
 * The agent redeems delegations through the DelegationManager contract.
 * Requires a smart account or EIP-7702 wallet for full enforcement.
 *
 * Simple mode: policies are natural-language rules enforced at the app layer.
 * No on-chain delegation, no signing, no smart account required.
 * Works with any wallet. Good for getting started or when you don't need
 * on-chain enforcement.
 */

import {
  getPolicyMode,
  setPolicyMode,
  type PolicyMode,
} from '../services/policy-types.js';

export const policymodeCommand = {
  name: 'policymode',
  description: 'Policy enforcement mode: /policymode [delegation|simple]',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx?: any) => {
    const args = (ctx?.args ?? '').trim().toLowerCase();

    // No args: show current mode
    if (!args) {
      return showCurrentMode();
    }

    if (args === 'delegation' || args === 'simple') {
      return switchMode(args);
    }

    return {
      text: [
        'Unknown mode. Available modes:',
        '',
        '  `/policymode delegation` — on-chain enforcement via EIP-7710 (default)',
        '  `/policymode simple` — app-layer enforcement only',
        '',
        'Use `/policymode` with no args to see the current mode.',
      ].join('\n'),
    };
  },
};

function showCurrentMode() {
  const mode = getPolicyMode();
  const lines: string[] = [];

  lines.push('**Policy Enforcement Mode**');
  lines.push('');

  if (mode === 'delegation') {
    lines.push('Current mode: **delegation** (on-chain)');
    lines.push('');
    lines.push('Policies compile to EIP-7710 delegations with on-chain caveat enforcers.');
    lines.push('The agent executes actions by redeeming delegations through the DelegationManager.');
    lines.push('Spending limits, allowed targets, and time bounds are enforced on-chain.');
    lines.push('');
    lines.push('Use `/delegate create <name>` to compile and sign a policy as a delegation.');
    lines.push('');
    lines.push('Switch to simple mode: `/policymode simple`');
  } else {
    lines.push('Current mode: **simple** (app-layer)');
    lines.push('');
    lines.push('Policies are natural-language rules enforced at the application layer.');
    lines.push('No on-chain delegation or signing required. Works with any wallet.');
    lines.push('The agent checks policies before each action and asks for confirmation');
    lines.push('when needed. Good for getting started.');
    lines.push('');
    lines.push('Switch to delegation mode: `/policymode delegation`');
  }

  return { text: lines.join('\n') };
}

function switchMode(newMode: PolicyMode) {
  const oldMode = getPolicyMode();
  const lines: string[] = [];

  if (oldMode === newMode) {
    lines.push(`Already in **${newMode}** mode. No change.`);
    return { text: lines.join('\n') };
  }

  setPolicyMode(newMode);

  lines.push(`**Policy mode switched: ${oldMode} → ${newMode}**`);
  lines.push('');

  if (newMode === 'delegation') {
    lines.push('On-chain delegation mode is now active.');
    lines.push('');
    lines.push('Your existing policies still work at the app layer. To add on-chain');
    lines.push('enforcement, use `/delegate create <policy-name>` to compile and sign');
    lines.push('each policy as an EIP-7710 delegation.');
  } else {
    lines.push('Simple mode is now active.');
    lines.push('');
    lines.push('Policies are enforced at the application layer only. Any existing on-chain');
    lines.push('delegations remain valid on-chain but the agent will not attempt to redeem');
    lines.push('them. Use `/policymode delegation` to re-enable on-chain execution.');
  }

  return { text: lines.join('\n') };
}
