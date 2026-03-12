/**
 * Price Watcher — polls token prices and fires events when thresholds are crossed.
 *
 * This service is the bridge between the event bus and price triggers defined
 * on plans. It maintains a set of "watches" (token + condition + threshold)
 * and periodically checks prices, emitting `price_crossed` events when thresholds
 * are breached.
 *
 * Design decisions:
 * - Uses the simple price-service (DexScreener) for fast, cached lookups.
 * - Deduplicates watches per token — if 3 plans watch ETH at different thresholds,
 *   we fetch ETH once per tick and check all 3 thresholds.
 * - Supports hysteresis (price must move N% past threshold before re-triggering)
 *   and cooldown (minimum time between triggers for same watch).
 * - Does NOT execute plans directly — it emits events that the scheduler consumes.
 */

import { getEventBus } from './event-bus.js';
import type { PriceTrigger } from './plan-types.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface PriceWatch {
  /** Unique ID for this watch (typically planId). */
  id: string;
  /** Token symbol to watch. */
  token: string;
  /** Trigger condition. */
  condition: 'above' | 'below' | 'crosses';
  /** Price threshold in USD. */
  threshold: number;
  /** Hysteresis percentage. Default: 1%. */
  hysteresisPercent: number;
  /** Cooldown between triggers in ms. Default: 300_000 (5 min). */
  cooldownMs: number;
  /** If true, trigger fires repeatedly. If false, fires once then removes itself. */
  recurring: boolean;
}

interface WatchState {
  /** Last known price for this token. */
  lastPrice: number | null;
  /** Whether the condition was met on the previous tick (for hysteresis). */
  wasTriggered: boolean;
  /** Timestamp of last trigger fire. */
  lastFiredAt: number;
}

export type PriceFetcher = (token: string) => Promise<number | null>;

// ─── Price Watcher ──────────────────────────────────────────────────────

export class PriceWatcher {
  private watches = new Map<string, PriceWatch>();
  private state = new Map<string, WatchState>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private priceFetcher: PriceFetcher;
  private tickMs: number;

  constructor(opts?: {
    priceFetcher?: PriceFetcher;
    tickMs?: number;
  }) {
    this.priceFetcher = opts?.priceFetcher ?? defaultPriceFetcher;
    this.tickMs = opts?.tickMs ?? 30_000; // 30s default
  }

  // ── Watch Management ──────────────────────────────────────────────────

  /** Add a price watch. */
  addWatch(watch: PriceWatch): void {
    this.watches.set(watch.id, watch);
    if (!this.state.has(watch.id)) {
      this.state.set(watch.id, {
        lastPrice: null,
        wasTriggered: false,
        lastFiredAt: 0,
      });
    }
  }

  /** Create a watch from a PriceTrigger (from a plan). */
  addFromTrigger(planId: string, trigger: PriceTrigger): void {
    this.addWatch({
      id: planId,
      token: trigger.token,
      condition: trigger.condition,
      threshold: trigger.threshold,
      hysteresisPercent: trigger.hysteresisPercent ?? 1,
      cooldownMs: trigger.cooldownMs ?? 300_000,
      recurring: trigger.recurring ?? false,
    });
  }

  /** Remove a watch. */
  removeWatch(id: string): boolean {
    this.state.delete(id);
    return this.watches.delete(id);
  }

  /** Get all active watches. */
  getWatches(): PriceWatch[] {
    return Array.from(this.watches.values());
  }

