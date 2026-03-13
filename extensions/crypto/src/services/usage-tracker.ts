/**
 * Usage Tracker — provider-aware LLM usage reporting.
 *
 * For Bankr: fetches real usage data from their API.
 * For other providers: reports active config + links to their dashboard
 * (we can't get real token counts from the plugin layer).
 *
 * Pricing reference table for cost awareness.
 */

import { getActiveProvider, PROVIDERS } from './keychain-secrets.js';
import { guardedFetch } from './endpoint-allowlist.js';
import { getCredentialVault } from './credential-vault.js';

// ─── Pricing (per 1M tokens, USD) ────────────────────────────────────────

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachePer1M?: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':     { inputPer1M: 15,    outputPer1M: 75,   cachePer1M: 1.875 },
  'claude-sonnet-4-6':   { inputPer1M: 3,     outputPer1M: 15,   cachePer1M: 0.375 },
  'claude-haiku-3-5':    { inputPer1M: 0.8,   outputPer1M: 4,    cachePer1M: 0.1 },
  'gpt-4o':              { inputPer1M: 2.5,   outputPer1M: 10 },
  'gpt-4o-mini':         { inputPer1M: 0.15,  outputPer1M: 0.6 },
  'o3':                  { inputPer1M: 10,     outputPer1M: 40 },
};

// ─── Provider dashboards ─────────────────────────────────────────────────

export const PROVIDER_DASHBOARDS: Record<string, string> = {
  anthropic:    'https://console.anthropic.com/settings/billing',
  openrouter:   'https://openrouter.ai/credits',
  openai:       'https://platform.openai.com/usage',
  bankr:        'https://bankr.bot/llm',
  'bankr-agent': 'https://bankr.bot',
};

// ─── Bankr usage fetch ──────────────────────────────────────────────────

const BANKR_BASE = 'https://llm.bankr.bot';

export interface BankrUsageData {
  totals: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadInputTokens: number;
    totalCost: number;
  };
  byModel: Array<{
    model: string;
    requests: number;
    totalCost: number;
  }>;
  credits?: {
    balance: number;
  };
}

/**
 * Fetch real usage data from Bankr LLM API.
 * Returns null if Bankr is not configured or the call fails.
 */
export async function fetchBankrUsage(days = 30): Promise<BankrUsageData | null> {
  const key = process.env.BANKR_LLM_KEY;
  if (!key) return null;

  try {
    const [usageRes, creditsRes] = await Promise.all([
      guardedFetch(`${BANKR_BASE}/v1/usage?days=${days}`, {
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }),
      guardedFetch(`${BANKR_BASE}/v1/credits`, {
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }),
    ]);

    if (!usageRes.ok) return null;
    const data = await usageRes.json() as any;
    
    let credits: { balance: number } | undefined;
    if (creditsRes.ok) {
      const creditsData = await creditsRes.json() as any;
      credits = { balance: creditsData?.balance ?? creditsData?.credits ?? 0 };
    }

    return {
      totals: data.totals ?? { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCost: 0 },
      byModel: data.byModel ?? [],
      credits,
    };
  } catch {
    return null;
  }
}
