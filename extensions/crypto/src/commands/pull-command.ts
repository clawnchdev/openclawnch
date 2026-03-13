/**
 * /pull <path> — Read a file from the running bot and send it to chat.
 *
 * Small files: inline as code block.
 * Large files on Telegram: sent as document attachment.
 * Directories: list contents.
 *
 * Security: blocks sensitive paths (.env, private keys, credentials, bot tokens).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { guardedFetch } from '../services/endpoint-allowlist.js';
import { getCredentialVault } from '../services/credential-vault.js';
import { extractChannelId } from '../services/channel-sender.js';

// ─── Constants ──────────────────────────────────────────────────────────

const MAX_TEXT = 3800;       // leave margin below Telegram's 4096 limit
const MAX_FILE_SIZE = 50_000_000; // Telegram doc limit: 50 MB
const CAPTION_LIMIT = 1024;

const HOME = process.env.HOME ?? '/home/openclawnch';
const WORKSPACE = '/workspace';
const OPENCLAWNCH_DIR = join(HOME, '.openclawnch');

/** Shortcuts so users don't need to type full paths. */
const PATH_SHORTCUTS: Record<string, string> = {
  'state':       join(WORKSPACE, '.openclaw-state'),
  'sessions':    join(WORKSPACE, '.openclaw-state', 'sessions'),
  'plans':       join(OPENCLAWNCH_DIR, 'plans'),
  'orders':      join(OPENCLAWNCH_DIR, 'orders'),
  'memory':      join(OPENCLAWNCH_DIR, 'memory'),
  'recall':      join(OPENCLAWNCH_DIR, 'recall'),
  'skills':      join(OPENCLAWNCH_DIR, 'learned-skills'),
  'tools':       join(OPENCLAWNCH_DIR, 'user-tools'),
  'webhooks':    join(OPENCLAWNCH_DIR, 'webhooks'),
  'agents':      join(OPENCLAWNCH_DIR, 'agents'),
  'ledger':      join(OPENCLAWNCH_DIR, 'ledger'),
  'budget':      join(OPENCLAWNCH_DIR, 'budget-audit'),
  'cost-basis':  join(OPENCLAWNCH_DIR, 'data'),
  'modes':       join(OPENCLAWNCH_DIR, 'modes'),
  'evolution':   join(OPENCLAWNCH_DIR, 'evolution'),
  'onboarding':  join(OPENCLAWNCH_DIR, 'onboarding'),
  'home':        HOME,
  'workspace':   WORKSPACE,
};

/** Patterns that must never be returned. */
const BLOCKED_PATTERNS = [
  /\.env$/i,
  /private[_-]?key/i,
  /credentials?\.(json|yaml|yml|toml)$/i,
  /secret/i,
  /bot[_-]?token/i,
  /\.pem$/i,
  /\.p12$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /keystore/i,
];

// ─── Helpers ────────────────────────────────────────────────────────────

function isBlocked(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  const full = filePath.toLowerCase();
  return BLOCKED_PATTERNS.some(p => p.test(name) || p.test(full));
}

function resolvePath(input: string): string {
  const shortcut = PATH_SHORTCUTS[input.toLowerCase()];
  if (shortcut) return shortcut;

  // Absolute path
  if (input.startsWith('/')) return resolve(input);

  // Relative to home
  return resolve(HOME, input);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDirListing(dirPath: string): string {
  const entries = readdirSync(dirPath);
  if (entries.length === 0) return '(empty directory)';

  const lines: string[] = [];
  for (const entry of entries.sort()) {
    try {
      const entryPath = join(dirPath, entry);
      const stat = statSync(entryPath);
      const suffix = stat.isDirectory() ? '/' : '';
      const size = stat.isFile() ? `  ${formatSize(stat.size)}` : '';
      lines.push(`  ${entry}${suffix}${size}`);
    } catch {
      lines.push(`  ${entry}  (unreadable)`);
    }
  }
  return lines.join('\n');
}

async function sendTelegramDocument(
  chatId: string,
  filePath: string,
  caption: string,
): Promise<void> {
  const token = getCredentialVault().getSecret('bot.telegram.botToken', 'pull-command');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not available');

  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', new Blob([fileBuffer]), fileName);
  form.append('caption', caption.slice(0, CAPTION_LIMIT));

  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const resp = await guardedFetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  const data = await resp.json() as any;
  if (!data.ok) {
    throw new Error(data.description ?? 'sendDocument failed');
  }
}

// ─── Command ────────────────────────────────────────────────────────────

export const pullCommand = {
  name: 'pull',
  description: 'Read a file from the bot: /pull <path|shortcut>',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx?: any) => {
    const args = (ctx?.args ?? '').trim();

    // No args: show shortcuts
    if (!args) {
      const shortcuts = Object.entries(PATH_SHORTCUTS)
        .map(([k, v]) => `  **${k}** → \`${v}\``)
        .join('\n');
      return {
        text: [
          '**Usage:** `/pull <path>` or `/pull <shortcut>`',
          '',
          '**Shortcuts:**',
          shortcuts,
          '',
          'Examples: `/pull plans`, `/pull /workspace/.openclaw-state/sessions`',
        ].join('\n'),
      };
    }

    const filePath = resolvePath(args);

    // Security check
    if (isBlocked(filePath)) {
      return { text: `Blocked: \`${basename(filePath)}\` matches a sensitive file pattern.` };
    }

    // Existence check
    if (!existsSync(filePath)) {
      return { text: `Not found: \`${filePath}\`` };
    }

    const stat = statSync(filePath);

    // ── Directory: list contents ──────────────────────────────────
    if (stat.isDirectory()) {
      const listing = formatDirListing(filePath);
      return {
        text: `**${filePath}/**\n\`\`\`\n${listing}\n\`\`\``,
      };
    }

    // ── File too large even for document ─────────────────────────
    if (stat.size > MAX_FILE_SIZE) {
      return {
        text: `File too large: \`${basename(filePath)}\` is ${formatSize(stat.size)} (max ${formatSize(MAX_FILE_SIZE)}).`,
      };
    }

    // ── Small file: inline as code block ─────────────────────────
    if (stat.size <= MAX_TEXT) {
      try {
        const content = readFileSync(filePath, 'utf8');
        return {
          text: `**${basename(filePath)}** (${formatSize(stat.size)})\n\`\`\`\n${content}\n\`\`\``,
        };
      } catch {
        return { text: `Could not read \`${filePath}\` as text.` };
      }
    }

    // ── Large file: try Telegram document, fall back to truncation ─
    const channel = extractChannelId(ctx);
    const chatId = ctx?.conversationId ?? ctx?.senderId ?? '';

    if (channel === 'telegram' && chatId) {
      try {
        await sendTelegramDocument(
          chatId,
          filePath,
          `${basename(filePath)} (${formatSize(stat.size)})`,
        );
        return { text: `Sent \`${basename(filePath)}\` as document (${formatSize(stat.size)}).` };
      } catch (err) {
        // Fall through to truncation
      }
    }

    // Truncated fallback
    try {
      const content = readFileSync(filePath, 'utf8');
      const truncated = content.slice(0, MAX_TEXT);
      return {
        text: `**${basename(filePath)}** (${formatSize(stat.size)}, truncated)\n\`\`\`\n${truncated}\n\`\`\`\n\n...truncated at ${formatSize(MAX_TEXT)} of ${formatSize(stat.size)}`,
      };
    } catch {
      return { text: `Could not read \`${filePath}\` as text. Binary file?` };
    }
  },
};
