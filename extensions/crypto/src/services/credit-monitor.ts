/**
 * Credit Monitor — proactive LLM credit balance monitoring.
 *
 * Periodically checks the Bankr LLM Gateway credit balance and emits
 * alerts when balance drops below configurable thresholds. Integrates
 * with the channel sender to notify users before credits run out.
 *
 * Architecture follows the HeartbeatMonitor pattern:
 * - Periodic timer with configurable interval
 * - Alert callbacks wired by index.ts to channel sender
 * - Event bus integration for credit_low events
 */

import { guardedFetch } from './endpoint-allowlist.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface CreditMonitorConfig {
  /** How often to check balance in ms. Default: 300_000 (5 minutes). */
  intervalMs?: number;
  /** Balance threshold in USD that triggers a warning. Default: 5. */
  warningThresholdUsd?: number;
  /** Balance threshold in USD that triggers a critical alert. Default: 1. */
  criticalThresholdUsd?: number;
  /** Whether the monitor is enabled. Default: true. */
  enabled?: boolean;
}

export interface CreditAlert {
  severity: 'warning' | 'critical';
  balance: number;
  currency: string;
  message: string;
  timestamp: number;
}

export type CreditAlertCallback = (alert: CreditAlert) => void | Promise<void>;

// ─── Constants ───────────────────────────────────────────────────────────

const BANKR_BASE = 'https://llm.bankr.bot';

/** Suppress duplicate alerts for this long after firing one. */
const ALERT_COOLDOWN_MS = 30 * 60_000; // 30 minutes

// ─── Service ─────────────────────────────────────────────────────────────

class CreditMonitor {
  private config: Required<CreditMonitorConfig>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private callbacks: CreditAlertCallback[] = [];
  private lastAlertTimestamp = 0;
  private lastBalance: number | null = null;
  private checkCount = 0;
  private tickInProgress = false;

  constructor(config: CreditMonitorConfig = {}) {
    this.config = {
      intervalMs: config.intervalMs ?? 300_000,
      warningThresholdUsd: config.warningThresholdUsd ?? 5,
      criticalThresholdUsd: config.criticalThresholdUsd ?? 1,
      enabled: config.enabled ?? true,
    };
  }

  /** Register an alert callback. */
  onAlert(cb: CreditAlertCallback): void {
    this.callbacks.push(cb);
  }

  /** Start periodic checking. */
  start(): void {
    if (this.running || !this.config.enabled) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.config.intervalMs);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    // Run first check after a short delay (don't block startup)
    setTimeout(() => this.tick(), 10_000);
  }

  /** Stop periodic checking. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get current state (for /llmcredits display). */
  getState(): { lastBalance: number | null; checkCount: number; running: boolean } {
    return {
      lastBalance: this.lastBalance,
      checkCount: this.checkCount,
      running: this.running,
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Run one check cycle. */
  async tick(): Promise<void> {
    if (this.tickInProgress) return; // Prevent overlapping checks
    this.tickInProgress = true;

    try {
      const key = process.env.BANKR_LLM_KEY;
      if (!key) return; // No key configured — skip

      const balance = await this.fetchBalance(key);
      if (balance === null) return; // API error — skip

      this.lastBalance = balance;
      this.checkCount++;

      // Check thresholds
      const now = Date.now();
      const cooldownExpired = now - this.lastAlertTimestamp > ALERT_COOLDOWN_MS;

      if (balance <= this.config.criticalThresholdUsd && cooldownExpired) {
        this.lastAlertTimestamp = now;
        this.emitAlert({
          severity: 'critical',
          balance,
          currency: 'USD',
          message: `LLM credits critically low: $${balance.toFixed(2)} remaining. Top up immediately with \`/topup 25\` or enable auto top-up with \`/autotopup enable\`.`,
          timestamp: now,
        });
      } else if (balance <= this.config.warningThresholdUsd && cooldownExpired) {
        this.lastAlertTimestamp = now;
        this.emitAlert({
          severity: 'warning',
          balance,
          currency: 'USD',
          message: `LLM credits low: $${balance.toFixed(2)} remaining. Consider topping up with \`/topup 25\` or enable \`/autotopup enable\`.`,
          timestamp: now,
        });
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  private async fetchBalance(key: string): Promise<number | null> {
    try {
      const res = await guardedFetch(`${BANKR_BASE}/v1/credits`, {
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      const balance = data?.balance ?? data?.credits ?? data?.remaining ?? null;
      if (typeof balance !== 'number') return null;
      return balance;
    } catch {
      return null;
    }
  }

  private emitAlert(alert: CreditAlert): void {
    for (const cb of this.callbacks) {
      try {
        const result = cb(alert);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {});
        }
      } catch { /* swallow */ }
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let instance: CreditMonitor | null = null;

export function getCreditMonitor(config?: CreditMonitorConfig): CreditMonitor {
  if (!instance) {
    instance = new CreditMonitor(config);
  }
  return instance;
}

export function resetCreditMonitor(): void {
  instance?.stop();
  instance = null;
}
