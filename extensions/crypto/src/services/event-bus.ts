/**
 * Event Bus — typed pub/sub for internal plan-engine events.
 *
 * Lightweight, zero-dependency event emitter for decoupling trigger sources
 * (price watcher, cron evaluator) from the scheduler. Events are fire-and-forget
 * (handlers run async but errors don't propagate).
 *
 * Usage:
 *   const bus = getEventBus();
 *   bus.on('price_crossed', handler);
 *   bus.emit('price_crossed', { token: 'ETH', ... });
 */

// ─── Event Types ────────────────────────────────────────────────────────

export interface PriceCrossedEvent {
  type: 'price_crossed';
  token: string;
  condition: 'above' | 'below' | 'crosses';
  threshold: number;
  currentPrice: number;
  previousPrice: number;
  timestamp: number;
}

export interface CronTickEvent {
  type: 'cron_tick';
  /** The cron expression that matched. */
  expression: string;
  /** ISO timestamp of the tick. */
  tickTime: string;
  timestamp: number;
}

export interface PlanCompletedEvent {
  type: 'plan_completed';
  planId: string;
  executionId: string;
  status: 'completed' | 'failed' | 'cancelled';
  timestamp: number;
}

export interface CheckpointResumedEvent {
  type: 'checkpoint_resumed';
  planId: string;
  executionId: string;
  nodeId: string;
  timestamp: number;
}

export type BusEvent =
  | PriceCrossedEvent
  | CronTickEvent
  | PlanCompletedEvent
  | CheckpointResumedEvent;

export type BusEventType = BusEvent['type'];

// Extract event by type
type EventOfType<T extends BusEventType> = Extract<BusEvent, { type: T }>;

export type BusEventHandler<T extends BusEventType = BusEventType> = (
  event: EventOfType<T>,
) => void | Promise<void>;

// ─── Event Bus ──────────────────────────────────────────────────────────

export class EventBus {
  private handlers = new Map<BusEventType, Set<BusEventHandler<any>>>();
  private allHandlers = new Set<BusEventHandler<any>>();

  /** Subscribe to a specific event type. Returns unsubscribe function. */
  on<T extends BusEventType>(type: T, handler: BusEventHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /** Subscribe to all events. Returns unsubscribe function. */
  onAny(handler: BusEventHandler): () => void {
    this.allHandlers.add(handler);
    return () => {
      this.allHandlers.delete(handler);
    };
  }

  /** Emit an event to all subscribers (async, errors swallowed). */
  emit<T extends BusEventType>(type: T, event: EventOfType<T>): void {
    const typeHandlers = this.handlers.get(type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          const result = handler(event);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(() => {});
          }
        } catch { /* swallow sync errors */ }
      }
    }

    for (const handler of this.allHandlers) {
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {});
        }
      } catch { /* swallow */ }
    }
  }

  /** Remove all handlers. */
  clear(): void {
    this.handlers.clear();
    this.allHandlers.clear();
  }

  /** Get handler count for a specific event type (for testing). */
  listenerCount(type?: BusEventType): number {
    if (type) {
      return (this.handlers.get(type)?.size ?? 0) + this.allHandlers.size;
    }
    let total = this.allHandlers.size;
    for (const set of this.handlers.values()) {
      total += set.size;
    }
    return total;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!instance) {
    instance = new EventBus();
  }
  return instance;
}

export function resetEventBus(): void {
  instance?.clear();
  instance = null;
}
