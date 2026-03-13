/**
 * API Command + Keychain Secrets Tests
 *
 * Tests the /api command for managing LLM API keys and the underlying
 * keychain-secrets service. Since Keychain access requires macOS auth
 * prompts, we test the fallback file-based storage path and the
 * command handler logic.
 *
 * Covers:
 *   1. PROVIDERS registry structure
 *   2. maskKey() masking logic
 *   3. hydrateApiKeys() env var precedence
 *   4. getActiveProvider() default and set behavior
 *   5. /api command — list (default subcommand)
 *   6. /api command — set validation
 *   7. /api command — rm
 *   8. /api command — use / switch
 *   9. /api command — providers
 *   10. /api command — unknown subcommand
 *   11. /api command metadata
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// 1. PROVIDERS Registry
// ═══════════════════════════════════════════════════════════════════════════

describe('PROVIDERS Registry', () => {
  it('has 5 known providers', async () => {
    const { PROVIDERS } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    expect(Object.keys(PROVIDERS)).toHaveLength(5);
    expect(Object.keys(PROVIDERS)).toContain('anthropic');
    expect(Object.keys(PROVIDERS)).toContain('bankr');
    expect(Object.keys(PROVIDERS)).toContain('bankr-agent');
    expect(Object.keys(PROVIDERS)).toContain('openrouter');
    expect(Object.keys(PROVIDERS)).toContain('openai');
  });

  it('each provider has envVar and label', async () => {
    const { PROVIDERS } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    for (const [name, config] of Object.entries(PROVIDERS)) {
      expect(config.envVar).toBeTruthy();
      expect(config.label).toBeTruthy();
      expect(typeof config.envVar).toBe('string');
      expect(typeof config.label).toBe('string');
    }
  });

  it('env var names follow naming conventions', async () => {
    const { PROVIDERS } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    expect(PROVIDERS.anthropic!.envVar).toBe('ANTHROPIC_API_KEY');
    expect(PROVIDERS.bankr!.envVar).toBe('BANKR_LLM_KEY');
    expect(PROVIDERS['bankr-agent']!.envVar).toBe('BANKR_API_KEY');
    expect(PROVIDERS.openrouter!.envVar).toBe('OPENROUTER_API_KEY');
    expect(PROVIDERS.openai!.envVar).toBe('OPENAI_API_KEY');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. maskKey()
// ═══════════════════════════════════════════════════════════════════════════

describe('maskKey()', () => {
  it('masks middle of key showing first 6 and last 4', async () => {
    const { maskKey } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    const result = maskKey('sk-ant-abcdef1234567890xyz');
    expect(result).toBe('sk-ant...0xyz');
    expect(result).not.toContain('abcdef1234567890');
  });

  it('returns **** for short keys', async () => {
    const { maskKey } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    expect(maskKey('short')).toBe('****');
    expect(maskKey('12345678')).toBe('****');
    expect(maskKey('123456789012')).toBe('****');
  });

  it('handles keys just above threshold', async () => {
    const { maskKey } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    const result = maskKey('1234567890123'); // 13 chars
    expect(result).toBe('123456...0123');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. hydrateApiKeys() — env var precedence
// ═══════════════════════════════════════════════════════════════════════════

describe('hydrateApiKeys()', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    const { PROVIDERS } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    // Save current env vars
    for (const config of Object.values(PROVIDERS)) {
      saved[config.envVar] = process.env[config.envVar];
    }
  });

  afterEach(async () => {
    // Restore env vars
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it('skips providers that already have env vars set', async () => {
    const { hydrateApiKeys } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    // Set an env var
    process.env.ANTHROPIC_API_KEY = 'existing-key';
    const result = hydrateApiKeys();
    expect(result.skipped).toContain('anthropic');
  });

  it('returns loaded and skipped arrays', async () => {
    const { hydrateApiKeys } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    const result = hydrateApiKeys();
    expect(Array.isArray(result.loaded)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. getActiveProvider() / setActiveProvider()
// ═══════════════════════════════════════════════════════════════════════════

describe('getActiveProvider / setActiveProvider', () => {
  const savedProvider = process.env.OPENCLAWNCH_LLM_PROVIDER;

  afterEach(() => {
    if (savedProvider === undefined) {
      delete process.env.OPENCLAWNCH_LLM_PROVIDER;
    } else {
      process.env.OPENCLAWNCH_LLM_PROVIDER = savedProvider;
    }
  });

  it('defaults to anthropic when env var not set', async () => {
    const { getActiveProvider } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    delete process.env.OPENCLAWNCH_LLM_PROVIDER;
    expect(getActiveProvider()).toBe('anthropic');
  });

  it('reads from OPENCLAWNCH_LLM_PROVIDER env var', async () => {
    const { getActiveProvider } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    process.env.OPENCLAWNCH_LLM_PROVIDER = 'openrouter';
    expect(getActiveProvider()).toBe('openrouter');
  });

  it('setActiveProvider updates the env var', async () => {
    const { setActiveProvider, getActiveProvider } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    setActiveProvider('bankr');
    expect(process.env.OPENCLAWNCH_LLM_PROVIDER).toBe('bankr');
    expect(getActiveProvider()).toBe('bankr');
  });

  it('setActiveProvider rejects unknown providers', async () => {
    const { setActiveProvider } = await import(
      '../extensions/crypto/src/services/keychain-secrets.js'
    );
    expect(() => setActiveProvider('unknown-provider')).toThrow('Unknown provider');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. /api Command — Metadata
// ═══════════════════════════════════════════════════════════════════════════

describe('/api Command — Metadata', () => {
  it('has correct command metadata', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    expect(apiCommand.name).toBe('api');
    expect(apiCommand.acceptsArgs).toBe(true);
    expect(apiCommand.requireAuth).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. /api Command — List (default)
// ═══════════════════════════════════════════════════════════════════════════

describe('/api Command — List', () => {
  it('shows provider list with no args', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: '' });
    expect(result.text).toContain('LLM API Keys');
    expect(result.text).toContain('Active provider');
    expect(result.text).toContain('Anthropic');
  });

  it('shows active provider', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: '' });
    expect(result.text).toContain('active');
  });

  it('handles explicit list subcommand', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'list' });
    expect(result.text).toContain('LLM API Keys');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. /api Command — Set validation
// ═══════════════════════════════════════════════════════════════════════════

describe('/api Command — Set', () => {
  it('rejects missing provider', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'set' });
    expect(result.text).toContain('Usage');
  });

  it('rejects missing key', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'set anthropic' });
    expect(result.text).toContain('Usage');
  });

  it('rejects unknown provider', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'set foobar sk-ant-some-key-value' });
    expect(result.text).toContain('Unknown provider');
    expect(result.text).toContain('foobar');
  });

  it('rejects too-short keys', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'set anthropic short' });
    expect(result.text).toContain('too short');
  });

  it('warns about prefix mismatch but still stores', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    // Anthropic expects sk-ant- prefix, but we pass a different prefix
    const result = await apiCommand.handler({ args: 'set anthropic wrong-prefix-but-long-enough-key' });
    expect(result.text).toContain('stored');
    expect(result.text).toContain('Expected');
    expect(result.text).toContain('sk-ant-');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. /api Command — Remove
// ═══════════════════════════════════════════════════════════════════════════

describe('/api Command — Remove', () => {
  it('rejects missing provider', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'rm' });
    expect(result.text).toContain('Usage');
  });

  it('rejects unknown provider', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'rm foobar' });
    expect(result.text).toContain('Unknown provider');
  });

  it('handles remove alias', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'remove' });
    expect(result.text).toContain('Usage'); // Missing provider
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. /api Command — Use / Switch
// ═══════════════════════════════════════════════════════════════════════════

describe('/api Command — Use', () => {
  it('rejects missing provider', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'use' });
    expect(result.text).toContain('Usage');
  });

  it('rejects unknown provider', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'use foobar' });
    expect(result.text).toContain('Unknown provider');
  });

  it('handles switch alias', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'switch' });
    expect(result.text).toContain('Usage');
  });

  it('requires key to be configured before switching', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    // Clear the env var to simulate no key
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const result = await apiCommand.handler({ args: 'use openrouter' });
    expect(result.text).toContain('No API key configured');
    expect(result.text).toContain('Set one first');

    // Restore
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. /api Command — Providers
// ═══════════════════════════════════════════════════════════════════════════

describe('/api Command — Providers', () => {
  it('lists all known providers', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'providers' });
    expect(result.text).toContain('Known LLM Providers');
    expect(result.text).toContain('anthropic');
    expect(result.text).toContain('bankr');
    expect(result.text).toContain('openrouter');
    expect(result.text).toContain('openai');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. /api Command — Unknown Subcommand
// ═══════════════════════════════════════════════════════════════════════════

describe('/api Command — Unknown Subcommand', () => {
  it('shows usage for unknown subcommand', async () => {
    const { apiCommand } = await import(
      '../extensions/crypto/src/commands/api-command.js'
    );
    const result = await apiCommand.handler({ args: 'foobar' });
    expect(result.text).toContain('Unknown subcommand');
    expect(result.text).toContain('foobar');
    expect(result.text).toContain('Usage');
  });
});
