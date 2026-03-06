/**
 * /llm command — view or switch the LLM model at runtime.
 *
 * Usage:
 *   /llm              — show current model + available shortcuts
 *   /llm opus         — switch to Claude Opus 4.6
 *   /llm sonnet       — switch to Claude Sonnet 4.6
 *   /llm gemini       — switch to Gemini 3 Pro
 *   /llm gpt          — switch to GPT-5.2
 *   /llm <full-name>  — switch to any model
 *
 * Supports both direct Anthropic/OpenRouter keys and Bankr LLM Gateway.
 * When provider is "bankr", model IDs use Bankr format (e.g. bankr/claude-opus-4.6).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_PATH = join(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');

/**
 * Detect which LLM provider is active.
 * Priority: OPENCLAWNCH_LLM_PROVIDER env > infer from current model string > 'anthropic'
 */
function getProvider(): 'anthropic' | 'openrouter' | 'bankr' | 'openai' {
  const explicit = process.env.OPENCLAWNCH_LLM_PROVIDER;
  if (explicit === 'bankr' || explicit === 'openrouter' || explicit === 'openai') return explicit;
  if (explicit === 'anthropic') return 'anthropic';

  // Infer from current model
  const current = getCurrentModel();
  if (current.startsWith('bankr/')) return 'bankr';
  if (current.startsWith('openrouter/')) return 'openrouter';
  if (current.startsWith('openai/')) return 'openai';
  return 'anthropic';
}

// ─── Model Shortcuts ─────────────────────────────────────────────────
// Maps friendly names to provider-specific model IDs.
// Format: { shortcut: { anthropic, openrouter, bankr } }
interface ModelIds {
  anthropic: string;
  openrouter: string;
  bankr: string;
}

