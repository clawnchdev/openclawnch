/**
 * Event-Sourced Transaction Ledger — append-only log of every on-chain action.
 *
 * Inspired by Lemon's event-sourced game engine and IronClaw's audit boundary.
 *
 * Every on-chain action the agent takes (swap, transfer, bridge, approve, launch,
 * etc.) is recorded as an immutable event. The ledger provides:
 *
 * 1. Complete audit trail for regulatory/tax purposes
 * 2. Foundation for heartbeat monitoring (knows all open positions)
 * 3. Replay capability — can reconstruct portfolio state from events
 * 4. Cross-session continuity — survives restarts
 *
 * Events are append-only: once written, they are never modified or deleted.
 * Each event gets a monotonically increasing sequence number.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────

export type TxEventType =
  | 'swap'
  | 'transfer'
  | 'bridge'
  | 'approve'
  | 'launch'
  | 'claim_fees'
  | 'add_liquidity'
  | 'remove_liquidity'
  | 'compound_action'
  | 'bankr_swap'
  | 'bankr_launch'
  | 'bankr_automate'
  | 'bankr_polymarket'
  | 'bankr_leverage'
  | 'permit2'
  | 'unknown';

export interface TxEvent {
  /** Monotonically increasing sequence number (assigned by ledger). */
  seq: number;
  /** Event type. */
  type: TxEventType;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Unix timestamp in ms. */
  timestampMs: number;
  /** User/session that triggered this action. */
  userId: string;
  /** On-chain transaction hash (null if tx hasn't been submitted yet). */
  txHash: string | null;
  /** Chain ID. */
  chainId: number;
  /** Chain name (base, ethereum, arbitrum, etc.). */
  chain: string;
  /** Wallet address that signed the tx. */
  from: string;
  /** Target contract/address. */
  to: string | null;
  /** Status of the action. */
  status: 'pending' | 'confirmed' | 'failed' | 'cancelled';
  /** Human-readable summary (e.g., "Swap 1.5 ETH → 4200 USDC on Base"). */
  summary: string;
  /** Structured payload — differs per event type. */
  data: Record<string, unknown>;
  /** Gas cost in USD (filled after confirmation). */
  gasCostUsd?: number;
  /** Tool that generated this event. */
  tool: string;
  /** Error message if the action failed. */
  error?: string;
}

export interface LedgerQuery {
  /** Filter by user ID. */
  userId?: string;
  /** Filter by event type(s). */
  types?: TxEventType[];
  /** Filter by chain ID. */
  chainId?: number;
  /** Filter by status. */
  status?: TxEvent['status'];
  /** Only events after this timestamp (ms). */
  afterMs?: number;
  /** Only events before this timestamp (ms). */
  beforeMs?: number;
  /** Max number of events to return (most recent first). */
  limit?: number;
  /** Starting sequence number (for pagination). */
  afterSeq?: number;
}

export interface LedgerStats {
  totalEvents: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  byChain: Record<string, number>;
  oldestEventMs: number | null;
  newestEventMs: number | null;
}

// ─── Chain Name Map ─────────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
  137: 'polygon',
};

// ─── Tool → Event Type Map ──────────────────────────────────────────────

const TOOL_EVENT_MAP: Record<string, TxEventType> = {
  defi_swap: 'swap',
  transfer: 'transfer',
  bridge: 'bridge',
  permit2: 'permit2',
  clawnch_launch: 'launch',
  clawnch_fees: 'claim_fees',
  liquidity: 'add_liquidity',
  compound_action: 'compound_action',
  bankr_launch: 'bankr_launch',
  bankr_automate: 'bankr_automate',
  bankr_polymarket: 'bankr_polymarket',
  bankr_leverage: 'bankr_leverage',
};

export function toolToEventType(toolName: string): TxEventType {
  return TOOL_EVENT_MAP[toolName] ?? 'unknown';
}

export function chainIdToName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? String(chainId);
}

// ─── Transaction Ledger ─────────────────────────────────────────────────

class TxLedger {
  private events: TxEvent[] = [];
  private nextSeq = 1;
  private dirty = false;
  private readonly ledgerPath: string;

  constructor() {
    this.ledgerPath = this.getLedgerPath();
    this.loadFromDisk();
  }

