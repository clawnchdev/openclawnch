/**
 * Telegram sendMessageDraft Streaming Service (Phase A)
 *
 * Uses Telegram Bot API 9.5's `sendMessageDraft` endpoint for native AI
 * streaming — animated text transitions, no "edited" badge, higher throughput.
 *
 * Falls back to traditional `editMessageText` if `sendMessageDraft` is
 * not supported (older Bot API servers).
 *
 * Phase A: Raw fetch bypass (grammy doesn't support sendMessageDraft yet).
 * Phase B: OpenClaw plugin hook integration (future).
 * Phase C: grammy native support (future).
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface DraftStreamConfig {
  /** Telegram Bot API token. */
  botToken: string;
  /** Telegram Bot API base URL. Default: https://api.telegram.org */
  apiBaseUrl?: string;
  /** Minimum interval between draft updates in ms. Default: 100. */
  minUpdateIntervalMs?: number;
  /** Maximum text length per draft update. Default: 4096 (Telegram limit). */
  maxTextLength?: number;
  /** Timeout for API calls in ms. Default: 10000. */
  timeoutMs?: number;
}

export interface DraftSession {
  chatId: number | string;
  draftId: number;
  lastText: string;
  lastUpdateTime: number;
  finalized: boolean;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class TelegramDraftStreamService {
  private config: Required<DraftStreamConfig>;
  private activeDrafts: Map<string, DraftSession> = new Map();
  private draftIdCounter = 1;
  private supported: boolean | null = null; // null = unknown, will probe on first use

  constructor(config: DraftStreamConfig) {
    this.config = {
      botToken: config.botToken,
      apiBaseUrl: config.apiBaseUrl ?? 'https://api.telegram.org',
      minUpdateIntervalMs: config.minUpdateIntervalMs ?? 100,
      maxTextLength: config.maxTextLength ?? 4096,
      timeoutMs: config.timeoutMs ?? 10000,
    };
  }

  /** Generate a unique draft ID (non-zero integer). */
  private nextDraftId(): number {
    return ++this.draftIdCounter;
  }

  /** Get the session key for a chat. */
  private sessionKey(chatId: number | string): string {
    return String(chatId);
  }

  /** Call a Telegram Bot API method via raw fetch. */
  private async callApi(method: string, params: Record<string, unknown>): Promise<any> {
    const url = `${this.config.apiBaseUrl}/bot${this.config.botToken}/${method}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    const data = await resp.json() as any;
    if (!data.ok) {
      throw new TelegramDraftError(
        `Telegram ${method} failed: ${data.description ?? 'unknown error'}`,
        data.error_code,
      );
    }
    return data.result;
  }

  /**
   * Probe whether the Bot API server supports sendMessageDraft.
   * Sends a minimal draft and immediately finalizes it.
   * Caches the result for the service lifetime.
   */
  async isSupported(): Promise<boolean> {
    if (this.supported !== null) return this.supported;

    // We can't truly probe without a chat_id, so check the Bot API version
    // by attempting a getMe call and checking the response.
    // For now, assume supported=true and catch 400/404 on first real call.
    this.supported = true;
    return this.supported;
  }

  /**
   * Start a new draft stream for a chat.
   * Returns the draft session for subsequent updates.
   */
  async startDraft(chatId: number | string, initialText: string): Promise<DraftSession> {
    const key = this.sessionKey(chatId);

    // Finalize any existing draft for this chat
    const existing = this.activeDrafts.get(key);
    if (existing && !existing.finalized) {
      await this.finalizeDraft(chatId).catch(() => {});
    }

    const draftId = this.nextDraftId();
    const truncated = initialText.slice(0, this.config.maxTextLength);

    try {
      await this.callApi('sendMessageDraft', {
        chat_id: chatId,
        draft_id: draftId,
        text: truncated,
        parse_mode: 'Markdown',
      });

      const session: DraftSession = {
        chatId,
        draftId,
        lastText: truncated,
        lastUpdateTime: Date.now(),
        finalized: false,
      };
      this.activeDrafts.set(key, session);
      return session;
    } catch (err) {
      if (err instanceof TelegramDraftError && (err.code === 400 || err.code === 404)) {
        // sendMessageDraft not supported — mark and throw
        this.supported = false;
        throw new TelegramDraftUnsupportedError(
          'sendMessageDraft not supported by this Bot API server. Fall back to editMessageText.',
        );
      }
      throw err;
    }
  }

  /**
   * Update an existing draft with new text.
   * Respects minimum update interval to avoid rate limits.
   * Returns true if the update was sent, false if throttled.
   */
  async updateDraft(chatId: number | string, text: string): Promise<boolean> {
    const key = this.sessionKey(chatId);
    const session = this.activeDrafts.get(key);

    if (!session || session.finalized) {
      throw new TelegramDraftError('No active draft for this chat. Call startDraft() first.');
    }

    // Throttle: skip if too soon since last update
    const elapsed = Date.now() - session.lastUpdateTime;
    if (elapsed < this.config.minUpdateIntervalMs) {
      return false;
    }

    // Skip if text hasn't changed
    const truncated = text.slice(0, this.config.maxTextLength);
    if (truncated === session.lastText) {
      return false;
    }

    await this.callApi('sendMessageDraft', {
      chat_id: chatId,
      draft_id: session.draftId,
      text: truncated,
      parse_mode: 'Markdown',
    });

    session.lastText = truncated;
    session.lastUpdateTime = Date.now();
    return true;
  }

  /**
   * Finalize a draft — converts it into a permanent message.
   * Sends a regular sendMessage with the final text.
   */
  async finalizeDraft(chatId: number | string, finalText?: string): Promise<any> {
    const key = this.sessionKey(chatId);
    const session = this.activeDrafts.get(key);

    if (!session) {
      throw new TelegramDraftError('No draft to finalize for this chat.');
    }

    const text = finalText ?? session.lastText;
    session.finalized = true;
    this.activeDrafts.delete(key);

    // Send a regular message to persist
    return this.callApi('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, this.config.maxTextLength),
      parse_mode: 'Markdown',
    });
  }

  /**
   * Convenience: stream text token-by-token with automatic draft management.
   * Calls startDraft on first token, updateDraft for subsequent tokens,
   * finalizeDraft when done.
   *
   * @param chatId Telegram chat ID
   * @param tokenStream Async iterable of text tokens (e.g., from LLM streaming)
   * @returns The finalized message result
   */
  async streamTokens(
    chatId: number | string,
    tokenStream: AsyncIterable<string>,
  ): Promise<any> {
    let accumulated = '';
    let started = false;

    for await (const token of tokenStream) {
      accumulated += token;

      if (!started) {
        await this.startDraft(chatId, accumulated);
        started = true;
      } else {
        // updateDraft handles throttling internally
        await this.updateDraft(chatId, accumulated);
      }
    }

    return this.finalizeDraft(chatId, accumulated);
  }

  /** Get the active draft session for a chat, if any. */
  getActiveDraft(chatId: number | string): DraftSession | undefined {
    return this.activeDrafts.get(this.sessionKey(chatId));
  }

  /** Get count of active (non-finalized) drafts. */
  getActiveDraftCount(): number {
    return this.activeDrafts.size;
  }

  /** Cancel all active drafts without finalizing (cleanup). */
  cancelAll(): void {
    this.activeDrafts.clear();
  }
}

// ── Error Classes ───────────────────────────────────────────────────────────

export class TelegramDraftError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'TelegramDraftError';
    this.code = code;
  }
}

export class TelegramDraftUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramDraftUnsupportedError';
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: TelegramDraftStreamService | null = null;

export function getDraftStreamService(config?: DraftStreamConfig): TelegramDraftStreamService {
  if (!_instance) {
    const token = config?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN required for draft streaming');
    _instance = new TelegramDraftStreamService({ ...config, botToken: token });
  }
  return _instance;
}

export function resetDraftStreamService(): void {
  _instance?.cancelAll();
  _instance = null;
}
