/**
 * Session Recall Service — full-text search over past conversations.
 *
 * Indexes conversation turns to JSONL on disk and provides in-memory
 * full-text search with relevance ranking. No external dependencies
 * (no SQLite — uses JSONL + in-memory search to match the codebase's
 * file-based persistence pattern).
 *
 * How it works:
 *   1. message_received and after_tool_call hooks feed messages in
 *   2. Messages are appended to ~/.openclawnch/recall/sessions.jsonl
 *   3. On startup, the index is loaded into memory
 *   4. Search queries tokenize and match against the index
 *   5. Results are grouped by session with context windows
 *
 * The in-memory approach works well for single-agent deployments with
 * thousands of conversations. For multi-agent or very large histories,
 * this can be upgraded to SQLite FTS5 later.
 *
 * Inspired by Hermes Agent's session_search_tool.py.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────

export interface RecallEntry {
  /** Monotonically increasing sequence number. */
  seq: number;
  /** Session identifier (e.g., "telegram-123456789"). */
  sessionKey: string;
  /** Message role: user, assistant, tool, system. */
  role: 'user' | 'assistant' | 'tool' | 'system';
  /** Message content (truncated to MAX_ENTRY_CHARS). */
  content: string;
  /** Tool name (if role is 'tool'). */
  toolName?: string;
  /** User ID. */
  userId?: string;
  /** Timestamp in ms. */
  timestamp: number;
}

export interface RecallSearchResult {
  /** Session key that had matches. */
  sessionKey: string;
  /** Matching entries from this session. */
  matches: RecallEntry[];
  /** Relevance score (higher = more relevant). */
  score: number;
  /** Earliest timestamp in matched entries. */
  earliestTimestamp: number;
  /** Latest timestamp in matched entries. */
  latestTimestamp: number;
}

export interface RecallConfig {
  /** Base directory. Default: ~/.openclawnch/recall/ */
  baseDir?: string;
  /** Max characters per entry content. Default: 2000. */
  maxEntryChars?: number;
  /** Max entries to keep in memory. Default: 50000. */
  maxEntries?: number;
  /** Max search results to return. Default: 5. */
  maxResults?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRY_CHARS = 2000;
const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_RESULTS = 5;

// ─── Full-Text Search (simple TF-based) ──────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2); // Skip very short tokens
}

function computeRelevance(entryTokens: string[], queryTokens: string[]): number {
  let score = 0;
  const entrySet = new Set(entryTokens);

  for (const qt of queryTokens) {
    if (entrySet.has(qt)) {
      score += 1;
    }
    // Partial match bonus (prefix)
    for (const et of entryTokens) {
      if (et.startsWith(qt) && et !== qt) {
        score += 0.5;
      }
    }
  }

  // Normalize by query length to prevent bias toward longer queries
  return queryTokens.length > 0 ? score / queryTokens.length : 0;
}

// ─── Session Recall Service ──────────────────────────────────────────────

class SessionRecallService {
  private config: Required<RecallConfig>;
  private entries: RecallEntry[] = [];
  private nextSeq = 1;
  private loaded = false;

  constructor(config: RecallConfig = {}) {
    this.config = {
      baseDir: config.baseDir ?? join(
        process.env.HOME ?? '/tmp', '.openclawnch', 'recall',
      ),
      maxEntryChars: config.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS,
      maxEntries: config.maxEntries ?? DEFAULT_MAX_ENTRIES,
      maxResults: config.maxResults ?? DEFAULT_MAX_RESULTS,
    };
  }

  // ── Indexing ───────────────────────────────────────────────────────

  /**
   * Record a conversation turn for future recall.
   */
  recordTurn(entry: Omit<RecallEntry, 'seq'>): void {
    this.ensureLoaded();

    const record: RecallEntry = {
      ...entry,
      content: entry.content.slice(0, this.config.maxEntryChars),
      seq: this.nextSeq++,
    };

    this.entries.push(record);
    this.appendToDisk(record);

    // Evict old entries if over limit
    if (this.entries.length > this.config.maxEntries) {
      const excess = this.entries.length - this.config.maxEntries;
      this.entries.splice(0, excess);
    }
  }

  // ── Search ─────────────────────────────────────────────────────────