  /**
   * Append a new event to the ledger. Returns the assigned sequence number.
   */
  append(event: Omit<TxEvent, 'seq' | 'timestamp' | 'timestampMs'>): TxEvent {
    const now = Date.now();
    const full: TxEvent = {
      ...event,
      seq: this.nextSeq++,
      timestamp: new Date(now).toISOString(),
      timestampMs: now,
    };

    this.events.push(full);
    this.dirty = true;
    this.persistAppend(full);

    return full;
  }

  /**
   * Update the status of an existing event (e.g., pending → confirmed).
   * This is the ONLY mutation allowed — and it creates a new event rather
   * than modifying the original, preserving the append-only invariant.
   */
  updateStatus(
    seq: number,
    status: TxEvent['status'],
    updates?: { txHash?: string; gasCostUsd?: number; error?: string },
  ): TxEvent | null {
    const original = this.events.find(e => e.seq === seq);
    if (!original) return null;

    // Append a status-update event that references the original
    return this.append({
      type: original.type,
      userId: original.userId,
      txHash: updates?.txHash ?? original.txHash,
      chainId: original.chainId,
      chain: original.chain,
      from: original.from,
      to: original.to,
      status,
      summary: `[status update] ${original.summary}`,
      data: { ...original.data, _refSeq: original.seq, _previousStatus: original.status },
      gasCostUsd: updates?.gasCostUsd ?? original.gasCostUsd,
      tool: original.tool,
      error: updates?.error ?? original.error,
    });
  }

  /**
   * Query events with optional filters. Returns newest-first.
   */
  query(q: LedgerQuery = {}): TxEvent[] {
    let results = [...this.events];

    if (q.userId) results = results.filter(e => e.userId === q.userId);
    if (q.types?.length) results = results.filter(e => q.types!.includes(e.type));
    if (q.chainId) results = results.filter(e => e.chainId === q.chainId);
    if (q.status) results = results.filter(e => e.status === q.status);
    if (q.afterMs) results = results.filter(e => e.timestampMs > q.afterMs!);
    if (q.beforeMs) results = results.filter(e => e.timestampMs < q.beforeMs!);
    if (q.afterSeq) results = results.filter(e => e.seq > q.afterSeq!);

    // Newest first
    results.sort((a, b) => b.seq - a.seq);

    if (q.limit) results = results.slice(0, q.limit);

    return results;
  }

  /**
   * Get a single event by sequence number.
   */
  getBySeq(seq: number): TxEvent | null {
    return this.events.find(e => e.seq === seq) ?? null;
  }

  /**
   * Get the most recent event for a given tx hash.
   */
  getByTxHash(txHash: string): TxEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.txHash === txHash) return this.events[i]!;
    }
    return null;
  }

  /**
   * Get aggregate statistics.
   */
  getStats(): LedgerStats {
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byChain: Record<string, number> = {};

    for (const e of this.events) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
      byChain[e.chain] = (byChain[e.chain] ?? 0) + 1;
    }

    return {
      totalEvents: this.events.length,
      byType,
      byStatus,
      byChain,
      oldestEventMs: this.events.length > 0 ? this.events[0]!.timestampMs : null,
      newestEventMs: this.events.length > 0 ? this.events[this.events.length - 1]!.timestampMs : null,
    };
  }

  /**
   * Get the total number of events.
   */
  get size(): number {
    return this.events.length;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private getLedgerPath(): string {
    const dir = process.env.OPENCLAWNCH_TX_DIR
      ? join(process.env.OPENCLAWNCH_TX_DIR, '..', 'ledger')
      : join(process.env.HOME ?? '/tmp', '.openclawnch', 'ledger');

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'tx-ledger.jsonl');
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.ledgerPath)) return;

      const content = readFileSync(this.ledgerPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as TxEvent;
          this.events.push(event);
          if (event.seq >= this.nextSeq) {
            this.nextSeq = event.seq + 1;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Fresh start if file can't be read
    }
  }

  private persistAppend(event: TxEvent): void {
    try {
      appendFileSync(this.ledgerPath, JSON.stringify(event) + '\n', 'utf8');
      this.dirty = false;
    } catch {
      // Best effort — don't crash on write failure
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _instance: TxLedger | null = null;

export function getTxLedger(): TxLedger {
  if (!_instance) {
    _instance = new TxLedger();
  }
  return _instance;
}

export function resetTxLedger(): void {
  _instance = null;
}
