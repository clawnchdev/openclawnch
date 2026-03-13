/**
 * Skills command — browse and search the unified skill registry.
 *
 * /skills              — List all skills (static + learned) with descriptions
 * /skills <name>       — Show full content of a specific skill
 * /skills search <q>   — Search skills by keyword
 */

import { getSkillRegistry } from '../services/skill-registry.js';

export const skillsCommand = {
  name: 'skills',
  description: 'Browse crypto skills: /skills, /skills <name>, /skills search <query>',
  acceptsArgs: true,
  requireAuth: false,
  handler: async (ctx?: any) => {
    const rawArgs = (ctx?.args ?? '').trim();
    const registry = getSkillRegistry();

    // ── No args: list all skills ─────────────────────────────────
    if (!rawArgs) {
      const skills = registry.list();
      if (skills.length === 0) {
        return { text: 'No skills found. Static skills should be in `extensions/crypto/skills/`. Learned skills in `~/.openclawnch/learned-skills/`.' };
      }

      const staticSkills = skills.filter(s => s.source === 'static');
      const learnedSkills = skills.filter(s => s.source === 'learned');

      const lines: string[] = [`**Skills** (${skills.length} total)`, ''];

      if (staticSkills.length > 0) {
        lines.push(`**Built-in** (${staticSkills.length}):`);
        for (const s of staticSkills) {
          lines.push(`  **${s.name}** — ${s.description.slice(0, 100)}${s.description.length > 100 ? '...' : ''}`);
        }
        lines.push('');
      }

      if (learnedSkills.length > 0) {
        lines.push(`**Learned** (${learnedSkills.length}):`);
        for (const s of learnedSkills) {
          lines.push(`  **${s.name}** — ${s.description.slice(0, 100)}${s.description.length > 100 ? '...' : ''}`);
        }
        lines.push('');
      }

      lines.push('Use `/skills <name>` to view full content, `/skills search <query>` to search.');
      return { text: lines.join('\n') };
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
        const tag = m.skill.source === 'learned' ? ' (learned)' : '';
        lines.push(`  **${m.skill.name}**${tag} (score: ${m.score}) — ${m.skill.description.slice(0, 80)}${m.skill.description.length > 80 ? '...' : ''}`);
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

    // Cap output at 4000 chars for chat readability
    const MAX_DISPLAY = 4000;
    const display = content.length > MAX_DISPLAY
      ? content.slice(0, MAX_DISPLAY) + `\n\n[...truncated at ${MAX_DISPLAY} chars. Full content available via skill_evolve(action: "view", name: "${name}")]`
      : content;

    return { text: `**Skill: ${name}**\n\n${display}` };
  },
};
