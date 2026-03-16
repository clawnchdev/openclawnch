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
import { getPolicyMode, isDelegationMode, describeRule } from '../services/policy-types.js';
import type { Policy } from '../services/policy-types.js';
import { buildPolicyDisplay, renderPolicyDisplay } from '../services/policy-evaluator.js';
import { formatDelegationStatus, canRedeem } from '../services/delegation-service.js';
import { CHAIN_NAMES } from '../services/delegation-types.js';

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
      case 'overview':
        return showOverview(userId);
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

  const mode = getPolicyMode();
  const modeLabel = mode === 'delegation' ? 'delegation (on-chain)' : 'simple (app-layer)';
  const lines: string[] = [
    `**${policies.length} polic${policies.length === 1 ? 'y' : 'ies'}** — mode: ${modeLabel}`,
    '',
  ];

  for (const p of policies) {
    const display = buildPolicyDisplay(p, userId);
    lines.push(renderPolicyDisplay(display));
    if (p.delegation && isDelegationMode()) {
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
  const lines: string[] = [renderPolicyDisplay(display)];

  // Include delegation info (same as list view)
  if (isDelegationMode() && policy.delegation) {
    lines.push('');
    lines.push('**On-chain delegation:**');
    lines.push(formatDelegationStatus(policy.delegation));

    // Show expiry if set
    if (policy.delegation.expiresAt) {
      const exp = new Date(policy.delegation.expiresAt);
      const remaining = exp.getTime() - Date.now();
      if (remaining > 0) {
        const hours = Math.floor(remaining / 3_600_000);
        const days = Math.floor(hours / 24);
        lines.push(`  Expires: ${exp.toISOString()} (${days > 0 ? `${days}d ` : ''}${hours % 24}h remaining)`);
      } else {
        lines.push('  Expires: **EXPIRED**');
      }
    }
  }

  return { text: lines.join('\n') };
}

// ─── Overview ───────────────────────────────────────────────────────────

function showOverview(userId: string) {
  const store = getPolicyStore();
  const policies = store.listPolicies(userId);
  const mode = getPolicyMode();
  const delegation = isDelegationMode();

  const lines: string[] = [];
  lines.push('**Policy Overview**');
  lines.push('');

  // Mode
  lines.push(`Mode: **${mode}** ${delegation ? '(on-chain enforcement)' : '(app-layer enforcement)'}`);

  // Counts
  const active = policies.filter(p => p.status === 'active');
  const withDelegation = active.filter(p => p.delegation?.status === 'signed' || p.delegation?.status === 'active');
  lines.push(`Policies: ${active.length} active of ${policies.length} total${delegation ? `, ${withDelegation.length} delegated on-chain` : ''}`);
  lines.push('');

  if (active.length === 0) {
    lines.push('No active policies. Describe a policy in plain English and the agent will create it.');
    return { text: lines.join('\n') };
  }

  // Per-policy summary (compact table-like format)
  for (const p of active) {
    const rules = p.rules.map(r => describeRule(r));
    const scopeLabel = p.scope.type === 'all_write' ? 'all write tools'
      : p.scope.type === 'tools' ? (p.scope as any).tools?.join(', ')
      : p.scope.type === 'categories' ? (p.scope as any).categories?.join(', ')
      : p.scope.type;

    lines.push(`**${p.name}**`);
    lines.push(`  Scope: ${scopeLabel}`);
    for (const r of rules) {
      lines.push(`  Rule: ${r}`);
    }

    // Budget usage
    const usage = store.getUsage?.(userId, p.id);
    if (usage) {
      for (const u of Array.isArray(usage) ? usage : []) {
        if (u.spentUsd !== undefined && u.limitUsd !== undefined) {
          const pct = Math.round((u.spentUsd / u.limitUsd) * 100);
          const remaining = Math.max(0, u.limitUsd - u.spentUsd);
          lines.push(`  Budget: $${u.spentUsd.toFixed(2)} / $${u.limitUsd} used (${pct}%, $${remaining.toFixed(2)} remaining)`);
        }
      }
    }

    // Delegation status (compact)
    if (delegation && p.delegation) {
      const d = p.delegation;
      const chain = CHAIN_NAMES[d.chainId] ?? d.chainId;
      const readiness = canRedeem(p.id);
      const statusTag = readiness.ready ? 'READY' : 'NOT READY';

      let expiryTag = '';
      if (d.expiresAt) {
        const remaining = new Date(d.expiresAt).getTime() - Date.now();
        if (remaining <= 0) expiryTag = ' | EXPIRED';
        else {
          const h = Math.floor(remaining / 3_600_000);
          expiryTag = h >= 24 ? ` | ${Math.floor(h / 24)}d remaining` : ` | ${h}h remaining`;
        }
      }

      lines.push(`  Delegation: [${d.status.toUpperCase()}] on ${chain} | ${statusTag}${expiryTag}`);
    } else if (delegation) {
      lines.push('  Delegation: none (use `/delegate create ${p.name}`)');
    }

    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('`/policies <name>` for details | `/delegate status` for on-chain state');

  return { text: lines.join('\n') };
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
