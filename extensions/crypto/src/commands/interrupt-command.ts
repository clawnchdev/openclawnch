/**
 * Interrupt commands — cancel ongoing operations.
 *
 * /interrupt       — Cancel the current LLM generation (suppresses response)
 * /interrupt_plan  — Cancel the currently executing plan
 */

import { getInterruptService } from '../services/interrupt-service.js';
import { getScheduler } from '../services/plan-scheduler.js';

export const interruptCommand = {
  name: 'interrupt',
  description: 'Cancel the current LLM response. The agent stops generating and no response is sent.',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx?: any) => {
    const sessionKey = ctx?.sessionKey ?? ctx?.conversationId ?? 'default';
    const svc = getInterruptService();
    const wasNew = svc.interrupt(sessionKey, 'user requested /interrupt');

    if (wasNew) {
      return { text: 'Interrupted. The current response has been cancelled.' };
    }
    return { text: 'Already interrupted — waiting for the current response to stop.' };
  },
};

export const interruptPlanCommand = {
  name: 'interrupt_plan',
  description: 'Cancel any currently executing plan. Use /plans to see active plans.',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx?: any) => {
    const rawArgs = (ctx?.args ?? '').trim();
    const scheduler = getScheduler();
    const activePlans = scheduler.getActivePlans();

    if (activePlans.length === 0) {
      return { text: 'No active plans to interrupt. Use `/plans` to see all plans.' };
    }

    // If a plan ID is provided, cancel that specific plan
    if (rawArgs) {
      const plan = activePlans.find(p => p.id === rawArgs || p.name === rawArgs);
      if (!plan) {
        return { text: `No active plan matching "${rawArgs}". Active plans: ${activePlans.map(p => `\`${p.name}\``).join(', ')}` };
      }
      scheduler.cancelPlan(plan.id);
      return { text: `Plan **${plan.name}** (\`${plan.id}\`) cancelled.` };
    }

    // No args — cancel all running plans
    let cancelled = 0;
    for (const plan of activePlans) {
      if (plan.status === 'running' || plan.status === 'scheduled') {
        scheduler.cancelPlan(plan.id);
        cancelled++;
      }
    }

    if (cancelled === 0) {
      return {
        text: `${activePlans.length} plan(s) are scheduled but none are currently executing.\nUse \`/plans_cancel <id>\` to cancel a specific plan, or \`/interrupt_plan <name>\` to cancel by name.`,
      };
    }

    return { text: `Cancelled ${cancelled} executing plan(s). Use \`/plans\` to verify.` };
  },
};
