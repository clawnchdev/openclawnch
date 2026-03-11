/**
 * Agent Memory Service — file-backed declarative memory with frozen snapshots.
 *
 * Inspired by Hermes Agent's memory system. Two stores:
 *   MEMORY.md  — agent's own notes (environment facts, tool quirks, lessons)
 *   USER_{id}.md — per-user profile (preferences, communication style, habits)
 *
 * The "frozen snapshot" pattern:
 *   1. At session start, MEMORY.md + USER_{id}.md are read from disk
 *   2. The contents are injected into the system prompt via before_prompt_build
 *   3. Mid-session writes update disk immediately but do NOT change the active
 *      prompt — this preserves the LLM prefix cache
 *   4. Next session sees the updated memory
 *
 * Entries are §-delimited strings inside the markdown files.
 * Character limits prevent unbounded growth.
 *
 * All writes are scanned for prompt injection and credential leaks.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────

export interface MemoryConfig {
  /** Max characters for agent memory. Default: 2200. */
  agentCharLimit?: number;
  /** Max characters per user profile. Default: 1375. */
  userCharLimit?: number;
  /** Base directory for memory files. Default: ~/.openclawnch/memory/ */
  baseDir?: string;
}

export interface MemoryEntry {
  content: string;
  addedAt: number;
}

type StoreType = 'agent' | 'user';

// ─── Injection Detection ─────────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /forget\s+(everything|all|your)/i,
  /\bsystem\s*:\s*you\s+(must|should|will)/i,
  /<\/?system[-_]?(message|prompt|instruction)>/i,
  /\bdo\s+not\s+(tell|reveal|mention|show)\s+(the\s+)?user\b/i,
  /\bact\s+as\s+if\s+(you|the)\s+(are|is|have)\b/i,
  /\b(CLAWNCHER_PRIVATE_KEY|BANKR_API_KEY|PRIVATE_KEY|WALLET_PASSWORD)\b/i,
  /\b(mnemonic|seed\s*phrase|recovery\s*phrase|secret\s*words)\b/i,
  /[\u200B-\u200F\u202A-\u202E\uFEFF]/,  // invisible unicode
];

function containsInjection(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return `Blocked: content matches injection pattern "${pattern.source.slice(0, 40)}"`;
    }
  }
  return null;
}

// ─── Entry Delimiter ─────────────────────────────────────────────────────

const ENTRY_DELIM = '\n§ ';
const ENTRY_DELIM_REGEX = /\n§ /g;

function parseEntries(content: string): string[] {
  if (!content.trim()) return [];
  // Split on § delimiter, trim each entry, filter empty
  return content.split(ENTRY_DELIM_REGEX)
    .map(e => e.replace(/^§\s*/, '').trim())
    .filter(Boolean);
}

function serializeEntries(entries: string[]): string {
  if (entries.length === 0) return '';
  return entries.map(e => `§ ${e}`).join('\n');
}

// ─── Memory Store ────────────────────────────────────────────────────────

class MemoryStore {
  private entries: string[] = [];
  private readonly filePath: string;
  private readonly charLimit: number;
  private readonly storeType: StoreType;

  constructor(filePath: string, charLimit: number, storeType: StoreType) {
    this.filePath = filePath;
    this.charLimit = charLimit;
    this.storeType = storeType;
    this.load();
  }

  // ── Read ──

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const content = readFileSync(this.filePath, 'utf8');
        this.entries = parseEntries(content);
      }
    } catch {
      this.entries = [];
    }
  }

  getEntries(): string[] {
    return [...this.entries];
  }

  getContent(): string {
    return serializeEntries(this.entries);
  }

  getTotalChars(): number {
    return this.getContent().length;
  }

  // ── Write ──

  add(entry: string): { ok: boolean; error?: string } {
    const trimmed = entry.trim();
    if (!trimmed) return { ok: false, error: 'Empty entry' };

    // Security scan
    const injectionResult = containsInjection(trimmed);
    if (injectionResult) return { ok: false, error: injectionResult };

    // Check if adding this would exceed the limit
    const newContent = serializeEntries([...this.entries, trimmed]);
    if (newContent.length > this.charLimit) {
      return {
        ok: false,
        error: `Entry would exceed ${this.storeType} memory limit (${newContent.length}/${this.charLimit} chars). ` +
          `Try removing old entries first with the "remove" action.`,
      };
    }

    // Check for duplicates
    if (this.entries.some(e => e.toLowerCase() === trimmed.toLowerCase())) {
      return { ok: false, error: 'Duplicate entry already exists' };
    }

    this.entries.push(trimmed);
    this.persist();
    return { ok: true };
  }

  replace(oldSubstring: string, newContent: string): { ok: boolean; error?: string } {
    const trimmedNew = newContent.trim();
    if (!trimmedNew) return { ok: false, error: 'Replacement content is empty' };

    const injectionResult = containsInjection(trimmedNew);
    if (injectionResult) return { ok: false, error: injectionResult };

    const idx = this.entries.findIndex(e =>
      e.toLowerCase().includes(oldSubstring.toLowerCase()),
    );
    if (idx === -1) {
      return { ok: false, error: `No entry containing "${oldSubstring.slice(0, 50)}" found` };
    }

    const updated = [...this.entries];
    updated[idx] = trimmedNew;

    const newSerialized = serializeEntries(updated);
    if (newSerialized.length > this.charLimit) {
      return { ok: false, error: `Replacement would exceed memory limit (${newSerialized.length}/${this.charLimit} chars)` };
    }

    this.entries = updated;
    this.persist();
    return { ok: true };
  }

  remove(substring: string): { ok: boolean; removed?: string; error?: string } {
    const idx = this.entries.findIndex(e =>
      e.toLowerCase().includes(substring.toLowerCase()),
    );
    if (idx === -1) {
      return { ok: false, error: `No entry containing "${substring.slice(0, 50)}" found` };
    }

    const removed = this.entries.splice(idx, 1)[0]!;
    this.persist();
    return { ok: true, removed };
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }

  // ── Persistence ──

  private persist(): void {
    try {
      const dir = this.filePath.replace(/\/[^/]+$/, '');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, this.getContent(), 'utf8');
    } catch {
      // Best effort
    }
  }
}

