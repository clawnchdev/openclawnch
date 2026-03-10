/**
 * Session Recall Tool — LLM-facing interface to search past conversations.
 *
 * Lets the agent search its own history for relevant context before asking
 * the user to repeat themselves. Proactive recall is key to the self-
 * improvement loop.
 *
 * Actions:
 *   search  — Full-text search across past conversations
 *   stats   — Show recall index statistics
 *
 * Always available (not gated by evolution mode — recall is read-only).
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, textResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { getSessionRecall } from '../services/session-recall.js';

const ACTIONS = ['search', 'stats'] as const;

const SessionRecallSchema = Type.Object({
  action: stringEnum(ACTIONS, { description: 'Operation to perform' }),
  query: Type.Optional(Type.String({
    description: 'Search query — natural language or keywords. For search action.',
  })),
  max_results: Type.Optional(Type.Number({
    description: 'Max sessions to return (default: 3, max: 10).',
  })),
});

export function createSessionRecallTool() {
  return {
    name: 'session_recall',
    label: 'Session Recall',
    ownerOnly: false,
    description:
      'Search your past conversations for relevant context. ' +
      'USE THIS PROACTIVELY when: ' +
      '(1) The user says "we did this before", "remember when", "last time". ' +
      '(2) You want to check if you\'ve solved a similar problem before. ' +
      '(3) The user references a past decision or strategy. ' +
      '(4) You need context from a previous session to continue work. ' +
      'Actions: search (full-text across past sessions), stats.',
    parameters: SessionRecallSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      const recall = getSessionRecall();

      switch (action) {
        case 'search': {
          const query = readStringParam(params, 'query');
          if (!query) return errorResult('query is required for search action.');

          const maxResults = Math.min(
            Math.max(1, (params.max_results as number) || 3),
            10,
          );

          const results = recall.search(query, maxResults);
          if (results.length === 0) {
            return textResult('No relevant past conversations found for this query.');
          }

          const lines = [`**Session Recall** (${results.length} session${results.length > 1 ? 's' : ''} found)`, ''];

          for (const result of results) {
            const date = new Date(result.latestTimestamp).toISOString().split('T')[0];
            lines.push(`### Session: ${result.sessionKey} (${date}, score: ${result.score.toFixed(1)})`);
            lines.push('');

            for (const match of result.matches.slice(0, 5)) {
              const role = match.role.toUpperCase();
              const tool = match.toolName ? ` [${match.toolName}]` : '';
              const preview = match.content.slice(0, 300) + (match.content.length > 300 ? '...' : '');
              lines.push(`**${role}${tool}**: ${preview}`);
              lines.push('');
            }

            if (result.matches.length > 5) {
              lines.push(`_... and ${result.matches.length - 5} more matching turns_`);
              lines.push('');
            }
          }

          return textResult(lines.join('\n'));
        }

        case 'stats': {
          const stats = recall.getStats();
          return jsonResult({
            totalEntries: stats.totalEntries,
            uniqueSessions: stats.uniqueSessions,
            oldestDate: stats.oldestTimestamp > 0
              ? new Date(stats.oldestTimestamp).toISOString()
              : null,
            newestDate: stats.newestTimestamp > 0
              ? new Date(stats.newestTimestamp).toISOString()
              : null,
          });
        }

        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}
