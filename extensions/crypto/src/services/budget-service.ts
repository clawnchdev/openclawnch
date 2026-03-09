/**
 * Budget Enforcement Service — per-operation gas+slippage budget tracking.
 *
 * Inspired by Lemon's BudgetTracker/BudgetEnforcer pattern.
 * Tracks cumulative costs across multi-step compound operations and
 * halts execution when a budget threshold is exceeded.
 *
 * Designed to solve the "agent spends too much gas on a failed swap chain"
 * problem: if step 1 of a 3-step compound action already burned $X in gas,
 * stop before step 2 if the remaining budget is insufficient.
 *
 * Usage:
 *   const session = budgetService.startSession({ maxGasUsd: 5, maxSlippagePercent: 2 });
 *   budgetService.recordCost(session.id, { gasUsd: 0.42, slippageUsd: 1.20, stepLabel: 'swap ETH→USDC' });
 *   const check = budgetService.checkBudget(session.id);
 *   if (!check.ok) { /* halt operation * / }
 *   budgetService.endSession(session.id);
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────

export interface BudgetLimits {
  /** Max total gas cost in USD across all steps. Default: 10. */
  maxGasUsd?: number;
  /** Max total slippage in USD across all steps. Default: no limit. */
  maxSlippageUsd?: number;
  /** Max slippage as a percentage of trade value. Default: 5. */
  maxSlippagePercent?: number;
  /** Max total cost (gas + slippage + fees) in USD. Default: 25. */
  maxTotalCostUsd?: number;
  /** Max number of on-chain transactions. Default: 10. */
  maxTransactions?: number;
}

export interface CostRecord {
  timestamp: number;
  stepLabel: string;
  gasUsd: number;
  slippageUsd: number;
  feesUsd: number;
  tradeValueUsd: number;
  txHash?: string;
}

export interface BudgetSession {
  id: string;
  userId: string;
  limits: Required<BudgetLimits>;
  costs: CostRecord[];
  status: 'active' | 'completed' | 'exceeded' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  label?: string;
}

export interface BudgetCheck {
  ok: boolean;
  totalGasUsd: number;
  totalSlippageUsd: number;
  totalFeesUsd: number;
  totalCostUsd: number;
  transactionCount: number;
  remainingGasUsd: number;
  remainingTotalUsd: number;
  remainingTransactions: number;
  warnings: string[];
  blockers: string[];
}

// ─── Default Limits ──────────────────────────────────────────────────────

const DEFAULT_LIMITS: Required<BudgetLimits> = {
  maxGasUsd: 10,
  maxSlippageUsd: Infinity,
  maxSlippagePercent: 5,
  maxTotalCostUsd: 25,
  maxTransactions: 10,
};

// ─── Budget Service ──────────────────────────────────────────────────────

class BudgetService {
  private sessions = new Map<string, BudgetSession>();
  private userActiveSessions = new Map<string, string>(); // userId → sessionId

