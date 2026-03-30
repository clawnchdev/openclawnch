/**
 * Agents command — manage sub-agent definitions.
 *
 * /agents            — List all sub-agents
 * /agents info <name> — Show details for a sub-agent
 * /agents enable <name>  — Enable a sub-agent
 * /agents disable <name> — Disable a sub-agent
 * /agents delete <name>  — Delete a custom sub-agent (presets cannot be deleted)
 */

import { getAgentPool, type SubAgentDef } from '../services/agent-pool.js';
import { detectProvider, getApiKey } from '../services/agent-orchestrator.js';

function formatAgentSummary(agent: SubAgentDef): string {
  const status = agent.enabled ? 'enabled' : 'disabled';
  const tag = agent.isPreset ? ' (preset)' : '';
  return `  **${agent.name}**${tag} (${status}) — ${agent.description.slice(0, 60)}${agent.description.length > 60 ? '...' : ''}\n    Model: ${agent.model} | Tools: ${agent.allowedTools.length} | Uses: ${agent.usageCount}`;
}

function formatAgentDetail(agent: SubAgentDef): string {
  const lines: string[] = [];
  lines.push(`**${agent.label}** (\`${agent.name}\`)${agent.isPreset ? ' — preset' : ''}`);
  lines.push(`  Status: ${agent.enabled ? 'enabled' : 'disabled'}`);
  lines.push(`  Description: ${agent.description}`);
  lines.push(`  Model: ${agent.model}`);
  lines.push(`  Max tokens: ${agent.maxTokens} | Temperature: ${agent.temperature}`);
  lines.push(`  Max tool calls: ${agent.maxToolCalls} | Timeout: ${agent.timeoutMs / 1000}s`);
  lines.push(`  Uses: ${agent.usageCount}`);
  if (agent.allowedTools.length > 0) {
    lines.push(`  Allowed tools: ${agent.allowedTools.join(', ')}`);
  } else {
    lines.push(`  Allowed tools: none (reasoning only)`);
  }
  lines.push(`  System prompt (first 200 chars):\n    ${agent.systemPrompt.slice(0, 200).replace(/\n/g, '\n    ')}${agent.systemPrompt.length > 200 ? '...' : ''}`);
  lines.push(`  Created by: ${agent.createdBy}`);
  return lines.join('\n');
}

export const agentsCommand = {
  name: 'agents',
  description: 'Manage sub-agents: list, info, enable, disable, delete',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx?: any) => {
    const rawArgs = (ctx?.args ?? '').trim();
    const parts = rawArgs.split(/\s+/);
    const subcommand = parts[0] || 'list';
    const arg = parts.slice(1).join(' ');

    const pool = getAgentPool();

    switch (subcommand) {
      case 'list': {
        const agents = pool.list();
        const provider = detectProvider();
        const hasKey = !!getApiKey(provider);

        const sections: string[] = [];
        sections.push(`**Sub-Agents** (${agents.length} total, provider: ${provider}, key: ${hasKey ? 'configured' : 'missing'})`);

        const presets = agents.filter(a => a.isPreset);
        const custom = agents.filter(a => !a.isPreset);

        if (presets.length > 0) {
          sections.push(`\n**Presets:**\n${presets.map(formatAgentSummary).join('\n')}`);
        }
        if (custom.length > 0) {
          sections.push(`\n**Custom:**\n${custom.map(formatAgentSummary).join('\n')}`);
        }

        if (!hasKey) {
          sections.push(`\n**Note:** No API key for "${provider}". Set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, or BANKR_LLM_KEY to enable sub-agents.`);
        }

        sections.push('\nUse `/agents info <name>` for details. Delegate tasks via the `agent_delegate` tool.');
        return { text: sections.join('\n') };
      }

      case 'info': {
        if (!arg) return { text: 'Usage: `/agents info <agent_name>`' };
        const agent = pool.getByName(arg);
        if (!agent) return { text: `No sub-agent named "${arg}" found.` };
        return { text: formatAgentDetail(agent) };
      }

      case 'enable': {
        if (!arg) return { text: 'Usage: `/agents enable <agent_name>`' };
        const agent = pool.getByName(arg);
        if (!agent) return { text: `No sub-agent named "${arg}" found.` };
        if (agent.enabled) return { text: `Agent "${arg}" is already enabled.` };
        pool.update(agent.id, { enabled: true });
        return { text: `Agent "${arg}" has been enabled.` };
      }

      case 'disable': {
        if (!arg) return { text: 'Usage: `/agents disable <agent_name>`' };
        const agent = pool.getByName(arg);
        if (!agent) return { text: `No sub-agent named "${arg}" found.` };
        if (!agent.enabled) return { text: `Agent "${arg}" is already disabled.` };
        pool.update(agent.id, { enabled: false });
        return { text: `Agent "${arg}" has been disabled.` };
      }

      case 'delete': {
        if (!arg) return { text: 'Usage: `/agents delete <agent_name>`' };
        const agent = pool.getByName(arg);
        if (!agent) return { text: `No sub-agent named "${arg}" found.` };
        if (agent.isPreset) return { text: `Cannot delete preset agent "${arg}". Use \`/agents disable ${arg}\` instead.` };
        pool.delete(agent.id);
        return { text: `Agent "${arg}" has been permanently deleted.` };
      }

      default:
        return {
          text: `Unknown subcommand: "${subcommand}".\n\nAvailable: \`list\`, \`info <name>\`, \`enable <name>\`, \`disable <name>\`, \`delete <name>\``,
        };
    }
  },
};
