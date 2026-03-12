/**
 * /molten command — quick Molten status check.
 *
 * Shows agent profile, claim status, and conversation count.
 * If not configured, shows setup instructions.
 *
 * Uses the real Molten API at api.molten.gg/api/v1.
 */

import { getCredentialVault } from '../services/credential-vault.js';
import { guardedFetch } from '../services/endpoint-allowlist.js';

const MOLTEN_BASE_URL = 'https://api.molten.gg/api/v1';

export const moltenCommand = {
  name: 'molten',
  description: 'Show your Molten agent status',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    const apiKey = getCredentialVault().getSecret('bot.molten.apiKey', 'molten-command');

    if (!apiKey) {
      return {
        text:
          '**Molten is not configured.**\n\n' +
          'Molten is an intent resolution layer for AI agents. ' +
          'Express what you need, Molten finds the best way to fulfill it.\n\n' +
          'Ask me to "register on Molten" to get started, or set your key:\n' +
          '  `/flykeys set MOLTEN_API_KEY your_key`',
      };
    }

    // H8: Removed MOLTEN_BASE_URL env override — prevents credential exfiltration
    // via attacker-controlled URL. Always use the hardcoded production URL.
    const baseUrl = MOLTEN_BASE_URL;

    try {
      // Try /agents/me for profile
      const profileRes = await guardedFetch(`${baseUrl}/agents/me`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
          'X-Client-Type': 'openclawnch',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!profileRes.ok) {
        const data = await profileRes.json().catch(() => ({})) as Record<string, any>;
        const errCode = data?.error?.code;

        if (profileRes.status === 401) {
          return {
            text: '**Molten API key is invalid or expired.**\n\n' +
              'Update: `/flykeys set MOLTEN_API_KEY your_new_key`',
          };
        }

        if (profileRes.status === 403 && errCode === 'AGENT_NOT_CLAIMED') {
          return {
            text: '**Molten agent not claimed yet.**\n\n' +
              'Your agent is registered but needs to be claimed.\n' +
              'Visit the claim URL you received during registration to activate.',
          };
        }

        if (profileRes.status === 404) {
          return {
            text: '**Molten agent not found.**\n\n' +
              'Your API key doesn\'t match a registered agent.\n' +
              'Ask me to "register on Molten" to create a new agent.',
          };
        }

        return {
          text: `Molten error (${profileRes.status}): ${data?.error?.message || profileRes.statusText}`,
        };
      }

      const profile = await profileRes.json() as Record<string, any>;
      const agent = profile?.agent || profile;

      const lines = [
        '**Molten Agent**',
        '',
        `Name: ${agent.name || 'unknown'}`,
        `ID: ${agent.id || 'unknown'}`,
      ];

      if (agent.description) lines.push(`Description: ${agent.description}`);
      if (agent.client_type) lines.push(`Type: ${agent.client_type}`);
      if (agent.wallet_address) lines.push(`Wallet: ${agent.wallet_address.slice(0, 6)}...${agent.wallet_address.slice(-4)}`);
      if (agent.status) lines.push(`Status: ${agent.status}`);
      if (agent.claw_rank_score !== undefined) lines.push(`ClawRank: ${agent.claw_rank_score}/100`);

      // Try to get conversation count
      try {
        const convRes = await guardedFetch(`${baseUrl}/conversations`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (convRes.ok) {
           const convData = await convRes.json() as Record<string, any>;
           const count = convData?.conversations?.length ?? convData?.count ?? 0;
          if (count > 0) {
            lines.push('');
            lines.push(`Active conversations: ${count}`);
          }
        }
      } catch {
        // Skip silently
      }

      // Try to get event count
      try {
        const eventsRes = await guardedFetch(`${baseUrl}/events`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (eventsRes.ok) {
           const eventsData = await eventsRes.json() as Record<string, any>;
           const events = eventsData?.events || [];
          if (events.length > 0) {
            lines.push(`Unread events: ${events.length}`);
          }
        }
      } catch {
        // Skip silently
      }

      lines.push('');
      lines.push('Use "search on Molten for..." or "start a Molten conversation about..." to interact.');

      return { text: lines.join('\n') };
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed') || msg.includes('abort')) {
        return {
          text: '**Molten API unreachable.**\n\n' +
            'Could not connect to api.molten.gg.\n' +
            'Check https://molten.gg for status.',
        };
      }
      return { text: `Molten error: ${msg}` };
    }
  },
};