const MODEL_MAP: Record<string, ModelIds> = {
  // Claude
  'opus':           { anthropic: 'anthropic/claude-opus-4-6',              openrouter: 'openrouter/anthropic/claude-opus-4-6',              bankr: 'bankr/claude-opus-4.6' },
  'opus4.6':        { anthropic: 'anthropic/claude-opus-4-6',              openrouter: 'openrouter/anthropic/claude-opus-4-6',              bankr: 'bankr/claude-opus-4.6' },
  'opus4.5':        { anthropic: 'anthropic/claude-opus-4-5',              openrouter: 'openrouter/anthropic/claude-opus-4-5',              bankr: 'bankr/claude-opus-4.5' },
  'sonnet':         { anthropic: 'anthropic/claude-sonnet-4-20250514',     openrouter: 'openrouter/anthropic/claude-sonnet-4-20250514',     bankr: 'bankr/claude-sonnet-4.6' },
  'sonnet4.6':      { anthropic: 'anthropic/claude-sonnet-4-20250514',     openrouter: 'openrouter/anthropic/claude-sonnet-4-20250514',     bankr: 'bankr/claude-sonnet-4.6' },
  'sonnet4.5':      { anthropic: 'anthropic/claude-sonnet-4-5-20250514',   openrouter: 'openrouter/anthropic/claude-sonnet-4-5-20250514',   bankr: 'bankr/claude-sonnet-4.5' },
  'haiku':          { anthropic: 'anthropic/claude-haiku-3-20250514',      openrouter: 'openrouter/anthropic/claude-haiku-3-20250514',      bankr: 'bankr/claude-haiku-4.5' },

  // Gemini (Bankr-only, but still resolve for other providers via OpenRouter)
  'gemini':         { anthropic: 'bankr/gemini-3-pro',    openrouter: 'openrouter/google/gemini-3-pro',    bankr: 'bankr/gemini-3-pro' },
  'gemini-pro':     { anthropic: 'bankr/gemini-3-pro',    openrouter: 'openrouter/google/gemini-3-pro',    bankr: 'bankr/gemini-3-pro' },
  'gemini-flash':   { anthropic: 'bankr/gemini-3-flash',  openrouter: 'openrouter/google/gemini-3-flash',  bankr: 'bankr/gemini-3-flash' },
  'gemini3':        { anthropic: 'bankr/gemini-3-pro',    openrouter: 'openrouter/google/gemini-3-pro',    bankr: 'bankr/gemini-3-pro' },
  'gemini2.5':      { anthropic: 'bankr/gemini-2.5-pro',  openrouter: 'openrouter/google/gemini-2.5-pro',  bankr: 'bankr/gemini-2.5-pro' },
  'gemini2.5-flash':{ anthropic: 'bankr/gemini-2.5-flash',openrouter: 'openrouter/google/gemini-2.5-flash',bankr: 'bankr/gemini-2.5-flash' },

  // GPT (Bankr-only)
  'gpt':            { anthropic: 'bankr/gpt-5.2',         openrouter: 'openrouter/openai/gpt-5.2',         bankr: 'bankr/gpt-5.2' },
  'gpt5':           { anthropic: 'bankr/gpt-5.2',         openrouter: 'openrouter/openai/gpt-5.2',         bankr: 'bankr/gpt-5.2' },
  'gpt5.2':         { anthropic: 'bankr/gpt-5.2',         openrouter: 'openrouter/openai/gpt-5.2',         bankr: 'bankr/gpt-5.2' },
  'codex':          { anthropic: 'bankr/gpt-5.2-codex',   openrouter: 'openrouter/openai/gpt-5.2-codex',   bankr: 'bankr/gpt-5.2-codex' },
  'gpt-mini':       { anthropic: 'bankr/gpt-5-mini',      openrouter: 'openrouter/openai/gpt-5-mini',      bankr: 'bankr/gpt-5-mini' },
  'gpt-nano':       { anthropic: 'bankr/gpt-5-nano',      openrouter: 'openrouter/openai/gpt-5-nano',      bankr: 'bankr/gpt-5-nano' },

  // Other (Bankr-only)
  'kimi':           { anthropic: 'bankr/kimi-k2.5',       openrouter: 'openrouter/moonshotai/kimi-k2.5',   bankr: 'bankr/kimi-k2.5' },
  'qwen':           { anthropic: 'bankr/qwen3-coder',     openrouter: 'openrouter/qwen/qwen3-coder',       bankr: 'bankr/qwen3-coder' },
};

function getCurrentModel(): string {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return cfg?.agents?.defaults?.model?.primary ?? 'unknown';
  } catch {
    return 'unknown (config not readable)';
  }
}

function setModel(modelId: string): void {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  cfg.agents = cfg.agents ?? {};
  cfg.agents.defaults = cfg.agents.defaults ?? {};
  cfg.agents.defaults.model = cfg.agents.defaults.model ?? {};
  cfg.agents.defaults.model.primary = modelId;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// H7: Validate model IDs to prevent injection via config file writes
const SAFE_MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-\/]{0,120}$/;

function validateModelId(input: string): string {
  if (!SAFE_MODEL_ID_RE.test(input)) {
    throw new Error(`Invalid model ID: "${input.slice(0, 30)}". Only alphanumeric, dots, hyphens, underscores, and slashes are allowed.`);
  }
  return input;
}

/** Resolve a shortcut or raw model name to the correct provider-prefixed ID. */
function resolveModel(input: string): string {
  const provider = getProvider();
  const mapping = MODEL_MAP[input];
  if (mapping) {
    return validateModelId(mapping[provider] ?? mapping.bankr);
  }
  // Not a shortcut — validate and use as-is, but prefix if needed
  validateModelId(input);
  if (provider === 'bankr' && !input.includes('/')) {
    return `bankr/${input}`;
  }
  if (provider === 'openrouter' && !input.startsWith('openrouter/')) {
    if (input.startsWith('anthropic/') || input.startsWith('openai/') || input.startsWith('google/')) {
      return `openrouter/${input}`;
    }
  }
  return input;
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic (direct)',
  openrouter: 'OpenRouter',
  bankr: 'Bankr LLM Gateway',
  openai: 'OpenAI (direct)',
};

