/**
 * Forum Topic commands — manage Telegram threaded mode topics.
 *
 * /topics         — List registered topics and their bindings
 * /topics_setup   — Set up suggested topic structure
 * /topic_bind     — Bind a topic to a persona/mode configuration
 * /topic_unbind   — Remove a topic binding
 */

import { getForumTopics, type TopicPurpose } from '../services/forum-topics.js';
import { getThreadBindings } from '../services/thread-bindings.js';

function getSenderId(ctx: any): string {
  return ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'unknown';
}

function getChatId(ctx: any): string {
  return ctx?.chatId ?? ctx?.metadata?.chatId ?? getSenderId(ctx);
}

export const topicsCommand = {
  name: 'topics',
  description: 'List forum topics and their bindings',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const chatId = getChatId(ctx);
    const topics = getForumTopics();
    const bindings = getThreadBindings();

    if (!topics.isForumEnabled(chatId)) {
      return {
        text: `**Forum Topics: Not Enabled**

To use forum topics:
1. Enable Topics mode in BotFather for this group
2. Create topics in the group (Trading, Portfolio, Research, Alerts, etc.)
3. Run **/topics_setup** in the group to register topics

Forum topics give each conversation thread its own isolated LLM context, persona, and safety mode.`,
      };
    }

    const registered = topics.listTopics(chatId);
    if (registered.length === 0) {
      return {
        text: 'Forum mode is enabled but no topics are registered.\n\nRun **/topics_setup** to set up the suggested topic structure.',
      };
    }

    const lines = ['**Forum Topics**', ''];

    for (const topic of registered) {
      const binding = bindings.getEffectiveBinding(chatId, topic.threadId, topic.purpose);
      const parts = [
        `**${topic.name}** (${topic.purpose})`,
        `  Thread ID: ${topic.threadId}`,
      ];
      if (binding.persona) parts.push(`  Persona: ${binding.persona}`);
      if (binding.safetyMode) parts.push(`  Safety: ${binding.safetyMode}`);
      if (topic.receivesNotifications) parts.push('  Receives notifications');
      lines.push(parts.join('\n'));
    }

    return { text: lines.join('\n') };
  },
};

export const topicsSetupCommand = {
  name: 'topics_setup',
  description: 'Set up suggested forum topic structure with default bindings',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const chatId = getChatId(ctx);
    const topics = getForumTopics();
    const bindings = getThreadBindings();

    topics.setForumEnabled(chatId, true);

    const suggested = topics.getSuggestedTopics();
    const lines = [
      '**Forum Topics Setup**',
      '',
      'Create these topics in your Telegram group, then register each one with **/topic_bind**:',
      '',
    ];

    for (let i = 0; i < suggested.length; i++) {
      const s = suggested[i]!;
      lines.push(`${i + 1}. **${s.emoji} ${s.name}** — ${s.purpose}`);
    }

    lines.push(
      '',
      'After creating topics in Telegram, register each one:',
      '```',
      '/topic_bind <thread_id> <purpose>',
      '/topic_bind 42 trading',
      '/topic_bind 43 portfolio',
      '```',
      '',
      'Thread IDs are visible in the Telegram API response when you create topics.',
      '',
      'Forum mode is now **enabled** for this chat.',
    );

    return { text: lines.join('\n') };
  },
};

export const topicBindCommand = {
  name: 'topic_bind',
  description: 'Bind a topic to a purpose and configuration (e.g. /topic_bind 42 trading)',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx: any) => {
    const chatId = getChatId(ctx);
    const args = (ctx?.args ?? ctx?.text ?? '').trim();

    // Parse: <thread_id> <purpose> [persona]
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
      return {
        text: 'Usage: /topic_bind <thread_id> <purpose> [persona]\n\nPurposes: trading, portfolio, research, alerts, governance, social, admin, general\nPersonas: professional, degen, chill, technical, mentor',
      };
    }

    const threadId = parseInt(parts[0]!, 10);
    if (isNaN(threadId)) {
      return { text: 'Invalid thread_id. Must be a number.' };
    }

    const purpose = parts[1]!.toLowerCase() as TopicPurpose;
    const validPurposes: TopicPurpose[] = ['general', 'trading', 'portfolio', 'research', 'alerts', 'governance', 'social', 'admin'];
    if (!validPurposes.includes(purpose)) {
      return { text: `Invalid purpose: "${purpose}". Valid: ${validPurposes.join(', ')}` };
    }

    const persona = parts[2] ?? undefined;

    const topics = getForumTopics();
    const bindings = getThreadBindings();

    // Register topic
    topics.registerTopic(chatId, threadId, purpose, purpose);

    // Apply binding
    const binding = bindings.applyDefaults(chatId, threadId, purpose);
    if (persona) {
      bindings.bind(chatId, threadId, { persona });
    }

    return {
      text: `Topic bound: thread ${threadId} → **${purpose}**${persona ? ` (persona: ${persona})` : ''}\n\nSafety mode: ${binding.safetyMode ?? 'default'}\nNotifications: ${topics.listTopics(chatId).find(t => t.threadId === threadId)?.receivesNotifications ? 'yes' : 'no'}`,
    };
  },
};

export const topicUnbindCommand = {
  name: 'topic_unbind',
  description: 'Remove a topic binding (e.g. /topic_unbind 42)',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx: any) => {
    const chatId = getChatId(ctx);
    const args = (ctx?.args ?? ctx?.text ?? '').trim();

    const threadId = parseInt(args, 10);
    if (isNaN(threadId)) {
      return { text: 'Usage: /topic_unbind <thread_id>' };
    }

    const topics = getForumTopics();
    const bindings = getThreadBindings();

    const removed = topics.unregisterTopic(chatId, threadId);
    bindings.unbind(chatId, threadId);

    return {
      text: removed
        ? `Topic ${threadId} unbound and removed.`
        : `No topic found with thread ID ${threadId}.`,
    };
  },
};
