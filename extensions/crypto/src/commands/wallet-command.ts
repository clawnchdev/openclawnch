/**
 * /wallet command — show connected wallet status
 * Bypasses the LLM agent for fast, zero-cost responses.
 */

import { getWalletState } from '../services/walletconnect-service.js';
import { formatPolicy } from '@clawnch/sdk';

export const walletCommand = {
  name: 'wallet',
  description: 'Show connected wallet address, chain, balance, and active spending policies',
  acceptsArgs: false,
  requireAuth: true,
  handler: async () => {
    const state = getWalletState();

    if (!state.connected) {
      return {
        text: 'No wallet connected.\n\nTo connect, ask the agent to use the clawnchconnect tool, or set WALLETCONNECT_PROJECT_ID / CLAWNCHER_PRIVATE_KEY.',
      };
    }

    const lines = [
      `**Wallet Connected**`,
      `Address: \`${state.address}\``,
      `Chain ID: ${state.chainId}`,
      `Mode: ${state.mode === 'private_key' ? 'Private key (headless)' : 'WalletConnect'}`,
    ];

    if (state.policies.length > 0) {
      lines.push('', '**Spending Policies:**');
      for (const p of state.policies) {
        const status = p.enabled !== false ? '' : ' (disabled)';
        lines.push(`- ${formatPolicy(p)}${status}`);
      }
    } else {
      lines.push('', 'No spending policies set. All transactions require manual approval.');
    }

    return { text: lines.join('\n') };
  },
};
