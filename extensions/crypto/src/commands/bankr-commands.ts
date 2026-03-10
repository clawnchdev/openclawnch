/**
 * Bankr commands.
 *
 * /llmcredits   — Credit balance, top-up link, onboarding guidance
 * /llmcost      — Model-by-model usage breakdown (last N days)
 * /automations  — List active Bankr automations (limit orders, DCA, etc.)
 * /topup        — Top up LLM credits from Bankr wallet (via Agent API)
 * /autotopup    — View or configure auto top-up for LLM credits
 *
 * LLM commands call llm.bankr.bot. Agent commands call api.bankr.bot.
 * Credit mutations (topup, autotopup) route through the Agent API's
 * prompt-and-poll pattern since they involve wallet transactions.
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

/** Try to fetch credit balance from the LLM gateway. Returns null on failure. */
async function fetchCreditBalance(key: string): Promise<{ balance: number; currency: string } | null> {
  try {
    const res = await guardedFetch(`${BANKR_BASE}/v1/credits`, {
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    // Accept various response shapes
    const balance = data?.balance ?? data?.credits ?? data?.remaining ?? null;
    if (typeof balance !== 'number') return null;
    return { balance, currency: data?.currency ?? 'USD' };
  } catch {
    return null;
  }
}

/** Try to fetch auto top-up config from the LLM gateway. Returns null on failure. */
async function fetchAutoTopupConfig(key: string): Promise<{
  enabled: boolean; amount?: number; threshold?: number; tokens?: string[];
} | null> {
  try {
    const res = await guardedFetch(`${BANKR_BASE}/v1/credits/auto`, {
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return {
      enabled: !!data?.enabled,
      amount: data?.amount,
      threshold: data?.threshold,
      tokens: data?.tokens,
    };
  } catch {
    return null;
  }
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

      // Try to get the actual credit balance
      const creditInfo = await fetchCreditBalance(key);
      // Try to get auto top-up config
      const autoConfig = await fetchAutoTopupConfig(key);

      const lines = ['**Bankr LLM Gateway**', ''];

      // Credit balance (if available)
      if (creditInfo) {
        lines.push(`**Credit Balance: $${creditInfo.balance.toFixed(2)}**`);
        if (creditInfo.balance < 5) {
          lines.push('  Low balance! Top up: /topup 25');
        }
        lines.push('');
      }

      lines.push(
        '**Last 30 days:**',
        `  Requests: ${requests30d.toLocaleString()}`,
        `  Cost: $${cost30d.toFixed(2)}`,
        '',
      );

      // Auto top-up status
      if (autoConfig) {
        if (autoConfig.enabled) {
          lines.push(
            '**Auto Top-up: ON**',
            `  Amount: $${autoConfig.amount ?? '?'} when below $${autoConfig.threshold ?? '?'}`,
            `  Token: ${autoConfig.tokens?.join(', ') ?? 'USDC'}`,
          );
        } else {
          lines.push('**Auto Top-up: OFF** (enable with /autotopup enable)');
        }
        lines.push('');
      }

      lines.push(
        '**Commands:**',
        '  /topup 25 — Add $25 credits from wallet',
        '  /autotopup — Configure auto top-up',
        '  /llmcost — Usage breakdown by model',
        '  /llm — Switch model',
        '',
        '**Links:**',
        '  Dashboard: https://bankr.bot/llm',
        '  Manage keys: https://bankr.bot/api',
      );

      return { text: lines.join('\n') };
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

// ── /topup ──────────────────────────────────────────────────────────────────

export const topupCommand = {
  name: 'topup',
  description: 'Top up LLM credits from your Bankr wallet',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx: any) => {
    // Need Agent API for wallet operations
    const apiKey = getCredentialVault().getSecret('bankr.apiKey', 'bankr-commands');
    if (!apiKey) {
      return {
        text: [
          '**Bankr Agent API not configured**',
          '',
          'Topping up credits requires a Bankr API key with Agent API enabled.',
          '',
          '1. Get a key at: https://bankr.bot/api',
          '2. Enable "Agent API"',
          '3. `/flykeys set BANKR_API_KEY bk_your_key`',
          '4. /flyrestart then /connect_bankr',
          '',
          'Or top up via the web: https://bankr.bot/llm?tab=credits',
        ].join('\n'),
      };
    }

    // Parse arguments: /topup <amount> [token]
    const rawArgs = (ctx?.args ?? ctx?.text ?? '').trim();
    const argStr = rawArgs.replace(/^\/topup\s*/, '').trim();
    const parts = argStr.split(/\s+/);
    const amountStr = parts[0] ?? '';
    const token = parts[1] ?? 'USDC';

    const amount = parseFloat(amountStr);
    if (!amountStr || isNaN(amount) || amount <= 0) {
      return {
        text: [
          '**Usage:** `/topup <amount> [token]`',
          '',
          '**Examples:**',
          '  `/topup 25` — Add $25 credits (USDC)',
          '  `/topup 50 ETH` — Add $50 credits (pay with ETH)',
          '  `/topup 10 BNKR` — Add $10 credits (pay with BNKR)',
          '',
          'Credits are deducted from your Bankr wallet balance.',
          'Check balance: /llmcredits',
        ].join('\n'),
      };
    }

    if (amount > 1000) {
      return { text: 'Maximum single top-up is $1000. For larger amounts, top up multiple times or use the dashboard: https://bankr.bot/llm' };
    }

    try {
      const { bankrPromptAndPoll } = await import('../services/bankr-api.js');

      const prompt = token.toUpperCase() === 'USDC'
        ? `add $${amount} to my LLM credits`
        : `add $${amount} to my LLM credits using ${token}`;

      const result = await bankrPromptAndPoll(prompt, { timeoutMs: 60_000 });

      if (result.status === 'failed') {
        const error = result.error ?? 'Unknown error';
        if (error.includes('insufficient') || error.includes('balance')) {
          return {
            text: [
              `**Top-up failed:** Insufficient ${token} balance`,
              '',
              `Your Bankr wallet needs at least $${amount} in ${token} to complete this top-up.`,
              '',
              'Check your wallet balance or top up via the web: https://bankr.bot/llm?tab=credits',
            ].join('\n'),
          };
        }
        return { text: `**Top-up failed:** ${error}` };
      }

      return {
        text: [
          `**Credits topped up: +$${amount}**`,
          '',
          result.response ?? `$${amount} added to your LLM credits from ${token}.`,
          '',
          'Check balance: /llmcredits',
        ].join('\n'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Agent API not enabled') || msg.includes('403')) {
        return { text: 'Agent API not enabled on this key. Enable at: https://bankr.bot/api' };
      }
      return { text: `**Top-up failed:** ${msg}\n\nTry the web dashboard: https://bankr.bot/llm?tab=credits` };
    }
  },
};

// ── /autotopup ──────────────────────────────────────────────────────────────

export const autotopupCommand = {
  name: 'autotopup',
  description: 'View or configure automatic LLM credit top-up',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx: any) => {
    if (!isBankrProvider()) {
      return { text: 'Bankr LLM Gateway is not configured. Run /llmcredits for setup instructions.' };
    }

    const rawArgs = (ctx?.args ?? ctx?.text ?? '').trim();
    const argStr = rawArgs.replace(/^\/autotopup\s*/, '').trim();
    const parts = argStr.split(/\s+/);
    const subcommand = (parts[0] ?? '').toLowerCase();

    // ── No args: show current config ──
    if (!subcommand) {
      // Try the LLM gateway first for structured data
      const key = getBankrKey();
      if (key) {
        const config = await fetchAutoTopupConfig(key);
        if (config) {
          if (config.enabled) {
            return {
              text: [
                '**Auto Top-up: ON**',
                '',
                `  Amount: $${config.amount ?? '?'}`,
                `  Threshold: $${config.threshold ?? '?'} (tops up when balance drops below this)`,
                `  Token: ${config.tokens?.join(', ') ?? 'USDC'}`,
                '',
                '**Manage:**',
                '  `/autotopup disable` — Turn off auto top-up',
                '  `/autotopup enable 25 5 USDC` — Set: $25 when below $5, pay with USDC',
              ].join('\n'),
            };
          }
          return {
            text: [
              '**Auto Top-up: OFF**',
              '',
              'Your credits will not be automatically replenished.',
              '',
              '**Enable:**',
              '  `/autotopup enable` — Enable with defaults ($25 when below $5, USDC)',
              '  `/autotopup enable 50 10 ETH` — $50 when below $10, pay with ETH',
              '',
              'Or configure at: https://bankr.bot/llm',
            ].join('\n'),
          };
        }
      }

      // Fallback: try agent API
      const apiKey = getCredentialVault().getSecret('bankr.apiKey', 'bankr-commands');
      if (apiKey) {
        try {
          const { bankrPromptAndPoll } = await import('../services/bankr-api.js');
          const result = await bankrPromptAndPoll('show my LLM auto top-up configuration', { timeoutMs: 30_000 });
          if (result.status !== 'failed' && result.response) {
            return { text: result.response };
          }
        } catch { /* fall through */ }
      }

      return {
        text: [
          '**Auto Top-up**',
          '',
          'Could not fetch current config. Manage at: https://bankr.bot/llm',
          '',
          '**Commands:**',
          '  `/autotopup enable` — Enable with defaults',
          '  `/autotopup enable 25 5 USDC` — $25 when below $5, pay USDC',
          '  `/autotopup disable` — Turn off',
        ].join('\n'),
      };
    }

    // ── Enable / Disable: route through Agent API ──
    const apiKey = getCredentialVault().getSecret('bankr.apiKey', 'bankr-commands');
    if (!apiKey) {
      return {
        text: [
          '**Bankr Agent API required**',
          '',
          'Configuring auto top-up requires the Agent API.',
          '1. Get a key at: https://bankr.bot/api',
          '2. `/flykeys set BANKR_API_KEY bk_your_key`',
          '3. /flyrestart',
          '',
          'Or configure at: https://bankr.bot/llm',
        ].join('\n'),
      };
    }

    if (subcommand === 'disable' || subcommand === 'off') {
      try {
        const { bankrPromptAndPoll } = await import('../services/bankr-api.js');
        const result = await bankrPromptAndPoll('disable my LLM auto top-up', { timeoutMs: 30_000 });
        if (result.status === 'failed') {
          return { text: `**Failed:** ${result.error ?? 'Unknown error'}\n\nTry: https://bankr.bot/llm` };
        }
        return {
          text: [
            '**Auto top-up disabled.**',
            '',
            result.response ?? 'Your LLM credits will no longer be automatically replenished.',
            '',
            'Re-enable anytime: `/autotopup enable`',
          ].join('\n'),
        };
      } catch (err) {
        return { text: `**Failed:** ${err instanceof Error ? err.message : String(err)}\n\nTry: https://bankr.bot/llm` };
      }
    }

    if (subcommand === 'enable' || subcommand === 'on') {
      // Parse optional: /autotopup enable [amount] [threshold] [token]
      const amount = parseFloat(parts[1] ?? '') || 25;
      const threshold = parseFloat(parts[2] ?? '') || 5;
      const token = parts[3] ?? 'USDC';

      try {
        const { bankrPromptAndPoll } = await import('../services/bankr-api.js');
        const prompt = `enable LLM auto top-up: add $${amount} ${token} when my LLM credits drop below $${threshold}`;
        const result = await bankrPromptAndPoll(prompt, { timeoutMs: 30_000 });
        if (result.status === 'failed') {
          return { text: `**Failed:** ${result.error ?? 'Unknown error'}\n\nTry: https://bankr.bot/llm` };
        }
        return {
          text: [
            '**Auto top-up enabled!**',
            '',
            result.response ?? `Will add $${amount} in ${token} when credits drop below $${threshold}.`,
            '',
            'View config: /autotopup',
            'Disable: `/autotopup disable`',
          ].join('\n'),
        };
      } catch (err) {
        return { text: `**Failed:** ${err instanceof Error ? err.message : String(err)}\n\nTry: https://bankr.bot/llm` };
      }
    }

    return {
      text: [
        '**Usage:** `/autotopup [enable|disable] [amount] [threshold] [token]`',
        '',
        '**Examples:**',
        '  `/autotopup` — Show current config',
        '  `/autotopup enable` — Enable with defaults ($25 when below $5, USDC)',
        '  `/autotopup enable 50 10 ETH` — $50 when below $10, pay with ETH',
        '  `/autotopup disable` — Turn off auto top-up',
      ].join('\n'),
    };
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
