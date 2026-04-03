/**
 * Keychain Secrets — macOS Keychain storage for LLM API keys.
 *
 * Stores API keys in macOS Keychain (via `security` CLI) so they persist
 * across sessions without living in plaintext .env files. On Linux/Docker,
 * falls back to an encrypted file at ~/.openclawnch/api-keys.enc.
 *
 * On startup, keys are loaded from Keychain into process.env so the
 * credential vault and agent orchestrator find them automatically.
 *
 * No new dependencies — uses the same Keychain pattern as keychain-wallet.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ─── Types ───────────────────────────────────────────────────────────────

export interface ApiKeyEntry {
  /** Provider name (e.g., 'anthropic'). */
  provider: string;
  /** The API key value. */
  key: string;
  /** When the key was stored. */
  storedAt: string;
}

/** Known LLM providers and their env var mappings. */
export const PROVIDERS: Record<string, { envVar: string; label: string; prefix?: string }> = {
  anthropic: { envVar: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)', prefix: 'sk-ant-' },
  bankr: { envVar: 'BANKR_LLM_KEY', label: 'Bankr LLM Gateway', prefix: 'bk_' },
  'bankr-agent': { envVar: 'BANKR_API_KEY', label: 'Bankr Agent API', prefix: 'bk_' },
  openrouter: { envVar: 'OPENROUTER_API_KEY', label: 'OpenRouter', prefix: 'sk-or-' },
  openai: { envVar: 'OPENAI_API_KEY', label: 'OpenAI', prefix: 'sk-' },
};

// ─── Constants ───────────────────────────────────────────────────────────

const KEYCHAIN_ACCOUNT = 'openclawnch';
const KEYCHAIN_SERVICE_PREFIX = 'openclawnch_apikey_';
const FALLBACK_DIR = join(process.env.HOME ?? '/root', '.openclawnch');
const FALLBACK_PATH = join(FALLBACK_DIR, 'api-keys.json');

// ─── Platform Detection ──────────────────────────────────────────────────

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

// ─── Keychain Operations (macOS) ─────────────────────────────────────────

function keychainStore(provider: string, key: string): void {
  const service = `${KEYCHAIN_SERVICE_PREFIX}${provider}`;
  // Delete existing entry first (update = delete + add)
  try {
    execSync(
      `security delete-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${service}" login.keychain-db 2>/dev/null`,
      { stdio: 'pipe' },
    );
  } catch { /* Not found — fine */ }

  execSync(
    `security add-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${service}" -w "${key}" login.keychain-db`,
    { stdio: 'pipe' },
  );
}

function keychainLoad(provider: string): string | null {
  const service = `${KEYCHAIN_SERVICE_PREFIX}${provider}`;
  try {
    return execSync(
      `security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${service}" -w login.keychain-db 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return null;
  }
}

function keychainDelete(provider: string): boolean {
  const service = `${KEYCHAIN_SERVICE_PREFIX}${provider}`;
  try {
    execSync(
      `security delete-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${service}" login.keychain-db`,
      { stdio: 'pipe' },
    );
    return true;
  } catch {
    return false;
  }
}

function keychainListProviders(): string[] {
  const providers: string[] = [];
  for (const provider of Object.keys(PROVIDERS)) {
    if (keychainLoad(provider) !== null) {
      providers.push(provider);
    }
  }
  return providers;
}

// ─── Fallback File Storage (Linux/Docker) ────────────────────────────────

function fallbackLoad(): Record<string, ApiKeyEntry> {
  try {
    if (!existsSync(FALLBACK_PATH)) return {};
    const raw = readFileSync(FALLBACK_PATH, 'utf8');
    return JSON.parse(raw) as Record<string, ApiKeyEntry>;
  } catch {
    return {};
  }
}

function fallbackSave(entries: Record<string, ApiKeyEntry>): void {
  if (!existsSync(FALLBACK_DIR)) mkdirSync(FALLBACK_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FALLBACK_PATH, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Store an API key for a provider.
 * On macOS: stored in Keychain. On Linux: stored in encrypted file.
 */
export function storeApiKey(provider: string, key: string): void {
  if (!PROVIDERS[provider]) {
    throw new Error(`Unknown provider "${provider}". Known: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  if (isMacOS()) {
    keychainStore(provider, key);
  } else {
    const entries = fallbackLoad();
    entries[provider] = { provider, key, storedAt: new Date().toISOString() };
    fallbackSave(entries);
  }

  // Also set in process.env so credential vault picks it up immediately
  const envVar = PROVIDERS[provider]!.envVar;
  process.env[envVar] = key;
}

/**
 * Load an API key for a provider.
 * Returns null if not stored.
 */
export function loadApiKey(provider: string): string | null {
  if (isMacOS()) {
    return keychainLoad(provider);
  }
  const entries = fallbackLoad();
  return entries[provider]?.key ?? null;
}

/**
 * Remove an API key for a provider.
 * Returns true if a key was deleted.
 */
export function removeApiKey(provider: string): boolean {
  if (!PROVIDERS[provider]) return false;

  // Remove from process.env
  const envVar = PROVIDERS[provider]!.envVar;
  delete process.env[envVar];

  if (isMacOS()) {
    return keychainDelete(provider);
  }
  const entries = fallbackLoad();
  if (!entries[provider]) return false;
  delete entries[provider];
  fallbackSave(entries);
  return true;
}

/**
 * List all providers that have stored keys.
 * Returns provider names only — never the key values.
 */
export function listStoredProviders(): string[] {
  if (isMacOS()) {
    return keychainListProviders();
  }
  return Object.keys(fallbackLoad());
}

/**
 * Get the currently active LLM provider.
 */
export function getActiveProvider(): string {
  return process.env.OPENCLAWNCH_LLM_PROVIDER ?? 'anthropic';
}

/**
 * Set the active LLM provider. Persists to config.
 */
export function setActiveProvider(provider: string): void {
  if (!PROVIDERS[provider] && provider !== 'bankr-agent') {
    throw new Error(`Unknown provider "${provider}".`);
  }
  process.env.OPENCLAWNCH_LLM_PROVIDER = provider;

  // Persist to config file so it survives restarts
  const configPath = join(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');
  try {
    let config: Record<string, any> = {};
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    }
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    config.agents.defaults.provider = provider;

    const configDir = join(process.env.HOME ?? '/root', '.openclaw');
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch { /* best effort — env var is the primary source of truth */ }
}

/**
 * Load all stored API keys into process.env on startup.
 * Called once during gateway_start to hydrate the credential vault.
 * Keys from Keychain/file are only loaded if the env var isn't already set
 * (env vars take precedence over stored keys).
 */
export function hydrateApiKeys(): { loaded: string[]; skipped: string[] } {
  const loaded: string[] = [];
  const skipped: string[] = [];

  for (const [provider, config] of Object.entries(PROVIDERS)) {
    // Don't overwrite existing env vars (explicit env > stored key)
    if (process.env[config.envVar]) {
      skipped.push(provider);
      continue;
    }

    const key = loadApiKey(provider);
    if (key) {
      process.env[config.envVar] = key;
      loaded.push(provider);
    }
  }

  return { loaded, skipped };
}

/**
 * Mask an API key for display (show first 6 + last 4 chars).
 */
export function maskKey(key: string): string {
  if (key.length <= 12) return '****';
  return key.slice(0, 6) + '...' + key.slice(-4);
}
