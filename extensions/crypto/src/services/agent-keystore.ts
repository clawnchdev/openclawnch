/**
 * Agent Keystore — Secure storage for the agent's private key.
 *
 * The agent account is a HybridDeleGator smart account deployed by the user.
 * The agent's private key (delegate key) is what enables autonomous execution.
 * Losing this key means the agent can't execute; the user can still access
 * funds via their owner key.
 *
 * Storage hierarchy (checked in order):
 * 1. macOS Keychain — most secure, survives app reinstalls
 * 2. Encrypted file — AES-256-GCM with user passphrase
 * 3. In-memory only — lost on restart (for testing)
 *
 * The key is NEVER logged, written to unencrypted files, or sent over the network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash, scryptSync } from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';

const HOME = process.env.HOME ?? '/home/openclawnch';
const AGENT_DIR = join(HOME, '.openclawnch', 'agent');
const KEYSTORE_PATH = join(AGENT_DIR, 'keystore.enc');
const META_PATH = join(AGENT_DIR, 'meta.json');
const KEYCHAIN_SERVICE = 'openclawnch-agent';

// ─── Types ──────────────────────────────────────────────────────────────

export interface AgentMeta {
  /** The HybridDeleGator smart account address. */
  smartAccountAddress: string;
  /** The agent's EOA address (derived from the private key). */
  agentAddress: string;
  /** The user's EOA address (owner of the smart account). */
  ownerAddress: string;
  /** Chain the smart account was deployed on. */
  chainId: number;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Where the key is stored: 'keychain' | 'encrypted_file' | 'memory' */
  storageMethod: 'keychain' | 'encrypted_file' | 'memory';
}

// ─── In-Memory Cache ────────────────────────────────────────────────────

let _cachedKey: string | null = null;
let _cachedMeta: AgentMeta | null = null;

// ─── Directory Setup ────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(AGENT_DIR)) {
    mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });
  }
}

// ─── macOS Keychain ─────────────────────────────────────────────────────

function isKeychainAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execSync('which security', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function saveToKeychain(agentAddress: string, privateKey: string): boolean {
  try {
    // Delete existing entry if present (update)
    try {
      execFileSync(
        'security',
        ['delete-generic-password', '-a', agentAddress, '-s', KEYCHAIN_SERVICE],
        { stdio: 'ignore' },
      );
    } catch { /* not found — fine */ }

    execFileSync(
      'security',
      ['add-generic-password', '-a', agentAddress, '-s', KEYCHAIN_SERVICE, '-w', privateKey, '-T', ''],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

function loadFromKeychain(agentAddress: string): string | null {
  try {
    const result = execFileSync(
      'security',
      ['find-generic-password', '-a', agentAddress, '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
    return result.trim();
  } catch {
    return null;
  }
}

// ─── Encrypted File Storage ─────────────────────────────────────────────

function deriveFileKey(passphrase: string): Buffer {
  // scrypt with strong params: N=2^17, r=8, p=1, maxmem=256MB
  // Default OpenSSL maxmem is 32MB which is too low for N=2^17.
  return scryptSync(passphrase, 'openclawnch-agent-salt-v1', 32, {
    N: 131072, r: 8, p: 1,
    maxmem: 256 * 1024 * 1024,
  });
}

function saveToEncryptedFile(privateKey: string, passphrase: string): void {
  ensureDir();
  const key = deriveFileKey(passphrase);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const data = Buffer.concat([iv, tag, encrypted]);
  const tmpPath = KEYSTORE_PATH + '.tmp.' + Date.now();
  writeFileSync(tmpPath, data, { mode: 0o600 });
  renameSync(tmpPath, KEYSTORE_PATH);
}

function loadFromEncryptedFile(passphrase: string): string | null {
  if (!existsSync(KEYSTORE_PATH)) return null;

  try {
    const data = readFileSync(KEYSTORE_PATH);
    const key = deriveFileKey(passphrase);
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    return null;
  }
}

// ─── Meta Storage ───────────────────────────────────────────────────────

export function saveMeta(meta: AgentMeta): void {
  ensureDir();
  _cachedMeta = meta;
  const tmpPath = META_PATH + '.tmp.' + Date.now();
  writeFileSync(tmpPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
  renameSync(tmpPath, META_PATH);
}

export function loadMeta(): AgentMeta | null {
  if (_cachedMeta) return _cachedMeta;

  if (!existsSync(META_PATH)) return null;
  try {
    _cachedMeta = JSON.parse(readFileSync(META_PATH, 'utf8')) as AgentMeta;
    return _cachedMeta;
  } catch {
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Store the agent's private key securely.
 * Tries: macOS Keychain → encrypted file → memory only.
 *
 * Returns the storage method used.
 */
export function storeAgentKey(
  agentAddress: string,
  privateKey: string,
  passphrase?: string,
): 'keychain' | 'encrypted_file' | 'memory' {
  _cachedKey = privateKey;

  // Try Keychain first
  if (isKeychainAvailable()) {
    if (saveToKeychain(agentAddress, privateKey)) {
      return 'keychain';
    }
  }

  // Fallback: encrypted file (requires passphrase)
  if (passphrase && passphrase.length >= 8) {
    saveToEncryptedFile(privateKey, passphrase);
    return 'encrypted_file';
  }

  // Last resort: memory only
  return 'memory';
}

/**
 * Load the agent's private key.
 * Tries: memory cache → macOS Keychain → encrypted file (passphrase from arg or env).
 */
export function loadAgentKey(passphrase?: string): string | null {
  if (_cachedKey) return _cachedKey;

  const meta = loadMeta();
  if (!meta) return null;

  // Try Keychain
  if (meta.storageMethod === 'keychain' || isKeychainAvailable()) {
    const key = loadFromKeychain(meta.agentAddress);
    if (key) {
      _cachedKey = key;
      return key;
    }
  }

  // Auto-unlock from DELEGATOR_PASSPHRASE env var
  if (!passphrase) {
    passphrase = process.env.DELEGATOR_PASSPHRASE ?? undefined;
  }

  // Try encrypted file
  if (passphrase) {
    const key = loadFromEncryptedFile(passphrase);
    if (key) {
      _cachedKey = key;
      return key;
    }
  }

  return null;
}

/**
 * Check if an agent account exists (meta file present).
 */
export function hasAgentAccount(): boolean {
  return loadMeta() !== null;
}

/**
 * Clear all agent data (for testing).
 */
export function resetAgentKeystore(): void {
  _cachedKey = null;
  _cachedMeta = null;
}
