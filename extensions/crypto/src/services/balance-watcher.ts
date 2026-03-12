/**
 * Balance Watcher — polls token balances and fires events when thresholds are crossed.
 *
 * Monitors wallet balances for specified tokens on specified chains. When a balance
 * crosses a threshold (above or below), emits a `balance_changed` event on the bus.
 *
 * Design:
 * - Polls at a configurable interval (default 60s — slower than price because
 *   balance changes are less frequent and RPC calls are heavier)
 * - Deduplicates by token+chain, similar to PriceWatcher
 * - Tracks previous balance to detect direction of change
 * - Supports one-shot and recurring watches
 */

import { getEventBus } from './event-bus.js';
import type { BalanceTrigger } from './plan-types.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface BalanceWatch {
  /** Unique ID (typically planId). */
  id: string;
  /** Token symbol or contract address. */
  token: string;
  /** Chain ID. Default: 8453 (Base). */
  chainId: number;
  /** Trigger when balance is above or below threshold. */
  condition: 'above' | 'below';
  /** Balance threshold in token units. */
  threshold: number;
  /** If true, fires repeatedly. */
  recurring: boolean;
}

interface WatchState {
  lastBalance: number | null;
  wasTriggered: boolean;
}

export type BalanceFetcher = (token: string, chainId: number, walletAddress: string) => Promise<number | null>;

// ─── Balance Watcher ────────────────────────────────────────────────────

export class BalanceWatcher {
  private watches = new Map<string, BalanceWatch>();
  private state = new Map<string, WatchState>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private balanceFetcher: BalanceFetcher;
  private walletAddressGetter: () => string | null;
  private tickMs: number;

  constructor(opts?: {
    balanceFetcher?: BalanceFetcher;
    walletAddressGetter?: () => string | null;
    tickMs?: number;
  }) {
    this.balanceFetcher = opts?.balanceFetcher ?? defaultBalanceFetcher;
    this.walletAddressGetter = opts?.walletAddressGetter ?? (() => null);
    this.tickMs = opts?.tickMs ?? 60_000; // 60s default
  }

  // ── Watch Management ──────────────────────────────────────────────────

  addWatch(watch: BalanceWatch): void {
    this.watches.set(watch.id, watch);
    if (!this.state.has(watch.id)) {
      this.state.set(watch.id, { lastBalance: null, wasTriggered: false });
    }
  }

  addFromTrigger(planId: string, trigger: BalanceTrigger): void {
    this.addWatch({
      id: planId,
      token: trigger.token,
      chainId: trigger.chainId ?? 8453,
      condition: trigger.condition,
      threshold: trigger.threshold,
      recurring: trigger.recurring ?? false,
    });
  }

  removeWatch(id: string): boolean {
    this.state.delete(id);
    return this.watches.delete(id);
  }

  getWatches(): BalanceWatch[] {
    return Array.from(this.watches.values());
  }

  get watchCount(): number {
    return this.watches.size;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tickInterval = setInterval(() => {
      this.tick().catch(() => {});
    }, this.tickMs);
  }

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

  async tick(): Promise<void> {
    if (this.watches.size === 0) return;

    const walletAddress = this.walletAddressGetter();
    if (!walletAddress) return; // No wallet connected — skip

    // Group by token+chain to deduplicate fetches
    const tokenChainKey = (token: string, chainId: number) => `${token.toUpperCase()}:${chainId}`;
    const fetchKeys = new Map<string, { token: string; chainId: number }>();
    for (const watch of this.watches.values()) {
      const key = tokenChainKey(watch.token, watch.chainId);
      if (!fetchKeys.has(key)) {
        fetchKeys.set(key, { token: watch.token, chainId: watch.chainId });
      }
    }

    // Fetch balances in parallel
    const balanceResults = new Map<string, number>();
    const promises = Array.from(fetchKeys.entries()).map(async ([key, { token, chainId }]) => {
      try {
        const balance = await this.balanceFetcher(token, chainId, walletAddress);
        if (balance !== null && !isNaN(balance)) {
          balanceResults.set(key, balance);
        }
      } catch { /* swallow */ }
    });
    await Promise.all(promises);

    // Evaluate watches
    const bus = getEventBus();
    const toRemove: string[] = [];

    for (const watch of this.watches.values()) {
      const key = tokenChainKey(watch.token, watch.chainId);
      const currentBalance = balanceResults.get(key);
      if (currentBalance === undefined) continue;

      const st = this.state.get(watch.id)!;
      const previousBalance = st.lastBalance;
      st.lastBalance = currentBalance;

      // Skip first tick (no previous balance to compare)
      if (previousBalance === null) continue;

      // Don't re-trigger if already triggered (for recurring watches, reset logic)
      if (st.wasTriggered && !watch.recurring) continue;

      const triggered =
        (watch.condition === 'below' && currentBalance <= watch.threshold && previousBalance > watch.threshold) ||
        (watch.condition === 'above' && currentBalance >= watch.threshold && previousBalance < watch.threshold);

      if (triggered) {
        st.wasTriggered = true;
        const change = currentBalance - previousBalance;

        bus.emit('balance_changed', {
          type: 'balance_changed',
          token: watch.token,
          chainId: watch.chainId,
          previousBalance,
          currentBalance,
          change: Math.abs(change),
          direction: change >= 0 ? 'increased' : 'decreased',
          walletAddress,
          timestamp: Date.now(),
        });

        if (!watch.recurring) {
          toRemove.push(watch.id);
        }
      } else if (st.wasTriggered && watch.recurring) {
        // Reset trigger if balance moved back past threshold
        const cleared =
          (watch.condition === 'below' && currentBalance > watch.threshold) ||
          (watch.condition === 'above' && currentBalance < watch.threshold);
        if (cleared) st.wasTriggered = false;
      }
    }

    for (const id of toRemove) {
      this.watches.delete(id);
      this.state.delete(id);
    }
  }

  clear(): void {
    this.watches.clear();
    this.state.clear();
  }
}

// ─── Default Balance Fetcher ────────────────────────────────────────────

const defaultBalanceFetcher: BalanceFetcher = async (token, chainId, walletAddress) => {
  const { getRpcManager } = await import('./rpc-provider.js');
  const rpc = getRpcManager();
  const client = await rpc.getClient(chainId);

  if (!token || token.toUpperCase() === 'ETH') {
    const balance = await client.getBalance({ address: walletAddress as `0x${string}` });
    return Number(balance) / 1e18;
  }

  // ERC-20
  const { resolveTokenDecimals } = await import('../lib/token-decimals.js');
  const decimals = await resolveTokenDecimals(token, client);
  const balanceOfAbi = [{
    name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  }] as const;
  const data = await client.readContract({
    address: token as `0x${string}`,
    abi: balanceOfAbi,
    functionName: 'balanceOf',
    args: [walletAddress as `0x${string}`],
  });
  return Number(data) / (10 ** decimals);
};

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: BalanceWatcher | null = null;

export function getBalanceWatcher(opts?: {
  balanceFetcher?: BalanceFetcher;
  walletAddressGetter?: () => string | null;
  tickMs?: number;
}): BalanceWatcher {
  if (!instance) {
    instance = new BalanceWatcher(opts);
  }
  return instance;
}

export function resetBalanceWatcher(): void {
  instance?.stop();
  instance?.clear();
  instance = null;
}
