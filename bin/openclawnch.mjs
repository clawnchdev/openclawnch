#!/usr/bin/env node

/**
 * OpenClawnch — OpenClaw for crypto.
 * 
 * Thin wrapper that delegates to OpenClaw with the crypto extension
 * pre-configured. All CLI commands pass through to OpenClaw.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = dirname(__dirname);

// ─── Config paths ──────────────────────────────────────────────────────────
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '';
const OPENCLAWNCH_DIR = join(HOME, '.openclawnch');
const OPENCLAW_DIR = join(HOME, '.openclaw');
const OPENCLAW_CONFIG = join(OPENCLAW_DIR, 'openclaw.json');

// ─── Ensure directories ───────────────────────────────────────────────────
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Inject crypto extension into OpenClaw config ─────────────────────────
function ensureCryptoExtension() {
  ensureDir(OPENCLAW_DIR);
  ensureDir(OPENCLAWNCH_DIR);

  let config = {};
  if (existsSync(OPENCLAW_CONFIG)) {
    try {
      config = JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf8'));
    } catch {
      // Corrupted config — start fresh
    }
  }

  // Register our extension via plugins.load.paths (how OpenClaw discovers plugins)
  const extensionPath = join(ROOT, 'extensions', 'crypto');
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.load) config.plugins.load = {};
  if (!config.plugins.load.paths) config.plugins.load.paths = [];

  if (!config.plugins.load.paths.includes(extensionPath)) {
    config.plugins.load.paths.push(extensionPath);
  }

  // Enable the plugin entry
  if (!config.plugins.entries) config.plugins.entries = {};
  if (!config.plugins.entries['@clawnch/openclaw-crypto']) {
    config.plugins.entries['@clawnch/openclaw-crypto'] = { enabled: true };
  }

  // Ensure crypto skills are discoverable
  if (!config.skills) config.skills = {};
  if (!config.skills.load) config.skills.load = {};
  if (!config.skills.load.extraDirs) config.skills.load.extraDirs = [];

  const skillsDir = join(extensionPath, 'skills');
  if (!config.skills.load.extraDirs.includes(skillsDir)) {
    config.skills.load.extraDirs.push(skillsDir);
  }

  writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2), 'utf8');
}

// ─── Install SOUL.md if user hasn't customized it ─────────────────────────
function ensureSoul() {
  const workspace = join(OPENCLAW_DIR, 'workspace');
  ensureDir(workspace);

  const soulDest = join(workspace, 'SOUL.md');
  const soulSrc = join(ROOT, 'SOUL.md');

  // Only install if no SOUL.md exists (don't overwrite user customizations)
  if (!existsSync(soulDest) && existsSync(soulSrc)) {
    copyFileSync(soulSrc, soulDest);
  }
}

// ─── Resolve openclaw binary ──────────────────────────────────────────────
function resolveOpenClaw() {
  // Try local node_modules first (when installed as dependency)
  const localBin = join(ROOT, 'node_modules', '.bin', 'openclaw');
  if (existsSync(localBin)) return localBin;

  // Try global
  try {
    const globalPath = execFileSync('which', ['openclaw'], { encoding: 'utf8' }).trim();
    if (globalPath) return globalPath;
  } catch {
    // Not found globally
  }

  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // Handle openclawnch-specific commands
  if (args[0] === 'version' || args[0] === '--version' || args[0] === '-v') {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    console.log(`OpenClawnch v${pkg.version}`);
    console.log('OpenClaw for crypto. Same assistant. Now it handles real money.');
    process.exit(0);
  }

  // Deploy command — provisions a personal DeFi agent on Fly.io + Telegram
  if (args[0] === 'deploy') {
    const { deployCli } = await import('../dist/deploy.js');
    await deployCli(args.slice(1));
    return;
  }

  // Ensure config is set up
  ensureCryptoExtension();
  ensureSoul();

  // Find openclaw
  const openclawBin = resolveOpenClaw();
  if (!openclawBin) {
    console.error('Error: openclaw not found.');
    console.error('Install it: npm install -g openclaw');
    console.error('Or add it as a dependency: npm install openclaw');
    process.exit(1);
  }

  // Pass through all args to openclaw
  const child = spawn(openclawBin, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Signal to the extension that we're running via OpenClawnch
      OPENCLAWNCH: '1',
      // Session persistence path
      OPENCLAWNCH_DIR,
    },
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    console.error(`Failed to start openclaw: ${err.message}`);
    process.exit(1);
  });
}

main();
