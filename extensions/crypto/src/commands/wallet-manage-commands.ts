/**
 * Wallet management commands — recover, export, and backup encrypted wallets.
 *
 * These commands work with the keychain-wallet service for local wallet
 * management (BIP-39 mnemonic + scrypt/AES-256-GCM encryption).
 */

import {
  hasKeychainWallet,
  loadAndDecrypt,
  encryptAndStore,
  exportBackupFile,
  deleteKeychainWallet,
  getStorageInfo,
} from '../services/keychain-wallet.js';

// ── /recover — Restore wallet from mnemonic ─────────────────────────────────

/**
 * Two-phase command:
 * Phase 1: /recover (no args) — prompts for mnemonic
 * Phase 2: /recover <mnemonic> <password> — executes recovery
 *
 * In practice, the LLM agent will collect the mnemonic and password
 * from the user in conversation, then call this with args.
 */
export const recoverCommand = {
  name: 'recover',
  description: 'Restore wallet from a 12/24-word seed phrase. Usage: /recover <mnemonic words> | <password>',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (_ctx: any, args?: string) => {
    if (!args || args.trim().length === 0) {
      return {
        text: 'To recover a wallet, provide your seed phrase and a new password separated by |.\n\n' +
          'Usage: `/recover word1 word2 ... word12 | yourpassword`\n\n' +
          '⚠️ **Security note**: Your seed phrase and password will appear in chat history. ' +
          'For maximum security, use the onboarding flow (/create_wallet or /import_wallet) instead, ' +
          'which handles sensitive input more carefully.\n\n' +
          'The mnemonic will be encrypted and stored locally. ' +
          (hasKeychainWallet() ? '⚠️ This will replace your existing local wallet.' : ''),
      };
    }

    // Parse: mnemonic | password
    const parts = args.split('|').map(s => s.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return {
        text: 'Invalid format. Usage: `/recover word1 word2 ... word12 | yourpassword`',
      };
    }

    const mnemonic = parts[0];
    const password = parts[1];
    const words = mnemonic.split(/\s+/);

    if (words.length !== 12 && words.length !== 24) {
      return {
        text: `Expected 12 or 24 words, got ${words.length}. Please provide a valid BIP-39 mnemonic.`,
      };
    }

    if (password.length < 8) {
      return { text: 'Password must be at least 8 characters.' };
    }

    try {
      // Validate mnemonic by deriving account
      const { mnemonicToAccount } = await import('viem/accounts');
      const account = mnemonicToAccount(mnemonic);

      // Delete existing wallet if present
      if (hasKeychainWallet()) {
        deleteKeychainWallet();
      }

      await encryptAndStore(mnemonic, password);
      const storage = getStorageInfo();
      const storageDesc = storage.backend === 'keychain'
        ? 'macOS Keychain'
        : `encrypted file (${storage.path})`;

      return {
        text: `Wallet recovered.\n\n` +
          `Address: \`${account.address}\`\n` +
          `Storage: ${storageDesc}\n\n` +
          `Restart the session or set \`CLAWNCHER_WALLET_PASSWORD\` to unlock automatically.`,
      };
    } catch (err) {
      return {
        text: `Recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ── /export_wallet — Display mnemonic (requires password) ───────────────────

export const exportWalletCommand = {
  name: 'export_wallet',
  description: 'Display your wallet mnemonic (requires password). Usage: /export_wallet <password>',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (_ctx: any, args?: string) => {
    if (!hasKeychainWallet()) {
      return {
        text: 'No local wallet found. Use /create_wallet to create one or /recover to import.',
      };
    }

    if (!args || args.trim().length === 0) {
      return {
        text: 'Usage: `/export_wallet <password>`\n\n' +
          '⚠️ This will display your seed phrase. Make sure no one can see your screen.\n' +
          '⚠️ Your password will appear in chat history.',
      };
    }

    const password = args.trim();

    try {
      const result = await loadAndDecrypt(password);

      return {
        text: `⚠️ **YOUR SEED PHRASE — DO NOT SHARE**\n\n` +
          `\`${result.mnemonic}\`\n\n` +
          `Address: \`${result.address}\`\n\n` +
          `Write this down and store it safely. Anyone with these words can access your funds.`,
      };
    } catch (err) {
      return {
        text: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ── /wallet_backup — Export encrypted backup file ───────────────────────────

export const walletBackupCommand = {
  name: 'wallet_backup',
  description: 'Export encrypted wallet backup file to ~/.openclawnch/',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (_ctx: any, args?: string) => {
    if (!hasKeychainWallet()) {
      return {
        text: 'No local wallet found. Use /create_wallet to create one or /recover to import.',
      };
    }

    try {
      const outputDir = args?.trim() || undefined;
      const backupPath = exportBackupFile(outputDir);

      return {
        text: `Encrypted backup saved to: \`${backupPath}\`\n\n` +
          `This file is encrypted with your wallet password. ` +
          `You can restore from it using /recover.`,
      };
    } catch (err) {
      return {
        text: `Backup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
