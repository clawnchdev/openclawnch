/**
 * Bankr commands.
 *
 * /llmcredits   — Credit balance, top-up link, onboarding guidance
 * /llmcost      — Model-by-model usage breakdown (last N days)
 * /automations  — List active Bankr automations (limit orders, DCA, etc.)
 *
 * LLM commands call llm.bankr.bot. Agent commands call api.bankr.bot.
 */

import { guardedFetch } from '../services/endpoint-allowlist.js';
import { getCredentialVault } from '../services/credential-vault.js';

const BANKR_BASE = 'https://llm.bankr.bot';

function getBankrKey(): string | null {
  return process.env.BANKR_LLM_KEY ?? null;
}

function isBankrProvider(): boolean {
  const provider = process.env.OPENCLAWNCH_LLM_PROVIDER ?? '';
  if (provider === 'bankr') return true;
  return !!process.env.BANKR_LLM_KEY;
}

// ── /llmcredits ─────────────────────────────────────────────────────────────

export const creditsCommand = {
  name: 'llmcredits',
  description: 'Bankr LLM credits, top-up, and setup info',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    // Not configured at all — show full onboarding
    if (!isBankrProvider()) {
      return {
        text: [
          '**Bankr LLM Gateway**',
          '',
          'Pay for AI with crypto. One API key for Claude, Gemini, GPT, and more.',
          '',
          '**Setup (3 steps):**',
          '1. Create account: https://bankr.bot',
          '2. Get an API key with LLM Gateway enabled: https://bankr.bot/api',
          '3. Top up credits (USDC, ETH, or BNKR on Base): https://bankr.bot/llm',
          '',
          'Then add the key:',
          '  `/flykeys set BANKR_LLM_KEY bk_your_key`',
          '  /provider_bankr',
          '',
          'Docs: https://docs.bankr.bot/llm-gateway/overview/',
        ].join('\n'),
      };
    }

    const key = getBankrKey();
    if (!key) {
      return {
        text: [
          'BANKR_LLM_KEY is not set.',
          '',
          'Add it:',
          '  `/flykeys set BANKR_LLM_KEY bk_your_key`',
          '  /flyrestart',
          '',
          'Get a key at: https://bankr.bot/api',
        ].join('\n'),
      };
    }

    // Try to fetch usage data
    try {
      const res = await guardedFetch(`${BANKR_BASE}/v1/usage?days=30`, {
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 403) {
        return {
          text: [
            '**LLM Gateway not enabled on this key**',
            '',
            'Your Bankr API key was recognized but doesn\'t have LLM Gateway access.',
            '',
            '**Fix it:**',
            '1. Go to https://bankr.bot/api',
            '2. Find your API key',
            '3. Enable the "LLM Gateway" toggle',
            '',
            'Then top up credits at: https://bankr.bot/llm',
          ].join('\n'),
        };
      }

      if (res.status === 402) {
        return {
          text: [
            '**LLM Credits: $0.00**',
            '',
            'Your credits are exhausted. The bot can\'t respond until you top up.',
            '',
            '**Options:**',
            '  Top up with crypto: https://bankr.bot/llm',
            '  Switch to Anthropic: /provider_anthropic',
            '',
            'You can also enable auto top-up at bankr.bot/llm so you never run out.',
          ].join('\n'),
        };
      }

      if (res.status === 401) {
        return {
          text: [
            '**Authentication failed**',
            '',
            'Your BANKR_LLM_KEY may be invalid or expired.',
            '',
            'Generate a new key at: https://bankr.bot/api',
            'Then update: `/flykeys set BANKR_LLM_KEY bk_new_key`',
            'Then: /flyrestart',
          ].join('\n'),
        };
      }

      if (!res.ok) {
        return {
          text: `Bankr API returned ${res.status}. Check: https://bankr.bot/llm`,
        };
      }

      const data = await res.json() as any;
      const total = data?.totals;
      const cost30d = total?.totalCost ?? 0;
      const requests30d = total?.totalRequests ?? 0;

      return {
        text: [
          '**Bankr LLM Gateway**',
          '',
          '**Last 30 days:**',
          `  Requests: ${requests30d.toLocaleString()}`,
          `  Cost: $${cost30d.toFixed(2)}`,
          '',
          '**Quick links:**',
          '  Top up credits: https://bankr.bot/llm',
          '  Manage keys: https://bankr.bot/api',
          '  Usage breakdown: /llmcost',
          '  Switch model: /llm',
        ].join('\n'),
      };
    } catch (err) {
      return {
        text: `Failed to reach Bankr: ${err instanceof Error ? err.message : String(err)}\n\nCheck manually: https://bankr.bot/llm`,
      };
    }
  },
};

