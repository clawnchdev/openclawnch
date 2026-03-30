/**
 * /approve and /deny commands — respond to plan step confirmations.
 *
 * When a plan step has `requireConfirmation: true`, the executor pauses
 * and asks the user. The user responds with /approve or /deny.
 */

import {
  respondToConfirmation,
  getPendingConfirmation,
} from '../services/confirmation-store.js';

export const approveCommand = {
  name: 'approve',
  description: 'Approve a pending plan step',
  acceptsArgs: false,
  requireAuth: true,

  handler: async (ctx: any) => {
    // Extract userId from context
    const userId = ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'owner';

    const pending = getPendingConfirmation(userId);
    if (!pending) {
      return { text: 'No pending confirmations.\n\nConfirmation requests appear when a plan step needs your approval before executing.' };
    }

    const confirmed = respondToConfirmation(userId, true);
    if (!confirmed) {
      return { text: 'No pending confirmations.' };
    }

    return {
      text: `Approved: **${confirmed.stepLabel}**\n\nThe plan will continue executing.`,
    };
  },
};

export const denyCommand = {
  name: 'deny',
  description: 'Deny a pending plan step',
  acceptsArgs: false,
  requireAuth: true,

  handler: async (ctx: any) => {
    const userId = ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'owner';

    const pending = getPendingConfirmation(userId);
    if (!pending) {
      return { text: 'No pending confirmations.' };
    }

    const denied = respondToConfirmation(userId, false);
    if (!denied) {
      return { text: 'No pending confirmations.' };
    }

    return {
      text: `Denied: **${denied.stepLabel}**\n\nThe step will be skipped. The plan may continue with remaining steps.`,
    };
  },
};
