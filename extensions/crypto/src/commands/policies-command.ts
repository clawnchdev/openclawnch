/**
 * /policies — User-facing command for viewing and managing spending policies.
 *
 * Subcommands:
 *   /policies              — list all policies with their rules
 *   /policies <name>       — view a specific policy
 *   /policies enable <name>
 *   /policies disable <name>
 *   /policies delete <name>
 *
 * Policy CREATION is handled conversationally via the policy_manage tool.
 * Users just say what they want in plain English; the agent interprets.
 */

import { getPolicyStore } from '../services/policy-store.js';
import { buildPolicyDisplay, renderPolicyDisplay } from '../services/policy-evaluator.js';
import { formatDelegationStatus } from '../services/delegation-service.js';

export const policiesCommand = {
  name: 'policies',
  description: 'View and manage spending policies: /policies [enable|disable|delete] [name]',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx?: any) => {
    const args = (ctx?.args ?? '').trim();
    const userId = ctx?.senderId ?? ctx?.from ?? 'owner';
    const store = getPolicyStore();

    // No args: list all
    if (!args) {
      return listAll(userId);
    }

    // Parse subcommand
    const parts = args.split(/\s+/);
    const sub = parts[0]!.toLowerCase();
    const name = parts.slice(1).join(' ');

    switch (sub) {
      case 'enable':
        return setStatus(userId, name, 'active');
      case 'disable':
        return setStatus(userId, name, 'disabled');
      case 'delete':
        return deletePol(userId, name);
      default:
        // Treat as policy name lookup
        return viewPolicy(userId, args);
    }
  },
};

function listAll(userId: string) {
  const store = getPolicyStore();
  const policies = store.listPolicies(userId);

  if (policies.length === 0) {
    return {
      text: [
        '**No policies set.**',
        '',
        'To create a policy, just describe what you want in plain English:',
        '  "Don\'t let me spend more than $500 a day on DeFi"',
        '  "Block all interactions with SHIB"',
        '  "Require my confirmation for anything over $100"',
        '',
        'The agent will interpret your request, show you exactly what will be enforced, and ask for confirmation before activating.',
      ].join('\n'),
    };
  }

  const lines: string[] = [`**${policies.length} polic${policies.length === 1 ? 'y' : 'ies'}:**`, ''];

  for (const p of policies) {
    const display = buildPolicyDisplay(p, userId);
    lines.push(renderPolicyDisplay(display));
    if (p.delegation) {
      lines.push('');
      lines.push('**On-chain delegation:**');
      lines.push(formatDelegationStatus(p.delegation));
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('Commands: `/policies enable <name>`, `/policies disable <name>`, `/policies delete <name>`');

  return { text: lines.join('\n') };
}

function viewPolicy(userId: string, nameOrId: string) {
  const store = getPolicyStore();
  let policy = store.getPolicyByName(userId, nameOrId);
  if (!policy) policy = store.getPolicy(userId, nameOrId);
  if (!policy) {
    return { text: `Policy "${nameOrId}" not found. Use \`/policies\` to list all.` };
  }

  const display = buildPolicyDisplay(policy, userId);
  return { text: renderPolicyDisplay(display) };
}

function setStatus(userId: string, name: string, status: 'active' | 'disabled') {
  if (!name) return { text: `Usage: \`/policies ${status === 'active' ? 'enable' : 'disable'} <name>\`` };

  const store = getPolicyStore();
  let policy = store.getPolicyByName(userId, name);
  if (!policy) policy = store.getPolicy(userId, name);
  if (!policy) return { text: `Policy "${name}" not found.` };

  // Prevent enabling a policy that was never confirmed through the propose→confirm flow
  if (status === 'active' && !policy.confirmedAt) {
    return {
      text: `Policy **${policy.name}** has never been confirmed. Describe the policy in plain English and the agent will walk you through the confirmation flow.`,
    };
  }

  policy.status = status;
  policy.updatedAt = Date.now();
  store.savePolicy(policy);

  const label = status === 'active' ? 'enabled (active)' : 'disabled';
  return { text: `Policy **${policy.name}** is now ${label}.` };
}

function deletePol(userId: string, name: string) {
  if (!name) return { text: 'Usage: `/policies delete <name>`' };

  const store = getPolicyStore();
  let policy = store.getPolicyByName(userId, name);
  if (!policy) policy = store.getPolicy(userId, name);
  if (!policy) return { text: `Policy "${name}" not found.` };

  store.deletePolicy(userId, policy.id);
  return { text: `Policy **${policy.name}** has been deleted.` };
}
