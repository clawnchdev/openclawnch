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
        text: 'No wallet connected.\n\nUse /connect to pair your mobile wallet, /create_wallet to generate a new one, or /connect_bankr for Bankr (custodial).',
      };
    }

    const CHAIN_NAMES: Record<number, string> = {
      1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum', 10: 'Optimism', 137: 'Polygon',
      84532: 'Base Sepolia', 11155111: 'Ethereum Sepolia',
    };

    const chainId = state.chainId ?? 8453;
    const chainName = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;

    const lines = [
      `**Wallet Connected**`,
      `Address: \`${state.address}\``,
      `Chain: ${chainName} (${chainId})`,
      `Mode: ${state.mode === 'private_key' ? 'Private key (headless)' : state.mode === 'bankr' ? 'Bankr (custodial)' : 'WalletConnect'}`,
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
