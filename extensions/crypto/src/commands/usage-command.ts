/**
 * /usage — LLM usage and cost reporting.
 *
 * Provider-aware: shows real data for Bankr, directs to dashboard for others.
 * Replaces the Bankr-only /llmcost with a unified command.
 *
 * Subcommands:
 *   /usage          — usage summary for active provider
 *   /usage pricing  — show model pricing reference
 *   /usage 7        — Bankr usage for past N days (default 30)
 */

import { getActiveProvider, PROVIDERS } from '../services/keychain-secrets.js';
import {
  fetchBankrUsage,
  PROVIDER_DASHBOARDS,
  PRICING,
  type ModelPricing,
} from '../services/usage-tracker.js';

export const usageNewCommand = {
  name: 'usage',
  description: 'LLM usage, costs, and provider dashboard links',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx: any) => {
    const args = (ctx?.args ?? '').trim();

    // ── /usage pricing ─────────────────────────────────────────────
    if (args === 'pricing' || args === 'prices' || args === 'cost') {
      return { text: formatPricing() };
    }

    const provider = getActiveProvider();
    const providerConfig = (PROVIDERS as Record<string, any>)[provider];
    const label = providerConfig?.label ?? provider;
    const dashboard = PROVIDER_DASHBOARDS[provider] ?? null;
    const hasKey = !!process.env[providerConfig?.envVar ?? ''];

    // ── Bankr: show real usage data ────────────────────────────────
    if (provider === 'bankr' || process.env.BANKR_LLM_KEY) {
      const daysArg = parseInt(args, 10);
      const days = (daysArg > 0 && daysArg <= 90) ? daysArg : 30;

      const data = await fetchBankrUsage(days);
      if (!data) {
        return { text: `Could not fetch Bankr usage. Check BANKR_LLM_KEY.\n\nDashboard: ${PROVIDER_DASHBOARDS.bankr}` };
      }

      const t = data.totals;
      const lines = [
        `**LLM Usage — ${label} (${days} days)**`,
        '',
      ];

      // Show credit balance if available
      if (data.credits) {
        lines.push(`**Balance:** $${data.credits.balance.toFixed(2)}`);
        lines.push('');
      }

      lines.push(
        '**Totals:**',
        `  Requests: ${t.totalRequests.toLocaleString()}`,
        `  Input tokens: ${t.totalInputTokens.toLocaleString()}`,
        `  Output tokens: ${t.totalOutputTokens.toLocaleString()}`,
        `  Cache reads: ${t.totalCacheReadInputTokens.toLocaleString()}`,
        `  Total cost: $${t.totalCost.toFixed(2)}`,
      );

      if (data.byModel.length > 0) {
        lines.push('', '**By model:**');
        const sorted = [...data.byModel].sort((a, b) => b.totalCost - a.totalCost);
        for (const m of sorted) {
          lines.push(`  ${m.model}: ${m.requests.toLocaleString()} reqs, $${m.totalCost.toFixed(2)}`);
        }
      }

      lines.push('', `Dashboard: ${PROVIDER_DASHBOARDS.bankr}`);

      // If active provider is NOT bankr but BANKR_LLM_KEY exists, note it
      if (provider !== 'bankr') {
        lines.unshift(`*Active provider: ${label} — showing Bankr data (has API key)*\n`);
      }

      return { text: lines.join('\n') };
    }

    // ── Other providers: show config + dashboard link ──────────────
    const lines = [
      `**LLM Usage — ${label}**`,
      '',
      `Active provider: **${label}**`,
      `API key: ${hasKey ? 'configured' : 'not set'}`,
    ];

    if (dashboard) {
      lines.push('', `Usage data is available at your provider's dashboard:`, dashboard);
    }

    // Show pricing for reference
    lines.push('', '**Model pricing (per 1M tokens):**');
    const relevantModels = getRelevantModels(provider);
    for (const [model, pricing] of relevantModels) {
      lines.push(`  ${model}: $${pricing.inputPer1M} input / $${pricing.outputPer1M} output`);
    }

    lines.push('', '*Tip: Run `/usage pricing` to see all model prices.*');
    
    // If BANKR_LLM_KEY is set but not active, mention it
    if (process.env.BANKR_LLM_KEY) {
      lines.push('', `*Bankr key detected — run \`/usage\` after \`/api use bankr\` for detailed stats.*`);
    }

    return { text: lines.join('\n') };
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function getRelevantModels(provider: string): Array<[string, ModelPricing]> {
  const entries = Object.entries(PRICING);
  switch (provider) {
    case 'anthropic':
    case 'bankr':
      return entries.filter(([k]) => k.startsWith('claude'));
    case 'openai':
      return entries.filter(([k]) => k.startsWith('gpt') || k.startsWith('o'));
    case 'openrouter':
      return entries; // OpenRouter has all models
    default:
      return entries;
  }
}

function formatPricing(): string {
  const lines = ['**Model Pricing Reference (per 1M tokens)**', ''];

  lines.push('**Anthropic:**');
  for (const [model, p] of Object.entries(PRICING)) {
    if (model.startsWith('claude')) {
      const cache = p.cachePer1M ? ` / $${p.cachePer1M} cache` : '';
      lines.push(`  ${model}: $${p.inputPer1M} in / $${p.outputPer1M} out${cache}`);
    }
  }

  lines.push('', '**OpenAI:**');
  for (const [model, p] of Object.entries(PRICING)) {
    if (model.startsWith('gpt') || model.startsWith('o')) {
      lines.push(`  ${model}: $${p.inputPer1M} in / $${p.outputPer1M} out`);
    }
  }

  lines.push('', '*Prices as of March 2026. Check provider dashboards for current rates.*');
  return lines.join('\n');
}
