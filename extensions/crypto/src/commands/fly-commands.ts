/**
 * Fly control commands — manage the Fly.io deployment from Telegram.
 *
 * /provider             — Show current LLM provider + switch options
 * /provider anthropic   — Switch to Anthropic (direct)
 * /provider bankr       — Switch to Bankr LLM Gateway
 * /provider openrouter  — Switch to OpenRouter
 *
 * /flykeys              — List configured secrets (names only, never values)
 * /flykeys set KEY val  — Set a secret
 * /flykeys rm KEY       — Remove a secret
 *
 * /flystatus            — Machine status, region, uptime
 *
 * /flyrestart           — Restart the machine (picks up new secrets)
 *
 * SECURITY:
 * - All commands require auth (requireAuth: true)
 * - Requires FLY_API_TOKEN set as a Fly secret
 * - Secret values are write-only (Fly never returns plaintext)
 * - The bot restarts after provider/secret changes (entrypoint.sh re-reads config)
 */

import {
  isFlyControlAvailable,
  getCurrentProvider,
  isValidProvider,
  setProvider,
  scheduleRestart,
  listSecrets,
  setSecrets,
  deleteSecret,
  listMachines,
  restartAllMachines,
  FlyNotConfiguredError,
  type LlmProvider,
} from '../services/fly-control-service.js';

// ─── Setup instructions (shared) ────────────────────────────────────────

const SETUP_TEXT = [
  '**Fly Control not configured**',
  '',
  'To manage your deploy from Telegram, set a Fly API token:',
  '',
  '```',
  'fly tokens create deploy -a openclawnch-tg',
  '# Copy the token, then:',
  'fly secrets set FLY_API_TOKEN="FlyV1 ..." -a openclawnch-tg',
  '```',
  '',
  'After that, /provider, /flykeys, /flystatus, and /flyrestart will work.',
].join('\n');

function notConfigured(): { text: string } {
  return { text: SETUP_TEXT };
}

function formatError(err: unknown): string {
  if (err instanceof FlyNotConfiguredError) return SETUP_TEXT;
  return err instanceof Error ? err.message : String(err);
}

// ─── /provider ──────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (direct)',
  bankr: 'Bankr LLM Gateway (pay with crypto)',
  openrouter: 'OpenRouter',
  openai: 'OpenAI (direct)',
};

const PROVIDER_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  bankr: 'BANKR_LLM_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export const providerCommand = {
  name: 'provider',
  description: 'View current LLM provider and switch options',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    const current = getCurrentProvider();
    const currentLabel = PROVIDER_LABELS[current] ?? current;

    if (!isFlyControlAvailable()) {
      return {
        text: [
          `**LLM Provider:** ${currentLabel}`,
          '',
          '**Switch provider:**',
          '  /provider_anthropic — Claude direct',
          '  /provider_bankr — Bankr Gateway (pay with crypto)',
          '  /provider_openrouter — OpenRouter',
          '',
          'Switching requires Fly control. Set FLY_API_TOKEN first.',
          '',
          'Current model: /llm',
        ].join('\n'),
      };
    }

    return {
      text: [
        `**LLM Provider:** ${currentLabel}`,
        '',
        '**Switch provider:**',
        '  /provider_anthropic — Claude direct',
        '  /provider_bankr — Bankr Gateway (pay with crypto)',
        '  /provider_openrouter — OpenRouter (multi-model)',
        '',
        'Switching restarts the bot (~40s). Model resets to default for the new provider.',
        '',
        'Current model: /llm',
      ].join('\n'),
    };
  },
};

/** Shared handler for /provider_<name> commands. */
async function handleProviderSwitch(providerArg: LlmProvider): Promise<{ text: string }> {
  if (!isFlyControlAvailable()) {
    return notConfigured();
  }

  const current = getCurrentProvider();
  const currentLabel = PROVIDER_LABELS[current] ?? current;

  if (providerArg === current) {
    return { text: `Already using ${currentLabel}. No change needed.` };
  }

  const requiredKey = PROVIDER_KEYS[providerArg];
  if (requiredKey && !process.env[requiredKey]) {
    return {
      text: [
        `**Missing API key for ${PROVIDER_LABELS[providerArg] ?? providerArg}**`,
        '',
        `Set \`${requiredKey}\` first, then try again.`,
        `(Use /flykeys to manage API keys)`,
      ].join('\n'),
    };
  }

  try {
    const targetLabel = PROVIDER_LABELS[providerArg] ?? providerArg;
    const secretsVersion = await setProvider(providerArg);
    scheduleRestart(2000, secretsVersion);
    return {
      text: `Switching to **${targetLabel}**. Restarting agent, please wait...\n\nThe bot will be back in ~40 seconds.`,
    };
  } catch (err) {
    return { text: `Failed to switch provider: ${formatError(err)}` };
  }
}

