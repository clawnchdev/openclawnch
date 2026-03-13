/**
 * policy_manage — LLM-facing tool for creating and managing spending policies.
 *
 * Creation flow (multi-turn with explicit confirmation):
 * 1. User says something like "don't spend more than $500/day on swaps"
 * 2. LLM calls `propose` with structured interpretation
 * 3. Tool saves as DRAFT and returns the exact rules for user to verify
 * 4. User says "yes" / adjusts → LLM calls `confirm` to activate
 *
 * The LLM MUST NOT call `confirm` without the user explicitly approving.
 * If the user's intent is ambiguous, the LLM should ask follow-up questions
 * BEFORE calling `propose`.
 */

import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import { stringEnum, jsonResult, errorResult } from '../lib/tool-helpers.js';
import { getPolicyStore } from '../services/policy-store.js';
import {
  evaluatePolicies,
  buildPolicyDisplay,
  renderPolicyDisplay,
} from '../services/policy-evaluator.js';
import {
  type Policy,
  type PolicyRule,
  type PolicyScope,
  type ActionContext,
  describeRule,
  describeScope,
  TOOL_CATEGORIES,
  CATEGORY_LABELS,
} from '../services/policy-types.js';

// ─── Schema ─────────────────────────────────────────────────────────────

const ACTIONS = [
  'propose',       // create a draft policy from structured rules (needs user confirm)
  'confirm',       // activate a draft after user approval
  'revise',        // update a draft's rules before confirming
  'list',          // list all policies
  'get',           // get details of one policy
  'disable',       // pause enforcement
  'enable',        // resume enforcement
  'delete',        // remove a policy
  'evaluate',      // dry-run: check if an action would be allowed
  'usage',         // show usage stats for a policy
  'categories',    // list available tool categories
] as const;

const RULE_TYPES = [
  'spending_limit', 'rate_limit', 'allowlist', 'blocklist',
  'time_window', 'approval_threshold', 'max_amount',
] as const;

const PERIODS = ['hourly', 'daily', 'weekly', 'monthly'] as const;
const FIELDS = ['tokens', 'chains', 'addresses', 'contracts'] as const;
const SCOPE_TYPES = ['all_write', 'tools', 'categories'] as const;

const PolicyManageSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'Action to perform. IMPORTANT: "propose" creates a DRAFT — you MUST show the user the exact rules and get explicit approval before calling "confirm".',
  }),
  // For propose / revise
  name: Type.Optional(Type.String({
    description: 'Short policy name (e.g., "daily DeFi limit")',
  })),
  description: Type.Optional(Type.String({
    description: 'The user\'s EXACT original words that define this policy. Do not paraphrase.',
  })),
  rules: Type.Optional(Type.Array(Type.Object({
    type: stringEnum(RULE_TYPES, { description: 'Rule type' }),
    maxAmountUsd: Type.Optional(Type.Number({ description: 'USD limit (spending_limit, max_amount)' })),
    period: Type.Optional(stringEnum(PERIODS, { description: 'Period (spending_limit)' })),
    maxCalls: Type.Optional(Type.Number({ description: 'Max calls (rate_limit)' })),
    periodMs: Type.Optional(Type.Number({ description: 'Window in ms (rate_limit)' })),
    field: Type.Optional(stringEnum(FIELDS, { description: 'Field (allowlist, blocklist)' })),
    values: Type.Optional(Type.Array(Type.String(), { description: 'Values (allowlist, blocklist)' })),
    allowedHours: Type.Optional(Type.Object({
      start: Type.Number({ description: 'Start hour 0-23' }),
      end: Type.Number({ description: 'End hour 0-23' }),
    })),
    allowedDays: Type.Optional(Type.Array(Type.Number(), { description: 'Days 0=Sun..6=Sat' })),
    timezone: Type.Optional(Type.String({ description: 'IANA timezone' })),
    amountUsd: Type.Optional(Type.Number({ description: 'USD threshold (approval_threshold)' })),
  }), { description: 'Policy rules. Each is independently evaluated.' })),
  scope: Type.Optional(Type.Object({
    type: stringEnum(SCOPE_TYPES, { description: 'Scope type' }),
    tools: Type.Optional(Type.Array(Type.String(), { description: 'Tool names (scope=tools)' })),
    categories: Type.Optional(Type.Array(Type.String(), { description: 'Category names (scope=categories)' })),
  })),
  // For confirm, revise, get, disable, enable, delete, usage
  policyId: Type.Optional(Type.String({ description: 'Policy ID' })),
  // For evaluate (dry-run)
  toolName: Type.Optional(Type.String({ description: 'Tool to check (evaluate)' })),
  amountUsd: Type.Optional(Type.Number({ description: 'USD amount to check (evaluate)' })),
  token: Type.Optional(Type.String({ description: 'Token to check (evaluate)' })),
});

