/**
 * /policy command — set spending policies in natural language
 * Bypasses the LLM agent for fast, zero-cost responses.
 */

import { parsePolicies, formatPolicy } from '@clawnch/sdk';
import { addPolicy, clearPolicies, getWalletState } from '../services/walletconnect-service.js';

export const policyCommand = {
  name: 'policy',
  description: 'Set spending policies in natural language. Example: /policy approve under 0.05 ETH, max 10/hour',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx: { args?: string }) => {
    const input = ctx.args?.trim();

    if (!input) {
      const state = getWalletState();
      if (state.policies.length === 0) {
        return {
          text: 'No spending policies set. All transactions require manual approval.\n\n' +
            '**Examples:**\n' +
            '`/policy approve under 0.05 ETH`\n' +
            '`/policy auto-approve below 0.01 ETH, max 10/hour`\n' +
            '`/policy no auto-approve`',
        };
      }

      return {
        text: '**Active Policies:**\n' +
          state.policies.map(p => `- ${formatPolicy(p)}`).join('\n'),
      };
    }

    let result: ReturnType<typeof parsePolicies>;
    try {
      result = parsePolicies(input);
    } catch (err) {
      return {
        text: `Failed to parse policy: ${err instanceof Error ? err.message : String(err)}\n\n` +
          '**Examples:**\n' +
          '`/policy approve under 0.05 ETH`\n' +
          '`/policy auto-approve below 0.01 ETH, max 10/hour`\n' +
          '`/policy no auto-approve`',
      };
    }

    if (result.clearAll) {
      clearPolicies();
      return {
        text: 'All spending policies cleared. Every transaction will require manual approval.',
      };
    }

    if (result.policies.length === 0) {
      return {
        text: `Could not parse: "${input}"\n\n` +
          '**Examples:**\n' +
          '`/policy approve under 0.05 ETH`\n' +
          '`/policy auto-approve below 0.01 ETH, max 10/hour`\n' +
          '`/policy only allow 0xABC...DEF`\n' +
          '`/policy no auto-approve`',
      };
    }

    for (const policy of result.policies) {
      addPolicy(policy);
    }

    const formatted = result.policies.map(p => formatPolicy(p));
    const warnings = result.unrecognized.length > 0
      ? `\n\nCould not parse: ${result.unrecognized.map(u => `"${u}"`).join(', ')}`
      : '';

    return {
      text: `**Policies added:**\n${formatted.map(f => `- ${f}`).join('\n')}${warnings}`,
    };
  },
};
