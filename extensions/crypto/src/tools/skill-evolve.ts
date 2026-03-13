/**
 * Skill Evolution Tool — agent-initiated skill creation and improvement.
 *
 * Lets the agent create new skills from experience and patch existing ones.
 * Skills are stored in ~/.openclawnch/learned-skills/ (separate from the 27
 * static skills that ship with the plugin, so upgrades don't overwrite them).
 *
 * Actions:
 *   create  — Write a new SKILL.md from a complex workflow just completed
 *   patch   — Targeted find-and-replace within an existing learned skill
 *   list    — List all learned skills (name + description)
 *   view    — Read the full content of a learned skill
 *   delete  — Remove a learned skill
 *
 * All writes pass through the skill security scanner (skill-guard.ts).
 * Only available when evolution mode is "evolving".
 *
 * Inspired by Hermes Agent's skill_manager_tool.py.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, textResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { scanSkillContent, validateSkillFrontmatter, formatScanReport } from '../lib/skill-guard.js';
import { getEvolutionMode } from '../services/evolution-mode.js';
import { getSkillRegistry } from '../services/skill-registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ACTIONS = ['create', 'patch', 'list', 'view', 'delete'] as const;

const SkillEvolveSchema = Type.Object({
  action: stringEnum(ACTIONS, { description: 'Operation to perform' }),
  name: Type.Optional(Type.String({
    description: 'Skill name in kebab-case (e.g., "uniswap-v3-snipe"). Required for create/patch/view/delete.',
  })),
  description: Type.Optional(Type.String({
    description: 'Brief skill description (for create action).',
  })),
  content: Type.Optional(Type.String({
    description: 'Full skill markdown content (for create action). Should include when-to-use, steps, and tips.',
  })),
  old_string: Type.Optional(Type.String({
    description: 'Text to find in the skill (for patch action). Must be an exact substring match.',
  })),
  new_string: Type.Optional(Type.String({
    description: 'Replacement text (for patch action).',
  })),
});

// ─── Skill Directory ─────────────────────────────────────────────────────

function getLearnedSkillsDir(): string {
  return join(process.env.HOME ?? '/tmp', '.openclawnch', 'learned-skills');
}

function getSkillDir(name: string): string {
  return join(getLearnedSkillsDir(), name);
}

function getSkillPath(name: string): string {
  return join(getSkillDir(name), 'SKILL.md');
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function buildSkillContent(name: string, description: string, body: string): string {
  return `---
name: ${name}
description: ${description}
version: 1.0.0
metadata:
  openclawnch:
    source: agent-learned
    createdAt: "${new Date().toISOString()}"
---

${body}
`;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  try {
    // Simple YAML parsing for the fields we care about
    const yamlText = match[1] ?? '';
    const body = match[2] ?? '';
    const fm: Record<string, unknown> = {};

    for (const line of yamlText.split('\n')) {
      const kvMatch = line.match(/^(\w+):\s*(.+)$/);
      if (kvMatch) {
        const key = kvMatch[1]!;
        let value: string | unknown = (kvMatch[2] ?? '').trim();
        // Strip quotes
        if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        fm[key] = value;
      }
    }

    return { frontmatter: fm, body };
  } catch {
    return null;
  }
}

function listLearnedSkills(): Array<{ name: string; description: string; path: string }> {
  const dir = getLearnedSkillsDir();
  if (!existsSync(dir)) return [];

  const results: Array<{ name: string; description: string; path: string }> = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;

      try {
        const content = readFileSync(skillPath, 'utf8');
        const parsed = parseFrontmatter(content);
        results.push({
          name: entry.name,
          description: parsed?.frontmatter?.description as string ?? '(no description)',
          path: skillPath,
        });
      } catch {
        results.push({ name: entry.name, description: '(unreadable)', path: skillPath });
      }
    }
  } catch {
    // Directory read failed
  }

  return results;
}

// ─── Tool ────────────────────────────────────────────────────────────────

export function createSkillEvolveTool() {
  return {
    name: 'skill_evolve',
    label: 'Skill Evolution',
    ownerOnly: false,
    description:
      'Create and improve learned skills from experience. ' +
      'After completing a complex task (5+ tool calls), fixing a tricky error, or discovering ' +
      'a non-trivial DeFi workflow, save it as a skill so you can reuse it next time. ' +
      'Actions: create (new skill), patch (update existing), list, view, delete. ' +
      'Only available in evolving mode (/evolve).',
    parameters: SkillEvolveSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      // Check evolution mode (extract userId from context if available)
      // The tool itself doesn't get ctx directly, but the readonly gate pattern
      // can be used. For now, we check via a default.
      // Note: the actual gate is in index.ts via the registration wrapper.

      switch (action) {
        case 'list':
          return handleList();
        case 'view':
          return handleView(params);
        case 'create':
          return handleCreate(params);
        case 'patch':
          return handlePatch(params);
        case 'delete':
          return handleDelete(params);
        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}

// ─── Action Handlers ─────────────────────────────────────────────────────

function handleList() {
  const learned = listLearnedSkills();

  // Also report static skill count from registry
  let staticCount = 0;
  try {
    const registry = getSkillRegistry();
    staticCount = registry.list({ source: 'static' }).length;
  } catch { /* registry not available */ }

  const lines: string[] = [];

  if (learned.length > 0) {
    lines.push(`**Learned Skills** (${learned.length}):`, '');
    for (const s of learned) {
      lines.push(`- **${s.name}**: ${s.description}`);
    }
  } else {
    lines.push('No learned skills yet. Use action "create" after completing a complex workflow to save it as a reusable skill.');
  }

  if (staticCount > 0) {
    lines.push('', `${staticCount} built-in skills also available. Use \`/skills\` to browse all skills.`);
  }

  return textResult(lines.join('\n'));
}

