/**
 * Channel-Agnostic Message Sender
 *
 * Abstracts OpenClaw's per-channel sendMessage* functions into a single
 * interface so the rest of the crypto extension never hard-codes a channel.
 *
 * Dynamically discovers available channels from `api.runtime.channel` at
 * runtime, so new channels added to OpenClaw (e.g. Matrix, Teams, Nostr)
 * are picked up automatically.
 *
 * Usage:
 *   const sender = createChannelSender(api);
 *   await sender.send('telegram', chatId, 'Hello!');
 *
 * Or with auto-detection from session key / hook context:
 *   await sender.sendToSession(sessionKey, chatId, 'Hello!');
 */

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Channel identifier. This is a string (not a union) so new channels added
 * upstream are supported without code changes here.
 */
export type ChannelId = string;

/**
 * Well-known channels for static references. This list does NOT limit which
 * channels can be used — it's only for code that needs a specific channel name.
 */
const WELL_KNOWN_CHANNELS = new Set([
  'telegram', 'discord', 'slack', 'signal', 'imessage', 'bluebubbles',
  'whatsapp', 'line', 'matrix', 'msteams', 'googlechat', 'feishu',
  'irc', 'mattermost', 'nextcloud-talk', 'nostr', 'synology-chat',
  'tlon', 'twitch', 'zalo', 'zalouser', 'webchat',
]);

/**
 * Known sendMessage function naming convention per channel.
 * OpenClaw uses: runtime.channel.<name>.sendMessage<PascalCase>
 * We map from the channel name to the expected function name.
 */
const SEND_FN_OVERRIDES: Record<string, string> = {
  imessage: 'sendMessageIMessage',
  whatsapp: 'sendMessageWhatsApp',
  msteams: 'sendMessageMSTeams',
  googlechat: 'sendMessageGoogleChat',
  bluebubbles: 'sendMessageBlueBubbles',
  'nextcloud-talk': 'sendMessageNextcloudTalk',
  'synology-chat': 'sendMessageSynologyChat',
  webchat: 'sendMessageWebChat',
  zalouser: 'sendMessageZaloUser',
};

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

  /**
   * List all channels that have a send function available on the current runtime.
   */
  availableChannels(): string[];
}

// ── Session Key Parsing ─────────────────────────────────────────────────────

/**
 * Check if a string looks like a known channel name.
 * Accepts well-known channels plus any key present on `api.runtime.channel`.
 */
function isChannelName(candidate: string, runtimeChannels?: Set<string>): boolean {
  if (WELL_KNOWN_CHANNELS.has(candidate)) return true;
  if (runtimeChannels?.has(candidate)) return true;
  return false;
}

/** Lazily built set of runtime channel names for parseSessionKey. */
let _runtimeChannelNames: Set<string> | undefined;

/**
 * Provide runtime channel names so parseSessionKey can recognize dynamically
 * registered channels. Called once when createChannelSender initializes.
 */
export function setRuntimeChannelNames(names: Set<string>): void {
  _runtimeChannelNames = names;
}

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
 *   matrix-@user:server.com   (Matrix)
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
    if (isChannelName(candidate, _runtimeChannelNames)) {
      // userId is everything between the first and second separator (or end of string)
      const rest = sessionKey.slice(idx + 1);
      // For compound keys like "telegram-123456-agent-default", extract just the ID
      // We look for a numeric-ish or identifier portion
      const idMatch = rest.match(/^([^-:]+)/);
      const userId = idMatch?.[1] ?? rest;
      if (userId) {
        return { channel: candidate, userId };
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
  if (ctx?.channelId && typeof ctx.channelId === 'string') {
    return ctx.channelId;
  }
  if (ctx?.messageChannel && typeof ctx.messageChannel === 'string') {
    return ctx.messageChannel;
  }
  if (ctx?.sessionKey) {
    const parsed = parseSessionKey(ctx.sessionKey);
    if (parsed) return parsed.channel;
  }
  return null;
}

// ── Channel Sender Factory ──────────────────────────────────────────────────

/**
 * Derive the expected sendMessage function name for a channel.
 *
 * Convention: runtime.channel.<name>.sendMessage<PascalCase>
 * e.g., telegram → sendMessageTelegram, discord → sendMessageDiscord
 *
 * Some channels have non-standard casing — handled via SEND_FN_OVERRIDES.
 */
function deriveSendFnName(channel: string): string {
  const override = SEND_FN_OVERRIDES[channel];
  if (override) return override;
  // Default: sendMessage + capitalize first letter
  return 'sendMessage' + channel.charAt(0).toUpperCase() + channel.slice(1);
}

/**
 * Create a channel-agnostic sender backed by the plugin API's runtime.
 *
 * Dynamically discovers channels from `api.runtime.channel` so new upstream
 * channels are automatically supported.
 */
export function createChannelSender(api: any): ChannelSender {
  // Build runtime channel name set for parseSessionKey to use
  const runtime = api.runtime?.channel;
  if (runtime && typeof runtime === 'object') {
    const names = new Set(Object.keys(runtime));
    setRuntimeChannelNames(names);
  }

  /** Get the send function for a given channel, or null if unavailable. */
  function getSendFn(channel: string): ((recipientId: string, text: string, opts: any) => Promise<any>) | null {
    if (!runtime) return null;

    const channelRuntime = runtime[channel];
    if (!channelRuntime) return null;

    // Try the derived function name first
    const fnName = deriveSendFnName(channel);
    if (typeof channelRuntime[fnName] === 'function') {
      return channelRuntime[fnName];
    }

    // Fallback: look for any function matching sendMessage*
    for (const key of Object.keys(channelRuntime)) {
      if (key.startsWith('sendMessage') && typeof channelRuntime[key] === 'function') {
        return channelRuntime[key];
      }
    }

    return null;
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

    availableChannels() {
      if (!runtime || typeof runtime !== 'object') return [];
      return Object.keys(runtime).filter(ch => getSendFn(ch) !== null);
    },
  };
}