export const providerAnthropicCommand = {
  name: 'provider_anthropic',
  description: 'Switch LLM to Anthropic (direct)',
  acceptsArgs: false,
  requireAuth: true,
  handler: async () => handleProviderSwitch('anthropic'),
};

export const providerBankrCommand = {
  name: 'provider_bankr',
  description: 'Switch LLM to Bankr Gateway (pay with crypto)',
  acceptsArgs: false,
  requireAuth: true,
  handler: async () => handleProviderSwitch('bankr'),
};

export const providerOpenrouterCommand = {
  name: 'provider_openrouter',
  description: 'Switch LLM to OpenRouter',
  acceptsArgs: false,
  requireAuth: true,
  handler: async () => handleProviderSwitch('openrouter'),
};

// ─── /flykeys ───────────────────────────────────────────────────────────

// Secrets that should never be shown or modified from Telegram
const PROTECTED_SECRETS = new Set([
  'FLY_API_TOKEN',         // Modifying this would lock yourself out
  'TELEGRAM_BOT_TOKEN',    // Breaking this kills the bot
]);

// Secrets that are safe to display are set from Telegram
const KNOWN_SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'Anthropic direct key',
  BANKR_LLM_KEY: 'Bankr LLM Gateway key',
  BANKR_API_KEY: 'Bankr Agent API key',
  OPENROUTER_API_KEY: 'OpenRouter key',
  OPENAI_API_KEY: 'OpenAI direct key',
  OPENCLAWNCH_LLM_PROVIDER: 'LLM provider (anthropic/bankr/openrouter)',
  WALLETCONNECT_PROJECT_ID: 'WalletConnect project ID',
  CLAWNCHER_PRIVATE_KEY: 'Private key (autosign)',
  CLAWNCHER_RPC_URL: 'Custom RPC URL',
  HERD_ACCESS_TOKEN: 'Herd Intelligence token',
  HUMMINGBOT_API_URL: 'Hummingbot API URL',
  MOLTEN_API_KEY: 'Molten API key',
};

