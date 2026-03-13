/**
 * Update Service — in-place update from GitHub + Fly restart.
 *
 * Flow:
 *   1. Clone latest code from GitHub (shallow, depth 1)
 *   2. Install deps + build + pack tarball
 *   3. Extract tarball over the installed extension
 *   4. Restart the Fly machine via Machines API
 *
 * All steps report progress via a callback so the user sees
 * live updates in Telegram.
 *
 * Prerequisites:
 *   - FLY_API_TOKEN (for restart) — already required for /flykeys etc.
 *   - git, npm, node in the container — present in Dockerfile layer 1
 */

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isFlyControlAvailable, restartAllMachines } from './fly-control-service.js';

const execFile = promisify(execFileCb);

// ─── Config ──────────────────────────────────────────────────────────────

const REPO_URL = 'https://github.com/clawnchbot/openclawnch.git';
const BRANCH = 'master';
const WORK_DIR = '/tmp/openclawnch-update';
const EXTENSION_DEST = '/usr/local/lib/node_modules/@clawnch/openclawnch';

/** Max time for the entire update (5 min). */
const UPDATE_TIMEOUT_MS = 5 * 60_000;

/** Max time per shell command (3 min). */
const CMD_TIMEOUT_MS = 3 * 60_000;

// ─── Types ───────────────────────────────────────────────────────────────

export type ProgressFn = (msg: string) => void | Promise<void>;

export interface UpdateResult {
  success: boolean;
  message: string;
  newCommit?: string;
  commits?: string[];
  durationMs?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<string> {
  const { stdout } = await execFile(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? CMD_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    env: { ...process.env, NODE_ENV: 'development' }, // Need dev deps for build
  });
  return stdout.trim();
}

/** Get the currently installed commit hash (if available). */
export function getCurrentCommit(): string | null {
  try {
    // Check for a baked-in commit file (set during npm pack)
    const commitFile = join(EXTENSION_DEST, '.commit');
    if (existsSync(commitFile)) {
      return readFileSync(commitFile, 'utf8').trim();
    }
    // Fallback: try package.json version
    const pkg = join(EXTENSION_DEST, 'package.json');
    if (existsSync(pkg)) {
      const data = JSON.parse(readFileSync(pkg, 'utf8'));
      return data.version ?? null;
    }
  } catch { /* */ }
  return null;
}

// ─── Check for Updates ──────────────────────────────────────────────────

export interface UpdateCheck {
  available: boolean;
  currentRef: string | null;
  remoteRef: string | null;
  newCommits: string[];
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  const current = getCurrentCommit();

  try {
    // Get remote HEAD sha
    const lsRemote = await run('git', ['ls-remote', REPO_URL, `refs/heads/${BRANCH}`]);
    const remoteRef = lsRemote.split(/\s/)[0] ?? null;

    if (!remoteRef) {
      return { available: false, currentRef: current, remoteRef: null, newCommits: [] };
    }

    // If we don't know our current commit, assume update is available
    if (!current || current !== remoteRef?.slice(0, current.length)) {
      // Get recent commit messages
      let newCommits: string[] = [];
      try {
        const log = await run('git', [
          'ls-remote', '--refs', REPO_URL,
        ], { timeout: 10_000 });
        // Can't get commit messages without cloning, so just report "updates available"
        newCommits = ['(clone required to see details)'];
      } catch { /* */ }

      return {
        available: true,
        currentRef: current,
        remoteRef: remoteRef.slice(0, 12),
        newCommits,
      };
    }

    return { available: false, currentRef: current, remoteRef: remoteRef.slice(0, 12), newCommits: [] };
  } catch {
    return { available: false, currentRef: current, remoteRef: null, newCommits: [] };
  }
}

// ─── Perform Update ─────────────────────────────────────────────────────

export async function performUpdate(progress: ProgressFn): Promise<UpdateResult> {
  const start = Date.now();

  // ── Preflight ──────────────────────────────────────────────────────
  if (!isFlyControlAvailable()) {
    return {
      success: false,
      message: 'Fly.io not configured. Set FLY_API_TOKEN to enable /update.\n'
        + 'Run: `fly secrets set FLY_API_TOKEN="$(fly tokens create deploy -a <app>)" -a <app>`',
    };
  }

  try {
    // ── Step 1: Clone ────────────────────────────────────────────────
    await progress('1/6 Cloning latest code...');
    if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
    await run('git', ['clone', '--depth', '1', '--branch', BRANCH, REPO_URL, WORK_DIR]);

    // Read the new commit SHA
    const newCommit = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: WORK_DIR });
    const commitMsg = await run('git', ['log', '-1', '--format=%s'], { cwd: WORK_DIR });
    await progress(`1/6 Cloned: ${newCommit} — ${commitMsg}`);

    // ── Step 2: Install deps ─────────────────────────────────────────
    await progress('2/6 Installing dependencies...');
    // Check if pnpm is available, fall back to npm
    let pm = 'npm';
    try {
      await run('pnpm', ['--version']);
      pm = 'pnpm';
    } catch { /* npm fallback */ }

    if (pm === 'pnpm') {
      await run('pnpm', ['install', '--frozen-lockfile'], { cwd: WORK_DIR });
    } else {
      await run('npm', ['install'], { cwd: WORK_DIR });
    }
    await progress('2/6 Dependencies installed');

    // ── Step 3: Build ────────────────────────────────────────────────
    await progress('3/6 Building...');
    await run(pm, ['run', 'build'], { cwd: WORK_DIR });
    await progress('3/6 Build complete');

    // ── Step 4: Pack tarball ─────────────────────────────────────────
    await progress('4/6 Packing extension...');
    // npm pack creates a .tgz in the cwd
    const packOutput = await run(pm, ['pack'], { cwd: WORK_DIR });
    const tgzName = packOutput.split('\n').pop()?.trim() ?? '';
    const tgzPath = join(WORK_DIR, tgzName);

    if (!existsSync(tgzPath)) {
      return { success: false, message: `Pack failed — tarball not found at ${tgzPath}` };
    }
    await progress('4/6 Tarball packed');

    // ── Step 5: Extract over existing ────────────────────────────────
    await progress('5/6 Installing update...');
    // Clear existing and extract
    if (existsSync(EXTENSION_DEST)) {
      // Preserve node_modules (Uniswap deps installed separately in Dockerfile)
      const nodeModules = join(EXTENSION_DEST, 'node_modules');
      const hasNodeModules = existsSync(nodeModules);

      // Extract tarball (npm pack creates package/ prefix)
      await run('tar', [
        'xzf', tgzPath,
        '-C', EXTENSION_DEST,
        '--strip-components=1',
      ]);

      // Write the commit SHA for future version detection
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(EXTENSION_DEST, '.commit'), newCommit, 'utf8');
    }
    await progress('5/6 Update installed');

    // ── Step 6: Restart ──────────────────────────────────────────────
    await progress('6/6 Restarting machine...');
    const restarted = await restartAllMachines();

    // ── Cleanup ──────────────────────────────────────────────────────
    try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* */ }

    const duration = Date.now() - start;
    return {
      success: true,
      message: `Updated to ${newCommit}. ${restarted.length} machine(s) restarting.\n`
        + `Duration: ${(duration / 1000).toFixed(1)}s`,
      newCommit,
      durationMs: duration,
    };
  } catch (err) {
    // Cleanup on failure
    try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* */ }

    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: `Update failed: ${msg}`,
      durationMs: Date.now() - start,
    };
  }
}
