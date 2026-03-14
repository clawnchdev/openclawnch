/**
 * Agent Delegate Tool — delegates tasks to specialized sub-agents.
 *
 * The main LLM calls this tool to spin up a sub-agent with a custom system
 * prompt, restricted tool access, and a focused task description. The
 * sub-agent runs its own LLM loop (possibly with tool calls), then returns
 * a structured result to the main agent.
 *
 * Actions:
 *   delegate  — Run a task with a named sub-agent
 *   list      — List available sub-agents and their specialties
 *   status    — Check if an API key is configured for sub-agent execution
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { getAgentPool } from '../services/agent-pool.js';
import { executeSubAgent, detectProvider, getApiKey } from '../services/agent-orchestrator.js';
import { isDelegationMode } from '../services/policy-types.js';
import type { ToolDispatcher } from '../services/sandbox-runtime.js';

const ACTIONS = ['delegate', 'list', 'status'] as const;

const AgentDelegateSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'delegate: run a task with a sub-agent. ' +
      'list: show available sub-agents. ' +
      'status: check sub-agent readiness.',
  }),
  agent: Type.Optional(Type.String({
    description: 'Sub-agent name (e.g. "strategist", "analyst", "accountant", "risk_manager") for delegate action.',
  })),
  task: Type.Optional(Type.String({
    description: 'The task description to delegate to the sub-agent. Be specific about what you want analyzed or done.',
  })),
});

/**
 * Factory: creates the agent_delegate tool.
 *
 * Requires a dispatcher (for sub-agents to call tools) and a function
 * to get the list of registered tools (for building sub-agent tool schemas).
 */
export function createAgentDelegateTool(
  getDispatcher: () => ToolDispatcher,
  getRegisteredTools: () => Array<{ name: string; description: string; parameters: any }>,
) {
  return {
    name: 'agent_delegate',
    label: 'Agent Delegate',
    ownerOnly: false,
    description:
      'Delegate tasks to specialized sub-agents (strategist, analyst, accountant, risk_manager). ' +
      'Sub-agents run their own LLM with focused expertise and restricted tool access. ' +
      'Use "list" to see available agents, "delegate" to run a task.',
    parameters: AgentDelegateSchema,

    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'delegate':
          return handleDelegate(params, getDispatcher, getRegisteredTools);
        case 'list':
          return handleList();
        case 'status':
          return handleStatus();
        default:
          return errorResult(`Unknown action: ${action}. Use: ${ACTIONS.join(', ')}`);
      }
    },
  };
}

// ─── Action Handlers ────────────────────────────────────────────────────

async function handleDelegate(
  params: Record<string, unknown>,
  getDispatcher: () => ToolDispatcher,
  getRegisteredTools: () => Array<{ name: string; description: string; parameters: any }>,
) {
  const agentName = readStringParam(params, 'agent');
  const task = readStringParam(params, 'task');

  if (!agentName) return errorResult('Missing required parameter: agent (name of the sub-agent).');
  if (!task) return errorResult('Missing required parameter: task (description of what to do).');

  const pool = getAgentPool();
  const agent = pool.getByName(agentName);

  if (!agent) {
    const available = pool.getEnabledAgents().map(a => a.name).join(', ');
    return errorResult(`No sub-agent named "${agentName}". Available: ${available}`);
  }

  if (!agent.enabled) {
    return errorResult(`Sub-agent "${agentName}" is disabled. Use /agents enable ${agentName} to re-enable.`);
  }

  // Check API key availability
  const provider = detectProvider();
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    return errorResult(
      `No LLM API key available for provider "${provider}". ` +
      `Set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, or BANKR_LLM_KEY.`
    );
  }

  // Assign ephemeral wallet for sub-delegation (if in delegation mode)
  let subDelegationInfo: Record<string, unknown> | undefined;
  if (isDelegationMode()) {
    try {
      const wallet = await pool.assignEphemeralWallet(agent.id);
      if (wallet) {
        // Attempt to create sub-delegation from any active parent delegation
        const { getDelegatedPolicies, createSubDelegation } = await import('../services/delegation-service.js');
        const { getDelegationStore } = await import('../services/delegation-store.js');

        const delegatedPolicies = getDelegatedPolicies('owner');
        const delegationStore = getDelegationStore();

        for (const policy of delegatedPolicies) {
          if (!policy.delegation) continue;
          if (policy.delegation.status !== 'signed' && policy.delegation.status !== 'active') continue;

          const stored = delegationStore.load(policy.id);
          if (!stored) continue;

          const parentHash = policy.delegation.hash;
          if (!parentHash || parentHash === '0x') continue;

          const subResult = await createSubDelegation({
            parentDelegation: stored.delegation,
            parentHash: parentHash as `0x${string}`,
            chainId: stored.chainId,
            subAgentAddress: wallet.address,
            subAgentPrivateKey: wallet.privateKey,
          });

          if ('error' in subResult) {
            // Sub-delegation failed — continue without it
            subDelegationInfo = { error: subResult.error };
          } else {
            subDelegationInfo = {
              subAgentAddress: wallet.address,
              parentPolicy: policy.name,
              chainId: stored.chainId,
              caveatCount: subResult.delegation.caveats.length,
            };
            agent.parentDelegationHash = parentHash as `0x${string}`;
          }
          break; // Use the first matching delegation
        }
      }
    } catch {
      // Sub-delegation is best-effort — don't block execution
    }
  }

  // Execute
  const result = await executeSubAgent(
    agent,
    task,
    getDispatcher(),
    getRegisteredTools(),
  );

  // Record usage
  pool.recordUsage(agent.id);

  return jsonResult({
    agent: agent.name,
    model: agent.model,
    status: result.status,
    response: result.response,
    toolCallCount: result.toolCalls.length,
    toolCalls: result.toolCalls.map(tc => ({
      tool: tc.tool,
      durationMs: tc.durationMs,
      resultPreview: tc.result.slice(0, 100),
    })),
    tokensUsed: result.tokensUsed,
    durationMs: result.durationMs,
    ...(result.error ? { error: result.error } : {}),
    ...(subDelegationInfo ? { subDelegation: subDelegationInfo } : {}),
  });
}

async function handleList() {
  const pool = getAgentPool();
  const agents = pool.list();

  if (agents.length === 0) {
    return jsonResult({ agents: [], message: 'No sub-agents defined.' });
  }

  return jsonResult({
    agents: agents.map(a => ({
      name: a.name,
      label: a.label,
      description: a.description,
      model: a.model,
      enabled: a.enabled,
      isPreset: a.isPreset,
      allowedTools: a.allowedTools,
      usageCount: a.usageCount,
    })),
  });
}

async function handleStatus() {
  const provider = detectProvider();
  const hasKey = !!getApiKey(provider);
  const pool = getAgentPool();
  const enabled = pool.getEnabledAgents();

  return jsonResult({
    ready: hasKey,
    provider,
    hasApiKey: hasKey,
    enabledAgents: enabled.length,
    agents: enabled.map(a => a.name),
    message: hasKey
      ? `Sub-agent system ready. Provider: ${provider}. ${enabled.length} agent(s) available.`
      : `No API key for "${provider}". Set an LLM API key to enable sub-agents.`,
  });
}
