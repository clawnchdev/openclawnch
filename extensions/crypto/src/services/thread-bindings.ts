/**
 * Thread Bindings Service — bind agent configurations to Telegram topics.
 *
 * Each Telegram topic can have its own:
 * - Persona override (e.g. "degen" in Trading, "technical" in Research)
 * - Tool restrictions (e.g. only read-only tools in Research)
 * - Safety mode override (e.g. readonly in Research, safe in Trading)
 * - Custom system prompt additions
 *
 * This enables multi-persona or multi-task separation within a single
 * Telegram group. Pairs with ForumTopicsService for topic management.
 *
 * Bindings are keyed by chatId + threadId, stored in memory (reset on restart).
 * Future: persist to MEMORY.md or a dedicated config file.
 *
 * Usage:
 *   const bindings = getThreadBindings();
 *   bindings.bind(chatId, threadId, { persona: 'degen', safetyMode: 'danger' });
 *   const config = bindings.getBinding(chatId, threadId);
 */

import type { TopicPurpose } from './forum-topics.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface ThreadBinding {
  /** Persona override for this topic */
  persona?: string;
  /** Safety mode override: 'safe', 'danger', 'readonly' */
  safetyMode?: 'safe' | 'danger' | 'readonly';
  /** If set, only these tools are available in this topic */
  allowedTools?: string[];
  /** If set, these tools are blocked in this topic */
  blockedTools?: string[];
  /** Additional system prompt text injected for this topic */
  systemPromptExtra?: string;
  /** Topic purpose (synced from ForumTopicsService) */
  purpose?: TopicPurpose;
}

/** Default bindings for well-known topic purposes */
const DEFAULT_BINDINGS: Partial<Record<TopicPurpose, Partial<ThreadBinding>>> = {
  trading: {
    persona: 'professional',
    safetyMode: 'safe',
  },
  portfolio: {
    safetyMode: 'readonly',
    systemPromptExtra: 'This topic is for portfolio overview. Show balances, positions, PnL. Do not execute trades here.',
  },
  research: {
    persona: 'technical',
    safetyMode: 'readonly',
    systemPromptExtra: 'This topic is for research and analysis. Provide data-heavy responses with charts, metrics, and comparisons.',
  },
  alerts: {
    safetyMode: 'readonly',
    systemPromptExtra: 'This topic receives automated alerts and notifications. Keep responses brief.',
  },
  governance: {
    safetyMode: 'safe',
    systemPromptExtra: 'This topic is for DAO governance. Focus on proposal analysis, voting power, and delegation.',
  },
  social: {
    safetyMode: 'safe',
    systemPromptExtra: 'This topic is for social media management (Farcaster, X/Twitter). Draft posts, check engagement.',
  },
  admin: {
    safetyMode: 'safe',
    systemPromptExtra: 'This topic is for bot administration. Handle /setup, /flykeys, mode changes, and configuration.',
  },
};

// ── Service ──────────────────────────────────────────────────────────────

export class ThreadBindingsService {
  /** chatId:threadId → binding */
  private bindings = new Map<string, ThreadBinding>();

  /**
   * Create or update a binding for a specific topic.
   */
  bind(chatId: string, threadId: number, config: Partial<ThreadBinding>): ThreadBinding {
    const key = this.key(chatId, threadId);
    const existing = this.bindings.get(key) ?? {};
    const merged: ThreadBinding = { ...existing, ...config };
    this.bindings.set(key, merged);
    return merged;
  }

  /**
   * Get the binding for a specific topic.
   * Falls back to default bindings based on topic purpose.
   */
  getBinding(chatId: string, threadId: number): ThreadBinding | undefined {
    const key = this.key(chatId, threadId);
    return this.bindings.get(key);
  }

  /**
   * Get the effective binding — user override merged over defaults for the purpose.
   */
  getEffectiveBinding(chatId: string, threadId: number, purpose?: TopicPurpose): ThreadBinding {
    const userBinding = this.getBinding(chatId, threadId) ?? {};
    const defaultBinding = purpose ? (DEFAULT_BINDINGS[purpose] ?? {}) : {};

    return {
      ...defaultBinding,
      ...userBinding,
      purpose: userBinding.purpose ?? purpose,
    };
  }

  /**
   * Remove a binding.
   */
  unbind(chatId: string, threadId: number): boolean {
    return this.bindings.delete(this.key(chatId, threadId));
  }

  /**
   * Check if a tool is allowed in a given topic.
   */
  isToolAllowed(chatId: string, threadId: number, toolName: string, purpose?: TopicPurpose): boolean {
    const binding = this.getEffectiveBinding(chatId, threadId, purpose);

    if (binding.blockedTools?.includes(toolName)) return false;
    if (binding.allowedTools && !binding.allowedTools.includes(toolName)) return false;

    return true;
  }

  /**
   * List all bindings for a chat.
   */
  listBindings(chatId: string): Array<{ threadId: number; binding: ThreadBinding }> {
    const results: Array<{ threadId: number; binding: ThreadBinding }> = [];
    const prefix = `${chatId}:`;

    for (const [key, binding] of this.bindings) {
      if (key.startsWith(prefix)) {
        const threadId = parseInt(key.slice(prefix.length), 10);
        if (!isNaN(threadId)) {
          results.push({ threadId, binding });
        }
      }
    }

    return results;
  }

  /**
   * Apply default bindings for a purpose to a topic (if no user override exists).
   */
  applyDefaults(chatId: string, threadId: number, purpose: TopicPurpose): ThreadBinding {
    const key = this.key(chatId, threadId);
    if (this.bindings.has(key)) {
      return this.bindings.get(key)!;
    }

    const defaults = DEFAULT_BINDINGS[purpose];
    if (defaults) {
      const binding: ThreadBinding = { ...defaults, purpose };
      this.bindings.set(key, binding);
      return binding;
    }

    return { purpose };
  }

  /**
   * Reset all bindings (for testing).
   */
  reset(): void {
    this.bindings.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────

  private key(chatId: string, threadId: number): string {
    return `${chatId}:${threadId}`;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: ThreadBindingsService | null = null;

export function getThreadBindings(): ThreadBindingsService {
  if (!_instance) _instance = new ThreadBindingsService();
  return _instance;
}

export function resetThreadBindings(): void {
  _instance = null;
}
