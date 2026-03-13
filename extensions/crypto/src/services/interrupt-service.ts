/**
 * Interrupt Service — shared interrupt flag per session.
 *
 * When `/interrupt` is called, the flag is set for the current session.
 * The `message_sending` hook checks the flag and cancels the LLM response.
 * The `after_tool_call` hook checks the flag to skip further tool calls.
 *
 * Flags auto-expire after TTL_MS to prevent stale interrupts from
 * silencing future responses.
 */

// ─── Types ───────────────────────────────────────────────────────────────

interface InterruptFlag {
  /** When the interrupt was requested. */
  timestamp: number;
  /** Reason (optional, for logging). */
  reason?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

/** Interrupt flags expire after 30 seconds. */
const TTL_MS = 30_000;

/** Sweep stale entries every 60 seconds. */
const SWEEP_INTERVAL_MS = 60_000;

// ─── Service ─────────────────────────────────────────────────────────────

class InterruptService {
  private flags = new Map<string, InterruptFlag>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Unref so the timer doesn't keep the process alive
    if (this.sweepTimer && typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  /**
   * Set the interrupt flag for a session.
   * Returns true if a flag was newly set (wasn't already active).
   */
  interrupt(sessionKey: string, reason?: string): boolean {
    const existing = this.flags.get(sessionKey);
    if (existing && Date.now() - existing.timestamp < TTL_MS) {
      return false; // Already interrupted
    }
    this.flags.set(sessionKey, { timestamp: Date.now(), reason });
    return true;
  }

  /**
   * Check and consume the interrupt flag.
   * Returns true if an interrupt was pending (and consumes it).
   */
  consume(sessionKey: string): boolean {
    const flag = this.flags.get(sessionKey);
    if (!flag) return false;

    // Check expiry
    if (Date.now() - flag.timestamp > TTL_MS) {
      this.flags.delete(sessionKey);
      return false;
    }

    this.flags.delete(sessionKey);
    return true;
  }

  /**
   * Check if an interrupt is pending without consuming it.
   */
  isPending(sessionKey: string): boolean {
    const flag = this.flags.get(sessionKey);
    if (!flag) return false;
    if (Date.now() - flag.timestamp > TTL_MS) {
      this.flags.delete(sessionKey);
      return false;
    }
    return true;
  }

  /** Remove expired entries. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, flag] of this.flags) {
      if (now - flag.timestamp > TTL_MS) {
        this.flags.delete(key);
      }
    }
  }

  /** Stop the sweep timer (for shutdown). */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Number of active flags (for testing). */
  get size(): number {
    return this.flags.size;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let instance: InterruptService | null = null;

export function getInterruptService(): InterruptService {
  if (!instance) {
    instance = new InterruptService();
  }
  return instance;
}

export function resetInterruptService(): void {
  instance?.stop();
  instance = null;
}
