/**
 * Skills command — browse, search, enable/disable the unified skill registry.
 *
 * /skills                — List all skills with status indicators
 * /skills <name>         — Show full content of a specific skill
 * /skills search <q>     — Search skills by keyword
 * /skills enable <name>  — Re-enable a disabled skill
 * /skills disable <name> — Disable a skill (saves prompt tokens)
 */

import type { SkillEntry } from '../services/skill-registry.js';
import { getSkillRegistry } from '../services/skill-registry.js';

/** Format a single skill line with status indicators. */
function formatSkillLine(s: SkillEntry, registry: ReturnType<typeof getSkillRegistry>): string {
  const missing = registry.missingEnv(s);
  const tags: string[] = [];

  if (s.disabled)       tags.push('[disabled]');
  if (missing.length)   tags.push(`[env not set: ${missing.join(', ')}]`);
  if (s.source === 'learned') tags.push('(learned)');

  const suffix = tags.length > 0 ? `  ${tags.join(' ')}` : '';
  return `  **${s.name}** — ${s.description.slice(0, 90)}${s.description.length > 90 ? '...' : ''}${suffix}`;
}

export const skillsCommand = {
  name: 'skills',
  description: 'Browse crypto skills: /skills, /skills <name>, /skills search|enable|disable <name>',
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx?: any) => {
    const rawArgs = (ctx?.args ?? '').trim();
    const registry = getSkillRegistry();

    // ── No args: list all skills ─────────────────────────────────
    if (!rawArgs) {
      const all = registry.listAll();
      if (all.length === 0) {
        return { text: 'No skills found. Check that `extensions/crypto/skills/` exists and contains skill directories.' };
      }

      const enabled = all.filter(s => !s.disabled);
      const disabled = all.filter(s => s.disabled);

      const lines: string[] = [
        `**Skills** (${enabled.length} active, ${all.length} total)`,
        '',
      ];

      // Group by source
      const staticSkills = all.filter(s => s.source === 'static');
      const learnedSkills = all.filter(s => s.source === 'learned');

      if (staticSkills.length > 0) {
        lines.push(`**Built-in** (${staticSkills.length}):`);
        for (const s of staticSkills) {
          lines.push(formatSkillLine(s, registry));
        }
        lines.push('');
      }

      if (learnedSkills.length > 0) {
        lines.push(`**Learned** (${learnedSkills.length}):`);
        for (const s of learnedSkills) {
          lines.push(formatSkillLine(s, registry));
        }
        lines.push('');
      }

      lines.push('---');
      lines.push('`/skills <name>` view | `/skills search <q>` search');
      lines.push('`/skills disable <name>` | `/skills enable <name>`');

      if (disabled.length === 0 && all.length > 10) {
        lines.push('');
        lines.push('*Tip: disable skills you don\'t use to save prompt tokens.*');
      }

      return { text: lines.join('\n') };
    }

    // ── "enable <name>" ──────────────────────────────────────────
    if (rawArgs.startsWith('enable ')) {
      const name = rawArgs.slice(7).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!name) return { text: 'Usage: `/skills enable <name>`' };

      const skill = registry.get(name);
      if (!skill) return { text: `Skill "${name}" not found. Use \`/skills\` to list all.` };
      if (!skill.disabled) return { text: `**${name}** is already enabled.` };

      registry.enable(name);
      return { text: `Enabled **${name}**. It will now appear in prompts and matching.` };
    }

    // ── "disable <name>" ─────────────────────────────────────────
    if (rawArgs.startsWith('disable ')) {
      const name = rawArgs.slice(8).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!name) return { text: 'Usage: `/skills disable <name>`' };

      const skill = registry.get(name);
      if (!skill) return { text: `Skill "${name}" not found. Use \`/skills\` to list all.` };
      if (skill.disabled) return { text: `**${name}** is already disabled.` };

      registry.disable(name);
      return { text: `Disabled **${name}**. It won't be injected into prompts (saves tokens). Re-enable with \`/skills enable ${name}\`.` };
    }

    // ── "search <query>": keyword search ─────────────────────────
    if (rawArgs.startsWith('search ')) {
      const query = rawArgs.slice(7).trim();
      if (!query) return { text: 'Usage: `/skills search <query>`' };

      const matches = registry.match(query, { minScore: 1, maxResults: 10 });
      if (matches.length === 0) {
        return { text: `No skills matching "${query}". Use \`/skills\` to list all.` };
      }

      const lines = [`**Skills matching "${query}"** (${matches.length} result${matches.length > 1 ? 's' : ''})`, ''];
      for (const m of matches) {
        lines.push(formatSkillLine(m.skill, registry));
      }
      lines.push('', 'Use `/skills <name>` to view full content.');
      return { text: lines.join('\n') };
    }

    // ── "<name>": show full content ──────────────────────────────
    const name = rawArgs.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const content = registry.readContent(name);
    if (!content) {
      // Try fuzzy: search for the name
      const matches = registry.match(rawArgs, { minScore: 1, maxResults: 3 });
      if (matches.length > 0) {
        const suggestions = matches.map(m => `\`${m.skill.name}\``).join(', ');
        return { text: `Skill "${name}" not found. Did you mean: ${suggestions}?` };
      }
      return { text: `Skill "${name}" not found. Use \`/skills\` to list all available skills.` };
    }

    // Show status header for the skill
    const skill = registry.get(name)!;
    const missing = registry.missingEnv(skill);
    const statusParts: string[] = [];
    if (skill.disabled) statusParts.push('DISABLED');
    if (missing.length) statusParts.push(`env not set: ${missing.join(', ')}`);
    const statusLine = statusParts.length > 0 ? `\n**Status:** ${statusParts.join(' | ')}\n` : '';

    // Cap output at 4000 chars for chat readability
    const MAX_DISPLAY = 4000;
    const display = content.length > MAX_DISPLAY
      ? content.slice(0, MAX_DISPLAY) + `\n\n[...truncated at ${MAX_DISPLAY} chars. Full content available via skill_evolve(action: "view", name: "${name}")]`
      : content;

    return { text: `**Skill: ${name}**${statusLine}\n${display}` };
  },
};
