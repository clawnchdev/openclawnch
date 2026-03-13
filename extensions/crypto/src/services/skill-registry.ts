/**
 * Skill Registry — unified index of static + learned skills with keyword matching.
 *
 * Solves the "LLM didn't load the right skill" problem by:
 * 1. Indexing ALL skills (42 static + N learned) with name, description, keywords
 * 2. Matching user messages against keywords → returning full skill content
 * 3. Providing a single lookup surface for /skills command + prompt-builder
 *
 * Static skills:  extensions/crypto/skills/<name>/SKILL.md
 * Learned skills: ~/.openclawnch/learned-skills/<name>/SKILL.md
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── ESM path resolution ────────────────────────────────────────────────
// __dirname is undefined in ESM. Resolve from import.meta.url instead.
// Compiled: extensions/crypto/dist/src/services/ → 3 levels up → extensions/crypto/
// Source:   extensions/crypto/src/services/       → 2 levels up → extensions/crypto/

const __selfDir = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = existsSync(join(__selfDir, '..', '..', '..', 'skills'))
  ? join(__selfDir, '..', '..', '..')       // from dist/src/services
  : join(__selfDir, '..', '..');            // from src/services (dev/test)

// ─── Types ──────────────────────────────────────────────────────────────

export interface SkillEntry {
  /** Skill name (kebab-case). */
  name: string;
  /** Short description from frontmatter or first paragraph. */
  description: string;
  /** Source: 'static' (shipped) or 'learned' (agent-created). */
  source: 'static' | 'learned';
  /** Absolute path to SKILL.md. */
  path: string;
  /** Keywords for matching (derived from name + description + frontmatter). */
  keywords: string[];
  /** Environment variables required by this skill (from frontmatter metadata). */
  requiresEnv: string[];
  /** Whether the user has disabled this skill. */
  disabled: boolean;
  /** Full file content (lazy-loaded, cached). */
  _content?: string;
}

export interface SkillMatch {
  skill: SkillEntry;
  /** Number of keyword hits. */
  score: number;
}

// ─── Disabled Skills Persistence ────────────────────────────────────────

const OPENCLAWNCH_DIR = join(process.env.HOME ?? '', '.openclawnch');
const DISABLED_FILE = join(OPENCLAWNCH_DIR, 'disabled-skills.json');

function loadDisabledSet(): Set<string> {
  try {
    if (existsSync(DISABLED_FILE)) {
      const data = JSON.parse(readFileSync(DISABLED_FILE, 'utf8'));
      if (Array.isArray(data)) return new Set(data as string[]);
    }
  } catch { /* corrupt file — start fresh */ }
  return new Set();
}

function saveDisabledSet(set: Set<string>): void {
  try {
    if (!existsSync(OPENCLAWNCH_DIR)) mkdirSync(OPENCLAWNCH_DIR, { recursive: true });
    writeFileSync(DISABLED_FILE, JSON.stringify([...set], null, 2), 'utf8');
  } catch { /* best-effort */ }
}

// ─── Frontmatter Parsing ────────────────────────────────────────────────

interface FrontmatterResult {
  name?: string;
  description?: string;
  requiresEnv: string[];
  rest: string;
}

