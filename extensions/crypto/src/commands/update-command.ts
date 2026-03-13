/**
 * /update + /restart — Update and restart the bot from Telegram.
 *
 * /update  — Clone latest, build, install, restart. Verbose progress.
 * /restart — Just restart the Fly machine (no code update).
 *
 * Both commands send live progress messages to the user's chat via
 * the channel sender so they can see each step happening.
 *
 * Requires: FLY_API_TOKEN (already used by /flykeys, /flystatus, etc.)
 */

import { checkForUpdates, performUpdate, getCurrentCommit } from '../services/update-service.js';
import { isFlyControlAvailable, restartAllMachines } from '../services/fly-control-service.js';
import type { ChannelSender } from '../services/channel-sender.js';
import { parseSessionKey } from '../services/channel-sender.js';

// ─── Dependency injection ────────────────────────────────────────────────
// The channel sender is created in index.ts during plugin registration.
// We store a reference here so the command handlers can send progress.

let _sender: ChannelSender | null = null;

export function setUpdateCommandSender(sender: ChannelSender): void {
  _sender = sender;
}

// ─── /update ─────────────────────────────────────────────────────────────

export const updateCommand = {
  name: 'update',
  description: 'Update to latest OpenClawnch and restart',
  acceptsArgs: false,
  requireAuth: true,

  handler: async (ctx: any) => {
    const sessionKey = ctx?.sessionKey ?? '';
    const chatId = ctx?.conversationId ?? ctx?.senderId ?? '';
    const parsed = sessionKey ? parseSessionKey(sessionKey) : null;
    const channel = parsed?.channel ?? 'telegram';

    // Create a progress function that sends messages to the user
    const progress = async (msg: string) => {
      if (_sender && chatId) {
        try {
          await _sender.send(channel, String(chatId), msg);
        } catch { /* non-critical */ }
      }
    };

    // ── Preflight checks ─────────────────────────────────────────────
    if (!isFlyControlAvailable()) {
      return {
        text: 'Fly.io not configured — /update requires FLY_API_TOKEN.\n\n'
          + 'Set it up:\n'
          + '```\nfly secrets set FLY_API_TOKEN="$(fly tokens create deploy -a <app>)" -a <app>\n```',
      };
    }

    const current = getCurrentCommit();
    await progress(
      `Starting update...\n`
      + `Current: ${current ?? 'unknown'}\n`
      + `This will take 1-2 minutes. You'll see progress below.`
    );

    // ── Run the update ───────────────────────────────────────────────
    const result = await performUpdate(progress);

    if (result.success) {
      // This message may not arrive if the machine restarts fast
      return {
        text: `Update complete.\n${result.message}\n\nBot is restarting — back in ~30s.`,
      };
    }

    return { text: `Update failed.\n\n${result.message}` };
  },
};

// ─── /restart ────────────────────────────────────────────────────────────

export const restartCommand = {
  name: 'restart',
  description: 'Restart the bot (no code update, just restart the machine)',
  acceptsArgs: false,
  requireAuth: true,

  handler: async (ctx: any) => {
    if (!isFlyControlAvailable()) {
      return {
        text: 'Fly.io not configured — /restart requires FLY_API_TOKEN.\n\n'
          + 'Set it up:\n'
          + '```\nfly secrets set FLY_API_TOKEN="$(fly tokens create deploy -a <app>)" -a <app>\n```',
      };
    }

    const sessionKey = ctx?.sessionKey ?? '';
    const chatId = ctx?.conversationId ?? ctx?.senderId ?? '';
    const parsed = sessionKey ? parseSessionKey(sessionKey) : null;
    const channel = parsed?.channel ?? 'telegram';

    // Send a heads-up
    if (_sender && chatId) {
      try {
        await _sender.send(channel, String(chatId), 'Restarting machine...');
      } catch { /* */ }
    }

    try {
      const restarted = await restartAllMachines();
      // This may not arrive if the machine restarts fast
      return {
        text: `Restarting ${restarted.length} machine(s). Back in ~30s.`,
      };
    } catch (err) {
      return {
        text: `Restart failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
