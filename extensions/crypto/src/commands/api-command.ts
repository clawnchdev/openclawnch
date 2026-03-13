/**
 * API key management command.
 *
 * /api              — List configured providers + active provider
 * /api set <p> <k>  — Store an API key for a provider in macOS Keychain
 * /api rm <p>       — Remove a stored key
 * /api use <p>      — Switch the active LLM provider
 */

import {
  PROVIDERS, storeApiKey, removeApiKey, listStoredProviders,
  getActiveProvider, setActiveProvider, maskKey, loadApiKey,
} from '../services/keychain-secrets.js';

export const apiCommand = {
  name: 'api',
  description: 'Manage LLM API keys: /api, /api set <provider> <key>, /api rm <provider>, /api use <provider>',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx?: any) => {
    const rawArgs = (ctx?.args ?? '').trim();
    const parts = rawArgs.split(/\s+/);
    const subcommand = parts[0] || 'list';

    switch (subcommand) {
      case 'list':
        return handleList();
      case 'set':
        return handleSet(parts[1], parts.slice(2).join(' '));
      case 'rm':
      case 'remove':
        return handleRemove(parts[1]);
      case 'use':
      case 'switch':
        return handleUse(parts[1]);
      case 'providers':
        return handleProviders();
      default:
        return {
          text: `Unknown subcommand: "${subcommand}".\n\n` +
            'Usage:\n' +
            '  `/api` — list configured keys\n' +
            '  `/api set <provider> <key>` — store a key\n' +
            '  `/api rm <provider>` — remove a key\n' +
            '  `/api use <provider>` — switch active provider\n' +
            '  `/api providers` — list all known providers',
        };
    }
  },
};

// ─── Handlers ────────────────────────────────────────────────────────────

function handleList() {
  const active = getActiveProvider();
  const stored = listStoredProviders();
  const lines: string[] = ['**LLM API Keys**', ''];

  for (const [name, config] of Object.entries(PROVIDERS)) {
    const isStored = stored.includes(name);
    const fromEnv = !!process.env[config.envVar];
    const isActive = name === active;

    let status = 'not configured';
    if (isStored && fromEnv) {
      // Key from keychain loaded into env
      const key = loadApiKey(name);
      status = `configured (Keychain) ${maskKey(key ?? '')}`;
    } else if (fromEnv) {
      status = `configured (env var)`;
    } else if (isStored) {
      const key = loadApiKey(name);
      status = `stored (Keychain) ${maskKey(key ?? '')} — not loaded`;
    }

    const marker = isActive ? ' **← active**' : '';
    lines.push(`  **${config.label}** (\`${name}\`): ${status}${marker}`);
  }

  lines.push('');
  lines.push(`Active provider: **${active}**`);
  lines.push('');
  lines.push('`/api set <provider> <key>` to add. `/api use <provider>` to switch.');

  if (process.platform === 'darwin') {
    lines.push('Keys stored in macOS Keychain (encrypted, persists across sessions).');
  } else {
    lines.push('Keys stored in `~/.openclawnch/api-keys.json` (file permissions 0600).');
  }

  return { text: lines.join('\n') };
}

function handleSet(provider: string | undefined, key: string | undefined) {
  if (!provider || !key) {
    return { text: 'Usage: `/api set <provider> <key>`\n\nProviders: ' + Object.keys(PROVIDERS).join(', ') };
  }

  const normalized = provider.toLowerCase();
  if (!PROVIDERS[normalized]) {
    return {
      text: `Unknown provider "${provider}". Known providers: ${Object.keys(PROVIDERS).join(', ')}`,
    };
  }

  // Basic key format validation
  const config = PROVIDERS[normalized]!;
  if (key.length < 10) {
    return { text: 'API key seems too short. Double-check and try again.' };
  }

  if (config.prefix && !key.startsWith(config.prefix)) {
    // Warn but don't block — some keys may have non-standard prefixes
    const warning = `\n\nNote: Expected ${config.label} keys to start with \`${config.prefix}\`. Your key doesn't match — double-check it's correct.`;
    try {
      storeApiKey(normalized, key);
    } catch (err) {
      return { text: `Failed to store key: ${err instanceof Error ? err.message : String(err)}` };
    }
    return {
      text: `API key for **${config.label}** stored and loaded into this session.${warning}\n\nUse \`/api use ${normalized}\` to switch to this provider.`,
    };
  }

  try {
    storeApiKey(normalized, key);
  } catch (err) {
    return { text: `Failed to store key: ${err instanceof Error ? err.message : String(err)}` };
  }

  return {
    text: `API key for **${config.label}** stored and loaded into this session.\n\nUse \`/api use ${normalized}\` to switch to this provider.`,
  };
}

function handleRemove(provider: string | undefined) {
  if (!provider) {
    return { text: 'Usage: `/api rm <provider>`\n\nProviders: ' + Object.keys(PROVIDERS).join(', ') };
  }

  const normalized = provider.toLowerCase();
  const config = PROVIDERS[normalized];
  if (!config) {
    return { text: `Unknown provider "${provider}".` };
  }

  const removed = removeApiKey(normalized);
  if (removed) {
    return { text: `API key for **${config.label}** removed from storage and unloaded from this session.` };
  }
  return { text: `No stored key found for **${config.label}**.` };
}

function handleUse(provider: string | undefined) {
  if (!provider) {
    return { text: 'Usage: `/api use <provider>`\n\nProviders: ' + Object.keys(PROVIDERS).join(', ') };
  }

  const normalized = provider.toLowerCase();
  const config = PROVIDERS[normalized];
  if (!config) {
    return { text: `Unknown provider "${provider}". Known: ${Object.keys(PROVIDERS).join(', ')}` };
  }

  // Check if key is available
  const hasKey = !!process.env[config.envVar];
  if (!hasKey) {
    return {
      text: `No API key configured for **${config.label}**. Set one first:\n\`/api set ${normalized} <your-key>\``,
    };
  }

  const prev = getActiveProvider();
  setActiveProvider(normalized);
  return {
    text: `Switched LLM provider: **${PROVIDERS[prev]?.label ?? prev}** → **${config.label}**\n\nNew requests will use ${config.label}. Model selection may need updating (\`/llm\`).`,
  };
}

function handleProviders() {
  const lines = ['**Known LLM Providers**', ''];
  for (const [name, config] of Object.entries(PROVIDERS)) {
    lines.push(`  **${name}** — ${config.label} (env: \`${config.envVar}\`)`);
  }
  lines.push('', 'Use `/api set <provider> <key>` to configure.');
  return { text: lines.join('\n') };
}