export const flykeysCommand = {
  name: 'flykeys',
  description: 'List, set, or remove Fly secrets (e.g. /flykeys set KEY value)',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx: any) => {
    if (!isFlyControlAvailable()) return notConfigured();

    const args = (ctx?.args ?? ctx?.text ?? '').trim();
    const parts = args.replace(/^\/flykeys\s*/, '').trim().split(/\s+/);
    const action = parts[0]?.toLowerCase() ?? '';

    // /flykeys — list
    if (!action) {
      try {
        const secrets = await listSecrets();
        if (secrets.length === 0) {
          return { text: 'No secrets configured.' };
        }

        const lines = ['**Configured Secrets:**', ''];
        for (const s of secrets) {
          const label = KNOWN_SECRETS[s.name];
          const protected_ = PROTECTED_SECRETS.has(s.name) ? ' (protected)' : '';
          lines.push(`  \`${s.name}\`${label ? ` — ${label}` : ''}${protected_}`);
        }

        lines.push(
          '',
          '**Set a secret:**',
          '  `/flykeys set KEY value`',
          '',
          '**Remove a secret:**',
          '  `/flykeys rm KEY`',
          '',
          'Changes take effect after /flyrestart',
        );
        return { text: lines.join('\n') };
      } catch (err) {
        return { text: `Failed to list secrets: ${formatError(err)}` };
      }
    }

    // /flykeys set KEY value
    if (action === 'set') {
      const key = parts[1]?.toUpperCase();
      // Value is everything after the key (may contain spaces)
      const value = parts.slice(2).join(' ');

      if (!key || !value) {
        return {
          text: [
            '**Usage:** `/flykeys set KEY value`',
            '',
            '**Examples:**',
            '  `/flykeys set BANKR_LLM_KEY bk_abc123`',
            '  `/flykeys set ANTHROPIC_API_KEY sk-ant-abc123`',
            '  `/flykeys set OPENCLAWNCH_LLM_PROVIDER bankr`',
          ].join('\n'),
        };
      }

      if (PROTECTED_SECRETS.has(key)) {
        return { text: `\`${key}\` is protected and cannot be modified from Telegram. Use the Fly CLI.` };
      }

      // H1 FIX: Allowlist — only permit known secret keys to prevent arbitrary env var injection
      if (!KNOWN_SECRETS[key]) {
        return {
          text: `\`${key}\` is not a recognized secret. Only these keys can be set:\n\n${Object.entries(KNOWN_SECRETS).map(([k, v]) => `  \`${k}\` — ${v}`).join('\n')}`,
        };
      }

      try {
        await setSecrets({ [key]: value });

        const needsRestart = key !== 'OPENCLAWNCH_LLM_PROVIDER';
        const hint = needsRestart
          ? '\n\nRun /flyrestart to pick up the new value.'
          : '\n\nUse /provider to switch (it auto-restarts).';

        return { text: `Secret \`${key}\` set successfully.${hint}` };
      } catch (err) {
        return { text: `Failed to set secret: ${formatError(err)}` };
      }
    }

    // /flykeys rm KEY
    if (action === 'rm' || action === 'remove' || action === 'delete') {
      const key = parts[1]?.toUpperCase();

      if (!key) {
        return { text: '**Usage:** `/flykeys rm KEY`' };
      }

      if (PROTECTED_SECRETS.has(key)) {
        return { text: `\`${key}\` is protected and cannot be removed from Telegram. Use the Fly CLI.` };
      }

      try {
        await deleteSecret(key);
        return { text: `Secret \`${key}\` removed.\n\nRun /flyrestart to pick up the change.` };
      } catch (err) {
        return { text: `Failed to remove secret: ${formatError(err)}` };
      }
    }

    return {
      text: [
        '**Unknown action:** ' + action,
        '',
        '**Usage:**',
        '  /flykeys — list all secrets',
        '  `/flykeys set KEY value` — set a secret',
        '  `/flykeys rm KEY` — remove a secret',
      ].join('\n'),
    };
  },
};

// ─── /flystatus ─────────────────────────────────────────────────────────

export const flystatusCommand = {
  name: 'flystatus',
  description: 'Show machine status, region, and uptime',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    if (!isFlyControlAvailable()) return notConfigured();

    try {
      const machines = await listMachines();

      if (machines.length === 0) {
        return { text: 'No machines found for this app.' };
      }

      const lines = [
        `**OpenClawnch Deploy Status**`,
        `App: \`${process.env.FLY_APP_NAME}\``,
        '',
      ];

      for (const m of machines) {
        const uptime = m.updatedAt ? timeSince(m.updatedAt) : 'unknown';
        const stateEmoji = m.state === 'started' ? 'running' : m.state;

        lines.push(
          `**Machine:** \`${m.id}\``,
          `  State: ${stateEmoji}`,
          `  Region: ${m.region}`,
          `  CPU: ${m.cpuKind} ${m.cpus}x / ${m.memoryMb}MB RAM`,
          `  Last update: ${uptime} ago`,
          '',
        );
      }

      lines.push(
        '**Quick actions:**',
        '  /flyrestart — restart the bot',
        '  /provider — switch LLM provider',
        '  /flykeys — manage API keys',
      );

      return { text: lines.join('\n') };
    } catch (err) {
      return { text: `Failed to get status: ${formatError(err)}` };
    }
  },
};

// ─── /flyrestart ────────────────────────────────────────────────────────

export const flyrestartCommand = {
  name: 'flyrestart',
  description: 'Restart the bot (picks up new secrets)',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    if (!isFlyControlAvailable()) return notConfigured();

    // Schedule restart after response is delivered
    scheduleRestart(2000);

    return {
      text: 'Restarting agent, please wait...\n\nThe bot will be back in ~40 seconds.',
    };
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function timeSince(dateStr: string): string {
  try {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diff = now - then;

    if (diff < 0) return 'just now';

    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;

    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  } catch {
    return 'unknown';
  }
}