// ─── Tool ───────────────────────────────────────────────────────────────

export function createPolicyManageTool() {
  return {
    name: 'policy_manage',
    label: 'Policy Manager',
    ownerOnly: true,
    description: [
      'Create and manage spending policies that limit what the agent can do autonomously.',
      '',
      'CRITICAL WORKFLOW for creating policies:',
      '1. If the user\'s request is ambiguous, ASK CLARIFYING QUESTIONS first.',
      '2. Call "propose" with your structured interpretation — this creates a DRAFT.',
      '3. Show the user EXACTLY what will be enforced (the tool returns this).',
      '4. WAIT for the user to explicitly approve.',
      '5. Only then call "confirm" to activate.',
      '',
      'NEVER skip step 3-4. NEVER call "confirm" without user approval.',
      'NEVER guess what the user means — ask if unclear.',
      '',
      'Actions: propose, confirm, revise, list, get, disable, enable, delete, evaluate, usage, categories',
    ].join('\n'),
    parameters: PolicyManageSchema,

    execute: async (_toolCallId: string, args: unknown, ctx?: any) => {
      const params = args as Record<string, unknown>;
      const action = params.action as string;
      const userId = ctx?.senderId ?? ctx?.from ?? 'owner';

      switch (action) {
        case 'propose':   return handlePropose(params, userId);
        case 'confirm':   return handleConfirm(params, userId);
        case 'revise':    return handleRevise(params, userId);
        case 'list':      return handleList(userId);
        case 'get':       return handleGet(params, userId);
        case 'disable':   return handleDisable(params, userId);
        case 'enable':    return handleEnable(params, userId);
        case 'delete':    return handleDelete(params, userId);
        case 'evaluate':  return handleEvaluate(params, userId);
        case 'usage':     return handleUsage(params, userId);
        case 'categories': return handleCategories();
        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}

// ─── Handlers ───────────────────────────────────────────────────────────

function handlePropose(params: Record<string, unknown>, userId: string) {
  const name = params.name as string | undefined;
  const description = params.description as string | undefined;
  const rawRules = params.rules as any[] | undefined;
  const rawScope = params.scope as any | undefined;

  if (!name) return errorResult('Policy name is required.');
  if (!description) return errorResult('Description is required — use the user\'s exact words.');
  if (!rawRules || rawRules.length === 0) return errorResult('At least one rule is required.');
  if (!rawScope) return errorResult('Scope is required (all_write, tools, or categories).');

  // Check for duplicate name
  const store = getPolicyStore();
  const existing = store.getPolicyByName(userId, name);
  if (existing) return errorResult(`A policy named "${name}" already exists (id: ${existing.id}).`);

  const rules = rawRules.map(parseRule);
  const scope = parseScope(rawScope);

  const policy: Policy = {
    id: randomUUID(),
    name,
    description,
    rules,
    scope,
    status: 'draft',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    userId,
  };

  store.savePolicy(policy);

  // Render for user verification
  const display = buildPolicyDisplay(policy, userId);
  const rendered = renderPolicyDisplay(display);

  return jsonResult({
    status: 'draft_created',
    policyId: policy.id,
    message: [
      'DRAFT policy created. Show the user this exact interpretation and ask them to confirm:',
      '',
      rendered,
      '',
      'Ask the user: "Does this match what you want? Say yes to activate, or tell me what to change."',
      'Call "confirm" ONLY after the user explicitly approves.',
    ].join('\n'),
  });
}

function handleConfirm(params: Record<string, unknown>, userId: string) {
  const policyId = params.policyId as string | undefined;
  if (!policyId) return errorResult('policyId is required.');

  const store = getPolicyStore();
  const policy = store.getPolicy(userId, policyId);
  if (!policy) return errorResult(`Policy ${policyId} not found.`);
  if (policy.status === 'active') return errorResult('Policy is already active.');

  policy.status = 'active';
  policy.updatedAt = Date.now();
  store.savePolicy(policy);

  const display = buildPolicyDisplay(policy, userId);
  const rendered = renderPolicyDisplay(display);

  return jsonResult({
    status: 'activated',
    policyId: policy.id,
    message: `Policy "${policy.name}" is now ACTIVE.\n\n${rendered}`,
  });
}

function handleRevise(params: Record<string, unknown>, userId: string) {
  const policyId = params.policyId as string | undefined;
  if (!policyId) return errorResult('policyId is required.');

  const store = getPolicyStore();
  const policy = store.getPolicy(userId, policyId);
  if (!policy) return errorResult(`Policy ${policyId} not found.`);
  if (policy.status === 'active') {
    return errorResult('Cannot revise an active policy. Disable it first, or delete and re-propose.');
  }

  // Update fields that are provided
  if (params.name) policy.name = params.name as string;
  if (params.description) policy.description = params.description as string;
  if (params.rules && Array.isArray(params.rules) && (params.rules as any[]).length > 0) {
    policy.rules = (params.rules as any[]).map(parseRule);
  }
  if (params.scope) policy.scope = parseScope(params.scope);

  policy.updatedAt = Date.now();
  store.savePolicy(policy);

  const display = buildPolicyDisplay(policy, userId);
  const rendered = renderPolicyDisplay(display);

  return jsonResult({
    status: 'draft_revised',
    policyId: policy.id,
    message: [
      'Draft revised. Show the user this updated interpretation:',
      '',
      rendered,
      '',
      'Ask: "Does this look right now?"',
    ].join('\n'),
  });
}

function handleList(userId: string) {
  const store = getPolicyStore();
  const policies = store.listPolicies(userId);

  if (policies.length === 0) {
    return jsonResult({
      policies: [],
      message: 'No policies set. The user can say something like "don\'t let me spend more than $500 a day" to create one.',
    });
  }

  const summaries = policies.map(p => {
    const display = buildPolicyDisplay(p, userId);
    return renderPolicyDisplay(display);
  });

  return jsonResult({
    count: policies.length,
    policies: policies.map(p => ({
      id: p.id,
      name: p.name,
      status: p.status,
      ruleCount: p.rules.length,
    })),
    rendered: summaries.join('\n\n---\n\n'),
  });
}

function handleGet(params: Record<string, unknown>, userId: string) {
  const policyId = params.policyId as string | undefined;
  if (!policyId) return errorResult('policyId is required.');

  const store = getPolicyStore();
  const policy = store.getPolicy(userId, policyId);
  if (!policy) return errorResult(`Policy ${policyId} not found.`);

  const display = buildPolicyDisplay(policy, userId);
  return jsonResult({
    policy: {
      id: policy.id,
      name: policy.name,
      status: policy.status,
      description: policy.description,
      rules: policy.rules,
      scope: policy.scope,
      createdAt: new Date(policy.createdAt).toISOString(),
      updatedAt: new Date(policy.updatedAt).toISOString(),
    },
    rendered: renderPolicyDisplay(display),
  });
}

function handleDisable(params: Record<string, unknown>, userId: string) {
  const policyId = params.policyId as string | undefined;
  if (!policyId) return errorResult('policyId is required.');

  const store = getPolicyStore();
  const policy = store.getPolicy(userId, policyId);
  if (!policy) return errorResult(`Policy ${policyId} not found.`);

  policy.status = 'disabled';
  policy.updatedAt = Date.now();
  store.savePolicy(policy);

  return jsonResult({
    status: 'disabled',
    message: `Policy "${policy.name}" is now disabled. It will not be enforced until re-enabled.`,
  });
}

function handleEnable(params: Record<string, unknown>, userId: string) {
  const policyId = params.policyId as string | undefined;
  if (!policyId) return errorResult('policyId is required.');

  const store = getPolicyStore();
  const policy = store.getPolicy(userId, policyId);
  if (!policy) return errorResult(`Policy ${policyId} not found.`);

  policy.status = 'active';
  policy.updatedAt = Date.now();
  store.savePolicy(policy);

  return jsonResult({
    status: 'active',
    message: `Policy "${policy.name}" is now active and being enforced.`,
  });
}

function handleDelete(params: Record<string, unknown>, userId: string) {
  const policyId = params.policyId as string | undefined;
  if (!policyId) return errorResult('policyId is required.');

  const store = getPolicyStore();
  const policy = store.getPolicy(userId, policyId);
  if (!policy) return errorResult(`Policy ${policyId} not found.`);

  store.deletePolicy(userId, policyId);

  return jsonResult({
    status: 'deleted',
    message: `Policy "${policy.name}" has been deleted.`,
  });
}

function handleEvaluate(params: Record<string, unknown>, userId: string) {
  const toolName = params.toolName as string | undefined;
  if (!toolName) return errorResult('toolName is required for evaluate.');

  const actionCtx: ActionContext = {
    toolName,
    userId,
    amountUsd: params.amountUsd as number | undefined,
    token: params.token as string | undefined,
  };

  const decision = evaluatePolicies(actionCtx);

  return jsonResult({
    decision: decision.action,
    reason: decision.reason ?? 'No policy violations.',
    policyName: decision.policyName,
    ruleSummary: decision.ruleSummary,
  });
}

function handleUsage(params: Record<string, unknown>, userId: string) {
  const policyId = params.policyId as string | undefined;
  if (!policyId) return errorResult('policyId is required.');

  const store = getPolicyStore();
  const policy = store.getPolicy(userId, policyId);
  if (!policy) return errorResult(`Policy ${policyId} not found.`);

  const usage = store.getUsage(userId, policyId);
  const display = buildPolicyDisplay(policy, userId);

  return jsonResult({
    policyName: policy.name,
    usageSummary: display.usageSummary ?? 'No usage tracked (no spending/rate limits).',
    recentEntries: (usage?.entries ?? []).slice(-20).map(e => ({
      time: new Date(e.timestamp).toISOString(),
      tool: e.toolName,
      action: e.action,
      amountUsd: e.amountUsd,
    })),
  });
}

function handleCategories() {
  const cats = Object.entries(CATEGORY_LABELS).map(([key, label]) => ({
    key,
    label,
    tools: TOOL_CATEGORIES[key] ?? [],
  }));

  return jsonResult({
    categories: cats,
    message: 'Available tool categories for policy scopes. Use category keys in scope.categories.',
  });
}

// ─── Parsing Helpers ────────────────────────────────────────────────────

function parseRule(raw: any): PolicyRule {
  const type = raw.type as string;
  switch (type) {
    case 'spending_limit':
      return {
        type: 'spending_limit',
        maxAmountUsd: raw.maxAmountUsd ?? 0,
        period: raw.period ?? 'daily',
      };
    case 'rate_limit':
      return {
        type: 'rate_limit',
        maxCalls: raw.maxCalls ?? 10,
        periodMs: raw.periodMs ?? 86_400_000,
      };
    case 'allowlist':
      return {
        type: 'allowlist',
        field: raw.field ?? 'tokens',
        values: (raw.values ?? []).map((v: string) => v.toLowerCase()),
      };
    case 'blocklist':
      return {
        type: 'blocklist',
        field: raw.field ?? 'tokens',
        values: (raw.values ?? []).map((v: string) => v.toLowerCase()),
      };
    case 'time_window':
      return {
        type: 'time_window',
        allowedHours: raw.allowedHours,
        allowedDays: raw.allowedDays,
        timezone: raw.timezone,
      };
    case 'approval_threshold':
      return {
        type: 'approval_threshold',
        amountUsd: raw.amountUsd ?? 0,
      };
    case 'max_amount':
      return {
        type: 'max_amount',
        maxAmountUsd: raw.maxAmountUsd ?? 0,
      };
    default:
      // Graceful fallback — treat unknown as max_amount 0 (blocks everything)
      return { type: 'max_amount', maxAmountUsd: 0 };
  }
}

function parseScope(raw: any): PolicyScope {
  return {
    type: raw.type ?? 'all_write',
    tools: raw.tools,
    categories: raw.categories,
  };
}