// ─── Agent Memory Service ────────────────────────────────────────────────

class AgentMemoryService {
  private config: Required<MemoryConfig>;
  private agentStore: MemoryStore;
  private userStores = new Map<string, MemoryStore>();
  private frozenSnapshots = new Map<string, string>(); // sessionKey → frozen content

  constructor(config: MemoryConfig = {}) {
    this.config = {
      agentCharLimit: config.agentCharLimit ?? 2200,
      userCharLimit: config.userCharLimit ?? 1375,
      baseDir: config.baseDir ?? join(
        process.env.HOME ?? '/tmp', '.openclawnch', 'memory',
      ),
    };

    this.agentStore = new MemoryStore(
      join(this.config.baseDir, 'MEMORY.md'),
      this.config.agentCharLimit,
      'agent',
    );
  }

  // ── Frozen Snapshots ───────────────────────────────────────────────

  /**
   * Take a frozen snapshot for a session.
   * Call this at session start (before_prompt_build). The snapshot is
   * immutable for the duration of the session.
   */
  freezeSnapshot(sessionKey: string, userId?: string): string {
    const parts: string[] = [];

    const agentContent = this.agentStore.getContent();
    if (agentContent) {
      parts.push('## Agent Memory\n' + agentContent);
    }

    if (userId) {
      const userStore = this.getUserStore(userId);
      const userContent = userStore.getContent();
      if (userContent) {
        parts.push('## User Profile\n' + userContent);
      }
    }

    const snapshot = parts.join('\n\n');
    this.frozenSnapshots.set(sessionKey, snapshot);
    return snapshot;
  }

  /**
   * Get the frozen snapshot for a session (returns empty string if none).
   */
  getSnapshot(sessionKey: string): string {
    return this.frozenSnapshots.get(sessionKey) ?? '';
  }

  /**
   * Clear the frozen snapshot when a session ends.
   */
  clearSnapshot(sessionKey: string): void {
    this.frozenSnapshots.delete(sessionKey);
  }

  // ── Agent Memory ───────────────────────────────────────────────────

  addAgentMemory(entry: string): { ok: boolean; error?: string } {
    return this.agentStore.add(entry);
  }

  replaceAgentMemory(oldSubstring: string, newContent: string): { ok: boolean; error?: string } {
    return this.agentStore.replace(oldSubstring, newContent);
  }

  removeAgentMemory(substring: string): { ok: boolean; removed?: string; error?: string } {
    return this.agentStore.remove(substring);
  }

  getAgentMemory(): string[] {
    return this.agentStore.getEntries();
  }

  getAgentMemoryStats(): { entries: number; chars: number; limit: number } {
    return {
      entries: this.agentStore.getEntries().length,
      chars: this.agentStore.getTotalChars(),
      limit: this.config.agentCharLimit,
    };
  }

  // ── User Memory ────────────────────────────────────────────────────

  private getUserStore(userId: string): MemoryStore {
    // Sanitize userId for filesystem safety
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

    let store = this.userStores.get(safeId);
    if (!store) {
      store = new MemoryStore(
        join(this.config.baseDir, `USER_${safeId}.md`),
        this.config.userCharLimit,
        'user',
      );
      this.userStores.set(safeId, store);
    }
    return store;
  }

  addUserMemory(userId: string, entry: string): { ok: boolean; error?: string } {
    return this.getUserStore(userId).add(entry);
  }

  replaceUserMemory(userId: string, oldSubstring: string, newContent: string): { ok: boolean; error?: string } {
    return this.getUserStore(userId).replace(oldSubstring, newContent);
  }

  removeUserMemory(userId: string, substring: string): { ok: boolean; removed?: string; error?: string } {
    return this.getUserStore(userId).remove(substring);
  }

  getUserMemory(userId: string): string[] {
    return this.getUserStore(userId).getEntries();
  }

  getUserMemoryStats(userId: string): { entries: number; chars: number; limit: number } {
    const store = this.getUserStore(userId);
    return {
      entries: store.getEntries().length,
      chars: store.getTotalChars(),
      limit: this.config.userCharLimit,
    };
  }

  // ── Diagnostics ────────────────────────────────────────────────────

  getStatus(): {
    agentEntries: number;
    agentChars: number;
    agentCharLimit: number;
    userStoreCount: number;
    frozenSnapshotCount: number;
  } {
    return {
      agentEntries: this.agentStore.getEntries().length,
      agentChars: this.agentStore.getTotalChars(),
      agentCharLimit: this.config.agentCharLimit,
      userStoreCount: this.userStores.size,
      frozenSnapshotCount: this.frozenSnapshots.size,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _instance: AgentMemoryService | null = null;

export function getAgentMemory(config?: MemoryConfig): AgentMemoryService {
  if (!_instance) {
    _instance = new AgentMemoryService(config);
  }
  return _instance;
}

export function resetAgentMemory(): void {
  _instance = null;
}
