/**
 * Tools commands — list, inspect, enable, disable, and delete user-defined tools.
 *
 * /tools            — List all user-defined tools (default action)
 * /tools list       — Same as above
 * /tools info <name> — Show details for a specific user tool
 * /tools enable <name>  — Enable a disabled user tool
 * /tools disable <name> — Disable a user tool (keeps definition, stops execution)
 * /tools delete <name>  — Delete a user tool permanently
 *
 * Tool creation is done via the LLM (natural language) — the agent calls
 * UserToolService.create() based on user intent. This command is for
 * management only.
 */

import { getUserToolService, type UserTool } from '../services/user-tool-service.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function formatToolSummary(tool: UserTool): string {
  const status = tool.enabled ? 'enabled' : 'disabled';
  const type = tool.definition.type;
  const uses = tool.usageCount;
  const budget = tool.maxBudgetUsd;
  const tags = tool.tags.length > 0 ? ` [${tool.tags.join(', ')}]` : '';
  return `  **${tool.name}** (${type}, ${status}) — ${tool.description.slice(0, 60)}${tool.description.length > 60 ? '...' : ''}\n    Uses: ${uses} | Budget: $${budget}/exec${tags}`;
}

function formatToolDetail(tool: UserTool): string {
  const lines: string[] = [];
  lines.push(`**${tool.label}** (\`${tool.name}\`)`);
  lines.push(`  Type: ${tool.definition.type}`);
  lines.push(`  Status: ${tool.enabled ? 'enabled' : 'disabled'}`);
  lines.push(`  Description: ${tool.description}`);
  lines.push(`  Created by: ${tool.createdBy}`);
  lines.push(`  Uses: ${tool.usageCount} | Budget: $${tool.maxBudgetUsd}/exec`);
  lines.push(`  Write tool: ${tool.isWrite ? 'yes' : 'no'}`);
  if (tool.tags.length > 0) lines.push(`  Tags: ${tool.tags.join(', ')}`);

  // Parameters
  if (tool.params.length > 0) {
    lines.push(`  Parameters:`);
    for (const p of tool.params) {
      const req = p.required ? 'required' : 'optional';
      const def = p.default !== undefined ? ` (default: ${p.default})` : '';
      lines.push(`    - ${p.name} (${p.type}, ${req})${def}: ${p.description}`);
    }
  } else {
    lines.push(`  Parameters: none`);
  }

  // Definition details
  switch (tool.definition.type) {
    case 'api_connector':
      lines.push(`  Endpoint: ${tool.definition.method} ${tool.definition.baseUrl}${tool.definition.path}`);
      if (tool.definition.resultPath) lines.push(`  Result path: ${tool.definition.resultPath}`);
      break;
    case 'composed':
      lines.push(`  Steps (${tool.definition.steps.length}):`);
      for (let i = 0; i < tool.definition.steps.length; i++) {
        const s = tool.definition.steps[i]!;
        lines.push(`    ${i + 1}. ${s.label} → ${s.tool}`);
      }
      break;
    case 'custom':
      lines.push(`  Behavior: ${tool.definition.behavior.slice(0, 120)}${tool.definition.behavior.length > 120 ? '...' : ''}`);
      lines.push(`  Allowed tools: ${tool.definition.allowedTools.join(', ')}`);
      lines.push(`  Max calls: ${tool.definition.maxCalls ?? 5}`);
      break;
  }

  const created = new Date(tool.createdAt).toLocaleDateString();
  const updated = new Date(tool.updatedAt).toLocaleDateString();
  lines.push(`  Created: ${created} | Updated: ${updated}`);

  return lines.join('\n');
}

// ─── Commands ───────────────────────────────────────────────────────────

export const toolsCommand = {
  name: 'tools',
  description: 'Manage user-defined tools: list, info, enable, disable, delete',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx?: any) => {
    const rawArgs = (ctx?.args ?? '').trim();
    const parts = rawArgs.split(/\s+/);
    const subcommand = parts[0] || 'list';
    const arg = parts.slice(1).join(' ');

    const service = getUserToolService();

    switch (subcommand) {
      case 'list': {
        const tools = service.list();
        if (tools.length === 0) {
          return {
            text: '**User Tools:** None defined yet.\n\n' +
              'Ask the agent to create a tool for you in natural language, e.g.:\n' +
              '  "Create a tool that checks the ETH price on CoinGecko"\n' +
              '  "Make a composed tool that swaps ETH→USDC then checks my balance"',
          };
        }

        const enabled = tools.filter(t => t.enabled);
        const disabled = tools.filter(t => !t.enabled);

        const sections: string[] = [];
        sections.push(`**User Tools** (${tools.length} total, ${enabled.length} enabled)`);

        if (enabled.length > 0) {
          sections.push(`\n**Enabled:**\n${enabled.map(formatToolSummary).join('\n')}`);
        }
        if (disabled.length > 0) {
          sections.push(`\n**Disabled:**\n${disabled.map(formatToolSummary).join('\n')}`);
        }

        sections.push('\nUse `/tools info <name>` for details, `/tools enable|disable|delete <name>` to manage.');

        return { text: sections.join('\n') };
      }

      case 'info': {
        if (!arg) return { text: 'Usage: `/tools info <tool_name>`' };
        const tool = service.getByName(arg);
        if (!tool) return { text: `No user tool named "${arg}" found.` };
        return { text: formatToolDetail(tool) };
      }

      case 'enable': {
        if (!arg) return { text: 'Usage: `/tools enable <tool_name>`' };
        const tool = service.getByName(arg);
        if (!tool) return { text: `No user tool named "${arg}" found.` };
        if (tool.enabled) return { text: `Tool "${arg}" is already enabled.` };
        service.update(tool.id, { enabled: true });
        return { text: `Tool "${arg}" has been enabled. It will be available for the agent to use.` };
      }

      case 'disable': {
        if (!arg) return { text: 'Usage: `/tools disable <tool_name>`' };
        const tool = service.getByName(arg);
        if (!tool) return { text: `No user tool named "${arg}" found.` };
        if (!tool.enabled) return { text: `Tool "${arg}" is already disabled.` };
        service.update(tool.id, { enabled: false });
        return { text: `Tool "${arg}" has been disabled. It won't be available until re-enabled.` };
      }

      case 'delete': {
        if (!arg) return { text: 'Usage: `/tools delete <tool_name>`' };
        const tool = service.getByName(arg);
        if (!tool) return { text: `No user tool named "${arg}" found.` };
        service.delete(tool.id);
        return { text: `Tool "${arg}" has been permanently deleted.` };
      }

      default:
        return {
          text: `Unknown subcommand: "${subcommand}".\n\n` +
            'Available: `list`, `info <name>`, `enable <name>`, `disable <name>`, `delete <name>`',
        };
    }
  },
};
