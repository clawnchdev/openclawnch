/**
 * Fiat commands — view fiat rail status, providers, and recent transfers.
 *
 * /fiat — Show configured fiat providers and recent transfer summary.
 */

import { getFiatService } from '../services/fiat-service.js';
import { getWalletState } from '../services/walletconnect-service.js';

export const fiatCommand = {
  name: 'fiat',
  description: 'Show fiat rail status: configured providers, linked bank accounts, and recent transfers',
  acceptsArgs: false,
  requireAuth: false,
  handler: async () => {
    const fiat = getFiatService();
    const providers = fiat.getConfiguredProviders();
    const state = getWalletState();

    const sections: string[] = [];

    // Provider status
    if (providers.length === 0) {
      sections.push(
        '**Fiat Providers:** None configured\n' +
        'Set `BRIDGE_API_KEY` or `MOONPAY_API_KEY` to enable fiat rails.'
      );
    } else {
      sections.push(`**Fiat Providers:** ${providers.join(', ')}`);
    }

    // Env var hints
    const envHints: string[] = [];
    if (process.env.BRIDGE_API_KEY) envHints.push('`BRIDGE_API_KEY` set (Bridge.xyz)');
    if (process.env.MOONPAY_API_KEY) envHints.push('`MOONPAY_API_KEY` set (MoonPay)');
    if (process.env.FIAT_CURRENCY) envHints.push(`Default currency: \`${process.env.FIAT_CURRENCY}\``);

    if (envHints.length > 0) {
      sections.push(`**Configuration:**\n${envHints.map(h => `  ${h}`).join('\n')}`);
    }

    // Bank accounts (if available)
    if (providers.length > 0) {
      try {
        const accounts = await fiat.listBankAccounts();
        if (accounts.length > 0) {
          const accountLines = accounts.map(a =>
            `  ${a.label} (${a.maskedNumber}) — ${a.bankName} [${a.currency}] via ${a.provider}`
          );
          sections.push(`**Linked Accounts:** ${accounts.length}\n${accountLines.join('\n')}`);
        } else {
          sections.push('**Linked Accounts:** None');
        }
      } catch {
        sections.push('**Linked Accounts:** Unable to fetch');
      }
    }

    // Recent transfers
    const userId = state.address ?? undefined;
    const transfers = fiat.listTransfers(userId);
    if (transfers.length > 0) {
      // Sort by most recent
      transfers.sort((a, b) => b.createdAt - a.createdAt);
      const recent = transfers.slice(0, 5);
      const lines = recent.map(t => {
        const dir = t.direction === 'off_ramp' ? 'SELL' : 'BUY';
        const date = new Date(t.createdAt).toLocaleDateString();
        return `  ${dir} ${t.cryptoAmount} ${t.cryptoToken} for ${t.fiatAmount} ${t.fiatCurrency} — ${t.status} (${date}) via ${t.provider}`;
      });
      sections.push(`**Recent Transfers:** ${transfers.length} total\n${lines.join('\n')}`);
    } else {
      sections.push('**Recent Transfers:** None');
    }

    sections.push('\nUse the `fiat_payment` tool to get quotes, execute transfers, or check status.');

    return { text: sections.join('\n\n') };
  },
};
