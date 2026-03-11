/**
 * Forum Topics Service — Telegram threaded mode topic management.
 *
 * When Telegram "Topics" mode is enabled (via BotFather), each topic
 * in a group becomes an isolated conversation thread. This service:
 *
 * 1. Maps well-known topic names to purpose categories
 * 2. Routes notifications (heartbeat, cron, alerts) to the right topic
 * 3. Maintains topic ID ↔ purpose mapping per chat
 * 4. Provides session isolation — each topic gets its own LLM context
 *
 * Topic IDs are Telegram message_thread_id values. The "General" topic
 * has thread_id = undefined (or 1 in some API versions).
 *
 * Usage:
 *   const topics = getForumTopics();
 *   topics.registerTopic(chatId, threadId, 'trading');
 *   const threadId = topics.getTopicForPurpose(chatId, 'alerts');
 */

// ── Types ────────────────────────────────────────────────────────────────

export type TopicPurpose =
  | 'general'     // Default / catch-all
  | 'trading'     // Swap, transfer, bridge operations
  | 'portfolio'   // Balance checks, PnL, cost basis
  | 'research'    // Price lookups, analytics, market intel
  | 'alerts'      // Heartbeat, price alerts, cron notifications
  | 'governance'  // DAO proposals, voting
  | 'social'      // Farcaster, ClawnX posting
  | 'admin';      // Bot settings, /setup, /flykeys

export interface TopicConfig {
  /** Telegram message_thread_id */
  threadId: number;
  /** Human-readable topic name (as set in Telegram) */
  name: string;
  /** Mapped purpose category */
  purpose: TopicPurpose;
  /** Whether notifications should be routed here */
  receivesNotifications: boolean;
}

export interface ChatTopics {
  /** Telegram chat ID (group/supergroup) */
  chatId: string;
  /** Whether forum mode is enabled for this chat */
  forumEnabled: boolean;
  /** Registered topics */
  topics: Map<number, TopicConfig>;
  /** Purpose → threadId quick lookup */
  purposeMap: Map<TopicPurpose, number>;
}

// ── Default Topic Names → Purpose Mapping ─────────────────────────────

const NAME_TO_PURPOSE: Record<string, TopicPurpose> = {
  // Trading
  'trading': 'trading', 'trades': 'trading', 'swap': 'trading', 'swaps': 'trading',
  'defi': 'trading', 'transactions': 'trading',
  // Portfolio
  'portfolio': 'portfolio', 'balances': 'portfolio', 'positions': 'portfolio',
  'wallet': 'portfolio', 'holdings': 'portfolio',
  // Research
  'research': 'research', 'analysis': 'research', 'prices': 'research',
  'market': 'research', 'charts': 'research', 'intel': 'research',
  // Alerts
  'alerts': 'alerts', 'notifications': 'alerts', 'heartbeat': 'alerts',
  'monitor': 'alerts', 'watchlist': 'alerts',
  // Governance
  'governance': 'governance', 'dao': 'governance', 'voting': 'governance',
  'proposals': 'governance',
  // Social
  'social': 'social', 'farcaster': 'social', 'twitter': 'social', 'x': 'social',
  // Admin
  'admin': 'admin', 'settings': 'admin', 'config': 'admin', 'setup': 'admin',
  'bot': 'admin',
};

// ── Service ──────────────────────────────────────────────────────────────

export class ForumTopicsService {
  private chats = new Map<string, ChatTopics>();

  /**
   * Register a topic for a chat. Auto-maps name to purpose.
   */
  registerTopic(
    chatId: string,
    threadId: number,
    name: string,
    purpose?: TopicPurpose,
  ): TopicConfig {
    const chat = this.getOrCreateChat(chatId);
    const resolvedPurpose = purpose ?? this.resolvePurpose(name);

    const config: TopicConfig = {
      threadId,
      name,
      purpose: resolvedPurpose,
      receivesNotifications: resolvedPurpose === 'alerts' || resolvedPurpose === 'general',
    };

    chat.topics.set(threadId, config);
    chat.purposeMap.set(resolvedPurpose, threadId);
    chat.forumEnabled = true;

    return config;
  }