// ── /llmcost ────────────────────────────────────────────────────────────────

export const usageCommand = {
  name: 'llmcost',
  description: 'Show Bankr LLM usage breakdown by model',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx: any) => {
    if (!isBankrProvider()) {
      return { text: 'Bankr LLM Gateway is not configured. Run /llmcredits for setup instructions.' };
    }

    const key = getBankrKey();
    if (!key) {
      return { text: 'BANKR_LLM_KEY is not set. Run /llmcredits for setup instructions.' };
    }

    const args = (ctx?.args ?? ctx?.text ?? '').trim();
    const daysArg = args.replace(/^\/llmcost\s*/, '').trim();
    const days = Math.min(90, Math.max(1, parseInt(daysArg, 10) || 30));

    try {
      const res = await guardedFetch(`${BANKR_BASE}/v1/usage?days=${days}`, {
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 403) {
        return { text: 'LLM Gateway not enabled on this key. Run /llmcredits for setup instructions.' };
      }

      if (res.status === 402) {
        return { text: 'Credits exhausted. Top up at: https://bankr.bot/llm' };
      }

      if (!res.ok) {
        return { text: `Bankr API returned ${res.status}. Try again later.` };
      }

      const data = await res.json() as any;
      const total = data?.totals;
      const byModel = data?.byModel ?? [];

      const lines = [
        `**Bankr LLM Usage (${days} days)**`,
        '',
        '**Totals:**',
        `  Requests: ${(total?.totalRequests ?? 0).toLocaleString()}`,
        `  Input tokens: ${(total?.totalInputTokens ?? 0).toLocaleString()}`,
        `  Output tokens: ${(total?.totalOutputTokens ?? 0).toLocaleString()}`,
        `  Cache reads: ${(total?.totalCacheReadInputTokens ?? 0).toLocaleString()}`,
        `  Total cost: $${(total?.totalCost ?? 0).toFixed(2)}`,
      ];

      if (byModel.length > 0) {
        lines.push('', '**By model:**');
        const sorted = [...byModel].sort((a: any, b: any) => (b.totalCost ?? 0) - (a.totalCost ?? 0));
        for (const m of sorted) {
          lines.push(`  ${m.model}: ${(m.requests ?? 0).toLocaleString()} reqs, $${(m.totalCost ?? 0).toFixed(2)}`);
        }
      }

      lines.push('', 'Top up: https://bankr.bot/llm');
      return { text: lines.join('\n') };
    } catch (err) {
      return { text: `Failed to reach Bankr: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

// ── /automations ────────────────────────────────────────────────────────────

export const automationsCommand = {
  name: 'automations',
  description: 'List your active Bankr automations (limit orders, DCA, etc.)',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    const apiKey = getCredentialVault().getSecret('bankr.apiKey', 'bankr-commands');
    if (!apiKey) {
      return {
        text: [
          '**Bankr Agent API not configured**',
          '',
          'Automations require a Bankr API key with Agent API enabled.',
          '',
          '1. Get a key at: https://bankr.bot/api',
          '2. Enable "Agent API"',
          '3. `/flykeys set BANKR_API_KEY bk_your_key`',
          '4. /flyrestart then /connect_bankr',
        ].join('\n'),
      };
    }

    try {
      const { bankrPromptAndPoll } = await import('../services/bankr-api.js');
      const result = await bankrPromptAndPoll('show my active automations', { timeoutMs: 30_000 });

      if (result.status === 'failed') {
        return { text: `Failed to fetch automations: ${result.error ?? 'Unknown error'}` };
      }

      return { text: result.response ?? 'No active automations found.' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Agent API not enabled') || msg.includes('403')) {
        return {
          text: 'Agent API not enabled on this key. Enable at: https://bankr.bot/api',
        };
      }
      return { text: `Failed to fetch automations: ${msg}` };
    }
  },
};
