/**
 * /triggers — view and manage active triggers (price watches, cron schedules).
 *
 * Commands:
 *   /triggers         — list all active triggers with plan info
 *   /triggers_price   — list active price watches
 *   /triggers_cron    — list active cron-scheduled plans
 *   /dead_letter      — view terminal failures from the dead-letter log
 */

import { getScheduler } from '../services/plan-scheduler.js';
import type { Plan } from '../services/plan-types.js';

function triggerType(plan: Plan): string {
  if (!plan.trigger) return 'immediate';
  return plan.trigger.type;
}

function formatTriggerDetail(plan: Plan): string {
  const t = plan.trigger;
  if (!t) return 'Trigger: immediate';

  switch (t.type) {
    case 'price':
      return `${t.token} ${t.condition} $${t.threshold}${t.recurring ? ' (recurring)' : ' (once)'}`;
    case 'cron':
      return `cron: \`${t.expression}\`${t.timezone ? ` (${t.timezone})` : ''}${t.maxRuns ? ` max ${t.maxRuns} runs` : ''}`;
    case 'interval':
      return `every ${formatMs(t.everyMs)}${t.maxRuns ? ` (max ${t.maxRuns})` : ''}`;
    case 'condition':
      return `condition-based (poll every ${formatMs(t.pollIntervalMs ?? 60_000)})`;
    case 'time':
      return `at ${new Date(t.at).toLocaleString()}`;
    case 'immediate':
      return 'immediate';
  }
}

function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function statusBadge(status: string): string {
  switch (status) {
    case 'scheduled': return 'ACTIVE';
    case 'running': return 'RUNNING';
    case 'paused': return 'PAUSED';
    default: return status.toUpperCase();
  }
}

export const triggersCommand = {
  name: 'triggers',
  description: 'List all active triggers',
  acceptsArgs: false,
  requireAuth: true,

  handler: async () => {
    const scheduler = getScheduler();
    const plans = scheduler.listPlans().filter(p =>
      ['scheduled', 'running', 'paused'].includes(p.status) &&
      p.trigger && p.trigger.type !== 'immediate',
    );

    if (plans.length === 0) {
      return {
        text: 'No active triggers.\n\nSet one up: "when ETH hits $4000, sell half" or "every day at 9am, check my portfolio"',
      };
    }

    const lines = [`**Active Triggers** (${plans.length})`, ''];

    for (const plan of plans) {
      lines.push(`[${statusBadge(plan.status)}] **${plan.name}**`);
      lines.push(`  Type: ${triggerType(plan)}`);
      lines.push(`  ${formatTriggerDetail(plan)}`);
      lines.push(`  ID: \`${plan.id}\``);
      lines.push('');
    }

    lines.push('/triggers_price | /triggers_cron | /plans_cancel');

    return { text: lines.join('\n') };
  },
};

export const triggersPriceCommand = {
  name: 'triggers_price',
  description: 'List active price triggers',
  acceptsArgs: false,
  requireAuth: true,

  handler: async () => {
    const scheduler = getScheduler();
    const plans = scheduler.listPlans().filter(p =>
      ['scheduled', 'running', 'paused'].includes(p.status) &&
      p.trigger?.type === 'price',
    );

    if (plans.length === 0) {
      return {
        text: 'No active price triggers.\n\nSet one: "when BTC drops below $50k, buy 0.1 BTC"',
      };
    }

    const lines = [`**Price Triggers** (${plans.length})`, ''];

    for (const plan of plans) {
      const t = plan.trigger;
      if (t?.type !== 'price') continue;
      lines.push(`[${statusBadge(plan.status)}] **${plan.name}**`);
      lines.push(`  ${t.token} ${t.condition} $${t.threshold}`);
      if (t.recurring) lines.push('  Recurring: yes');
      if (t.hysteresisPercent && t.hysteresisPercent !== 1) {
        lines.push(`  Hysteresis: ${t.hysteresisPercent}%`);
      }
      lines.push(`  ID: \`${plan.id}\``);
      lines.push('');
    }

    return { text: lines.join('\n') };
  },
};

export const triggersCronCommand = {
  name: 'triggers_cron',
  description: 'List active cron triggers',
  acceptsArgs: false,
  requireAuth: true,

  handler: async () => {
    const scheduler = getScheduler();
    const plans = scheduler.listPlans().filter(p =>
      ['scheduled', 'running', 'paused'].includes(p.status) &&
      p.trigger?.type === 'cron',
    );

    if (plans.length === 0) {
      return {
        text: 'No active cron triggers.\n\nSet one: "every Monday at 9am, rebalance my portfolio"',
      };
    }

    const lines = [`**Cron Triggers** (${plans.length})`, ''];

    for (const plan of plans) {
      const t = plan.trigger;
      if (t?.type !== 'cron') continue;
      lines.push(`[${statusBadge(plan.status)}] **${plan.name}**`);
      lines.push(`  Expression: \`${t.expression}\``);
      if (t.timezone) lines.push(`  Timezone: ${t.timezone}`);
      if (t.maxRuns) lines.push(`  Max runs: ${t.maxRuns}`);
      lines.push(`  ID: \`${plan.id}\``);
      lines.push('');
    }

    return { text: lines.join('\n') };
  },
};

export const deadLetterCommand = {
  name: 'dead_letter',
  description: 'View terminal plan failures',
  acceptsArgs: false,
  requireAuth: true,

  handler: async () => {
    const scheduler = getScheduler();
    const entries = scheduler.loadDeadLetters();

    if (entries.length === 0) {
      return {
        text: 'No dead-letter entries. All plans have completed successfully or are still running.',
      };
    }

    const lines = [`**Dead-Letter Log** (${entries.length} failures)`, ''];

    for (const entry of entries.slice(0, 10)) {
      const age = Date.now() - entry.timestamp;
      lines.push(`**Plan:** \`${entry.planId}\` | **Node:** \`${entry.nodeId}\``);
      if (entry.tool) lines.push(`  Tool: ${entry.tool}`);
      lines.push(`  Error: ${entry.error}`);
      lines.push(`  Retries: ${entry.retryCount} | ${formatMs(age)} ago`);
      lines.push('');
    }

    if (entries.length > 10) {
      lines.push(`...and ${entries.length - 10} more`);
    }

    lines.push('Use compound_action with action="dead_letter" clear=true to purge.');

    return { text: lines.join('\n') };
  },
};