function parseFrontmatter(content: string): FrontmatterResult {
  if (!content.startsWith('---')) {
    // No frontmatter — extract from markdown heading + first paragraph
    const lines = content.split('\n');
    let name: string | undefined;
    let description: string | undefined;

    for (const line of lines) {
      if (!name && line.startsWith('# ')) {
        name = line.slice(2).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      } else if (!description && name && line.trim().length > 0 && !line.startsWith('#')) {
        description = line.trim().slice(0, 200);
        break;
      }
    }
    return { name, description, requiresEnv: [], rest: content };
  }

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return { requiresEnv: [], rest: content };

  const yaml = content.slice(3, endIdx).trim();
  const rest = content.slice(endIdx + 3).trim();

  let name: string | undefined;
  let description: string | undefined;
  let requiresEnv: string[] = [];

  for (const line of yaml.split('\n')) {
    const nameMatch = line.match(/^name:\s*["']?(.+?)["']?\s*$/);
    if (nameMatch) name = nameMatch[1];

    const descMatch = line.match(/^description:\s*["']?(.+?)["']?\s*$/);
    if (descMatch) description = descMatch[1];

    // Parse metadata JSON: metadata: { "openclaw": { "requires": { "env": [...] } } }
    const metaMatch = line.match(/^metadata:\s*(\{.+\})\s*$/);
    if (metaMatch) {
      try {
        const meta = JSON.parse(metaMatch[1]!);
        const envArr = meta?.openclaw?.requires?.env;
        if (Array.isArray(envArr)) {
          requiresEnv = envArr.filter((v: unknown): v is string => typeof v === 'string');
        }
      } catch { /* malformed JSON — skip */ }
    }
  }

  return { name, description, requiresEnv, rest };
}

/** Extract keywords from name + description for matching. */
function extractKeywords(name: string, description: string): string[] {
  const text = `${name.replace(/-/g, ' ')} ${description}`.toLowerCase();
  // Split on non-alphanumeric, filter short/stopwords
  const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'be', 'to', 'of', 'and', 'or', 'in',
    'on', 'for', 'with', 'by', 'from', 'at', 'as', 'it', 'its', 'this', 'that',
    'use', 'via', 'any', 'all', 'can', 'your', 'you', 'more', 'also', 'into',
  ]);
  const words = text.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

// ─── Directory Scanning ─────────────────────────────────────────────────

function scanSkillDir(
  dir: string,
  source: 'static' | 'learned',
  disabledSet: Set<string>,
): SkillEntry[] {
  const entries: SkillEntry[] = [];
  if (!existsSync(dir)) return entries;

  try {
    for (const entry of readdirSync(dir)) {
      const entryPath = join(dir, entry);
      if (!statSync(entryPath).isDirectory()) continue;

      const skillPath = join(entryPath, 'SKILL.md');
      if (!existsSync(skillPath)) continue;

      try {
        const content = readFileSync(skillPath, 'utf8');
        if (content.length > 256_000) continue; // skip oversized

        const fm = parseFrontmatter(content);
        const name = fm.name ?? entry;
        const description = fm.description ?? '';

        entries.push({
          name,
          description,
          source,
          path: skillPath,
          keywords: extractKeywords(name, description),
          requiresEnv: fm.requiresEnv,
          disabled: disabledSet.has(name),
        });
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir not readable */ }

  return entries;
}

// ─── Registry ───────────────────────────────────────────────────────────

export class SkillRegistry {
  private skills = new Map<string, SkillEntry>();
  private disabledSet: Set<string>;
  private staticDir: string;
  private learnedDir: string;
  private lastScan = 0;
  private scanIntervalMs = 60_000; // re-scan every 60s

  constructor(opts?: { staticDir?: string; learnedDir?: string }) {
    this.staticDir = opts?.staticDir ?? join(EXTENSION_ROOT, 'skills');
    this.learnedDir = opts?.learnedDir ?? join(
      process.env.HOME ?? '', '.openclawnch', 'learned-skills'
    );
    this.disabledSet = loadDisabledSet();
    this.scan();
  }

  /** Re-scan both directories for skills. */
  scan(): void {
    this.skills.clear();
    this.disabledSet = loadDisabledSet();

    const staticSkills = scanSkillDir(this.staticDir, 'static', this.disabledSet);
    const learnedSkills = scanSkillDir(this.learnedDir, 'learned', this.disabledSet);

    // Learned skills override static if name conflicts
    for (const s of staticSkills) this.skills.set(s.name, s);
    for (const s of learnedSkills) this.skills.set(s.name, s);

    this.lastScan = Date.now();
  }

  private ensureFresh(): void {
    if (Date.now() - this.lastScan > this.scanIntervalMs) {
      this.scan();
    }
  }

  /** Get a skill by exact name. */
  get(name: string): SkillEntry | null {
    this.ensureFresh();
    return this.skills.get(name) ?? null;
  }

  /** List all skills sorted by name. */
  list(opts?: { source?: 'static' | 'learned'; includeDisabled?: boolean }): SkillEntry[] {
    this.ensureFresh();
    let all = Array.from(this.skills.values());
    if (opts?.source) all = all.filter(s => s.source === opts.source);
    if (!opts?.includeDisabled) all = all.filter(s => !s.disabled);
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** List all skills including disabled (for /skills command). */
  listAll(): SkillEntry[] {
    this.ensureFresh();
    return Array.from(this.skills.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Read the full SKILL.md content for a skill. */
  readContent(name: string): string | null {
    const skill = this.get(name);
    if (!skill) return null;

    // Cache content
    if (skill._content === undefined) {
      try {
        skill._content = readFileSync(skill.path, 'utf8');
      } catch {
        return null;
      }
    }
    return skill._content;
  }

  /**
   * Match user message against skill keywords.
   * Returns skills sorted by match score (descending), filtered to score >= minScore.
   * Only matches enabled skills.
   */
  match(message: string, opts?: { minScore?: number; maxResults?: number }): SkillMatch[] {
    this.ensureFresh();
    const minScore = opts?.minScore ?? 2;
    const maxResults = opts?.maxResults ?? 3;

    const msgLower = message.toLowerCase();
    const msgTokens = msgLower.split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const msgTokenSet = new Set(msgTokens);

    const matches: SkillMatch[] = [];

    for (const skill of this.skills.values()) {
      // Skip disabled skills in matching
      if (skill.disabled) continue;

      let score = 0;

      // Exact name match in message (strongest signal)
      if (msgLower.includes(skill.name.replace(/-/g, ' ')) || msgLower.includes(skill.name)) {
        score += 5;
      }

      // Keyword overlap
      for (const kw of skill.keywords) {
        if (msgTokenSet.has(kw)) {
          score += 1;
        }
        // Substring match for compound words (e.g. "botcoin" matches "botcoin-mining")
        if (kw.length > 3 && msgLower.includes(kw)) {
          score += 1;
        }
      }

      if (score >= minScore) {
        matches.push({ skill, score });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, maxResults);
  }

  /** Build a compact index for prompt injection (name + description, one line each). */
  buildIndex(): string {
    // Only include enabled skills in the prompt index
    const skills = this.list();
    if (skills.length === 0) return '';

    const lines = [
      `## Crypto Skills (${skills.length} available)`,
      'If a user request matches a skill below, load it with `/skills <name>` or `skill_evolve(action: "view", name: "...")` for full instructions.',
      '',
    ];
    for (const s of skills) {
      const tag = s.source === 'learned' ? ' (learned)' : '';
      lines.push(`- **${s.name}**${tag}: ${s.description.slice(0, 120)}`);
    }
    return lines.join('\n');
  }

  // ─── Enable / Disable ───────────────────────────────────────────────

  /** Disable a skill (won't appear in prompts or matching). */
  disable(name: string): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    skill.disabled = true;
    this.disabledSet.add(name);
    saveDisabledSet(this.disabledSet);
    return true;
  }

  /** Re-enable a disabled skill. */
  enable(name: string): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    skill.disabled = false;
    this.disabledSet.delete(name);
    saveDisabledSet(this.disabledSet);
    return true;
  }

  /** Check which required env vars are missing for a skill. */
  missingEnv(skill: SkillEntry): string[] {
    return skill.requiresEnv.filter(key => !process.env[key]);
  }

  /** Get total count (enabled only by default). */
  get size(): number {
    this.ensureFresh();
    return this.list().length;
  }

  /** Get total count including disabled. */
  get totalSize(): number {
    this.ensureFresh();
    return this.skills.size;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: SkillRegistry | null = null;

export function getSkillRegistry(opts?: { staticDir?: string; learnedDir?: string }): SkillRegistry {
  if (!instance) {
    instance = new SkillRegistry(opts);
  }
  return instance;
}

export function resetSkillRegistry(): void {
  instance = null;
}
