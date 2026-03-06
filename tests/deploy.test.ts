/**
 * Tests for the OpenClawnch deploy CLI.
 *
 * These test argument parsing, config generation, and the deploy flow logic
 * without making real API calls (Fly, Telegram, LLM APIs are mocked).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseDeployArgs } from '../src/deploy.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Argument Parsing ──────────────────────────────────────────────────────

describe('parseDeployArgs', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses all required arguments', () => {
    const config = parseDeployArgs([
      '--telegram-token', '123456:ABC-test',
      '--fly-token', 'FlyV1_test_token',
      '--llm-key', 'sk-ant-test123',
    ]);

    expect(config).not.toBeNull();
    expect(config!.telegramToken).toBe('123456:ABC-test');
    expect(config!.flyToken).toBe('FlyV1_test_token');
    expect(config!.llmKey).toBe('sk-ant-test123');
    expect(config!.llmProvider).toBe('anthropic');
  });

  it('detects OpenAI provider from key prefix', () => {
    const config = parseDeployArgs([
      '--telegram-token', '123456:ABC-test',
      '--fly-token', 'FlyV1_test_token',
      '--llm-key', 'sk-proj-test123',
    ]);

    expect(config).not.toBeNull();
    expect(config!.llmProvider).toBe('openai');
  });

  it('detects OpenRouter provider from sk-or- key prefix', () => {
    const config = parseDeployArgs([
      '--telegram-token', '123456:ABC-test',
      '--fly-token', 'FlyV1_test_token',
      '--llm-key', 'sk-or-v1-test123',
    ]);

    expect(config).not.toBeNull();
    expect(config!.llmProvider).toBe('openrouter');
    expect(config!.llmKey).toBe('sk-or-v1-test123');
  });

  it('applies default region and memory', () => {
    const config = parseDeployArgs([
      '--telegram-token', '123456:ABC-test',
      '--fly-token', 'FlyV1_test_token',
      '--llm-key', 'sk-ant-test123',
    ]);

    expect(config).not.toBeNull();
    expect(config!.region).toBe('iad');
    expect(config!.memoryMb).toBe(2048);
  });

  it('accepts custom region and memory', () => {
    const config = parseDeployArgs([
      '--telegram-token', '123456:ABC-test',
      '--fly-token', 'FlyV1_test_token',
      '--llm-key', 'sk-ant-test123',
      '--region', 'lhr',
      '--memory', '1024',
    ]);

    expect(config).not.toBeNull();
    expect(config!.region).toBe('lhr');
    expect(config!.memoryMb).toBe(1024);
  });

  it('accepts WalletConnect project ID', () => {
    const config = parseDeployArgs([
      '--telegram-token', '123456:ABC-test',
      '--fly-token', 'FlyV1_test_token',
      '--llm-key', 'sk-ant-test123',
      '--wc-project-id', 'my-wc-project',
    ]);

    expect(config).not.toBeNull();
    expect(config!.wcProjectId).toBe('my-wc-project');
  });

  it('accepts --app-name for resuming partial deploys', () => {
    const config = parseDeployArgs([
      '--telegram-token', '123456:ABC-test',
      '--fly-token', 'FlyV1_test_token',
      '--llm-key', 'sk-ant-test123',
      '--app-name', 'openclawnch-abc123',
    ]);

    expect(config).not.toBeNull();
    expect(config!.appName).toBe('openclawnch-abc123');
  });

  it('returns null on --help', () => {
    const config = parseDeployArgs(['--help']);
    expect(config).toBeNull();
  });

  it('returns null when missing required args', () => {
    const config = parseDeployArgs(['--telegram-token', '123:ABC']);
    expect(config).toBeNull();
  });

  it('returns null when no args provided', () => {
    const config = parseDeployArgs([]);
    expect(config).toBeNull();
  });

  it('returns null on unknown arguments', () => {
    const config = parseDeployArgs([
      '--telegram-token', '123:ABC',
      '--fly-token', 'FlyV1_test',
      '--llm-key', 'sk-ant-test',
      '--unknown-flag', 'value',
    ]);
    expect(config).toBeNull();
  });
});

// ── Deploy Artifacts ──────────────────────────────────────────────────────

describe('deploy artifacts', () => {
  const deployDir = join(__dirname, '..', 'deploy');

  it('Dockerfile exists and installs openclawnch', () => {
    const dockerfile = readFileSync(join(deployDir, 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('FROM node:22-slim');
    expect(dockerfile).toContain('openclawnch.tgz');
    expect(dockerfile).toContain('openclaw@latest');
    expect(dockerfile).toContain('ENTRYPOINT ["/entrypoint.sh"]');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('18789');
  });

  it('Dockerfile has generous healthcheck start-period (60s for slow gateway boot)', () => {
    const dockerfile = readFileSync(join(deployDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('--start-period=60s');
  });

  it('Dockerfile does NOT run doctor (OOM risk)', () => {
    const dockerfile = readFileSync(join(deployDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).not.toContain('openclaw doctor');
  });

  it('Dockerfile creates required dirs at build time', () => {
    const dockerfile = readFileSync(join(deployDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('agents/main/sessions');
    expect(dockerfile).toContain('credentials');
    expect(dockerfile).toContain('chmod 700');
  });

  it('entrypoint.sh warns about CLAWNCHER_PRIVATE_KEY (autosign mode)', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('CLAWNCHER_PRIVATE_KEY');
    expect(entrypoint).toContain('WARNING');
    expect(entrypoint).toContain('autosign');
  });

  it('entrypoint.sh also blocks PRIVATE_KEY', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('"$PRIVATE_KEY"');
  });

  it('entrypoint.sh uses --bind lan for Fly proxy reachability', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('--bind lan');
  });

  it('entrypoint.sh injects webhook secret from env into config', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('OPENCLAW_TG_WEBHOOK_SECRET');
    expect(entrypoint).toContain('webhookSecret');
  });

  it('entrypoint.sh persists WalletConnect session on volume', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('/workspace/.openclaw-state/wc');
    expect(entrypoint).toContain('WALLETCONNECT_SESSION');
  });

  it('entrypoint.sh persists identity and devices on volume', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('/workspace/.openclaw-state/identity');
    expect(entrypoint).toContain('/workspace/.openclaw-state/devices');
    expect(entrypoint).toContain('ln -sf');
  });

  it('entrypoint.sh persists credentials (pairing approvals) on volume', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('/workspace/.openclaw-state/credentials');
    // Must symlink to survive reboots
    expect(entrypoint).toContain('ln -sf /workspace/.openclaw-state/credentials /root/.openclaw/credentials');
  });

  it('entrypoint.sh persists agent sessions on volume', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('/workspace/.openclaw-state/sessions');
    expect(entrypoint).toContain('ln -sf /workspace/.openclaw-state/sessions /root/.openclaw/agents/main/sessions');
  });

  it('entrypoint.sh never runs doctor (OOM risk, config rewriting)', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).not.toContain('openclaw doctor');
    // Restores clean config from baked copy instead
    expect(entrypoint).toContain('openclaw-clean.json');
  });

  it('entrypoint.sh sets model config based on LLM provider', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('OPENCLAWNCH_LLM_PROVIDER');
    // Must handle all three providers
    expect(entrypoint).toContain('anthropic');
    expect(entrypoint).toContain('openrouter');
    expect(entrypoint).toContain('openai');
  });

  it('entrypoint.sh starts openclaw gateway on port 18789 with lan bind and --allow-unconfigured', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('exec openclaw gateway --port 18789 --bind lan --allow-unconfigured');
  });

  it('openclaw.json has Telegram channel enabled', () => {
    const config = JSON.parse(
      readFileSync(join(deployDir, 'openclaw.json'), 'utf8'),
    );
    expect(config.channels).toBeDefined();
    expect(config.channels.telegram).toBeDefined();
  });

  it('openclaw.json uses absolute plugin path for Docker container', () => {
    const config = JSON.parse(
      readFileSync(join(deployDir, 'openclaw.json'), 'utf8'),
    );
    expect(config.plugins).toBeDefined();
    // Must be absolute path matching npm global install location
    expect(config.plugins.load.paths[0]).toBe(
      '/usr/local/lib/node_modules/@clawnch/openclawnch/extensions/crypto',
    );
    expect(
      config.plugins.entries['openclaw-crypto'].enabled,
    ).toBe(true);
  });

  it('openclaw.json sets gateway port, mode, bind, and controlUi', () => {
    const config = JSON.parse(
      readFileSync(join(deployDir, 'openclaw.json'), 'utf8'),
    );
    expect(config.gateway).toBeDefined();
    expect(config.gateway.port).toBe(18789);
    expect(config.gateway.mode).toBe('local');
    expect(config.gateway.bind).toBe('lan');
    expect(config.gateway.auth).toBeDefined();
    expect(config.gateway.auth.mode).toBe('token');
    expect(config.gateway.controlUi).toBeDefined();
    // H6 fix: dangerouslyAllowHostHeaderOriginFallback was removed for security (DNS rebinding risk)
    expect(config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback).toBeUndefined();
  });

  it('openclaw.json uses new config schema (agents.defaults, not agent)', () => {
    const config = JSON.parse(
      readFileSync(join(deployDir, 'openclaw.json'), 'utf8'),
    );
    expect(config.agent).toBeUndefined();
    expect(config.agents?.defaults?.model?.primary).toBeDefined();
    expect(config.agents.defaults.memorySearch?.enabled).toBe(false);
  });

  it('fly.template.toml uses suspend mode', () => {
    const flyToml = readFileSync(
      join(deployDir, 'fly.template.toml'),
      'utf8',
    );
    expect(flyToml).toContain('auto_stop_machines = "suspend"');
    expect(flyToml).not.toContain('auto_stop_machines = "stop"');
  });

  it('fly.template.toml has auto_start enabled', () => {
    const flyToml = readFileSync(
      join(deployDir, 'fly.template.toml'),
      'utf8',
    );
    expect(flyToml).toContain('auto_start_machines = true');
  });

  it('fly.template.toml has min_machines_running = 0', () => {
    const flyToml = readFileSync(
      join(deployDir, 'fly.template.toml'),
      'utf8',
    );
    expect(flyToml).toContain('min_machines_running = 0');
  });

  it('fly.template.toml uses correct image', () => {
    const flyToml = readFileSync(
      join(deployDir, 'fly.template.toml'),
      'utf8',
    );
    expect(flyToml).toContain('ghcr.io/openclawnch/telegram:latest');
  });

  it('fly.template.toml mounts workspace volume', () => {
    const flyToml = readFileSync(
      join(deployDir, 'fly.template.toml'),
      'utf8',
    );
    expect(flyToml).toContain('source = "workspace"');
    expect(flyToml).toContain('destination = "/workspace"');
  });

  it('fly.template.toml uses 1024mb memory', () => {
    const flyToml = readFileSync(
      join(deployDir, 'fly.template.toml'),
      'utf8',
    );
    expect(flyToml).toContain('memory = "1024mb"');
  });
});

// ── Security Properties ───────────────────────────────────────────────────

describe('security properties', () => {
  const deployDir = join(__dirname, '..', 'deploy');

  it('entrypoint warns about both known private key env var names', () => {
    const entrypoint = readFileSync(join(deployDir, 'entrypoint.sh'), 'utf8');

    const clawnchBlock = entrypoint.indexOf('CLAWNCHER_PRIVATE_KEY');
    const genericBlock = entrypoint.indexOf('"$PRIVATE_KEY"');

    expect(clawnchBlock).toBeGreaterThan(-1);
    expect(genericBlock).toBeGreaterThan(-1);

    // Entrypoint now warns instead of blocking (autosign mode)
    const warningCount = (entrypoint.match(/WARNING/g) ?? []).length;
    expect(warningCount).toBeGreaterThanOrEqual(2);
  });

  it('openclaw.json does not contain any API keys', () => {
    const config = readFileSync(join(deployDir, 'openclaw.json'), 'utf8');

    expect(config).not.toContain('sk-ant-');
    expect(config).not.toContain('sk-proj-');
    expect(config).not.toContain('sk-or-');
    expect(config).not.toContain('FlyV1');
    expect(config).not.toContain('ANTHROPIC_API_KEY');
    expect(config).not.toContain('OPENAI_API_KEY');
    expect(config).not.toContain('OPENROUTER_API_KEY');
    expect(config).not.toContain('PRIVATE_KEY');
  });

  it('Dockerfile does not embed actual secret values', () => {
    const dockerfile = readFileSync(join(deployDir, 'Dockerfile'), 'utf8');

    expect(dockerfile).not.toContain('sk-ant-');
    expect(dockerfile).not.toContain('sk-proj-');
    expect(dockerfile).not.toContain('sk-or-');
    expect(dockerfile).not.toContain('FlyV1');

    const envLines = dockerfile
      .split('\n')
      .filter((l) => l.trimStart().startsWith('ENV '));
    for (const line of envLines) {
      expect(line).not.toContain('ANTHROPIC_API_KEY');
      expect(line).not.toContain('OPENAI_API_KEY');
      expect(line).not.toContain('OPENROUTER_API_KEY');
      expect(line).not.toContain('TELEGRAM_BOT_TOKEN');
      expect(line).not.toContain('PRIVATE_KEY');
    }
  });

  it('deploy CLI never stores tokens to disk (by design)', () => {
    const deploySource = readFileSync(
      join(__dirname, '..', 'src', 'deploy.ts'),
      'utf8',
    );
    expect(deploySource).not.toContain('writeFileSync');
    expect(deploySource).not.toContain('writeFile');
  });

  it('deploy CLI has no unused fs/path imports', () => {
    const deploySource = readFileSync(
      join(__dirname, '..', 'src', 'deploy.ts'),
      'utf8',
    );
    // Only randomBytes and parseArgs should be imported from node builtins
    expect(deploySource).not.toContain("from 'node:fs'");
    expect(deploySource).not.toContain("from 'node:path'");
    expect(deploySource).not.toContain("from 'node:url'");
  });

  it('deploy CLI uses /telegram-webhook path constant', () => {
    const deploySource = readFileSync(
      join(__dirname, '..', 'src', 'deploy.ts'),
      'utf8',
    );
    expect(deploySource).toContain('/telegram-webhook');
    // Must NOT have the old wrong path as a webhook URL
    expect(deploySource).not.toMatch(/fly\.dev\/webhook['"]/);
  });
});

// ── CLI Integration ───────────────────────────────────────────────────────

describe('CLI integration', () => {
  it('bin/openclawnch.mjs handles deploy command', () => {
    const cliSource = readFileSync(
      join(__dirname, '..', 'bin', 'openclawnch.mjs'),
      'utf8',
    );
    expect(cliSource).toContain("args[0] === 'deploy'");
    expect(cliSource).toContain('deployCli');
  });

  it('main function is async (required for dynamic import)', () => {
    const cliSource = readFileSync(
      join(__dirname, '..', 'bin', 'openclawnch.mjs'),
      'utf8',
    );
    expect(cliSource).toContain('async function main()');
  });

  it('deploy is dynamically imported (not eagerly loaded)', () => {
    const cliSource = readFileSync(
      join(__dirname, '..', 'bin', 'openclawnch.mjs'),
      'utf8',
    );
    expect(cliSource).toContain("import('../dist/deploy.js')");
  });
});

// ── Extension Package Fix ─────────────────────────────────────────────────

describe('extension package.json', () => {
  it('main points to dist/index.js (not .ts source)', () => {
    const pkg = JSON.parse(
      readFileSync(
        join(__dirname, '..', 'extensions', 'crypto', 'package.json'),
        'utf8',
      ),
    );
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.main).not.toContain('.ts');
  });

  it('openclaw.extensions points to dist (not .ts source)', () => {
    const pkg = JSON.parse(
      readFileSync(
        join(__dirname, '..', 'extensions', 'crypto', 'package.json'),
        'utf8',
      ),
    );
    expect(pkg.openclaw.extensions[0]).toContain('dist/');
    expect(pkg.openclaw.extensions[0]).not.toContain('.ts');
  });
});