  /**
   * Search past conversations for relevant context.
   * Returns sessions ranked by relevance.
   */
  search(query: string, maxResults?: number): RecallSearchResult[] {
    this.ensureLoaded();

    const limit = maxResults ?? this.config.maxResults;
    const queryTokens = tokenize(query);

    if (queryTokens.length === 0) return [];

    // Score each entry
    const scored: Array<{ entry: RecallEntry; score: number }> = [];

    for (const entry of this.entries) {
      const entryTokens = tokenize(entry.content);
      const score = computeRelevance(entryTokens, queryTokens);
      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    // Group by session
    const sessionScores = new Map<string, { entries: RecallEntry[]; totalScore: number }>();

    for (const { entry, score } of scored) {
      let session = sessionScores.get(entry.sessionKey);
      if (!session) {
        session = { entries: [], totalScore: 0 };
        sessionScores.set(entry.sessionKey, session);
      }
      session.entries.push(entry);
      session.totalScore += score;
    }

    // Build results, sorted by total score descending
    const results: RecallSearchResult[] = [];

    for (const [sessionKey, session] of sessionScores) {
      // Keep top 10 matching entries per session (most relevant)
      session.entries.sort((a, b) => {
        const scoreA = computeRelevance(tokenize(a.content), queryTokens);
        const scoreB = computeRelevance(tokenize(b.content), queryTokens);
        return scoreB - scoreA;
      });
      const topEntries = session.entries.slice(0, 10);

      const timestamps = topEntries.map(e => e.timestamp);
      results.push({
        sessionKey,
        matches: topEntries,
        score: session.totalScore,
        earliestTimestamp: Math.min(...timestamps),
        latestTimestamp: Math.max(...timestamps),
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ── Persistence ────────────────────────────────────────────────────

  private getFilePath(): string {
    return join(this.config.baseDir, 'sessions.jsonl');
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      const filePath = this.getFilePath();
      if (!existsSync(filePath)) return;

      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as RecallEntry;
          this.entries.push(entry);
          if (entry.seq >= this.nextSeq) {
            this.nextSeq = entry.seq + 1;
          }
        } catch {
          // Skip malformed lines
        }
      }

      // Evict old entries if over limit
      if (this.entries.length > this.config.maxEntries) {
        const excess = this.entries.length - this.config.maxEntries;
        this.entries.splice(0, excess);
      }
    } catch {
      // Failed to load — start fresh
    }
  }

  private diskWrites = 0;
  private static readonly COMPACT_INTERVAL = 500; // check every N writes
  private static readonly MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

  private appendToDisk(entry: RecallEntry): void {
    try {
      const dir = this.config.baseDir;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.getFilePath(), JSON.stringify(entry) + '\n', 'utf8');
      this.diskWrites++;

      // Periodically check if the file needs compaction
      if (this.diskWrites % SessionRecallService.COMPACT_INTERVAL === 0) {
        this.maybeCompact();
      }
    } catch {
      // Best effort
    }
  }

  /**
   * Compact the JSONL file by rewriting it with only the in-memory entries.
   * Prevents unbounded disk growth — the file is capped at maxEntries lines.
   */
  private maybeCompact(): void {
    try {
      const filePath = this.getFilePath();
      if (!existsSync(filePath)) return;

      const stat = statSync(filePath);
      if (stat.size < SessionRecallService.MAX_FILE_SIZE_BYTES) return;

      // Rewrite with only the entries we have in memory (already evicted to maxEntries)
      const compacted = this.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(filePath, compacted, 'utf8');
    } catch {
      // Best effort — don't crash on compaction failure
    }
  }

  // ── Diagnostics ────────────────────────────────────────────────────

  getStats(): {
    totalEntries: number;
    uniqueSessions: number;
    oldestTimestamp: number;
    newestTimestamp: number;
  } {
    this.ensureLoaded();

    const sessions = new Set(this.entries.map(e => e.sessionKey));
    const timestamps = this.entries.map(e => e.timestamp);

    return {
      totalEntries: this.entries.length,
      uniqueSessions: sessions.size,
      oldestTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : 0,
      newestTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : 0,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _instance: SessionRecallService | null = null;

export function getSessionRecall(config?: RecallConfig): SessionRecallService {
  if (!_instance) {
    _instance = new SessionRecallService(config);
  }
  return _instance;
}

export function resetSessionRecall(): void {
  _instance = null;
}
