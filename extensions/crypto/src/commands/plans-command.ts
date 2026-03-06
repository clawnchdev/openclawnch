/**
 * /plans command — list and manage scheduled plans via tappable Telegram commands.
 *
 * Sub-commands:
 *   /plans         — show all plans with status
 *   /plans_active   — show only active (scheduled/running) plans
 *   /plans_cancel   — show cancellable plans with IDs
 *   /plans_clear    — cancel all active plans
 */

import { getScheduler } from '../services/plan-scheduler.js';
import type { Plan } from '../services/plan-types.js';

function statusIcon(status: string): string {
  switch (status) {
    case 'scheduled': return '[SCHED]';
    case 'running': return '[RUN]';
    case 'paused': return '[PAUSE]';
    case 'completed': return '[DONE]';
    case 'failed': return '[FAIL]';
    case 'cancelled': return '[X]';
    case 'validated': return '[READY]';
    case 'draft': return '[DRAFT]';
    default: return `[${status.toUpperCase()}]`;
  }
}

function describeTrigger(plan: Plan): string {
  const t = plan.trigger;
  if (!t) return 'immediate';
  switch (t.type) {
    case 'immediate': return 'immediate';
    case 'time': return `at ${new Date(t.at).toLocaleString()}`;
    case 'interval': return `every ${formatMs(t.everyMs)}`;
    case 'condition': return 'when condition met';
  }
}

function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function formatPlan(plan: Plan, showId = false): string {
  const parts = [
    `${statusIcon(plan.status)} **${plan.name}**`,
    `  Trigger: ${describeTrigger(plan)}`,
  ];
  if (showId) {
    parts.push(`  ID: \`${plan.id}\``);
  }
  const age = Date.now() - plan.createdAt;
  parts.push(`  Created: ${formatMs(age)} ago`);
  return parts.join('\n');
}

export const plansCommand = {
  name: 'plans',
  description: 'List scheduled plans',
  acceptsArgs: false,
  requireAuth: true,

  handler: async () => {
    const scheduler = getScheduler();
    const plans = scheduler.listPlans();

    if (plans.length === 0) {
      return {
        text: 'No plans found.\n\nAsk me to create one: "when ETH hits $4000, sell half for USDC"',
      };
    }

    // Sort: active first, then by creation time descending
    const active = ['scheduled', 'running', 'paused', 'validated', 'draft'];
    plans.sort((a, b) => {
      const aActive = active.includes(a.status) ? 0 : 1;
      const bActive = active.includes(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return b.createdAt - a.createdAt;
    });

    const lines = [
      `**Plans** (${plans.length} total)`,
      '',
      ...plans.slice(0, 15).map(p => formatPlan(p, true)),
    ];

    if (plans.length > 15) {
      lines.push(`\n...and ${plans.length - 15} more`);
    }

    const activeCount = plans.filter(p => active.includes(p.status)).length;
    lines.push('');
    lines.push(`Active: ${activeCount} | /plans_active | /plans_cancel`);

    return { text: lines.join('\n') };
  },
};

export const plansActiveCommand = {
  name: 'plans_active',
  description: 'Show active plans only',
  acceptsArgs: false,
  requireAuth: true,

  handler: async () => {
    const scheduler = getScheduler();
    const plans = scheduler.listPlans()
      .filter(p => ['scheduled', 'running', 'paused'].includes(p.status));

    if (plans.length === 0) {
      return { text: 'No active plans.\n\nAsk me to create one, or tap /plans to see all plans.' };
    }

    const lines = [
      `**Active Plans** (${plans.length})`,
      '',
      ...plans.map(p => formatPlan(p, true)),
    ];

    return { text: lines.join('\n') };
  },
};

export const plansCancelCommand = {
  name: 'plans_cancel',
  description: 'Show plans that can be cancelled (with IDs)',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx: any) => {
    const scheduler = getScheduler();
    const planId = (ctx?.args ?? ctx?.commandBody ?? '').trim();

    // If a plan ID is provided, cancel it directly
    if (planId) {
      const success = scheduler.cancelPlan(planId);
      if (!success) {
        return { text: `Plan \`${planId}\` not found or already completed.` };
      }
      return { text: `Cancelled plan \`${planId}\`.` };
    }

    // Otherwise show cancellable plans
    const cancellable = scheduler.listPlans()
      .filter(p => ['scheduled', 'running', 'paused', 'validated', 'draft'].includes(p.status));

    if (cancellable.length === 0) {
      return { text: 'No plans to cancel.' };
    }

    const lines = [
      `**Cancellable Plans** (${cancellable.length})`,
      '',
      ...cancellable.map(p => formatPlan(p, true)),
      '',
      'To cancel a plan, tell me: "cancel plan PLAN_ID"',
      'To cancel all: /plans_clear',
    ];

    return { text: lines.join('\n') };
  },
};

export const plansClearCommand = {
  name: 'plans_clear',
  description: 'Cancel all active plans',
  acceptsArgs: false,
  requireAuth: true,

  handler: async () => {
    const scheduler = getScheduler();
    const active = scheduler.listPlans()
      .filter(p => ['scheduled', 'running', 'paused', 'validated', 'draft'].includes(p.status));

    if (active.length === 0) {
      return { text: 'No active plans to clear.' };
    }

    let cancelled = 0;
    for (const plan of active) {
      if (scheduler.cancelPlan(plan.id)) cancelled++;
    }

    return {
      text: `Cancelled ${cancelled} plan${cancelled !== 1 ? 's' : ''}.\n\nAll scheduled operations have been stopped.`,
    };
  },
};
