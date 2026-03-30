/**
 * Evolution mode commands — toggle between stable and evolving agent behavior.
 *
 * /evolve  — Enable self-improvement (memory writes, skill creation, nudges)
 * /stable  — Disable self-improvement (read-only on learned knowledge)
 * /evolution — Show current evolution mode status
 */

import { getEvolutionMode } from '../services/evolution-mode.js';
import { getAgentMemory } from '../services/agent-memory.js';
import { buildLearnedSkillsIndex } from '../tools/skill-evolve.js';

function getSenderId(ctx: any): string {
  return ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'unknown';
}

export const evolveCommand = {
  name: 'evolve',
  description: 'Enable self-improvement mode — agent learns from experience',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const evo = getEvolutionMode();

    if (evo.isEvolving(userId)) {
      return {
        text: 'Self-improvement is already active.\n\nThe agent can:\n- Save memories (environment facts, tool quirks, lessons)\n- Create and patch skills from complex workflows\n- Search past conversations for relevant context\n\nUse /stable to switch to stable mode.',
      };
    }

    evo.setMode(userId, 'evolving');

    return {
      text: `**Self-improvement enabled.**

The agent will now:
- Proactively save important discoveries to memory
- Create reusable skills from complex workflows (5+ tool calls)
- Search past conversations when relevant context might exist
- Receive periodic nudges to persist knowledge

Learned memories and skills persist across sessions and improve the agent over time.

Use **/stable** to return to stable mode (all learned knowledge remains accessible but no new learning occurs).`,
    };
  },
};

export const stableCommand = {
  name: 'stable',
  description: 'Disable self-improvement — use only static skills and existing knowledge',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const evo = getEvolutionMode();

    if (!evo.isEvolving(userId)) {
      return {
        text: 'Already in stable mode.\n\nThe agent uses only built-in skills. Existing learned knowledge is still accessible (read-only) but no new learning occurs.\n\nUse /evolve to enable self-improvement.',
      };
    }

    evo.setMode(userId, 'stable');

    return {
      text: `**Stable mode enabled.**

Self-improvement is paused:
- Memory and skill tools will return "disabled in stable mode" for write operations
- Existing learned skills and memories remain accessible (read-only)
- Session recall (search) still works
- No periodic nudges

Use **/evolve** to resume self-improvement.`,
    };
  },
};

export const evolutionCommand = {
  name: 'evolution',
  description: 'Show current self-improvement mode and statistics',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const evo = getEvolutionMode();
    const memory = getAgentMemory();

    const mode = evo.getMode(userId);
    const memStats = memory.getAgentMemoryStats();
    const userStats = memory.getUserMemoryStats(userId);
    const learnedSkillsIndex = buildLearnedSkillsIndex();
    const learnedCount = learnedSkillsIndex ? learnedSkillsIndex.split('\n').filter(l => l.startsWith('- ')).length : 0;
    const evoStatus = evo.getStatus();

    const lines = [
      '**Evolution Status**',
      '',
      `Mode: **${mode}** ${mode === 'evolving' ? '(self-improving)' : '(stable, no new learning)'}`,
      `Turns this session: ${evo.getTurnCount(userId)}`,
      '',
      '**Agent Memory**',
      `  Entries: ${memStats.entries}`,
      `  Usage: ${memStats.chars}/${memStats.limit} chars`,
      '',
      '**User Profile**',
      `  Entries: ${userStats.entries}`,
      `  Usage: ${userStats.chars}/${userStats.limit} chars`,
      '',
      `**Learned Skills**: ${learnedCount}`,
      '',
      '**Nudge Intervals**',
      `  Memory: every ${evoStatus.memoryNudgeInterval} turns`,
      `  Skills: every ${evoStatus.skillNudgeInterval} turns`,
    ];

    return { text: lines.join('\n') };
  },
};