  /** Get the number of active watches. */
  get watchCount(): number {
    return this.watches.size;
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

  /** Check if the watcher is running. */
  get isRunning(): boolean {
    return this.running;
  }

  // ── Core Tick ─────────────────────────────────────────────────────────

  /** Run one price check cycle. Public for testing. */
  async tick(): Promise<void> {
    if (this.watches.size === 0) return;

    // Group watches by token to deduplicate fetches
    const tokenWatches = new Map<string, PriceWatch[]>();
    for (const watch of this.watches.values()) {
      const key = watch.token.toUpperCase();
      if (!tokenWatches.has(key)) {
        tokenWatches.set(key, []);
      }
      tokenWatches.get(key)!.push(watch);
    }

    // Fetch prices for all watched tokens in parallel
    const pricePromises = Array.from(tokenWatches.keys()).map(async (token) => {
      try {
        const price = await this.priceFetcher(token);
        return { token, price };
      } catch {
        return { token, price: null };
      }
    });

    const results = await Promise.all(pricePromises);
    const prices = new Map<string, number>();
    for (const { token, price } of results) {
      if (price !== null && !isNaN(price)) {
        prices.set(token, price);
      }
    }

    // Evaluate each watch against current prices
    const now = Date.now();
    const toRemove: string[] = [];
    const bus = getEventBus();

    for (const watch of this.watches.values()) {
      const tokenKey = watch.token.toUpperCase();
      const currentPrice = prices.get(tokenKey);
      if (currentPrice === undefined) continue;

      const st = this.state.get(watch.id)!;
      const previousPrice = st.lastPrice;
      st.lastPrice = currentPrice;

      // Check cooldown
      if (now - st.lastFiredAt < watch.cooldownMs) continue;

      // Evaluate condition
      const triggered = this.evaluateCondition(
        watch, currentPrice, previousPrice, st.wasTriggered,
      );

      if (triggered) {
        st.wasTriggered = true;
        st.lastFiredAt = now;

        bus.emit('price_crossed', {
          type: 'price_crossed',
          token: watch.token,
          condition: watch.condition,
          threshold: watch.threshold,
          currentPrice,
          previousPrice: previousPrice ?? currentPrice,
          timestamp: now,
        });

        if (!watch.recurring) {
          toRemove.push(watch.id);
        }
      } else if (st.wasTriggered) {
        // Check hysteresis: price must move back past threshold by hysteresis%
        // before the watch can re-trigger
        const hysteresisMargin = watch.threshold * (watch.hysteresisPercent / 100);
        const cleared = watch.condition === 'above'
          ? currentPrice < watch.threshold - hysteresisMargin
          : watch.condition === 'below'
            ? currentPrice > watch.threshold + hysteresisMargin
            : Math.abs(currentPrice - watch.threshold) > hysteresisMargin;

        if (cleared) {
          st.wasTriggered = false;
        }
      }
    }

    // Remove one-shot watches that fired
    for (const id of toRemove) {
      this.watches.delete(id);
      this.state.delete(id);
    }
  }

  // ── Condition Evaluation ──────────────────────────────────────────────

  private evaluateCondition(
    watch: PriceWatch,
    currentPrice: number,
    previousPrice: number | null,
    wasTriggered: boolean,
  ): boolean {
    // Don't re-trigger if still in triggered state (hysteresis not cleared)
    if (wasTriggered) return false;

    switch (watch.condition) {
      case 'above':
        return currentPrice >= watch.threshold;
      case 'below':
        return currentPrice <= watch.threshold;
      case 'crosses':
        // Crosses: triggered when price moves from one side to the other
        if (previousPrice === null) return false;
        return (
          (previousPrice < watch.threshold && currentPrice >= watch.threshold) ||
          (previousPrice > watch.threshold && currentPrice <= watch.threshold)
        );
      default:
        return false;
    }
  }

  /** Clear all watches and state. */
  clear(): void {
    this.watches.clear();
    this.state.clear();
  }
}

// ─── Default Price Fetcher ──────────────────────────────────────────────
// Uses the price service (DexScreener). Lazy-loaded to avoid circular deps.

const defaultPriceFetcher: PriceFetcher = async (token: string) => {
  const { getPrice } = await import('./price-service.js');
  const result = await getPrice(token);
  return result?.priceUsd ?? null;
};

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: PriceWatcher | null = null;

export function getPriceWatcher(opts?: {
  priceFetcher?: PriceFetcher;
  tickMs?: number;
}): PriceWatcher {
  if (!instance) {
    instance = new PriceWatcher(opts);
  }
  return instance;
}

export function resetPriceWatcher(): void {
  instance?.stop();
  instance?.clear();
  instance = null;
}