  /**
   * Start a new budget tracking session for a compound operation.
   */
  startSession(opts: {
    userId: string;
    limits?: BudgetLimits;
    label?: string;
  }): BudgetSession {
    // End any existing active session for this user
    const existingId = this.userActiveSessions.get(opts.userId);
    if (existingId) {
      this.endSession(existingId, 'completed');
    }

    const id = `budget_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: BudgetSession = {
      id,
      userId: opts.userId,
      limits: { ...DEFAULT_LIMITS, ...opts.limits },
      costs: [],
      status: 'active',
      startedAt: Date.now(),
      label: opts.label,
    };

    this.sessions.set(id, session);
    this.userActiveSessions.set(opts.userId, id);
    return session;
  }

  /**
   * Record a cost incurred by a step in the operation.
   */
  recordCost(sessionId: string, cost: {
    stepLabel: string;
    gasUsd?: number;
    slippageUsd?: number;
    feesUsd?: number;
    tradeValueUsd?: number;
    txHash?: string;
  }): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return;

    session.costs.push({
      timestamp: Date.now(),
      stepLabel: cost.stepLabel,
      gasUsd: cost.gasUsd ?? 0,
      slippageUsd: cost.slippageUsd ?? 0,
      feesUsd: cost.feesUsd ?? 0,
      tradeValueUsd: cost.tradeValueUsd ?? 0,
      txHash: cost.txHash,
    });

    // After recording, check if any budget limit is now exceeded and
    // transition the session status. This keeps checkBudget() side-effect-free.
    const totalGas = session.costs.reduce((s, c) => s + c.gasUsd, 0);
    const totalSlippage = session.costs.reduce((s, c) => s + c.slippageUsd, 0);
    const totalFees = session.costs.reduce((s, c) => s + c.feesUsd, 0);
    const totalCost = totalGas + totalSlippage + totalFees;
    const txCount = session.costs.filter(c => c.txHash).length;

    const exceeded =
      totalGas > session.limits.maxGasUsd ||
      totalCost > session.limits.maxTotalCostUsd ||
      totalSlippage > session.limits.maxSlippageUsd ||
      txCount >= session.limits.maxTransactions;

    if (exceeded) {
      session.status = 'exceeded';
    }
  }

  /**
   * Check whether the session is still within budget.
   * Returns detailed breakdown with warnings and blockers.
   */
  checkBudget(sessionId: string): BudgetCheck {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: true, // No session = no budget tracking = allow
        totalGasUsd: 0, totalSlippageUsd: 0, totalFeesUsd: 0,
        totalCostUsd: 0, transactionCount: 0,
        remainingGasUsd: Infinity, remainingTotalUsd: Infinity,
        remainingTransactions: Infinity,
        warnings: [], blockers: [],
      };
    }

    const totalGasUsd = session.costs.reduce((sum, c) => sum + c.gasUsd, 0);
    const totalSlippageUsd = session.costs.reduce((sum, c) => sum + c.slippageUsd, 0);
    const totalFeesUsd = session.costs.reduce((sum, c) => sum + c.feesUsd, 0);
    const totalCostUsd = totalGasUsd + totalSlippageUsd + totalFeesUsd;
    const transactionCount = session.costs.filter(c => c.txHash).length;

    const warnings: string[] = [];
    const blockers: string[] = [];

    // Check gas limit
    if (totalGasUsd > session.limits.maxGasUsd) {
      blockers.push(
        `Gas budget exceeded: $${totalGasUsd.toFixed(2)} spent (limit: $${session.limits.maxGasUsd.toFixed(2)})`
      );
    } else if (totalGasUsd > session.limits.maxGasUsd * 0.8) {
      warnings.push(
        `Gas budget 80% consumed: $${totalGasUsd.toFixed(2)} of $${session.limits.maxGasUsd.toFixed(2)}`
      );
    }

    // Check total cost limit
    if (totalCostUsd > session.limits.maxTotalCostUsd) {
      blockers.push(
        `Total cost budget exceeded: $${totalCostUsd.toFixed(2)} spent (limit: $${session.limits.maxTotalCostUsd.toFixed(2)})`
      );
    } else if (totalCostUsd > session.limits.maxTotalCostUsd * 0.8) {
      warnings.push(
        `Total cost budget 80% consumed: $${totalCostUsd.toFixed(2)} of $${session.limits.maxTotalCostUsd.toFixed(2)}`
      );
    }

    // Check slippage limit (USD)
    if (totalSlippageUsd > session.limits.maxSlippageUsd) {
      blockers.push(
        `Slippage budget exceeded: $${totalSlippageUsd.toFixed(2)} lost (limit: $${session.limits.maxSlippageUsd.toFixed(2)})`
      );
    }

    // Check slippage limit (percentage per individual trade)
    for (const cost of session.costs) {
      if (cost.tradeValueUsd > 0 && cost.slippageUsd > 0) {
        const slippagePct = (cost.slippageUsd / cost.tradeValueUsd) * 100;
        if (slippagePct > session.limits.maxSlippagePercent) {
          warnings.push(
            `High slippage on "${cost.stepLabel}": ${slippagePct.toFixed(1)}% (limit: ${session.limits.maxSlippagePercent}%)`
          );
        }
      }
    }

    // Check transaction count
    if (transactionCount >= session.limits.maxTransactions) {
      blockers.push(
        `Transaction limit reached: ${transactionCount} of ${session.limits.maxTransactions}`
      );
    }

    return {
      ok: blockers.length === 0,
      totalGasUsd,
      totalSlippageUsd,
      totalFeesUsd,
      totalCostUsd,
      transactionCount,
      remainingGasUsd: Math.max(0, session.limits.maxGasUsd - totalGasUsd),
      remainingTotalUsd: Math.max(0, session.limits.maxTotalCostUsd - totalCostUsd),
      remainingTransactions: Math.max(0, session.limits.maxTransactions - transactionCount),
      warnings,
      blockers,
    };
  }

  /**
   * End a budget session.
   */
  endSession(sessionId: string, status: 'completed' | 'cancelled' = 'completed'): BudgetSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (session.status === 'active') {
      session.status = status;
    }
    session.endedAt = Date.now();

    // Clean up user mapping
    if (this.userActiveSessions.get(session.userId) === sessionId) {
      this.userActiveSessions.delete(session.userId);
    }

    // Persist to disk for audit trail
    this.persistSession(session);

    return session;
  }

  /**
   * Get the active budget session for a user (if any).
   */
  getActiveSession(userId: string): BudgetSession | null {
    const sessionId = this.userActiveSessions.get(userId);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return null;
    return session;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): BudgetSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Format a budget check result as a human-readable string.
   */
  formatBudgetCheck(check: BudgetCheck): string {
    const lines: string[] = [];

    lines.push(`Cost so far: $${check.totalCostUsd.toFixed(2)} (gas: $${check.totalGasUsd.toFixed(2)}, slippage: $${check.totalSlippageUsd.toFixed(2)}, fees: $${check.totalFeesUsd.toFixed(2)})`);
    lines.push(`Transactions: ${check.transactionCount}`);
    lines.push(`Remaining budget: $${check.remainingTotalUsd.toFixed(2)} total, $${check.remainingGasUsd.toFixed(2)} gas`);

    if (check.warnings.length > 0) {
      lines.push('', 'Warnings:');
      for (const w of check.warnings) lines.push(`  - ${w}`);
    }
    if (check.blockers.length > 0) {
      lines.push('', 'BLOCKED:');
      for (const b of check.blockers) lines.push(`  - ${b}`);
    }

    return lines.join('\n');
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private getAuditDir(): string {
    return process.env.OPENCLAWNCH_TX_DIR
      ? join(process.env.OPENCLAWNCH_TX_DIR, '..', 'budget-audit')
      : join(process.env.HOME ?? '/tmp', '.openclawnch', 'budget-audit');
  }

  private persistSession(session: BudgetSession): void {
    try {
      const dir = this.getAuditDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const filename = `${session.id}.json`;
      writeFileSync(join(dir, filename), JSON.stringify(session, null, 2), 'utf8');
    } catch {
      // Best effort — don't crash on audit write failure
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _instance: BudgetService | null = null;

export function getBudgetService(): BudgetService {
  if (!_instance) {
    _instance = new BudgetService();
  }
  return _instance;
}

export function resetBudgetService(): void {
  _instance = null;
}
