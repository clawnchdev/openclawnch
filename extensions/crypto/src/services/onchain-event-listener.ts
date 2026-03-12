/**
 * On-Chain Event Listener — polls contract logs and emits events.
 *
 * Monitors specified contracts for events via `eth_getLogs` polling.
 * When a matching log is found, emits an `onchain_event` on the event bus.
 *
 * Uses polling (not `eth_subscribe`) because:
 * 1. Works with all RPC providers (many don't support WebSocket subscriptions)
 * 2. Survives reconnections without missed events
 * 3. Can query historical logs on startup to catch events missed during downtime
 *
 * Design:
 * - Each "subscription" tracks a contract + event signature + chain
 * - Polls at a configurable interval (default 30s)
 * - Tracks `lastBlockSeen` per subscription to avoid duplicate events
 * - Groups subscriptions by chain to batch getLogs calls
 */

import { getEventBus } from './event-bus.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface EventSubscription {
  /** Unique ID for this subscription (typically planId). */
  id: string;
  /** Chain ID to monitor. */
  chainId: number;
  /** Contract address to watch. */
  contractAddress: string;
  /** Keccak256 of the event signature (topic0). */
  eventTopic: string;
  /** Human-readable event signature for logging. */
  eventSignature: string;
  /** Optional topic filters (topic1, topic2, topic3). null = any. */
  topicFilters?: (string | null)[];
  /** If true, subscription persists after first match. */
  recurring: boolean;
}

interface SubscriptionState {
  /** Last block number we've processed for this subscription. */
  lastBlockSeen: number;
}

/** Function to fetch logs from an RPC provider. */
export type LogFetcher = (params: {
  chainId: number;
  address: string;
  topics: (string | string[] | null)[];
  fromBlock: number;
  toBlock: number | 'latest';
}) => Promise<Array<{
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
}>>;

// ─── On-Chain Event Listener ────────────────────────────────────────────

export class OnChainEventListener {
  private subscriptions = new Map<string, EventSubscription>();
  private state = new Map<string, SubscriptionState>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private logFetcher: LogFetcher;
  private tickMs: number;

  constructor(opts?: {
    logFetcher?: LogFetcher;
    tickMs?: number;
  }) {
    this.logFetcher = opts?.logFetcher ?? defaultLogFetcher;
    this.tickMs = opts?.tickMs ?? 30_000; // 30s default
  }

  // ── Subscription Management ───────────────────────────────────────────

  /** Add an event subscription. */
  addSubscription(sub: EventSubscription): void {
    this.subscriptions.set(sub.id, sub);
    if (!this.state.has(sub.id)) {
      this.state.set(sub.id, { lastBlockSeen: 0 });
    }
  }

  /** Remove a subscription. */
  removeSubscription(id: string): boolean {
    this.state.delete(id);
    return this.subscriptions.delete(id);
  }

  /** Get all active subscriptions. */
  getSubscriptions(): EventSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  /** Number of active subscriptions. */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Start the polling loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.tickInterval = setInterval(() => {
      this.tick().catch(() => {});
    }, this.tickMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Core Tick ─────────────────────────────────────────────────────────

  /** Run one polling cycle. Public for testing. */
  async tick(): Promise<void> {
    if (this.subscriptions.size === 0) return;

    // Group subscriptions by chainId
    const byChain = new Map<number, EventSubscription[]>();
    for (const sub of this.subscriptions.values()) {
      if (!byChain.has(sub.chainId)) byChain.set(sub.chainId, []);
      byChain.get(sub.chainId)!.push(sub);
    }

    const bus = getEventBus();
    const toRemove: string[] = [];

    // Process each chain
    for (const [chainId, subs] of byChain) {
      for (const sub of subs) {
        const st = this.state.get(sub.id)!;
        const fromBlock = st.lastBlockSeen > 0 ? st.lastBlockSeen + 1 : 0;

        // Build topics filter
        const topics: (string | string[] | null)[] = [sub.eventTopic];
        if (sub.topicFilters) {
          for (const filter of sub.topicFilters) {
            topics.push(filter);
          }
        }

        try {
          const logs = await this.logFetcher({
            chainId,
            address: sub.contractAddress,
            topics,
            fromBlock: fromBlock || 0,
            toBlock: 'latest',
          });

          for (const log of logs) {
            // Update last seen block
            if (log.blockNumber > st.lastBlockSeen) {
              st.lastBlockSeen = log.blockNumber;
            }

            // Emit event
            bus.emit('onchain_event', {
              type: 'onchain_event',
              chainId,
              contractAddress: log.address,
              eventSignature: sub.eventSignature,
              topics: log.topics,
              data: log.data,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash,
              timestamp: Date.now(),
            });

            // One-shot: remove after first match
            if (!sub.recurring) {
              toRemove.push(sub.id);
              break; // Don't process more logs for this one-shot sub
            }
          }
        } catch {
          // RPC errors are swallowed — retry on next tick
        }
      }
    }

    for (const id of toRemove) {
      this.subscriptions.delete(id);
      this.state.delete(id);
    }
  }

  /** Clear all subscriptions and state. */
  clear(): void {
    this.subscriptions.clear();
    this.state.clear();
  }
}

// ─── Default Log Fetcher ────────────────────────────────────────────────
// Uses the RPC manager. Lazy-loaded to avoid circular deps.

const defaultLogFetcher: LogFetcher = async (params) => {
  const { getRpcManager } = await import('./rpc-provider.js');
  const rpc = getRpcManager();
  const client = await rpc.getClient(params.chainId);

  // viem getLogs uses a specific filter format — construct it carefully.
  // We use the raw overload with explicit fromBlock/toBlock.
  const filter: Record<string, unknown> = {
    address: params.address as `0x${string}`,
  };
  if (params.fromBlock > 0) filter.fromBlock = BigInt(params.fromBlock);
  if (params.toBlock !== 'latest') filter.toBlock = BigInt(params.toBlock);

  const logs = await client.getLogs(filter as any);

  // Post-filter by topics (viem's getLogs doesn't always support topic arrays in all modes)
  return logs
    .filter(log => {
      if (!log.topics || log.topics.length === 0) return false;
      // Match topic0 (event signature)
      if (params.topics[0] && log.topics[0] !== params.topics[0]) return false;
      // Match additional topic filters
      for (let i = 1; i < params.topics.length; i++) {
        const filter = params.topics[i];
        if (filter === null) continue;
        if (typeof filter === 'string' && log.topics[i] !== filter) return false;
      }
      return true;
    })
    .map(log => ({
      address: log.address,
      topics: log.topics as string[],
      data: log.data,
      blockNumber: Number(log.blockNumber),
      transactionHash: log.transactionHash,
    }));
};

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: OnChainEventListener | null = null;

export function getOnChainEventListener(opts?: {
  logFetcher?: LogFetcher;
  tickMs?: number;
}): OnChainEventListener {
  if (!instance) {
    instance = new OnChainEventListener(opts);
  }
  return instance;
}

export function resetOnChainEventListener(): void {
  instance?.stop();
  instance?.clear();
  instance = null;
}
