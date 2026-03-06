/**
 * Mode service — tracks per-user safety mode and signing mode.
 *
 * Two independent toggles:
 * 1. Intent confirmation: safe (confirm before acting) / danger (act immediately)
 * 2. Signing method: wallet (WalletConnect, phone approval) / autosign (private key)
 *
 * State persists on volume alongside onboarding state.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type SafetyMode = 'safe' | 'danger';
export type SigningMode = 'wallet' | 'autosign';

export interface UserMode {
  userId: string;
  safetyMode: SafetyMode;
  signingMode: SigningMode;
  lastChanged: number;
}

function getStateDir(): string {
  return process.env.OPENCLAWNCH_TX_DIR
    ? join(process.env.OPENCLAWNCH_TX_DIR, '..', 'modes')
    : join(process.env.HOME ?? '/tmp', '.openclawnch', 'modes');
}

function ensureDir(): void {
  const dir = getStateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// M5: Sanitize userId to prevent path traversal
function sanitizeUserId(userId: string): string {
  // Only allow alphanumeric, underscores, hyphens, dots
  const safe = userId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  // Prevent directory traversal
  if (safe.includes('..') || safe.includes('/') || safe.includes('\\')) {
    return 'invalid_user';
  }
  return safe.slice(0, 64); // Cap length
}

function modePath(userId: string): string {
  return join(getStateDir(), `${sanitizeUserId(userId)}.json`);
}

function loadMode(userId: string): UserMode {
  try {
    const path = modePath(userId);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8')) as UserMode;
    }
  } catch { /* default */ }
  return {
    userId,
    safetyMode: 'safe',
    signingMode: 'wallet',
    lastChanged: Date.now(),
  };
}

function saveMode(mode: UserMode): void {
  ensureDir();
  writeFileSync(modePath(mode.userId), JSON.stringify(mode, null, 2), 'utf8');
}

const cache = new Map<string, UserMode>();

export function getUserMode(userId: string): UserMode {
  let mode = cache.get(userId);
  if (!mode) {
    mode = loadMode(userId);
    cache.set(userId, mode);
  }
  return mode;
}

export function setSafetyMode(userId: string, safetyMode: SafetyMode): UserMode {
  const mode = getUserMode(userId);
  mode.safetyMode = safetyMode;
  mode.lastChanged = Date.now();
  cache.set(userId, mode);
  saveMode(mode);
  return mode;
}

export function setSigningMode(userId: string, signingMode: SigningMode): UserMode {
  const mode = getUserMode(userId);
  mode.signingMode = signingMode;
  mode.lastChanged = Date.now();
  cache.set(userId, mode);
  saveMode(mode);
  return mode;
}

export function resetModes(): void {
  cache.clear();
}
