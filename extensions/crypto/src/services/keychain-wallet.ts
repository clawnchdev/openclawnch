/**
 * Keychain Wallet — local key generation with encrypted Keychain storage.
 *
 * Extends `private_key` mode with:
 * - BIP-39 mnemonic generation via viem/accounts
 * - scrypt + AES-256-GCM envelope encryption
 * - macOS Keychain storage (via `security` CLI)
 * - Encrypted file fallback for Linux/Docker
 *
 * The runtime behavior is identical to raw `private_key` mode — once we have
 * a viem Account object, the same wallet client code path is used. The only
 * difference is how the key is acquired (generated vs env var) and stored
 * (Keychain vs plaintext env).
 *
 * No new dependencies. Uses:
 * - viem/accounts: generateMnemonic, mnemonicToAccount
 * - @scure/bip39/wordlists/english: BIP-39 English wordlist (transitive via viem)
 * - @noble/hashes/scrypt: key derivation
 * - node:crypto: AES-256-GCM encryption
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ─── Types ───────────────────────────────────────────────────────────────

export interface EncryptedPayload {
  /** scrypt salt (hex) */
  salt: string;
  /** AES-GCM nonce (hex) */
  nonce: string;
  /** AES-GCM ciphertext (hex) */
  ciphertext: string;
  /** AES-GCM auth tag (hex) */
  tag: string;
  /** Encryption version for future-proofing */
  version: 1;
}

export interface GeneratedWallet {
  /** 12-word BIP-39 mnemonic */
  mnemonic: string;
  /** Derived Ethereum address */
  address: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

const KEYCHAIN_ACCOUNT = 'eth';
const KEYCHAIN_SERVICE = 'clawncher_mnemonic';
const FALLBACK_DIR = join(process.env.HOME ?? '/root', '.openclawnch');
const FALLBACK_PATH = join(FALLBACK_DIR, 'wallet.enc');
const BACKUP_FILENAME = 'wallet-backup.enc';

/** scrypt parameters: N=2^17, r=8, p=1. ~128MB memory, ~0.5s on modern hardware. */
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32; // 256-bit key for AES-256

// ─── Platform Detection ──────────────────────────────────────────────────

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

// ─── Encryption ──────────────────────────────────────────────────────────

/**
 * Derive an AES-256 key from a password using scrypt.
 * Uses @noble/hashes for the scrypt implementation (already in dep tree via viem).
 */
async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const { scryptAsync } = await import('@noble/hashes/scrypt');
  const passwordBytes = Buffer.from(password, 'utf-8');
  const derived = await scryptAsync(passwordBytes, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DKLEN,
  });
  return Buffer.from(derived);
}

/**
 * Encrypt a plaintext string with AES-256-GCM using a password-derived key.
 */
export async function encrypt(plaintext: string, password: string): Promise<EncryptedPayload> {
  const salt = randomBytes(32);
  const nonce = randomBytes(12); // 96-bit nonce for GCM
  const key = await deriveKey(password, salt);

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    nonce: nonce.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    tag: tag.toString('hex'),
    version: 1,
  };
}

/**
 * Decrypt an AES-256-GCM encrypted payload using a password-derived key.
 * Throws on wrong password (GCM auth tag mismatch).
 */
export async function decrypt(payload: EncryptedPayload, password: string): Promise<string> {
  if (payload.version !== 1) {
    throw new Error(`Unsupported encryption version: ${payload.version}`);
  }

  const salt = Buffer.from(payload.salt, 'hex');
  const nonce = Buffer.from(payload.nonce, 'hex');
  const ciphertext = Buffer.from(payload.ciphertext, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const key = await deriveKey(password, salt);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf-8');
  } catch {
    throw new Error('Decryption failed — wrong password or corrupted data.');
  }
}

// ─── Keychain Operations (macOS) ─────────────────────────────────────────

/**
 * Store an encrypted payload in macOS Keychain.
 */
function keychainStore(payload: EncryptedPayload): void {
  const json = JSON.stringify(payload);
  // Delete existing entry first (update = delete + add)
  try {
    execSync(
      `security delete-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" login.keychain-db 2>/dev/null`,
      { stdio: 'pipe' },
    );
  } catch {
    // Not found — fine, we're creating fresh
  }

  execSync(
    `security add-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w "${json.replace(/"/g, '\\"')}" login.keychain-db`,
    { stdio: 'pipe' },
  );
}

/**
 * Load an encrypted payload from macOS Keychain.
 * Returns null if not found.
 */
