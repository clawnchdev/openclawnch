/**
 * Heartbeat Position Monitor — periodic checks on open positions.
 *
 * Inspired by ZeroClaw's heartbeat system.
 *
 * Periodically checks:
 * 1. Token positions for large price moves (configurable threshold)
 * 2. Portfolio value changes exceeding alert thresholds
 * 3. Stale/unknown tokens that appeared in the wallet
 *
 * Works with the tx-ledger to know which positions the agent opened,
 * and the portfolio-snapshot service to get current values.
 *
 * Fires alert callbacks when thresholds are breached. The caller
 * (index.ts) wires these to channel notifications.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface HeartbeatConfig {
  /** How often to run checks in ms. Default: 300_000 (5 minutes). */
  intervalMs?: number;
  /** Price drop % that triggers an alert. Default: 10. */
  priceDropAlertPercent?: number;
  /** Price gain % that triggers an alert. Default: 20. */
  priceGainAlertPercent?: number;
  /** Portfolio value drop in USD that triggers an alert. Default: 100. */
  portfolioDropAlertUsd?: number;
  /** Whether the monitor is enabled. Default: true. */
  enabled?: boolean;
}

export interface PositionSnapshot {
  symbol: string;
  address: string;
  chain: string;
  priceUsd: number;
  valueUsd: number;
  balanceHuman: number;
  timestamp: number;
}

export interface HeartbeatAlert {
  type: 'price_drop' | 'price_gain' | 'portfolio_drop' | 'new_token' | 'position_gone';
  severity: 'info' | 'warning' | 'critical';
  symbol: string;
  chain: string;
  message: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export type AlertCallback = (alert: HeartbeatAlert) => void | Promise<void>;

// ─── Heartbeat Monitor ──────────────────────────────────────────────────

class HeartbeatMonitor {
  private config: Required<HeartbeatConfig>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastPositions = new Map<string, PositionSnapshot>();
  private lastPortfolioValueUsd = 0;
  private lastCheckMs = 0;
  private alerts: HeartbeatAlert[] = [];
  private callbacks: AlertCallback[] = [];
  private checkCount = 0;
  private tickInProgress = false;

  private static readonly MAX_ALERTS = 500;
  private static readonly ALERT_KEY_SEP = ':';

  constructor(config: HeartbeatConfig = {}) {
    this.config = {
      intervalMs: config.intervalMs ?? 300_000,
      priceDropAlertPercent: config.priceDropAlertPercent ?? 10,
      priceGainAlertPercent: config.priceGainAlertPercent ?? 20,
      portfolioDropAlertUsd: config.portfolioDropAlertUsd ?? 100,
      enabled: config.enabled ?? true,
    };
  }

  /**
   * Register a callback that fires when an alert is generated.
   */
  onAlert(cb: AlertCallback): void {
    this.callbacks.push(cb);
  }