  /**
   * Remove a topic registration.
   */
  unregisterTopic(chatId: string, threadId: number): boolean {
    const chat = this.chats.get(chatId);
    if (!chat) return false;

    const config = chat.topics.get(threadId);
    if (!config) return false;

    chat.topics.delete(threadId);
    // Remove from purpose map if it was the mapped topic
    if (chat.purposeMap.get(config.purpose) === threadId) {
      chat.purposeMap.delete(config.purpose);
    }

    return true;
  }

  /**
   * Get the thread ID for a given purpose in a chat.
   * Returns undefined if no topic is mapped for that purpose.
   */
  getTopicForPurpose(chatId: string, purpose: TopicPurpose): number | undefined {
    return this.chats.get(chatId)?.purposeMap.get(purpose);
  }

  /**
   * Get the thread ID for routing a notification.
   * Falls back: alerts topic → general topic → undefined.
   */
  getNotificationTopic(chatId: string): number | undefined {
    const chat = this.chats.get(chatId);
    if (!chat?.forumEnabled) return undefined;
    return chat.purposeMap.get('alerts') ?? chat.purposeMap.get('general');
  }

  /**
   * Get the purpose for a specific thread in a chat.
   */
  getTopicPurpose(chatId: string, threadId: number): TopicPurpose | undefined {
    return this.chats.get(chatId)?.topics.get(threadId)?.purpose;
  }

  /**
   * Generate a session key suffix for a topic, enabling isolated LLM sessions.
   * Returns '-topic-{threadId}' or empty string if no forum mode.
   */
  getSessionKeySuffix(chatId: string, threadId?: number): string {
    if (!threadId) return '';
    const chat = this.chats.get(chatId);
    if (!chat?.forumEnabled) return '';
    return `-topic-${threadId}`;
  }

  /**
   * Check if forum mode is enabled for a chat.
   */
  isForumEnabled(chatId: string): boolean {
    return this.chats.get(chatId)?.forumEnabled ?? false;
  }

  /**
   * Enable/disable forum mode for a chat.
   */
  setForumEnabled(chatId: string, enabled: boolean): void {
    const chat = this.getOrCreateChat(chatId);
    chat.forumEnabled = enabled;
  }

  /**
   * List all registered topics for a chat.
   */
  listTopics(chatId: string): TopicConfig[] {
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    return [...chat.topics.values()];
  }

  /**
   * List all chats with forum mode enabled.
   */
  listForumChats(): string[] {
    return [...this.chats.entries()]
      .filter(([, chat]) => chat.forumEnabled)
      .map(([chatId]) => chatId);
  }

  /**
   * Get suggested topic structure for a new forum-enabled chat.
   */
  getSuggestedTopics(): Array<{ name: string; purpose: TopicPurpose; emoji: string }> {
    return [
      { name: 'Trading', purpose: 'trading', emoji: '📊' },
      { name: 'Portfolio', purpose: 'portfolio', emoji: '💰' },
      { name: 'Research', purpose: 'research', emoji: '🔍' },
      { name: 'Alerts', purpose: 'alerts', emoji: '🔔' },
      { name: 'Governance', purpose: 'governance', emoji: '🗳️' },
      { name: 'Admin', purpose: 'admin', emoji: '⚙️' },
    ];
  }

  // ── Internal ──────────────────────────────────────────────────────

  private getOrCreateChat(chatId: string): ChatTopics {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = {
        chatId,
        forumEnabled: false,
        topics: new Map(),
        purposeMap: new Map(),
      };
      this.chats.set(chatId, chat);
    }
    return chat;
  }

  private resolvePurpose(name: string): TopicPurpose {
    const lower = name.toLowerCase().trim();
    return NAME_TO_PURPOSE[lower] ?? 'general';
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: ForumTopicsService | null = null;

export function getForumTopics(): ForumTopicsService {
  if (!_instance) _instance = new ForumTopicsService();
  return _instance;
}

export function resetForumTopics(): void {
  _instance = null;
}