function keychainLoad(): EncryptedPayload | null {
  try {
    const raw = execSync(
      `security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w login.keychain-db 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    return JSON.parse(raw) as EncryptedPayload;
  } catch {
    return null;
  }
}

/**
 * Check if an encrypted wallet exists in macOS Keychain.
 */
function keychainExists(): boolean {
  try {
    execSync(
      `security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" login.keychain-db 2>/dev/null`,
      { stdio: 'pipe' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the encrypted wallet from macOS Keychain.
 */
function keychainDelete(): boolean {
  try {
    execSync(
      `security delete-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" login.keychain-db`,
      { stdio: 'pipe' },
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Encrypted File Fallback (Linux/Docker) ──────────────────────────────

function ensureFallbackDir(): void {
  if (!existsSync(FALLBACK_DIR)) {
    mkdirSync(FALLBACK_DIR, { recursive: true, mode: 0o700 });
  }
}

function fileStore(payload: EncryptedPayload): void {
  ensureFallbackDir();
  writeFileSync(FALLBACK_PATH, JSON.stringify(payload), { mode: 0o600 });
}

function fileLoad(): EncryptedPayload | null {
  try {
    const raw = readFileSync(FALLBACK_PATH, 'utf-8');
    return JSON.parse(raw) as EncryptedPayload;
  } catch {
    return null;
  }
}

function fileExists(): boolean {
  return existsSync(FALLBACK_PATH);
}

function fileDelete(): boolean {
  try {
    unlinkSync(FALLBACK_PATH);
    return true;
  } catch {
    return false;
  }
}

// ─── Unified Storage Interface ───────────────────────────────────────────

function storePayload(payload: EncryptedPayload): void {
  if (isMacOS()) {
    keychainStore(payload);
  } else {
    fileStore(payload);
  }
}

function loadPayload(): EncryptedPayload | null {
  if (isMacOS()) {
    return keychainLoad();
  }
  return fileLoad();
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Generate a new BIP-39 wallet. Returns the mnemonic and derived address.
 * Does NOT store anything — call encryptAndStore() after user confirms backup.
 */
export async function generateWallet(): Promise<GeneratedWallet> {
  const { generateMnemonic, mnemonicToAccount } = await import('viem/accounts');
  const { wordlist } = await import('@scure/bip39/wordlists/english');

  const mnemonic = generateMnemonic(wordlist);
  const account = mnemonicToAccount(mnemonic);

  return {
    mnemonic,
    address: account.address,
  };
}

/**
 * Encrypt a mnemonic with user password and store in Keychain (macOS) or
 * encrypted file (Linux/Docker).
 */
export async function encryptAndStore(mnemonic: string, password: string): Promise<void> {
  // Validate mnemonic before storing
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error(`Invalid mnemonic: expected 12 or 24 words, got ${words.length}`);
  }

  // Enforce minimum password strength — scrypt is pointless with a weak password
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  const payload = await encrypt(mnemonic, password);
  storePayload(payload);
}

/**
 * Load and decrypt the stored mnemonic, then derive a viem Account.
 * Returns the Account object ready for privateKeyToAccount-style usage.
 */
export async function loadAndDecrypt(password: string): Promise<{
  account: any; // viem Account — using any to avoid version conflicts
  mnemonic: string;
  address: string;
}> {
  const payload = loadPayload();
  if (!payload) {
    throw new Error('No encrypted wallet found in storage.');
  }

  const mnemonic = await decrypt(payload, password);
  const { mnemonicToAccount } = await import('viem/accounts');
  const account = mnemonicToAccount(mnemonic);

  return {
    account,
    mnemonic,
    address: account.address,
  };
}

/**
 * Check if an encrypted wallet exists in storage.
 */
export function hasKeychainWallet(): boolean {
  if (isMacOS()) {
    return keychainExists();
  }
  return fileExists();
}

/**
 * Delete the encrypted wallet from storage.
 */
export function deleteKeychainWallet(): boolean {
  if (isMacOS()) {
    return keychainDelete();
  }
  return fileDelete();
}

/**
 * Export encrypted backup file to a specified path (or default backup location).
 * Returns the path where the backup was written.
 */
export function exportBackupFile(outputDir?: string): string {
  const payload = loadPayload();
  if (!payload) {
    throw new Error('No encrypted wallet found in storage.');
  }

  const dir = outputDir ?? FALLBACK_DIR;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const backupPath = join(dir, BACKUP_FILENAME);
  writeFileSync(backupPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return backupPath;
}

/**
 * Import wallet from a backup file. Requires the original password.
 * Stores into the active storage backend (Keychain or file).
 */
export async function importFromBackup(backupPath: string, password: string): Promise<string> {
  const raw = readFileSync(backupPath, 'utf-8');
  const payload = JSON.parse(raw) as EncryptedPayload;

  // Verify we can decrypt it (validates password)
  const mnemonic = await decrypt(payload, password);
  const { mnemonicToAccount } = await import('viem/accounts');
  const account = mnemonicToAccount(mnemonic);

  // Store in active backend
  storePayload(payload);

  return account.address;
}

/**
 * Generate 3 random word indices for mnemonic confirmation.
 * Returns array of {index, word} pairs the user must confirm.
 */
export function getConfirmationWords(mnemonic: string, count = 3): Array<{ index: number; word: string }> {
  const words = mnemonic.trim().split(/\s+/);
  const indices = new Set<number>();
  while (indices.size < count) {
    const idx = Math.floor(Math.random() * words.length);
    indices.add(idx);
  }
  return Array.from(indices)
    .sort((a, b) => a - b)
    .map(idx => ({ index: idx + 1, word: words[idx]! })); // 1-indexed for display
}

/**
 * Validate that the user's confirmation words match the mnemonic.
 */
export function validateConfirmation(
  mnemonic: string,
  confirmations: Array<{ index: number; word: string }>,
): boolean {
  const words = mnemonic.trim().split(/\s+/);
  return confirmations.every(
    ({ index, word }) => words[index - 1]?.toLowerCase() === word.toLowerCase(),
  );
}

/**
 * Get the storage backend description (for display to user).
 */
export function getStorageInfo(): { backend: 'keychain' | 'file'; path?: string } {
  if (isMacOS()) {
    return { backend: 'keychain' };
  }
  return { backend: 'file', path: FALLBACK_PATH };
}
