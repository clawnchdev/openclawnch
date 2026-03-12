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
  // Clean up old scoped key if present
  if (config.plugins.entries['@clawnch/openclaw-crypto']) {
    delete config.plugins.entries['@clawnch/openclaw-crypto'];
  }
  if (!config.plugins.entries['openclaw-crypto']) {
    config.plugins.entries['openclaw-crypto'] = { enabled: true };
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
  // 1. Bundled openclaw (installed as a dependency of openclawnch)
  const bundledBin = join(ROOT, 'node_modules', '.bin', 'openclaw');
  if (existsSync(bundledBin)) return bundledBin;

  // 2. Sibling install (both globally installed via npm)
  try {
    const globalPath = execFileSync('which', ['openclaw'], { encoding: 'utf8' }).trim();
    if (globalPath) return globalPath;
  } catch {
    // Not found globally
  }

  return null;
}

// ─── Report bundled openclaw version ──────────────────────────────────────
function getOpenClawVersion() {
  try {
    const ocPkg = join(ROOT, 'node_modules', 'openclaw', 'package.json');
    if (existsSync(ocPkg)) {
      return JSON.parse(readFileSync(ocPkg, 'utf8')).version;
    }
  } catch {}
  return null;
}

// ─── Load .env (no dependencies — simple key=value parser) ───────────────
function loadDotEnv() {
  // Check common .env locations: cwd, then openclawnch dir
  const candidates = [
    join(process.cwd(), '.env'),
    join(OPENCLAWNCH_DIR, '.env'),
    join(ROOT, '.env'),
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const contents = readFileSync(envPath, 'utf8');
      for (const line of contents.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        // Don't override existing env vars (explicit exports take precedence)
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      return; // Only load the first .env found
    } catch {
      // Ignore read errors
    }
  }
}