function handleView(params: Record<string, unknown>) {
  const name = readStringParam(params, 'name', { required: true });
  if (!name) return errorResult('Skill name is required for view action.');

  // Try learned skills first (original behavior)
  const learnedPath = getSkillPath(name);
  if (existsSync(learnedPath)) {
    try {
      const content = readFileSync(learnedPath, 'utf8');
      return textResult(content);
    } catch (err) {
      return errorResult(`Failed to read skill: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fall through to the unified skill registry (includes static skills)
  try {
    const registry = getSkillRegistry();
    const content = registry.readContent(name);
    if (content) {
      return textResult(content);
    }
  } catch {
    // Registry not available — continue to error
  }

  return errorResult(`Skill "${name}" not found. Use action "list" or \`/skills\` to see available skills.`);
}

function handleCreate(params: Record<string, unknown>) {
  const name = readStringParam(params, 'name', { required: true });
  const description = readStringParam(params, 'description', { required: true });
  const content = readStringParam(params, 'content', { required: true });

  if (!name) return errorResult('Skill name is required (kebab-case, e.g., "uniswap-v3-snipe").');
  if (!description) return errorResult('Skill description is required.');
  if (!content) return errorResult('Skill content (markdown body) is required.');

  // Validate name format
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) || name.length > 60) {
    return errorResult('Invalid skill name. Must be lowercase kebab-case, 2-60 chars (e.g., "my-skill").');
  }

  // Check if already exists
  if (existsSync(getSkillPath(name))) {
    return errorResult(`Skill "${name}" already exists. Use action "patch" to update it, or "delete" first.`);
  }

  // Build full skill content
  const fullContent = buildSkillContent(name, description, content);

  // Validate frontmatter
  const parsed = parseFrontmatter(fullContent);
  if (parsed) {
    const fmErrors = validateSkillFrontmatter(parsed.frontmatter);
    if (fmErrors.length > 0) {
      return errorResult('Skill frontmatter validation failed:\n' + fmErrors.map(e => `- ${e}`).join('\n'));
    }
  }

  // Security scan
  const scanResult = scanSkillContent(fullContent, 'learned');
  if (!scanResult.safe) {
    return errorResult(
      'Skill creation BLOCKED by security scanner:\n\n' +
      formatScanReport(scanResult) +
      '\n\nRemove the flagged content and try again.',
    );
  }

  // Write to disk
  try {
    const dir = getSkillDir(name);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(getSkillPath(name), fullContent, 'utf8');
  } catch (err) {
    return errorResult(`Failed to write skill: ${err instanceof Error ? err.message : String(err)}`);
  }

  const infoNote = scanResult.findings.length > 0
    ? `\n\nNote: ${scanResult.findings.length} informational finding(s) detected but did not block creation.`
    : '';

  return jsonResult({
    status: 'created',
    name,
    description,
    path: getSkillPath(name),
    message: `Learned skill "${name}" created successfully. It will be available in your next session's skill index.${infoNote}`,
  });
}

