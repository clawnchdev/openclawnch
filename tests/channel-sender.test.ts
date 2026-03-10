/**
 * Tests for the channel-agnostic message sender abstraction.
 *
 * Covers:
 * - Session key parsing (all channels, separators, compound keys)
 * - extractSenderId from various context shapes
 * - extractChannelId from various context shapes
 * - createChannelSender routing to correct sendMessage* function
 * - Fallback behavior when channel is unavailable
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseSessionKey,
  extractSenderId,
  extractChannelId,
  createChannelSender,
  type ChannelId,
} from '../extensions/crypto/src/services/channel-sender.js';

// ── parseSessionKey ─────────────────────────────────────────────────────

describe('parseSessionKey', () => {
  it('parses telegram session keys with dash separator', () => {
    const result = parseSessionKey('telegram-123456789');
    expect(result).toEqual({ channel: 'telegram', userId: '123456789' });
  });

  it('parses telegram session keys with colon separator', () => {
    const result = parseSessionKey('telegram:123456789');
    expect(result).toEqual({ channel: 'telegram', userId: '123456789' });
  });

  it('parses discord session keys', () => {
    const result = parseSessionKey('discord-987654321');
    expect(result).toEqual({ channel: 'discord', userId: '987654321' });
  });

  it('parses slack session keys', () => {
    const result = parseSessionKey('slack-U1234567');
    expect(result).toEqual({ channel: 'slack', userId: 'U1234567' });
  });

  it('parses signal session keys with phone number', () => {
    const result = parseSessionKey('signal:+15551234567');
    expect(result).toEqual({ channel: 'signal', userId: '+15551234567' });
  });

  it('parses whatsapp session keys', () => {
    const result = parseSessionKey('whatsapp-15551234567');
    expect(result).toEqual({ channel: 'whatsapp', userId: '15551234567' });
  });

  it('parses imessage session keys', () => {
    const result = parseSessionKey('imessage-user@icloud.com');
    expect(result).toEqual({ channel: 'imessage', userId: 'user@icloud.com' });
  });

  it('parses line session keys', () => {
    const result = parseSessionKey('line-U9876543');
    expect(result).toEqual({ channel: 'line', userId: 'U9876543' });
  });

  it('handles compound session keys (extracts first ID segment)', () => {
    const result = parseSessionKey('telegram-123456789-agent-default');
    expect(result).toEqual({ channel: 'telegram', userId: '123456789' });
  });

  it('is case-insensitive for channel name', () => {
    const result = parseSessionKey('Telegram-123');
    expect(result).toEqual({ channel: 'telegram', userId: '123' });
  });

  it('returns null for empty string', () => {
    expect(parseSessionKey('')).toBeNull();
  });

  it('returns null for unknown channel', () => {
    expect(parseSessionKey('xmpp-user123')).toBeNull();
  });

  it('returns null for string without separator', () => {
    expect(parseSessionKey('telegramuser')).toBeNull();
  });
});

// ── extractSenderId ─────────────────────────────────────────────────────

describe('extractSenderId', () => {
  it('returns requesterSenderId from ctx when available', () => {
    const ctx = { requesterSenderId: '12345' };
    expect(extractSenderId({}, ctx)).toBe('12345');
  });

  it('falls back to ctx.senderId', () => {
    const ctx = { senderId: '67890' };
    expect(extractSenderId({}, ctx)).toBe('67890');
  });

  it('falls back to event.from', () => {
    const event = { from: '111' };
    expect(extractSenderId(event, {})).toBe('111');
  });

  it('falls back to event.metadata.senderId', () => {
    const event = { metadata: { senderId: '222' } };
    expect(extractSenderId(event, {})).toBe('222');
  });

  it('falls back to parsing sessionKey', () => {
    const ctx = { sessionKey: 'telegram-333' };
    expect(extractSenderId({}, ctx)).toBe('333');
  });

  it('returns null if nothing is available', () => {
    expect(extractSenderId({}, {})).toBeNull();
    expect(extractSenderId(null, null)).toBeNull();
  });

  it('prefers requesterSenderId over sessionKey', () => {
    const ctx = { requesterSenderId: 'preferred', sessionKey: 'telegram-fallback' };
    expect(extractSenderId({}, ctx)).toBe('preferred');
  });
});

// ── extractChannelId ────────────────────────────────────────────────────

describe('extractChannelId', () => {
  it('returns channelId from ctx when valid', () => {
    expect(extractChannelId({ channelId: 'telegram' })).toBe('telegram');
    expect(extractChannelId({ channelId: 'discord' })).toBe('discord');
    expect(extractChannelId({ channelId: 'slack' })).toBe('slack');
  });

  it('falls back to messageChannel', () => {
    expect(extractChannelId({ messageChannel: 'signal' })).toBe('signal');
  });

  it('falls back to sessionKey parsing', () => {
    expect(extractChannelId({ sessionKey: 'whatsapp-123' })).toBe('whatsapp');
  });

  it('passes through unknown channel names (dynamic discovery)', () => {
    // With dynamic channel support, any string channelId is accepted.
    // The sender will return false if no send function is found at runtime.
    expect(extractChannelId({ channelId: 'xmpp' })).toBe('xmpp');
  });

  it('returns null for empty context', () => {
    expect(extractChannelId({})).toBeNull();
    expect(extractChannelId(null)).toBeNull();
  });
});

// ── createChannelSender ─────────────────────────────────────────────────

describe('createChannelSender', () => {
  /**
   * The actual sendMessage function names from OpenClaw's channel runtime:
   * telegram → sendMessageTelegram
   * discord  → sendMessageDiscord
   * slack    → sendMessageSlack
   * signal   → sendMessageSignal
   * imessage → sendMessageIMessage
   * whatsapp → sendMessageWhatsApp
   * line     → sendMessageLine
   */
  const SEND_FN_NAMES: Record<ChannelId, string> = {
    telegram: 'sendMessageTelegram',
    discord: 'sendMessageDiscord',
    slack: 'sendMessageSlack',
    signal: 'sendMessageSignal',
    imessage: 'sendMessageIMessage',
    whatsapp: 'sendMessageWhatsApp',
    line: 'sendMessageLine',
  };

  function makeMockApi(channels: Partial<Record<ChannelId, boolean>> = {}) {
    const fns: Record<string, ReturnType<typeof vi.fn>> = {};
    const runtime: any = { channel: {} };

    for (const [ch, available] of Object.entries(channels)) {
      if (available) {
        const fn = vi.fn().mockResolvedValue(undefined);
        fns[ch] = fn;
        const sendName = SEND_FN_NAMES[ch as ChannelId];
        runtime.channel[ch] = { [sendName]: fn };
      }
    }

    return {
      api: { runtime, logger: { warn: vi.fn(), info: vi.fn() } },
      fns,
    };
  }

  it('routes to telegram sendMessageTelegram', async () => {
    const { api, fns } = makeMockApi({ telegram: true });
    const sender = createChannelSender(api);

    const ok = await sender.send('telegram', '123', 'Hello');
    expect(ok).toBe(true);
    expect(fns.telegram).toHaveBeenCalledWith('123', 'Hello', { accountId: 'default' });
  });

  it('routes to discord sendMessageDiscord', async () => {
    const { api, fns } = makeMockApi({ discord: true });
    const sender = createChannelSender(api);

    const ok = await sender.send('discord', '456', 'Hi Discord');
    expect(ok).toBe(true);
    expect(fns.discord).toHaveBeenCalledWith('456', 'Hi Discord', { accountId: 'default' });
  });

  it('routes to slack sendMessageSlack', async () => {
    const { api, fns } = makeMockApi({ slack: true });
    const sender = createChannelSender(api);

    const ok = await sender.send('slack', 'C123', 'Hi Slack');
    expect(ok).toBe(true);
    expect(fns.slack).toHaveBeenCalledWith('C123', 'Hi Slack', { accountId: 'default' });
  });

  it('returns false when channel is not available', async () => {
    const { api } = makeMockApi({}); // no channels
    const sender = createChannelSender(api);

    const ok = await sender.send('telegram', '123', 'Hello');
    expect(ok).toBe(false);
  });

  it('returns false when send throws', async () => {
    const { api, fns } = makeMockApi({ telegram: true });
    fns.telegram!.mockRejectedValue(new Error('network error'));
    const sender = createChannelSender(api);

    const ok = await sender.send('telegram', '123', 'Hello');
    expect(ok).toBe(false);
  });

  it('passes custom accountId', async () => {
    const { api, fns } = makeMockApi({ telegram: true });
    const sender = createChannelSender(api);

    await sender.send('telegram', '123', 'Hello', { accountId: 'my-account' });
    expect(fns.telegram).toHaveBeenCalledWith('123', 'Hello', { accountId: 'my-account' });
  });

  it('isAvailable returns true for configured channels', () => {
    const { api } = makeMockApi({ telegram: true, discord: true });
    const sender = createChannelSender(api);

    expect(sender.isAvailable('telegram')).toBe(true);
    expect(sender.isAvailable('discord')).toBe(true);
    expect(sender.isAvailable('slack')).toBe(false);
  });

  it('sendToSession auto-detects channel from session key', async () => {
    const { api, fns } = makeMockApi({ discord: true });
    const sender = createChannelSender(api);

    const ok = await sender.sendToSession('discord-789', 'Hello from session');
    expect(ok).toBe(true);
    expect(fns.discord).toHaveBeenCalledWith('789', 'Hello from session', { accountId: 'default' });
  });

  it('sendToSession returns false for unparseable session key', async () => {
    const { api } = makeMockApi({ telegram: true });
    const sender = createChannelSender(api);

    const ok = await sender.sendToSession('garbage', 'Hello');
    expect(ok).toBe(false);
  });

  it('routes to all 7 supported channels', async () => {
    const allChannels: ChannelId[] = ['telegram', 'discord', 'slack', 'signal', 'imessage', 'whatsapp', 'line'];
    const channelMap: Partial<Record<ChannelId, boolean>> = {};
    for (const ch of allChannels) channelMap[ch] = true;

    const { api, fns } = makeMockApi(channelMap);
    const sender = createChannelSender(api);

    for (const ch of allChannels) {
      const ok = await sender.send(ch, 'test-id', `Hello ${ch}`);
      expect(ok).toBe(true);
      expect(fns[ch]).toHaveBeenCalled();
    }
  });
});