  /**
   * Start the periodic heartbeat.
   */
  start(): void {
    if (!this.config.enabled || this.running) return;

    this.running = true;
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        // Best effort — don't let a failed tick stop the monitor
      });
    }, this.config.intervalMs);

    // Don't prevent Node from exiting
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  /**
   * Stop the periodic heartbeat.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single check cycle. Called automatically by the timer,
   * but can also be called manually for testing.
   */
  async tick(): Promise<HeartbeatAlert[]> {
    // Guard against overlapping ticks (slow RPC, slow portfolio fetch)
    if (this.tickInProgress) return [];
    this.tickInProgress = true;

    this.checkCount++;
    this.lastCheckMs = Date.now();
    const newAlerts: HeartbeatAlert[] = [];

    try {
      try {
        // Dynamically import to avoid circular deps and allow mocking
        const { getPortfolioService } = await import('./portfolio-snapshot.js');
        const { getWalletState } = await import('./walletconnect-service.js');

        const wallet = getWalletState();
        if (!wallet.connected || !wallet.address) return newAlerts;

        const portfolioSvc = getPortfolioService();
        const snapshot = await portfolioSvc.getSnapshot(wallet.address);

        // ── Price change alerts ──────────────────────────────────────
        for (const token of snapshot.tokens) {
          const key = `${token.symbol}${HeartbeatMonitor.ALERT_KEY_SEP}${token.chain}`;
          const prev = this.lastPositions.get(key);

          if (prev && prev.priceUsd > 0 && token.priceUsd > 0) {
            const changePct = ((token.priceUsd - prev.priceUsd) / prev.priceUsd) * 100;

            if (changePct <= -this.config.priceDropAlertPercent) {
              const alert: HeartbeatAlert = {
                type: 'price_drop',
                severity: changePct <= -25 ? 'critical' : 'warning',
                symbol: token.symbol,
                chain: token.chain,
                message: `${token.symbol} dropped ${Math.abs(changePct).toFixed(1)}% ` +
                  `($${prev.priceUsd.toFixed(4)} → $${token.priceUsd.toFixed(4)}) on ${token.chain}. ` +
                  `Position value: $${token.valueUsd.toFixed(2)}`,
                data: {
                  previousPrice: prev.priceUsd,
                  currentPrice: token.priceUsd,
                  changePct: Math.round(changePct * 100) / 100,
                  valueUsd: token.valueUsd,
                  balance: token.balanceHuman,
                },
                timestamp: Date.now(),
              };
              newAlerts.push(alert);
            } else if (changePct >= this.config.priceGainAlertPercent) {
              const alert: HeartbeatAlert = {
                type: 'price_gain',
                severity: 'info',
                symbol: token.symbol,
                chain: token.chain,
                message: `${token.symbol} gained ${changePct.toFixed(1)}% ` +
                  `($${prev.priceUsd.toFixed(4)} → $${token.priceUsd.toFixed(4)}) on ${token.chain}. ` +
                  `Position value: $${token.valueUsd.toFixed(2)}`,
                data: {
                  previousPrice: prev.priceUsd,
                  currentPrice: token.priceUsd,
                  changePct: Math.round(changePct * 100) / 100,
                  valueUsd: token.valueUsd,
                  balance: token.balanceHuman,
                },
                timestamp: Date.now(),
              };
              newAlerts.push(alert);
            }
          }

          // Detect new tokens that weren't in the last snapshot
          if (!prev && this.checkCount > 1) {
            newAlerts.push({
              type: 'new_token',
              severity: 'info',
              symbol: token.symbol,
              chain: token.chain,
              message: `New token detected: ${token.symbol} on ${token.chain} ` +
                `(${token.balanceHuman.toFixed(4)} @ $${token.priceUsd.toFixed(4)}, ` +
                `value: $${token.valueUsd.toFixed(2)})`,
              data: {
                address: token.address,
                balance: token.balanceHuman,
                priceUsd: token.priceUsd,
                valueUsd: token.valueUsd,
              },
              timestamp: Date.now(),
            });
          }

          // Update tracked position
          this.lastPositions.set(key, {
            symbol: token.symbol,
            address: token.address,
            chain: token.chain,
            priceUsd: token.priceUsd,
            valueUsd: token.valueUsd,
            balanceHuman: token.balanceHuman,
            timestamp: Date.now(),
          });
        }

        // ── Detect positions that disappeared ──────────────────────────
        if (this.checkCount > 1) {
          const currentKeys = new Set(
            snapshot.tokens.map(t => `${t.symbol}${HeartbeatMonitor.ALERT_KEY_SEP}${t.chain}`),
          );
          for (const [key, prev] of this.lastPositions) {
            if (!currentKeys.has(key) && prev.valueUsd > 1) {
              newAlerts.push({
                type: 'position_gone',
                severity: 'warning',
                symbol: prev.symbol,
                chain: prev.chain,
                message: `Position disappeared: ${prev.symbol} on ${prev.chain} ` +
                  `(was ${prev.balanceHuman.toFixed(4)} @ $${prev.priceUsd.toFixed(4)}, ` +
                  `value was $${prev.valueUsd.toFixed(2)})`,
                data: {
                  lastBalance: prev.balanceHuman,
                  lastPrice: prev.priceUsd,
                  lastValue: prev.valueUsd,
                },
                timestamp: Date.now(),
              });
              this.lastPositions.delete(key);
            }
          }
        }

        // ── Portfolio value drop alert ────────────────────────────────
        if (this.lastPortfolioValueUsd > 0) {
          const dropUsd = this.lastPortfolioValueUsd - snapshot.totalValueUsd;
          if (dropUsd >= this.config.portfolioDropAlertUsd) {
            const dropPct = (dropUsd / this.lastPortfolioValueUsd) * 100;
            newAlerts.push({
              type: 'portfolio_drop',
              severity: dropPct > 20 ? 'critical' : 'warning',
              symbol: 'PORTFOLIO',
              chain: 'all',
              message: `Portfolio dropped $${dropUsd.toFixed(2)} (${dropPct.toFixed(1)}%) ` +
                `since last check ($${this.lastPortfolioValueUsd.toFixed(2)} → $${snapshot.totalValueUsd.toFixed(2)})`,
              data: {
                previousValueUsd: this.lastPortfolioValueUsd,
                currentValueUsd: snapshot.totalValueUsd,
                dropUsd,
                dropPct: Math.round(dropPct * 100) / 100,
              },
              timestamp: Date.now(),
            });
          }
        }
        this.lastPortfolioValueUsd = snapshot.totalValueUsd;

      } catch {
        // Failed to get portfolio — skip this tick silently
      }

      // Store and fire alerts
      for (const alert of newAlerts) {
        this.alerts.push(alert);
        for (const cb of this.callbacks) {
          try {
            await cb(alert);
          } catch {
            // Best effort
          }
        }
      }

      // Trim alert history
      if (this.alerts.length > HeartbeatMonitor.MAX_ALERTS) {
        this.alerts = this.alerts.slice(-HeartbeatMonitor.MAX_ALERTS);
      }

      return newAlerts;
    } finally {
      this.tickInProgress = false;
    }
  }

  /**
   * Get recent alerts.
   */
  getAlerts(limit = 50): HeartbeatAlert[] {
    return this.alerts.slice(-limit);
  }

  /**
   * Get current tracked positions.
   */
  getPositions(): PositionSnapshot[] {
    return Array.from(this.lastPositions.values());
  }

  /**
   * Get monitor status for diagnostics.
   */
  getStatus(): {
    running: boolean;
    enabled: boolean;
    checkCount: number;
    lastCheckMs: number;
    trackedPositions: number;
    totalAlerts: number;
    intervalMs: number;
    config: Required<HeartbeatConfig>;
  } {
    return {
      running: this.running,
      enabled: this.config.enabled,
      checkCount: this.checkCount,
      lastCheckMs: this.lastCheckMs,
      trackedPositions: this.lastPositions.size,
      totalAlerts: this.alerts.length,
      intervalMs: this.config.intervalMs,
      config: this.config,
    };
  }

  /**
   * Manually set position data (useful for testing or seeding from ledger).
   */
  seedPosition(pos: PositionSnapshot): void {
    const key = `${pos.symbol}${HeartbeatMonitor.ALERT_KEY_SEP}${pos.chain}`;
    this.lastPositions.set(key, pos);
  }

  /**
   * Manually set the last portfolio value (useful for testing).
   */
  seedPortfolioValue(valueUsd: number): void {
    this.lastPortfolioValueUsd = valueUsd;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _instance: HeartbeatMonitor | null = null;

export function getHeartbeatMonitor(config?: HeartbeatConfig): HeartbeatMonitor {
  if (!_instance) {
    _instance = new HeartbeatMonitor(config);
  }
  return _instance;
}

export function resetHeartbeatMonitor(): void {
  if (_instance) {
    _instance.stop();
  }
  _instance = null;
}
