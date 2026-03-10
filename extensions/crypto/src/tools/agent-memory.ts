/**
 * Agent Memory Tool — LLM-facing interface to the agent memory service.
 *
 * Lets the agent persist and manage declarative memories (environment facts,
 * tool quirks, user preferences, lessons learned).
 *
 * Actions:
 *   add         — Save a new memory entry
 *   replace     — Update an existing entry (find by substring, replace)
 *   remove      — Remove an entry (find by substring)
 *   list        — Show all agent memories
 *   user_add    — Save a user profile entry
 *   user_list   — Show a user's profile entries
 *   user_remove — Remove a user profile entry
 *   stats       — Show memory usage stats
 *
 * Only write actions are gated by evolution mode.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, textResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { getAgentMemory } from '../services/agent-memory.js';

const ACTIONS = [
  'add', 'replace', 'remove', 'list',
  'user_add', 'user_list', 'user_remove',
  'stats',
] as const;

const AgentMemorySchema = Type.Object({
  action: stringEnum(ACTIONS, { description: 'Operation to perform' }),
  entry: Type.Optional(Type.String({
    description: 'Memory content to add or replace with (for add/replace/user_add).',
  })),
  search: Type.Optional(Type.String({
    description: 'Substring to search for (for replace/remove/user_remove). Matches are case-insensitive.',
  })),
  user_id: Type.Optional(Type.String({
    description: 'User ID for user_add/user_list/user_remove actions.',
  })),
});

export function createAgentMemoryTool() {
  return {
    name: 'agent_memory',
    label: 'Agent Memory',
    ownerOnly: false,
    description:
      'Persist and manage your declarative memory. ' +
      'WHEN TO SAVE (do this proactively, don\'t wait to be asked): ' +
      '(1) You discover something about the environment (chain IDs, gas patterns, tool quirks). ' +
      '(2) User shares a preference or corrects you. ' +
      '(3) You learn a workaround for a recurring issue. ' +
      '(4) You find a useful DeFi strategy or protocol detail. ' +
      'Actions: add, replace, remove, list, user_add, user_list, user_remove, stats. ' +
      'Only available in evolving mode (/evolve).',
    parameters: AgentMemorySchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      const memory = getAgentMemory();

      switch (action) {
        case 'add': {
          const entry = readStringParam(params, 'entry');
          if (!entry) return errorResult('entry is required for add action.');
          const result = memory.addAgentMemory(entry);
          if (!result.ok) return errorResult(result.error!);
          return jsonResult({ status: 'saved', message: 'Memory entry saved. It will appear in your context next session.' });
        }

        case 'replace': {
          const search = readStringParam(params, 'search');
          const entry = readStringParam(params, 'entry');
          if (!search) return errorResult('search is required (substring to find in existing entry).');
          if (!entry) return errorResult('entry is required (new content to replace with).');
          const result = memory.replaceAgentMemory(search, entry);
          if (!result.ok) return errorResult(result.error!);
          return jsonResult({ status: 'replaced', message: 'Memory entry updated.' });
        }

        case 'remove': {
          const search = readStringParam(params, 'search');
          if (!search) return errorResult('search is required (substring to find in entry to remove).');
          const result = memory.removeAgentMemory(search);
          if (!result.ok) return errorResult(result.error!);
          return jsonResult({ status: 'removed', removed: result.removed, message: 'Memory entry removed.' });
        }

        case 'list': {
          const entries = memory.getAgentMemory();
          if (entries.length === 0) {
            return textResult('No agent memories saved yet. Use action "add" to save a discovery or lesson.');
          }
          const stats = memory.getAgentMemoryStats();
          const lines = [
            `**Agent Memory** (${stats.entries} entries, ${stats.chars}/${stats.limit} chars)`,
            '',
            ...entries.map((e, i) => `${i + 1}. ${e}`),
          ];
          return textResult(lines.join('\n'));
        }

        case 'user_add': {
          const userId = readStringParam(params, 'user_id');
          const entry = readStringParam(params, 'entry');
          if (!userId) return errorResult('user_id is required for user_add.');
          if (!entry) return errorResult('entry is required for user_add.');
          const result = memory.addUserMemory(userId, entry);
          if (!result.ok) return errorResult(result.error!);
          return jsonResult({ status: 'saved', message: `User profile entry saved for ${userId}.` });
        }

        case 'user_list': {
          const userId = readStringParam(params, 'user_id');
          if (!userId) return errorResult('user_id is required for user_list.');
          const entries = memory.getUserMemory(userId);
          if (entries.length === 0) {
            return textResult(`No profile entries for user ${userId}.`);
          }
          const stats = memory.getUserMemoryStats(userId);
          const lines = [
            `**User Profile: ${userId}** (${stats.entries} entries, ${stats.chars}/${stats.limit} chars)`,
            '',
            ...entries.map((e, i) => `${i + 1}. ${e}`),
          ];
          return textResult(lines.join('\n'));
        }

        case 'user_remove': {
          const userId = readStringParam(params, 'user_id');
          const search = readStringParam(params, 'search');
          if (!userId) return errorResult('user_id is required for user_remove.');
          if (!search) return errorResult('search is required (substring to find in entry to remove).');
          const result = memory.removeUserMemory(userId, search);
          if (!result.ok) return errorResult(result.error!);
          return jsonResult({ status: 'removed', removed: result.removed });
        }

        case 'stats': {
          const status = memory.getStatus();
          return jsonResult(status);
        }

        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}
