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
  | 'lend_supply'
  | 'lend_borrow'
  | 'lend_repay'
  | 'lend_withdraw'
  | 'approval_revoke'
  | 'stake'
  | 'stake_unstake'
  | 'stake_wrap'
  | 'stake_unwrap'
  | 'nft_transfer'
  | 'nft_buy'
  | 'nft_list'
  | 'privacy_deposit'
  | 'privacy_withdraw'
  | 'privacy_transfer'
  | 'yield_deposit'
  | 'yield_withdraw'
  | 'governance_vote'
  | 'governance_delegate'
  | 'safe_propose'
  | 'safe_confirm'
  | 'airdrop_check'
  | 'airdrop_claim'
  | 'order_create'
  | 'order_cancel'
  | 'hummingbot_action'
  | 'molten_action'
  | 'clawnx_post'
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
  defi_lend: 'lend_supply', // Default — overridden by action-specific mapping below
  approvals: 'approval_revoke',
  defi_stake: 'stake', // Default — overridden by action-specific mapping below
  nft: 'nft_transfer', // Default — overridden by action-specific mapping below
  privacy: 'privacy_deposit', // Default — overridden by action-specific mapping below
  yield: 'yield_deposit', // Default — overridden by action-specific mapping below
  governance: 'governance_vote', // Default — overridden by action-specific mapping below
  safe: 'safe_propose', // Default — overridden by action-specific mapping below
  airdrop: 'airdrop_check', // Default — overridden by action-specific mapping below
  manage_orders: 'order_create', // Default — overridden by action-specific mapping below
  hummingbot: 'hummingbot_action',
  molten: 'molten_action',
  clawnx: 'clawnx_post',
};

/**
 * Map defi_lend action names to specific event types.
 * Used by the lending tool to record granular events.
 */
export const LEND_ACTION_EVENT_MAP: Record<string, TxEventType> = {
  supply: 'lend_supply',
  borrow: 'lend_borrow',
  repay: 'lend_repay',
  withdraw: 'lend_withdraw',
};

/**
 * Map defi_stake action names to specific event types.
 */
export const STAKE_ACTION_EVENT_MAP: Record<string, TxEventType> = {
  stake: 'stake',
  unstake: 'stake_unstake',
  wrap: 'stake_wrap',
  unwrap: 'stake_unwrap',
};

/**
 * Map nft action names to specific event types.
 */
export const NFT_ACTION_EVENT_MAP: Record<string, TxEventType> = {
  transfer: 'nft_transfer',
  buy: 'nft_buy',
  list: 'nft_list',
};

/**
 * Map privacy action names to specific event types.
 */
export const PRIVACY_ACTION_EVENT_MAP: Record<string, TxEventType> = {
  deposit: 'privacy_deposit',
  withdraw: 'privacy_withdraw',
  transfer: 'privacy_transfer',
};

/**
 * Map yield action names to specific event types.
 */
export const YIELD_ACTION_EVENT_MAP: Record<string, TxEventType> = {
  deposit: 'yield_deposit',
  withdraw: 'yield_withdraw',
};

/**
 * Map governance action names to specific event types.
 */
export const GOVERNANCE_ACTION_EVENT_MAP: Record<string, TxEventType> = {
  vote: 'governance_vote',
  delegate: 'governance_delegate',
};

/**
 * Map safe action names to specific event types.
 * Safe operations are off-chain (REST API) but recorded for audit trail.
 */
export const SAFE_ACTION_EVENT_MAP: Record<string, TxEventType> = {
  propose: 'safe_propose',
  confirm: 'safe_confirm',
};

/**
 * Map airdrop action names to specific event types.
 */
export const AIRDROP_ACTION_EVENT_MAP: Record<string, TxEventType> = {
  check: 'airdrop_check',
  check_all: 'airdrop_check',
  claim: 'airdrop_claim',
};

/**
 * Map manage_orders action names to specific event types.
 */
export const ORDER_ACTION_EVENT_MAP: Record<string, TxEventType> = {
  create: 'order_create',
  cancel: 'order_cancel',
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
