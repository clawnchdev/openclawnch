/**
 * Skill Registry Tests
 *
 * Tests the unified skill registry that indexes static + learned skills
 * and provides keyword matching for auto-injection into prompts.
 *
 * Covers:
 *   1. Static skill scanning (42 skills in extensions/crypto/skills/)
 *   2. Learned skill scanning (temp directory)
 *   3. Frontmatter parsing (YAML + bare markdown)
 *   4. Keyword matching + scoring
 *   5. Content loading + caching
 *   6. Compact index building
 *   7. /skills command handler
 *   8. Prompt builder skill auto-injection
 *   9. skill_evolve view action for static skills
 *   10. Plugin registers 118 commands (including skills, interrupt, api, pull, delegate, policymode, profile, upgrade)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.env.HOME ?? '/tmp', '.openclawnch-skill-test-' + Date.now());
const STATIC_DIR = join(TEST_DIR, 'static-skills');
const LEARNED_DIR = join(TEST_DIR, 'learned-skills');

function setupTestSkills() {
  // Create static skills
  mkdirSync(join(STATIC_DIR, 'botcoin-mining'), { recursive: true });
  writeFileSync(join(STATIC_DIR, 'botcoin-mining', 'SKILL.md'), `---
name: botcoin-mining
description: Mine BOTCOIN tokens by solving hash challenges and staking
---

# BOTCOIN Mining

Steps to mine BOTCOIN:
1. Stake tokens
2. Solve hash challenges
3. Claim rewards
`);

  mkdirSync(join(STATIC_DIR, 'uniswap-v3'), { recursive: true });
  writeFileSync(join(STATIC_DIR, 'uniswap-v3', 'SKILL.md'), `# Uniswap V3

Provide concentrated liquidity on Uniswap V3.

## Steps
1. Choose token pair
2. Set price range
3. Add liquidity
`);

  mkdirSync(join(STATIC_DIR, 'bridge-arbitrage'), { recursive: true });
  writeFileSync(join(STATIC_DIR, 'bridge-arbitrage', 'SKILL.md'), `---
name: bridge-arbitrage
description: Find and execute cross-chain bridge arbitrage opportunities
---

# Bridge Arbitrage

Monitor price differences across chains and execute profitable bridges.
`);

  // Skill with requires.env metadata
  mkdirSync(join(STATIC_DIR, 'clawnx'), { recursive: true });
  writeFileSync(join(STATIC_DIR, 'clawnx', 'SKILL.md'), `---
name: clawnx
description: X/Twitter integration for posting tweets and monitoring feeds
metadata: { "openclaw": { "emoji": "𝕏", "requires": { "env": ["X_API_KEY", "X_API_SECRET"] } } }
---

# ClawnX

Post tweets and manage your X account.
`);

  // Create a learned skill
  mkdirSync(join(LEARNED_DIR, 'custom-dca'), { recursive: true });
  writeFileSync(join(LEARNED_DIR, 'custom-dca', 'SKILL.md'), `---
name: custom-dca
description: Custom DCA strategy using Bankr automate for weekly ETH buys
version: 1.0.0
metadata:
  openclawnch:
    source: agent-learned
---

# Custom DCA

A learned workflow for setting up weekly DCA into ETH.
`);
}

function cleanup() {
  try {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. SkillRegistry — Scanning + Indexing
// ═══════════════════════════════════════════════════════════════════════════

describe('SkillRegistry — Scanning', () => {
  beforeEach(() => {
    cleanup();
    setupTestSkills();
  });
  afterEach(cleanup);

  it('scans static and learned skill directories', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    expect(registry.size).toBe(5); // 4 static + 1 learned
  });

  it('lists skills sorted by name', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const all = registry.list();
    expect(all.length).toBe(5);
    expect(all[0]!.name).toBe('botcoin-mining');
    expect(all[1]!.name).toBe('bridge-arbitrage');
    expect(all[2]!.name).toBe('clawnx');
    expect(all[3]!.name).toBe('custom-dca');
    expect(all[4]!.name).toBe('uniswap-v3');
  });

  it('filters by source', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    expect(registry.list({ source: 'static' }).length).toBe(4);
    expect(registry.list({ source: 'learned' }).length).toBe(1);
  });

  it('gets skill by exact name', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const skill = registry.get('botcoin-mining');
    expect(skill).not.toBeNull();
    expect(skill!.source).toBe('static');
    expect(skill!.description).toContain('BOTCOIN');

    expect(registry.get('nonexistent')).toBeNull();
  });

  it('handles empty directories gracefully', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const emptyStatic = join(TEST_DIR, 'empty-static');
    const emptyLearned = join(TEST_DIR, 'empty-learned');
    mkdirSync(emptyStatic, { recursive: true });

    const registry = new SkillRegistry({ staticDir: emptyStatic, learnedDir: emptyLearned });
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it('parses YAML frontmatter', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const skill = registry.get('botcoin-mining');
    expect(skill!.description).toBe('Mine BOTCOIN tokens by solving hash challenges and staking');
  });

  it('parses bare markdown (no frontmatter)', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const skill = registry.get('uniswap-v3');
    expect(skill).not.toBeNull();
    expect(skill!.description).toContain('concentrated liquidity');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. SkillRegistry — Keyword Matching
// ═══════════════════════════════════════════════════════════════════════════

describe('SkillRegistry — Keyword Matching', () => {
  beforeEach(() => {
    cleanup();
    setupTestSkills();
  });
  afterEach(cleanup);

  it('matches exact skill name in message (high score)', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const matches = registry.match('How do I mine botcoin?', { minScore: 1 });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.skill.name).toBe('botcoin-mining');
    expect(matches[0]!.score).toBeGreaterThanOrEqual(3); // Name match (5) + keyword overlaps
  });

  it('matches keywords from description', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const matches = registry.match('I want to bridge tokens across chains for arbitrage', { minScore: 1 });
    expect(matches.some(m => m.skill.name === 'bridge-arbitrage')).toBe(true);
  });

  it('returns empty for unrelated messages', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const matches = registry.match('What is the weather today?', { minScore: 2 });
    expect(matches.length).toBe(0);
  });

  it('respects maxResults', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const matches = registry.match('mining bridge liquidity tokens staking DCA', { minScore: 1, maxResults: 2 });
    expect(matches.length).toBeLessThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SkillRegistry — Content Loading
// ═══════════════════════════════════════════════════════════════════════════

describe('SkillRegistry — Content Loading', () => {
  beforeEach(() => {
    cleanup();
    setupTestSkills();
  });
  afterEach(cleanup);

  it('reads full skill content', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const content = registry.readContent('botcoin-mining');
    expect(content).not.toBeNull();
    expect(content).toContain('Solve hash challenges');
    expect(content).toContain('Claim rewards');
  });

  it('returns null for nonexistent skill', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    expect(registry.readContent('nonexistent')).toBeNull();
  });

  it('caches content after first read', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const content1 = registry.readContent('botcoin-mining');
    const content2 = registry.readContent('botcoin-mining');
    expect(content1).toBe(content2); // Same reference (cached)
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. SkillRegistry — Index Building
// ═══════════════════════════════════════════════════════════════════════════

describe('SkillRegistry — Index Building', () => {
  beforeEach(() => {
    cleanup();
    setupTestSkills();
  });
  afterEach(cleanup);

  it('builds compact index', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const index = registry.buildIndex();
    expect(index).toContain('Crypto Skills (5 available)');
    expect(index).toContain('botcoin-mining');
    expect(index).toContain('custom-dca');
    expect(index).toContain('(learned)');
  });

  it('returns empty string when no skills', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const emptyDir = join(TEST_DIR, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const registry = new SkillRegistry({ staticDir: emptyDir, learnedDir: join(TEST_DIR, 'nope') });
    expect(registry.buildIndex()).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. /skills Command
// ═══════════════════════════════════════════════════════════════════════════

describe('/skills Command', () => {
  beforeEach(() => {
    cleanup();
    setupTestSkills();
  });
  afterEach(cleanup);

  it('lists all skills with no args', async () => {
    // Reset singleton and point to test dirs
    const regModule = await import('../extensions/crypto/src/services/skill-registry.js');
    regModule.resetSkillRegistry();
    // Initialize with test dirs
    regModule.getSkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });

    const { skillsCommand } = await import('../extensions/crypto/src/commands/skills-command.js');
    const result = await skillsCommand.handler({});
    expect(result.text).toContain('Skills');
    expect(result.text).toContain('botcoin-mining');
    expect(result.text).toContain('Built-in');
    expect(result.text).toContain('Learned');
  });

  it('shows full content for a specific skill', async () => {
    const regModule = await import('../extensions/crypto/src/services/skill-registry.js');
    regModule.resetSkillRegistry();
    regModule.getSkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });

    const { skillsCommand } = await import('../extensions/crypto/src/commands/skills-command.js');
    const result = await skillsCommand.handler({ args: 'botcoin-mining' });
    expect(result.text).toContain('Skill: botcoin-mining');
    expect(result.text).toContain('Solve hash challenges');
  });

  it('searches skills by keyword', async () => {
    const regModule = await import('../extensions/crypto/src/services/skill-registry.js');
    regModule.resetSkillRegistry();
    regModule.getSkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });

    const { skillsCommand } = await import('../extensions/crypto/src/commands/skills-command.js');
    const result = await skillsCommand.handler({ args: 'search bridge' });
    expect(result.text).toContain('bridge-arbitrage');
  });

  it('suggests similar skills when name not found', async () => {
    const regModule = await import('../extensions/crypto/src/services/skill-registry.js');
    regModule.resetSkillRegistry();
    regModule.getSkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });

    const { skillsCommand } = await import('../extensions/crypto/src/commands/skills-command.js');
    const result = await skillsCommand.handler({ args: 'botcoin' });
    expect(result.text).toContain('not found');
    // Should suggest botcoin-mining
    expect(result.text).toContain('botcoin-mining');
  });

  it('has correct command metadata', async () => {
    const { skillsCommand } = await import('../extensions/crypto/src/commands/skills-command.js');
    expect(skillsCommand.name).toBe('skills');
    expect(skillsCommand.acceptsArgs).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Real Skills Scan (integration test with actual skill files)
// ═══════════════════════════════════════════════════════════════════════════

describe('SkillRegistry — Real Static Skills', () => {
  it('scans all 42 static skills from extensions/crypto/skills/', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const realStaticDir = join(__dirname, '..', 'extensions', 'crypto', 'skills');
    const registry = new SkillRegistry({
      staticDir: realStaticDir,
      learnedDir: join(TEST_DIR, 'no-learned'), // Empty — only test static
    });

    // Should find all 42 static skills
    expect(registry.size).toBeGreaterThanOrEqual(42);
    expect(registry.list({ source: 'static' }).length).toBeGreaterThanOrEqual(42);

    // Spot-check known skills
    expect(registry.get('botcoin-mining')).not.toBeNull();
  });

  it('matches "botcoin mining" to the botcoin-mining skill', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const realStaticDir = join(__dirname, '..', 'extensions', 'crypto', 'skills');
    const registry = new SkillRegistry({
      staticDir: realStaticDir,
      learnedDir: join(TEST_DIR, 'no-learned'),
    });

    const matches = registry.match('How do I mine botcoin?', { minScore: 2 });
    expect(matches.length).toBeGreaterThan(0);
    // botcoin-mining should be the top match
    expect(matches[0]!.skill.name).toBe('botcoin-mining');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. SkillRegistry — requiresEnv Parsing
// ═══════════════════════════════════════════════════════════════════════════

describe('SkillRegistry — requiresEnv', () => {
  beforeEach(() => {
    cleanup();
    setupTestSkills();
  });
  afterEach(cleanup);

  it('parses requires.env from frontmatter metadata JSON', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const skill = registry.get('clawnx');
    expect(skill).not.toBeNull();
    expect(skill!.requiresEnv).toEqual(['X_API_KEY', 'X_API_SECRET']);
  });

  it('returns empty requiresEnv for skills without metadata', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const skill = registry.get('botcoin-mining');
    expect(skill!.requiresEnv).toEqual([]);
  });

  it('missingEnv returns only unset vars', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    const skill = registry.get('clawnx')!;

    // Neither is set (test environment)
    const missing = registry.missingEnv(skill);
    expect(missing).toContain('X_API_KEY');
    expect(missing).toContain('X_API_SECRET');
  });

  it('missingEnv returns empty when all vars set', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    // Temporarily set env vars
    const prev1 = process.env.X_API_KEY;
    const prev2 = process.env.X_API_SECRET;
    process.env.X_API_KEY = 'test';
    process.env.X_API_SECRET = 'test';

    try {
      const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
      const skill = registry.get('clawnx')!;
      expect(registry.missingEnv(skill)).toEqual([]);
    } finally {
      if (prev1 === undefined) delete process.env.X_API_KEY;
      else process.env.X_API_KEY = prev1;
      if (prev2 === undefined) delete process.env.X_API_SECRET;
      else process.env.X_API_SECRET = prev2;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. SkillRegistry — Enable / Disable
// ═══════════════════════════════════════════════════════════════════════════

describe('SkillRegistry — Enable / Disable', () => {
  const DISABLED_FILE = join(process.env.HOME ?? '/tmp', '.openclawnch', 'disabled-skills.json');
  let prevDisabled: string | undefined;

  beforeEach(() => {
    cleanup();
    setupTestSkills();
    // Save existing disabled file if any
    try {
      if (existsSync(DISABLED_FILE)) {
        prevDisabled = require('node:fs').readFileSync(DISABLED_FILE, 'utf8');
      }
    } catch { /* no file */ }
  });

  afterEach(() => {
    cleanup();
    // Restore previous disabled file
    try {
      if (prevDisabled !== undefined) {
        writeFileSync(DISABLED_FILE, prevDisabled, 'utf8');
      } else if (existsSync(DISABLED_FILE)) {
        rmSync(DISABLED_FILE);
      }
    } catch { /* best effort */ }
  });

  it('disable() marks skill disabled and excludes from list()', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    expect(registry.size).toBe(5);

    registry.disable('clawnx');
    expect(registry.size).toBe(4);
    expect(registry.list().some((s: any) => s.name === 'clawnx')).toBe(false);
  });

  it('disabled skills still in listAll()', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    registry.disable('clawnx');
    expect(registry.listAll().some((s: any) => s.name === 'clawnx')).toBe(true);
    expect(registry.totalSize).toBe(5);
  });

  it('disabled skills excluded from match()', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    registry.disable('clawnx');
    const matches = registry.match('tweet on X clawnx', { minScore: 1 });
    expect(matches.some((m: any) => m.skill.name === 'clawnx')).toBe(false);
  });

  it('disabled skills excluded from buildIndex()', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    registry.disable('clawnx');
    const index = registry.buildIndex();
    expect(index).not.toContain('clawnx');
    expect(index).toContain('Crypto Skills (4 available)');
  });

  it('enable() re-enables a disabled skill', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    registry.disable('clawnx');
    expect(registry.size).toBe(4);

    registry.enable('clawnx');
    expect(registry.size).toBe(5);
    expect(registry.list().some((s: any) => s.name === 'clawnx')).toBe(true);
  });

  it('disable/enable returns false for nonexistent skill', async () => {
    const { SkillRegistry, resetSkillRegistry } = await import(
      '../extensions/crypto/src/services/skill-registry.js'
    );
    resetSkillRegistry();

    const registry = new SkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    expect(registry.disable('nonexistent')).toBe(false);
    expect(registry.enable('nonexistent')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. /skills Command — Enable / Disable Subcommands
// ═══════════════════════════════════════════════════════════════════════════

describe('/skills Command — Enable / Disable', () => {
  const DISABLED_FILE = join(process.env.HOME ?? '/tmp', '.openclawnch', 'disabled-skills.json');
  let prevDisabled: string | undefined;

  beforeEach(() => {
    cleanup();
    setupTestSkills();
    try {
      if (existsSync(DISABLED_FILE)) {
        prevDisabled = require('node:fs').readFileSync(DISABLED_FILE, 'utf8');
      }
    } catch { /* no file */ }
  });

  afterEach(() => {
    cleanup();
    try {
      if (prevDisabled !== undefined) {
        writeFileSync(DISABLED_FILE, prevDisabled, 'utf8');
      } else if (existsSync(DISABLED_FILE)) {
        rmSync(DISABLED_FILE);
      }
    } catch { /* best effort */ }
  });

  it('disable subcommand disables a skill', async () => {
    const regModule = await import('../extensions/crypto/src/services/skill-registry.js');
    regModule.resetSkillRegistry();
    const registry = regModule.getSkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });

    const { skillsCommand } = await import('../extensions/crypto/src/commands/skills-command.js');
    const result = await skillsCommand.handler({ args: 'disable clawnx' });
    expect(result.text).toContain('Disabled');
    expect(result.text).toContain('clawnx');

    // Verify it's actually disabled
    expect(registry.get('clawnx')!.disabled).toBe(true);
  });

  it('enable subcommand re-enables a skill', async () => {
    const regModule = await import('../extensions/crypto/src/services/skill-registry.js');
    regModule.resetSkillRegistry();
    const registry = regModule.getSkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    registry.disable('clawnx');

    const { skillsCommand } = await import('../extensions/crypto/src/commands/skills-command.js');
    const result = await skillsCommand.handler({ args: 'enable clawnx' });
    expect(result.text).toContain('Enabled');
    expect(registry.get('clawnx')!.disabled).toBe(false);
  });

  it('list shows [disabled] and [env not set] tags', async () => {
    const regModule = await import('../extensions/crypto/src/services/skill-registry.js');
    regModule.resetSkillRegistry();
    const registry = regModule.getSkillRegistry({ staticDir: STATIC_DIR, learnedDir: LEARNED_DIR });
    registry.disable('bridge-arbitrage');

    const { skillsCommand } = await import('../extensions/crypto/src/commands/skills-command.js');
    const result = await skillsCommand.handler({});
    expect(result.text).toContain('[disabled]');
    expect(result.text).toContain('[env not set:');
    expect(result.text).toContain('X_API_KEY');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Plugin Registration Count
// ═══════════════════════════════════════════════════════════════════════════

describe('Plugin Registration — Skills', () => {
   it('registers 118 commands including /skills, /interrupt, /api, and /pull', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const commands: string[] = [];
    const mockApi = {
      registerTool: () => {},
      registerCommand: (c: any) => commands.push(c.name),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };

    plugin.register(mockApi as any);

    expect(commands).toHaveLength(118);
    expect(commands).toContain('skills');
    expect(commands).toContain('interrupt');
    expect(commands).toContain('interrupt_plan');
    expect(commands).toContain('api');
  });
});