export const modelCommand = {
  name: 'llm',
  description: 'View or switch the LLM model (e.g. /llm sonnet)',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx: any) => {
    const args = (ctx?.args ?? ctx?.text ?? '').trim().toLowerCase();
    const modelArg = args.replace(/^\/llm\s*/, '').trim();

    const provider = getProvider();
    const providerName = PROVIDER_LABEL[provider] ?? provider;

    if (!modelArg) {
      const current = getCurrentModel();
      const isBankr = provider === 'bankr';

      let text = `Current model: ${current}\nProvider: ${providerName}\n\n`;
      text += '**Claude**\n';
      text += '  /llm_opus — Opus 4.6 (most capable)\n';
      text += '  /llm_sonnet — Sonnet 4.6 (fast + capable)\n';
      text += '  /llm_haiku — Haiku 4.5 (fastest Claude)\n';

      if (isBankr) {
        text += '\n**Gemini**\n';
        text += '  /llm_gemini — Gemini 3 Pro\n';
        text += '  /llm_gemini_flash — Gemini 3 Flash\n';
        text += '\n**GPT**\n';
        text += '  /llm_gpt — GPT-5.2\n';
        text += '  /llm_codex — GPT-5.2 Codex\n';
        text += '  /llm_gpt_mini — GPT-5 Mini\n';
        text += '  /llm_gpt_nano — GPT-5 Nano\n';
        text += '\n**Other**\n';
        text += '  /llm_kimi — Kimi K2.5\n';
        text += '  /llm_qwen — Qwen3 Coder\n';
        text += '\nCheck credits: /llmcredits\nUsage breakdown: /llmcost';
      }

      text += '\n\nOr use a full model ID: `/llm <model-id>`';
      return { text };
    }

    // Normalize underscores to hyphens for tappable slash commands
    // e.g. /llm gemini_flash → gemini-flash
    const normalized = modelArg.replace(/_/g, '-');
    const finalModel = resolveModel(normalized);

    try {
      const previousModel = getCurrentModel();
      setModel(finalModel);
      return {
        text: `Model switched.\n\n  Before: ${previousModel}\n  Now: ${finalModel}\n\nTakes effect on your next message.`,
      };
    } catch (err) {
      return {
        text: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ─── Tappable /llm_<model> shortcut commands ────────────────────────────
// Each delegates to the main handler with the model name as args.

const LLM_SHORTCUTS: Array<{ name: string; model: string; label: string }> = [
  { name: 'llm_opus', model: 'opus', label: 'Claude Opus 4.6' },
  { name: 'llm_sonnet', model: 'sonnet', label: 'Claude Sonnet 4.6' },
  { name: 'llm_haiku', model: 'haiku', label: 'Claude Haiku 4.5' },
  { name: 'llm_gemini', model: 'gemini', label: 'Gemini 3 Pro' },
  { name: 'llm_gemini_flash', model: 'gemini-flash', label: 'Gemini 3 Flash' },
  { name: 'llm_gpt', model: 'gpt', label: 'GPT-5.2' },
  { name: 'llm_codex', model: 'codex', label: 'GPT-5.2 Codex' },
  { name: 'llm_gpt_mini', model: 'gpt-mini', label: 'GPT-5 Mini' },
  { name: 'llm_gpt_nano', model: 'gpt-nano', label: 'GPT-5 Nano' },
  { name: 'llm_kimi', model: 'kimi', label: 'Kimi K2.5' },
  { name: 'llm_qwen', model: 'qwen', label: 'Qwen3 Coder' },
];

export const llmShortcutCommands = LLM_SHORTCUTS.map(({ name, model, label }) => ({
  name,
  description: `Switch to ${label}`,
  acceptsArgs: false,
  requireAuth: true,
  handler: async () => modelCommand.handler({ args: model }),
}));
