/**
 * Recurring Payment Service — subscription management via plan scheduler.
 *
 * Creates and manages recurring payment plans using the existing workflow
 * engine. Each recurring payment is a Plan with a cron/interval trigger
 * that executes a transfer action on schedule.
 *
 * This is a high-level API that compiles human-friendly payment descriptions
 * into Plan IR and registers them with the scheduler.
 *
 * Architecture:
 * - RecurringPayment → Plan IR with CronTrigger/IntervalTrigger + ActionNode(transfer)
 * - The plan scheduler handles timing, persistence, and trigger evaluation
 * - The plan executor handles actual transfer execution
 * - This service tracks metadata (label, recipient info) the plan doesn't
 *
 * Supports both crypto transfers (via transfer tool) and fiat payments
 * (via fiat_payment tool) on schedule.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan, CronTrigger, IntervalTrigger, ActionNode, SequenceNode } from './plan-types.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type PaymentFrequency =
  | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'
  | { cronExpression: string; timezone?: string }
  | { intervalMs: number };

export type PaymentMethod = 'crypto' | 'fiat';

export interface RecurringPayment {
  id: string;
  /** Human-readable label (e.g. "Vercel monthly"). */
  label: string;
  /** Recipient address or name. */
  recipient: string;
  /** Recipient wallet address (for crypto) or bank account ID (for fiat). */
  recipientAddress: string;
  /** Payment amount (human-readable units). */
  amount: string;
  /** Token symbol for crypto, or currency code for fiat (e.g. "USDC", "USD"). */
  currency: string;
  /** Token contract address for ERC-20 (omit for native ETH). */
  tokenAddress?: string;
  /** Chain ID for crypto payments. Default: 8453. */
  chainId: number;
  /** How the payment is sent. */
  method: PaymentMethod;
  /** How often to pay. */
  frequency: PaymentFrequency;
  /** Associated plan ID in the scheduler. */
  planId?: string;
  /** Current status. */
  status: 'active' | 'paused' | 'cancelled' | 'completed';
  /** Total number of payments made. */
  paymentsMade: number;
  /** Max total payments (undefined = forever). */
  maxPayments?: number;
  /** Next scheduled payment time (ISO 8601). */
  nextPaymentAt?: string;
  /** Memo/note attached to each payment. */
  memo?: string;
  /** Creator wallet address. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Frequency → Trigger Helpers ────────────────────────────────────────

const FREQUENCY_CRON: Record<string, string> = {
  daily: '0 9 * * *',        // 9am UTC daily
  weekly: '0 9 * * 1',       // 9am UTC every Monday
  biweekly: '0 9 1,15 * *',  // 9am UTC on 1st and 15th
  monthly: '0 9 1 * *',      // 9am UTC on 1st of month
  quarterly: '0 9 1 1,4,7,10 *', // 9am UTC on 1st of Jan,Apr,Jul,Oct
  yearly: '0 9 1 1 *',       // 9am UTC on Jan 1st
};

function frequencyToTrigger(freq: PaymentFrequency, maxRuns?: number): CronTrigger | IntervalTrigger {
  if (typeof freq === 'string') {
    const cron = FREQUENCY_CRON[freq];
    if (!cron) throw new Error(`Unknown frequency: ${freq}`);
    return { type: 'cron', expression: cron, maxRuns };
  }

  if ('cronExpression' in freq) {
    return { type: 'cron', expression: freq.cronExpression, timezone: freq.timezone, maxRuns };
  }

  return { type: 'interval', everyMs: freq.intervalMs, maxRuns };
}

function frequencyLabel(freq: PaymentFrequency): string {
  if (typeof freq === 'string') return freq;
  if ('cronExpression' in freq) return `cron(${freq.cronExpression})`;
  const hours = freq.intervalMs / 3_600_000;
  if (hours >= 24) return `every ${Math.round(hours / 24)} days`;
  return `every ${Math.round(hours)} hours`;
}

// ─── Plan Builder ───────────────────────────────────────────────────────

function buildPaymentPlan(payment: RecurringPayment): Plan {
  const trigger = frequencyToTrigger(payment.frequency, payment.maxPayments);

  // Build the action node based on payment method
  let actionNode: ActionNode;

  if (payment.method === 'crypto') {
    const toolParams: Record<string, string> = {
      action: 'send',
      to: payment.recipientAddress,
      amount: payment.amount,
    };
    if (payment.tokenAddress) {
      toolParams.token = payment.tokenAddress;
    }

    actionNode = {
      id: 'pay',
      type: 'action',
      label: `Pay ${payment.amount} ${payment.currency} to ${payment.recipient}`,
      tool: 'transfer',
      params: toolParams,
      requireConfirmation: false, // recurring payments are pre-approved
    };
  } else {
    // Fiat payment via fiat_payment tool
    actionNode = {
      id: 'pay',
      type: 'action',
      label: `Pay ${payment.amount} ${payment.currency} to ${payment.recipient}`,
      tool: 'fiat_payment',
      params: {
        action: 'off_ramp',
        amount: payment.amount,
        crypto_token: payment.currency,
        chain_id: payment.chainId,
      },
      requireConfirmation: false,
    };
  }

  const rootNode: SequenceNode = {
    id: 'root',
    type: 'sequence',
    label: `Recurring: ${payment.label}`,
    steps: [actionNode],
  };

  return {
    id: payment.planId ?? `recurring_${payment.id}`,
    name: `Recurring: ${payment.label}`,
    root: rootNode,
    trigger,
    userId: payment.createdBy,
    createdAt: payment.createdAt,
    status: 'scheduled',
    validation: { valid: true, issues: [], toolsUsed: [payment.method === 'crypto' ? 'transfer' : 'fiat_payment'], chainsUsed: [payment.chainId] },
    tags: ['recurring-payment', payment.method],
    naturalLanguage: `${frequencyLabel(payment.frequency)} payment of ${payment.amount} ${payment.currency} to ${payment.recipient}`,
  };
}

// ─── Service ────────────────────────────────────────────────────────────

export class RecurringPaymentService {
  private payments = new Map<string, RecurringPayment>();
  private stateDir: string;

  constructor(opts?: { stateDir?: string }) {
    this.stateDir = opts?.stateDir ?? join(
      process.env.HOME ?? '', '.openclawnch', 'recurring-payments'
    );
    this.loadState();
  }

  /** Create a new recurring payment. Returns the payment and the compiled Plan. */
  create(params: {
    label: string;
    recipient: string;
    recipientAddress: string;
    amount: string;
    currency: string;
    tokenAddress?: string;
    chainId?: number;
    method?: PaymentMethod;
    frequency: PaymentFrequency;
    maxPayments?: number;
    memo?: string;
    createdBy: string;
  }): { payment: RecurringPayment; plan: Plan } {
    const id = `rp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const payment: RecurringPayment = {
      id,
      label: params.label,
      recipient: params.recipient,
      recipientAddress: params.recipientAddress,
      amount: params.amount,
      currency: params.currency,
      tokenAddress: params.tokenAddress,
      chainId: params.chainId ?? 8453,
      method: params.method ?? 'crypto',
      frequency: params.frequency,
      planId: `recurring_${id}`,
      status: 'active',
      paymentsMade: 0,
      maxPayments: params.maxPayments,
      memo: params.memo,
      createdBy: params.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    const plan = buildPaymentPlan(payment);
    payment.planId = plan.id;

    this.payments.set(id, payment);
    this.saveState();

    return { payment, plan };
  }

  /** Pause a recurring payment. */
  pause(id: string): RecurringPayment | null {
    const p = this.payments.get(id);
    if (!p || p.status !== 'active') return p ?? null;
    p.status = 'paused';
    p.updatedAt = Date.now();
    this.saveState();
    return p;
  }

  /** Resume a paused recurring payment. Returns updated payment + new plan. */
  resume(id: string): { payment: RecurringPayment; plan: Plan } | null {
    const p = this.payments.get(id);
    if (!p || p.status !== 'paused') return null;
    p.status = 'active';
    p.updatedAt = Date.now();
    const plan = buildPaymentPlan(p);
    this.saveState();
    return { payment: p, plan };
  }

  /** Cancel a recurring payment permanently. */
  cancel(id: string): RecurringPayment | null {
    const p = this.payments.get(id);
    if (!p) return null;
    p.status = 'cancelled';
    p.updatedAt = Date.now();
    this.saveState();
    return p;
  }

  /** Record that a payment was made (called by executor hook). */
  recordPayment(id: string): RecurringPayment | null {
    const p = this.payments.get(id);
    if (!p) return null;
    p.paymentsMade += 1;
    p.updatedAt = Date.now();
    if (p.maxPayments && p.paymentsMade >= p.maxPayments) {
      p.status = 'completed';
    }
    this.saveState();
    return p;
  }

  /** Get a recurring payment by ID. */
  get(id: string): RecurringPayment | null {
    return this.payments.get(id) ?? null;
  }

  /** Find recurring payment by plan ID. */
  getByPlanId(planId: string): RecurringPayment | null {
    for (const p of this.payments.values()) {
      if (p.planId === planId) return p;
    }
    return null;
  }

  /** List all recurring payments. */
  list(opts?: { createdBy?: string; status?: RecurringPayment['status'] }): RecurringPayment[] {
    let all = Array.from(this.payments.values());
    if (opts?.createdBy) all = all.filter(p => p.createdBy === opts.createdBy);
    if (opts?.status) all = all.filter(p => p.status === opts.status);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Clear all state (for testing). */
  clear(): void {
    this.payments.clear();
  }

  // ── Persistence ─────────────────────────────────────────────────

  private loadState(): void {
    try {
      const filePath = join(this.stateDir, 'payments.json');
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        for (const p of data) {
          this.payments.set(p.id, p);
        }
      }
    } catch { /* fresh start */ }
  }

  private saveState(): void {
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
      const filePath = join(this.stateDir, 'payments.json');
      writeFileSync(filePath, JSON.stringify(Array.from(this.payments.values()), null, 2), 'utf8');
    } catch { /* best effort */ }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: RecurringPaymentService | null = null;

export function getRecurringPaymentService(opts?: { stateDir?: string }): RecurringPaymentService {
  if (!instance) {
    instance = new RecurringPaymentService(opts);
  }
  return instance;
}

export function resetRecurringPaymentService(): void {
  instance?.clear();
  instance = null;
}
