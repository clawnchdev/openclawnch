/**
 * /tx command — show recent transaction history
 * Bypasses the LLM agent for fast, zero-cost responses.
 */

import { getTransactionHistory } from '../services/walletconnect-service.js';

export const txCommand = {
  name: 'tx',
  description: 'Show recent transaction history (approved, rejected, auto-approved)',
  acceptsArgs: false,
  requireAuth: true,
  handler: async () => {
    const history = getTransactionHistory();

    if (history.length === 0) {
      return {
        text: 'No transactions yet this session.',
      };
    }

    // Show most recent 20
    const recent = history.slice(-20).reverse();
    const lines = ['**Recent Transactions:**', ''];

    for (const tx of recent) {
      const status = {
        approved: 'Approved',
        auto_approved: `Auto-approved (${tx.policyLabel})`,
        rejected: 'Rejected',
        pending: 'Pending...',
      }[tx.status];

      const hashStr = tx.hash ? ` \`${tx.hash.slice(0, 10)}...${tx.hash.slice(-6)}\`` : '';
      const time = new Date(tx.timestamp).toLocaleTimeString();

      lines.push(`- [${time}] ${status}${hashStr} — ${tx.summary}`);
    }

    if (history.length > 20) {
      lines.push('', `(showing 20 of ${history.length} total)`);
    }

    return { text: lines.join('\n') };
  },
};