function handlePatch(params: Record<string, unknown>) {
  const name = readStringParam(params, 'name', { required: true });
  const oldString = readStringParam(params, 'old_string', { required: true });
  const newString = readStringParam(params, 'new_string', { required: true });

  if (!name) return errorResult('Skill name is required for patch.');
  if (!oldString) return errorResult('old_string is required (the text to find).');
  if (!newString) return errorResult('new_string is required (the replacement text).');

  const path = getSkillPath(name);
  if (!existsSync(path)) {
    return errorResult(`Learned skill "${name}" not found.`);
  }

  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    return errorResult(`Failed to read skill: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Find the old string
  if (!content.includes(oldString)) {
    return errorResult(
      `old_string not found in skill "${name}". ` +
      'Provide an exact substring match. Use action "view" to see the current content.',
    );
  }

  // Apply the patch
  const patched = content.replace(oldString, newString);

  // Security scan the result
  const scanResult = scanSkillContent(patched, 'learned');
  if (!scanResult.safe) {
    return errorResult(
      'Skill patch BLOCKED by security scanner:\n\n' +
      formatScanReport(scanResult) +
      '\n\nThe original skill was not modified.',
    );
  }

  // Write
  try {
    writeFileSync(path, patched, 'utf8');
  } catch (err) {
    return errorResult(`Failed to write patched skill: ${err instanceof Error ? err.message : String(err)}`);
  }

  return jsonResult({
    status: 'patched',
    name,
    message: `Skill "${name}" patched successfully. Changes will be visible in the next session.`,
  });
}

function handleDelete(params: Record<string, unknown>) {
  const name = readStringParam(params, 'name', { required: true });
  if (!name) return errorResult('Skill name is required for delete.');

  const dir = getSkillDir(name);
  if (!existsSync(dir)) {
    return errorResult(`Learned skill "${name}" not found.`);
  }

  try {
    rmSync(dir, { recursive: true });
  } catch (err) {
    return errorResult(`Failed to delete skill: ${err instanceof Error ? err.message : String(err)}`);
  }

  return jsonResult({
    status: 'deleted',
    name,
    message: `Learned skill "${name}" deleted.`,
  });
}

// ─── Utility: Build Learned Skills Index for System Prompt ───────────────

/**
 * Build a compact index of all learned skills for injection into the
 * system prompt. Format: "- name: description" per skill.
 */
export function buildLearnedSkillsIndex(): string {
  const skills = listLearnedSkills();
  if (skills.length === 0) return '';

  const lines = [
    '## Learned Skills (agent-created)',
    'These skills were created by you from past experience. ' +
    'If one matches the current task, load it with skill_evolve(action: "view", name: "...") for detailed instructions.',
    '',
  ];

  for (const s of skills) {
    lines.push(`- **${s.name}**: ${s.description}`);
  }

  return lines.join('\n');
}
