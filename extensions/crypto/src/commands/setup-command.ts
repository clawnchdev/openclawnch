/**
 * /setup — Show tool configuration status and setup instructions.
 *
 * Groups tools into:
 *   - Ready (configured and working)
 *   - Needs wallet (requires /connect first)
 *   - Needs API keys (with setup instructions)
 *
 * All output uses tappable slash commands where possible.
 */

import { getAllToolStatus, type ToolStatus } from '../services/tool-config-service.js';
import { getWalletState } from '../services/walletconnect-service.js';

export const setupCommand = {
  name: 'setup',
  description: 'Show which tools are configured and what keys are missing',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    const statuses = getAllToolStatus();
    const wallet = getWalletState();

    // Partition tools
    const ready: ToolStatus[] = [];
    const needsWallet: ToolStatus[] = [];
    const needsKeys: ToolStatus[] = [];

    for (const s of statuses) {
      if (s.configured && !s.walletRequired) {
        ready.push(s);
      } else if (s.configured && s.walletRequired && !wallet.connected) {
        needsWallet.push(s);
      } else if (s.configured && s.walletRequired && wallet.connected) {
        ready.push(s);
      } else if (s.missingKeys.length > 0) {
        needsKeys.push(s);
      } else if (s.walletRequired && !wallet.connected) {
        needsWallet.push(s);
      } else {
        ready.push(s);
      }
    }

    const lines: string[] = [
      '**OpenClawnch Tool Setup**',
      '',
    ];

    // ── Ready tools ──────────────────────────────────────────────
    if (ready.length > 0) {
      lines.push(`**Ready (${ready.length} tools):**`);
      for (const s of ready) {
        lines.push(`  ${s.label} — ${s.description}`);
      }
      lines.push('');
    }

    // ── Needs wallet ─────────────────────────────────────────────
    if (needsWallet.length > 0) {
      lines.push(`**Needs wallet (${needsWallet.length} tools):**`);
      for (const s of needsWallet) {
        lines.push(`  ${s.label} — ${s.description}`);
      }
      lines.push('');
      lines.push('  Connect: /connect');
      lines.push('');
    }

    // ── Needs API keys ───────────────────────────────────────────
    if (needsKeys.length > 0) {
      lines.push(`**Needs API keys (${needsKeys.length} tools):**`);
      for (const s of needsKeys) {
        const missingStr = s.missingKeys.map(k => `\`${k}\``).join(', ');
        lines.push(`  **${s.label}** — ${s.description}`);
        lines.push(`    Missing: ${missingStr}`);
        if (s.keySource) {
          lines.push(`    Get keys: ${s.keySource}`);
        }
        if (s.setupHint) {
          lines.push(`    Setup: ${s.setupHint}`);
        }
        lines.push('');
      }
    }

    // ── Summary ──────────────────────────────────────────────────
    const total = statuses.length;
    const readyCount = ready.length;
    lines.push(`**${readyCount}/${total} tools ready.**`);

    if (needsKeys.length > 0) {
      lines.push('');
      lines.push('Use /flykeys to set API keys, then /flyrestart to apply.');
    }

    return { text: lines.join('\n') };
  },
};
