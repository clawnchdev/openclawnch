/**
 * Channel-Agnostic Message Sender
 *
 * Abstracts OpenClaw's per-channel sendMessage* functions into a single
 * interface so the rest of the crypto extension never hard-codes a channel.
 *
 * Supported channels: telegram, discord, slack, signal, imessage, whatsapp, line.
 *
 * Usage:
 *   const sender = createChannelSender(api);
 *   await sender.send('telegram', chatId, 'Hello!');
 *
 * Or with auto-detection from session key / hook context:
 *   await sender.sendToSession(sessionKey, chatId, 'Hello!');
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** All channel IDs that OpenClaw supports. */
export type ChannelId = 'telegram' | 'discord' | 'slack' | 'signal' | 'imessage' | 'whatsapp' | 'line';

const SUPPORTED_CHANNELS: ReadonlySet<string> = new Set<ChannelId>([
  'telegram', 'discord', 'slack', 'signal', 'imessage', 'whatsapp', 'line',
]);

export interface SendOptions {
  /** Account ID for multi-account setups. Defaults to 'default'. */
  accountId?: string;
}

export interface ChannelSender {
  /**
   * Send a message to a specific channel + recipient.
   * Returns true on success, false if the channel's send function isn't available.
   */
  send(channel: ChannelId, recipientId: string, text: string, opts?: SendOptions): Promise<boolean>;

  /**
   * Auto-detect channel from a session key (e.g. "telegram-123456", "discord:789")
   * and send to the extracted recipient.
   */
  sendToSession(sessionKey: string, text: string, opts?: SendOptions): Promise<boolean>;

  /**
   * Check if a channel's send function is available on the current runtime.
   */
  isAvailable(channel: ChannelId): boolean;
}

// ── Session Key Parsing ─────────────────────────────────────────────────────

/**
 * Parse a session key to extract the channel and user/chat ID.
 *
 * OpenClaw session keys follow these patterns:
 *   telegram-123456789        (Telegram user ID)
 *   telegram:123456789        (alternate separator)
 *   discord-987654321         (Discord user/channel ID)
 *   discord:987654321
 *   slack-U1234567            (Slack user ID)
 *   signal-+15551234567       (Signal phone number)
 *   whatsapp-15551234567      (WhatsApp)
 *   imessage-user@icloud.com  (iMessage)
 *   line-U1234567             (LINE user ID)
 *
 * Also handles compound keys like "telegram-123456789-agent-default".
 */
export function parseSessionKey(sessionKey: string): { channel: ChannelId; userId: string } | null {
  if (!sessionKey) return null;

  // Try pattern: <channel><separator><userId>[<separator>rest...]
  // Separator is either '-' or ':'
  for (const sep of [':', '-']) {
    const idx = sessionKey.indexOf(sep);
    if (idx === -1) continue;

    const candidate = sessionKey.slice(0, idx).toLowerCase();
    if (SUPPORTED_CHANNELS.has(candidate)) {
      // userId is everything between the first and second separator (or end of string)
      const rest = sessionKey.slice(idx + 1);
      // For compound keys like "telegram-123456-agent-default", extract just the ID
      // We look for a numeric-ish or identifier portion
      const idMatch = rest.match(/^([^-:]+)/);
      const userId = idMatch?.[1] ?? rest;
      if (userId) {
        return { channel: candidate as ChannelId, userId };
      }
    }
  }

  return null;
}

/**
 * Extract a user/sender ID from hook context — channel-agnostic.
 *
 * Tries multiple sources in priority order:
 * 1. ctx.requesterSenderId (OpenClaw tool context)
 * 2. ctx.senderId
 * 3. event.from / event.metadata.senderId
 * 4. parseSessionKey(ctx.sessionKey).userId
 */
export function extractSenderId(event: any, ctx: any): string | null {
  // Direct from context (most reliable)
  if (ctx?.requesterSenderId) return String(ctx.requesterSenderId);
  if (ctx?.senderId) return String(ctx.senderId);

  // From event payload
  if (event?.from) return String(event.from);
  if (event?.metadata?.senderId) return String(event.metadata.senderId);

  // Fall back to session key parsing
  if (ctx?.sessionKey) {
    const parsed = parseSessionKey(ctx.sessionKey);
    if (parsed) return parsed.userId;
  }

  return null;
}

/**
 * Extract the channel ID from hook context — channel-agnostic.
 *
 * Tries:
 * 1. ctx.channelId (directly from OpenClaw hook context)
 * 2. ctx.messageChannel
 * 3. parseSessionKey(ctx.sessionKey).channel
 */
export function extractChannelId(ctx: any): ChannelId | null {
  if (ctx?.channelId && SUPPORTED_CHANNELS.has(ctx.channelId)) {
    return ctx.channelId as ChannelId;
  }
  if (ctx?.messageChannel && SUPPORTED_CHANNELS.has(ctx.messageChannel)) {
    return ctx.messageChannel as ChannelId;
  }
  if (ctx?.sessionKey) {
    const parsed = parseSessionKey(ctx.sessionKey);
    if (parsed) return parsed.channel;
  }
  return null;
}

// ── Channel Sender Factory ──────────────────────────────────────────────────

/**
 * Create a channel-agnostic sender backed by the plugin API's runtime.
 *
 * The api.runtime.channel.<channel>.sendMessage<Channel> functions have
 * different signatures per channel, but they all accept (recipientId, text, options).
 */
export function createChannelSender(api: any): ChannelSender {
  /** Get the send function for a given channel, or null if unavailable. */
  function getSendFn(channel: ChannelId): ((recipientId: string, text: string, opts: any) => Promise<any>) | null {
    const runtime = api.runtime?.channel;
    if (!runtime) return null;

    switch (channel) {
      case 'telegram':
        return runtime.telegram?.sendMessageTelegram ?? null;
      case 'discord':
        return runtime.discord?.sendMessageDiscord ?? null;
      case 'slack':
        return runtime.slack?.sendMessageSlack ?? null;
      case 'signal':
        return runtime.signal?.sendMessageSignal ?? null;
      case 'imessage':
        return runtime.imessage?.sendMessageIMessage ?? null;
      case 'whatsapp':
        return runtime.whatsapp?.sendMessageWhatsApp ?? null;
      case 'line':
        return runtime.line?.sendMessageLine ?? null;
      default:
        return null;
    }
  }

  return {
    async send(channel, recipientId, text, opts) {
      const sendFn = getSendFn(channel);
      if (!sendFn) {
        api.logger?.warn?.(
          `[crypto] Channel sender: ${channel} sendMessage not available`
        );
        return false;
      }

      try {
        await sendFn(recipientId, text, { accountId: opts?.accountId ?? 'default' });
        return true;
      } catch (err) {
        api.logger?.warn?.(
          `[crypto] Channel sender: failed to send via ${channel}: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      }
    },

    async sendToSession(sessionKey, text, opts) {
      const parsed = parseSessionKey(sessionKey);
      if (!parsed) {
        api.logger?.warn?.(
          `[crypto] Channel sender: could not parse session key "${sessionKey}"`
        );
        return false;
      }
      return this.send(parsed.channel, parsed.userId, text, opts);
    },

    isAvailable(channel) {
      return getSendFn(channel) !== null;
    },
  };
}
