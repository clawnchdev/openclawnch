/**
 * Issue Reporter Service — file GitHub issues from chat.
 *
 * Persistent opt-in per user. When enabled, the agent can proactively
 * suggest filing issues when it detects bugs, errors, or UX problems.
 *
 * Issues are filed via `gh issue create` against the openclawnch repo.
 * Requires `gh` CLI installed and authenticated.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ── Config ──────────────────────────────────────────────────────────────

const REPO = 'clawnchbot/openclawnch';
const MAX_BODY_CHARS = 4000;

interface IssueReporterConfig {
  /** Whether the user has opted in to issue reporting. */
  enabled: boolean;
  /** ISO timestamp of when opt-in was granted. */
  optedInAt?: string;
  /** Number of issues filed. */
  issueCount: number;
}

const DEFAULT_CONFIG: IssueReporterConfig = {
  enabled: false,
  issueCount: 0,
};

// ── State ───────────────────────────────────────────────────────────────

const configCache = new Map<string, IssueReporterConfig>();

function getStateDir(): string {
  return process.env.OPENCLAWNCH_STATE_DIR
    ? join(process.env.OPENCLAWNCH_STATE_DIR, 'issue-reporter')
    : join(process.env.HOME ?? '/tmp', '.openclawnch', 'issue-reporter');
}

function ensureDir(): void {
  const dir = getStateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_\-. ]/g, '_').slice(0, 64);
}

function configPath(userId: string): string {
  return join(getStateDir(), `${sanitizeUserId(userId)}.json`);
}

// ── Public API ──────────────────────────────────────────────────────────

export function getReporterConfig(userId: string): IssueReporterConfig {
  const cached = configCache.get(userId);
  if (cached) return cached;

  const path = configPath(userId);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as IssueReporterConfig;
      configCache.set(userId, raw);
      return raw;
    } catch {
      // Corrupted file — return default
    }
  }
  return { ...DEFAULT_CONFIG };
}

export function isReportingEnabled(userId: string): boolean {
  return getReporterConfig(userId).enabled;
}

export function enableReporting(userId: string): void {
  ensureDir();
  const config: IssueReporterConfig = {
    ...getReporterConfig(userId),
    enabled: true,
    optedInAt: new Date().toISOString(),
  };
  writeFileSync(configPath(userId), JSON.stringify(config, null, 2));
  configCache.set(userId, config);
}

export function disableReporting(userId: string): void {
  ensureDir();
  const config: IssueReporterConfig = {
    ...getReporterConfig(userId),
    enabled: false,
  };
  writeFileSync(configPath(userId), JSON.stringify(config, null, 2));
  configCache.set(userId, config);
}

/**
 * File a GitHub issue. Returns the issue URL on success.
 *
 * Labels are auto-applied:
 *   - `from-agent` on every issue
 *   - `bug` / `enhancement` / `question` based on the category param
 */
export function fileIssue(opts: {
  title: string;
  body: string;
  category: 'bug' | 'feature' | 'ux' | 'question';
  userId: string;
}): { url: string } | { error: string } {
  const config = getReporterConfig(opts.userId);
  if (!config.enabled) {
    return { error: 'Issue reporting is not enabled. Use /report_opt_in to enable.' };
  }

  // Verify gh CLI is available
  try {
    execSync('gh auth status', { stdio: 'pipe', timeout: 5000 });
  } catch {
    return { error: 'GitHub CLI (gh) is not authenticated. Run `gh auth login` first.' };
  }

  const labelMap: Record<string, string> = {
    bug: 'bug',
    feature: 'enhancement',
    ux: 'ux',
    question: 'question',
  };
  const label = labelMap[opts.category] ?? 'bug';

  // Truncate body to prevent massive issues
  const body = opts.body.length > MAX_BODY_CHARS
    ? opts.body.slice(0, MAX_BODY_CHARS) + '\n\n---\n*[Truncated — full context exceeded limit]*'
    : opts.body;

  // Build the issue body with metadata footer
  const fullBody = [
    body,
    '',
    '---',
    `*Filed by OpenClawnch agent on behalf of user. Category: ${opts.category}.*`,
  ].join('\n');

  try {
    const result = execSync(
      `gh issue create --repo ${REPO} --title ${shellEscape(opts.title)} --body ${shellEscape(fullBody)} --label from-agent --label ${shellEscape(label)}`,
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe' },
    ).trim();

    // gh issue create prints the URL on success
    const url = result.split('\n').pop() ?? result;

    // Update issue count
    ensureDir();
    const updated: IssueReporterConfig = {
      ...config,
      issueCount: config.issueCount + 1,
    };
    writeFileSync(configPath(opts.userId), JSON.stringify(updated, null, 2));
    configCache.set(opts.userId, updated);

    return { url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Don't leak full stderr — extract just the useful part
    if (msg.includes('label')) {
      // Labels may not exist on the repo yet — retry without labels
      try {
        const result = execSync(
          `gh issue create --repo ${REPO} --title ${shellEscape(opts.title)} --body ${shellEscape(fullBody)}`,
          { encoding: 'utf8', timeout: 15000, stdio: 'pipe' },
        ).trim();
        const url = result.split('\n').pop() ?? result;
        return { url };
      } catch (retryErr) {
        return { error: `Failed to create issue: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}` };
      }
    }
    return { error: `Failed to create issue: ${msg}` };
  }
}

/** Reset for testing. */
export function resetReporter(): void {
  configCache.clear();
}

// ── Helpers ─────────────────────────────────────────────────────────────

function shellEscape(s: string): string {
  // Use $'...' syntax to handle newlines and special chars
  return "$'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
}