// ─── Startup banner ──────────────────────────────────────────────────────
function printBanner() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const ocVersion = getOpenClawVersion();

  const G = '\x1b[32m'; // green
  const Y = '\x1b[33m'; // yellow
  const R = '\x1b[31m'; // red
  const D = '\x1b[2m';  // dim
  const B = '\x1b[1m';  // bold
  const X = '\x1b[0m';  // reset

  const ok = (label, detail) => `  ${G}✓${X} ${label}  ${D}${detail}${X}`;
  const warn = (label, detail) => `  ${Y}!${X} ${label}  ${D}${detail}${X}`;
  const fail = (label, detail) => `  ${R}✗${X} ${label}  ${D}${detail}${X}`;

  console.log('');
  console.log(`  ${B}OpenClawnch${X} v${pkg.version}${ocVersion ? `  ${D}(OpenClaw v${ocVersion})${X}` : ''}`);
  console.log('');

  // ── LLM ──
  const llmKey = process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || process.env.BANKR_LLM_KEY;
  if (llmKey) {
    let provider = 'Unknown';
    if (process.env.ANTHROPIC_API_KEY) provider = 'Anthropic';
    else if (process.env.OPENROUTER_API_KEY) provider = 'OpenRouter';
    else if (process.env.OPENAI_API_KEY) provider = 'OpenAI';
    else if (process.env.BANKR_LLM_KEY) provider = 'Bankr Gateway';
    console.log(ok('LLM', provider));
  } else {
    console.log(fail('LLM', 'No API key found — run: openclawnch init'));
  }

  // ── Channel ──
  const channels = [];
  if (process.env.TELEGRAM_BOT_TOKEN) channels.push('Telegram');
  if (process.env.DISCORD_TOKEN) channels.push('Discord');
  if (process.env.SLACK_BOT_TOKEN) channels.push('Slack');

  if (channels.length > 0) {
    console.log(ok('Channel', channels.join(', ')));
  } else {
    console.log(fail('Channel', 'No channel token found — run: openclawnch init'));
  }

  // ── Wallet ──
  if (process.env.WALLETCONNECT_PROJECT_ID) {
    console.log(ok('Wallet', 'WalletConnect ready (use /connect in chat)'));
  } else if (process.env.CLAWNCHER_PRIVATE_KEY && process.env.ALLOW_PRIVATE_KEY_MODE === 'true') {
    console.log(warn('Wallet', 'Private key mode (auto-sign enabled)'));
  } else if (process.env.BANKR_API_KEY) {
    console.log(ok('Wallet', 'Bankr custodial'));
  } else {
    console.log(warn('Wallet', 'Not configured — use /connect in chat'));
  }

  // ── Missing essentials guard ──
  if (!llmKey || channels.length === 0) {
    console.log('');
    console.log(`  ${R}Missing required configuration.${X}`);
    console.log(`  Run ${B}openclawnch init${X} to set up, or see docs/SETUP.md`);
    console.log('');
    process.exit(1);
  }

  // ── Optional keys summary ──
  const optionalKeys = [
    ['ALCHEMY_API_KEY', 'Alchemy RPC'],
    ['ZEROX_API_KEY', '0x DEX'],
    ['BASESCAN_API_KEY', 'Basescan'],
    ['HERD_ACCESS_TOKEN', 'Herd Intel'],
    ['COINGECKO_API_KEY', 'CoinGecko'],
    ['CMC_API_KEY', 'CoinMarketCap'],
    ['X_API_KEY', 'ClawnX'],
    ['HUMMINGBOT_API_URL', 'Hummingbot'],
  ];
  const configuredOptional = optionalKeys.filter(([k]) => process.env[k]);

  if (configuredOptional.length > 0) {
    const names = configuredOptional.map(([, n]) => n).join(', ');
    console.log(ok('APIs', names));
  }

  console.log('');
  console.log(`  ${D}Run /setup in chat to see all tool status${X}`);
  console.log(`  ${D}Run /doctor for a full diagnostic check${X}`);
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // Handle openclawnch-specific commands
  if (args[0] === 'version' || args[0] === '--version' || args[0] === '-v') {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const ocVersion = getOpenClawVersion();
    console.log(`OpenClawnch v${pkg.version}`);
    if (ocVersion) console.log(`OpenClaw    v${ocVersion} (bundled)`);
    console.log('OpenClaw for crypto. Same assistant. Now it handles real money.');
    process.exit(0);
  }

  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const ocVersion = getOpenClawVersion();
    console.log('');
    console.log(`  OpenClawnch v${pkg.version}${ocVersion ? ` (OpenClaw v${ocVersion})` : ''}`);
    console.log('  OpenClaw for crypto. Same assistant. Now it handles real money.');
    console.log('');
    console.log('  Usage:');
    console.log('    openclawnch              Start the agent (requires LLM key + channel token)');
    console.log('    openclawnch init         Interactive setup wizard — creates your .env');
    console.log('    openclawnch deploy       Deploy to Fly.io as a Telegram bot');
    console.log('    openclawnch version      Show version info');
    console.log('    openclawnch help         Show this help');
    console.log('');
    console.log('  In-chat commands:');
    console.log('    /setup                   Show tool status (X/42 tools ready)');
    console.log('    /doctor                  Run 13 diagnostic checks');
    console.log('    /connect                 Connect a mobile wallet via WalletConnect');
    console.log('    /wallet                  Show wallet status and balances');
    console.log('    /policy <rules>          Set spending policies');
    console.log('    /help                    Full command reference');
    console.log('');
    console.log('  Docs:   https://openclawn.ch/docs');
    console.log('  GitHub: https://github.com/clawnch/openclawnch');
    console.log('');
    process.exit(0);
  }

  // Init command — interactive setup wizard
  if (args[0] === 'init' || args[0] === 'setup') {
    const { initCli } = await import('../dist/init.js');
    await initCli(args.slice(1));
    return;
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

  // Load .env if present (don't override existing env vars)
  loadDotEnv();

  // Print startup banner with config status
  printBanner();

  // Find openclaw (bundled as a dependency — should always resolve)
  const openclawBin = resolveOpenClaw();
  if (!openclawBin) {
    console.error('Error: openclaw binary not found.');
    console.error('This usually means node_modules is missing or corrupted.');
    console.error('Try: npm install   (or pnpm install)');
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
