/**
 * Typing Indicator — sends Telegram "typing..." action for the full
 * duration the agent is thinking/processing.
 *
 * Telegram's `sendChatAction` typing indicator expires after ~5 seconds,
 * so we re-send it every 4.5s on a loop until explicitly stopped.
 *
 * Follows the same raw Bot API call pattern as telegram-draft-stream.ts.
 * No new dependencies — uses guardedFetch.
 *
 * Lifecycle:
 *   message_received → start(chatId)
 *   message_sending  → stop(chatId)
 *
 * Safety:
 *   - Max duration cap (5 minutes) prevents orphaned indicators
 *   - Errors are swallowed (typing indicator is non-critical UX)
 *   - Only activates for Telegram channel
 */

import { guardedFetch } from './endpoint-allowlist.js';
import { getCredentialVault } from './credential-vault.js';

// ─── Constants ───────────────────────────────────────────────────────────

/** Re-send typing action every 4.5s (Telegram expires at ~5s). */
const REPEAT_MS = 4_500;

/** Hard cap: stop indicator after 5 minutes even if not explicitly stopped. */
const MAX_DURATION_MS = 5 * 60_000;

const API_BASE = 'https://api.telegram.org';

// ─── Types ───────────────────────────────────────────────────────────────

interface ActiveIndicator {
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
  /** Safety timeout that force-stops after MAX_DURATION_MS. */
  safetyTimeout: ReturnType<typeof setTimeout>;
}

// ─── Service ─────────────────────────────────────────────────────────────

class TypingIndicatorService {
  private active = new Map<string, ActiveIndicator>();
  private botToken: string | null = null;
  private tokenResolved = false;

  /** Resolve the bot token lazily (only when first needed). */
  private getToken(): string | null {
    if (this.tokenResolved) return this.botToken;
    this.tokenResolved = true;

    try {
      const vault = getCredentialVault();
      this.botToken = vault.getSecret('bot.telegram.botToken', 'typing-indicator') ?? null;
    } catch {
      this.botToken = process.env.TELEGRAM_BOT_TOKEN ?? null;
    }
    return this.botToken;
  }

  /**
   * Start the typing indicator for a chat.
   * Sends `sendChatAction` immediately, then repeats every 4.5s.
   */
  start(chatId: string): void {
    const token = this.getToken();
    if (!token) return; // No bot token — can't send typing

    const key = String(chatId);
    if (this.active.has(key)) return; // Already typing for this chat

    // Fire immediately
    this.sendTyping(token, key);

    // Repeat on interval
    const timer = setInterval(() => this.sendTyping(token, key), REPEAT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    // Safety cap
    const safetyTimeout = setTimeout(() => this.stop(key), MAX_DURATION_MS);
    if (typeof safetyTimeout.unref === 'function') safetyTimeout.unref();

    this.active.set(key, { timer, startedAt: Date.now(), safetyTimeout });
  }

  /** Stop the typing indicator for a chat. */
  stop(chatId: string): void {
    const key = String(chatId);
    const entry = this.active.get(key);
    if (!entry) return;

    clearInterval(entry.timer);
    clearTimeout(entry.safetyTimeout);
    this.active.delete(key);
  }

  /** Stop all active indicators (for shutdown). */
  stopAll(): void {
    for (const [key] of this.active) {
      this.stop(key);
    }
  }

  /** Number of chats with active typing indicator (for testing). */
  get size(): number {
    return this.active.size;
  }

  /** Whether a chat has an active indicator (for testing). */
  isActive(chatId: string): boolean {
    return this.active.has(String(chatId));
  }

  /** Send a single sendChatAction typing call. Fire-and-forget. */
  private sendTyping(token: string, chatId: string): void {
    const url = `${API_BASE}/bot${token}/sendChatAction`;
    guardedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      // Non-critical — swallow errors silently.
      // Common failures: bot token invalid, chat not found, rate limited.
    });
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let instance: TypingIndicatorService | null = null;

export function getTypingIndicator(): TypingIndicatorService {
  if (!instance) {
    instance = new TypingIndicatorService();
  }
  return instance;
}

export function resetTypingIndicator(): void {
  instance?.stopAll();
  instance = null;
}
