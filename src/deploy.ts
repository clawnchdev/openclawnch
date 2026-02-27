/**
 * OpenClawnch Deploy CLI
 *
 * Provisions a personal DeFi agent on Fly.io accessible via Telegram.
 * No shared infrastructure, no middleman — the user's Fly Machine IS the bot.
 *
 * Usage:
 *   npx openclawnch deploy \
 *     --telegram-token "123456:ABC..." \
 *     --fly-token "FlyV1..." \
 *     --llm-key "sk-ant-..."
 *
 * What it does:
 *   1. Validates all tokens (Fly, Telegram, LLM)
 *   2. Creates Fly app + 1GB volume
 *   3. Allocates shared IPv4+IPv6
 *   4. Deploys machine with volume attached by ID
 *   5. Waits for health check
 *   6. Lets OpenClaw's gateway register its own Telegram webhook
 *   7. Prints success with bot link
 */

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

// ── Constants ───────────────────────────────────────────────────────────────

const FLY_API = 'https://api.machines.dev/v1';
const FLY_GQL = 'https://api.fly.io/graphql';
const TELEGRAM_API = 'https://api.telegram.org';
const IMAGE = 'ghcr.io/openclawnch/telegram:latest';
const DEFAULT_REGION = 'iad';
const DEFAULT_VM_SIZE = 'shared-cpu-2x';
const DEFAULT_MEMORY_MB = 2048;
const VOLUME_SIZE_GB = 1;
const INTERNAL_PORT = 18789;
const WEBHOOK_PATH = '/telegram-webhook';

// ── Types ───────────────────────────────────────────────────────────────────

interface DeployConfig {
  telegramToken: string;
  flyToken: string;
  llmKey: string;
  llmProvider: 'anthropic' | 'openai' | 'openrouter';
  region: string;
  vmSize: string;
  memoryMb: number;
  wcProjectId?: string;
  appName?: string; // For resuming a partial deploy
}

interface TelegramBotInfo {
  id: number;
  first_name: string;
  username: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function logStep(step: number, total: number, msg: string): void {
  console.log(`\n  [${step}/${total}] ${msg}`);
}

function logError(msg: string): void {
  console.error(`\n  ERROR: ${msg}`);
}

function generateAppName(): string {
  const suffix = randomBytes(3).toString('hex');
  return `openclawnch-${suffix}`;
}

function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

async function flyFetch(
  path: string,
  token: string,
  opts: {
    method?: string;
    body?: unknown;
    expectStatus?: number[];
  } = {},
): Promise<unknown> {
  const { method = 'GET', body, expectStatus = [200, 201] } = opts;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const response = await fetch(`${FLY_API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!expectStatus.includes(response.status)) {
    const text = await response.text();
    throw new Error(
      `Fly API ${method} ${path} returned ${response.status}: ${text}`,
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

// ── Validation ──────────────────────────────────────────────────────────────

async function validateFlyToken(token: string): Promise<void> {
  try {
    await flyFetch('/apps?org_slug=personal', token);
  } catch (err) {
    throw new Error(
      `Invalid Fly token. Get one at https://fly.io/user/personal_access_tokens\n  ${(err as Error).message}`,
    );
  }
}

async function validateTelegramToken(token: string): Promise<TelegramBotInfo> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
  const data = (await response.json()) as {
    ok: boolean;
    result?: TelegramBotInfo;
    description?: string;
  };

  if (!data.ok || !data.result) {
    throw new Error(
      `Invalid Telegram token: ${data.description ?? 'getMe failed'}. Get one from @BotFather.`,
    );
  }

  return data.result;
}

async function validateLlmKey(
  key: string,
): Promise<'anthropic' | 'openai' | 'openrouter'> {
  if (key.startsWith('sk-ant-')) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    if (response.status === 401) {
      throw new Error(
        'Invalid Anthropic API key. Get one at https://console.anthropic.com/settings/keys',
      );
    }
    // 200 or 429 (rate limited) both mean the key is valid
    return 'anthropic';
  }

  if (key.startsWith('sk-or-')) {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (response.status === 401) {
      throw new Error(
        'Invalid OpenRouter API key. Get one at https://openrouter.ai/keys',
      );
    }
    return 'openrouter';
  }

  if (key.startsWith('sk-')) {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (response.status === 401) {
      throw new Error(
        'Invalid OpenAI API key. Get one at https://platform.openai.com/api-keys',
      );
    }
    return 'openai';
  }

  throw new Error(
    'Unrecognized LLM key format. Provide an Anthropic (sk-ant-...), OpenRouter (sk-or-...), or OpenAI (sk-...) key.',
  );
}

// ── Fly Provisioning ────────────────────────────────────────────────────────

async function createApp(
  appName: string,
  token: string,
): Promise<void> {
  try {
    await flyFetch('/apps', token, {
      method: 'POST',
      body: {
        app_name: appName,
        org_slug: 'personal',
      },
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('already') || msg.includes('taken')) {
      log('App already exists, reusing.');
      return;
    }
    throw err;
  }
}

async function createVolume(
  appName: string,
  token: string,
  region: string,
): Promise<string> {
  const volumes = (await flyFetch(`/apps/${appName}/volumes`, token)) as Array<{
    id: string;
    name: string;
    region: string;
    state: string;
  }>;

  const existing = volumes.find(
    (v) => v.name === 'workspace' && v.region === region,
  );
  if (existing) {
    log(`Volume already exists (${existing.id}), reusing.`);
    return existing.id;
  }

  const vol = (await flyFetch(`/apps/${appName}/volumes`, token, {
    method: 'POST',
    body: {
      name: 'workspace',
      size_gb: VOLUME_SIZE_GB,
      region,
    },
  })) as { id: string };

  return vol.id;
}

/**
 * Allocate shared IPv4 + IPv6 for the app.
 * Without this, the app hostname won't resolve and Telegram
 * webhooks can't reach the machine.
 * Uses the Fly GraphQL API since Machines REST API doesn't
 * have an IP allocation endpoint.
 */
async function allocateIps(appName: string, token: string): Promise<void> {
  const gqlFetch = async (query: string, variables: Record<string, unknown>) => {
    const response = await fetch(FLY_GQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const data = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };
    if (data.errors?.length) {
      const msg = data.errors[0]!.message;
      // "already allocated" is fine
      if (msg.includes('already') || msg.includes('exists')) return;
      throw new Error(`Fly GraphQL: ${msg}`);
    }
  };

  // Shared IPv4 (free)
  await gqlFetch(
    `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id address type } } }`,
    { input: { appId: appName, type: 'shared_v4' } },
  );

  // IPv6 (free)
  await gqlFetch(
    `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id address type } } }`,
    { input: { appId: appName, type: 'v6' } },
  );
}

async function createMachine(
  appName: string,
  token: string,
  config: DeployConfig,
  volumeId: string,
  webhookSecret: string,
): Promise<string> {
  const machines = (await flyFetch(
    `/apps/${appName}/machines`,
    token,
  )) as Array<{
    id: string;
    state: string;
  }>;

  const machineConfig = buildMachineConfig(config, volumeId, webhookSecret);

  if (machines.length > 0) {
    const existing = machines[0]!;
    log(`Machine already exists (${existing.id}), updating...`);

    await flyFetch(`/apps/${appName}/machines/${existing.id}`, token, {
      method: 'POST',
      body: machineConfig,
    });

    return existing.id;
  }

  const machine = (await flyFetch(`/apps/${appName}/machines`, token, {
    method: 'POST',
    body: {
      name: 'telegram',
      region: config.region,
      ...machineConfig,
    },
  })) as { id: string };

  return machine.id;
}

function buildMachineConfig(
  config: DeployConfig,
  volumeId: string,
  webhookSecret: string,
): Record<string, unknown> {
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    TELEGRAM_BOT_TOKEN: config.telegramToken,
    // OpenClaw's Telegram channel requires a webhook secret for verification
    OPENCLAW_TG_WEBHOOK_SECRET: webhookSecret,
  };

  if (config.llmProvider === 'anthropic') {
    env['ANTHROPIC_API_KEY'] = config.llmKey;
  } else if (config.llmProvider === 'openrouter') {
    env['OPENROUTER_API_KEY'] = config.llmKey;
  } else {
    env['OPENAI_API_KEY'] = config.llmKey;
  }

  // Tell the entrypoint which provider to configure in openclaw.json
  env['OPENCLAWNCH_LLM_PROVIDER'] = config.llmProvider;

  if (config.wcProjectId) {
    env['WALLETCONNECT_PROJECT_ID'] = config.wcProjectId;
  }

  return {
    config: {
      image: IMAGE,
      env,
      guest: {
        cpu_kind: 'shared',
        cpus: 2,
        memory_mb: config.memoryMb,
      },
      services: [
        {
          protocol: 'tcp',
          internal_port: INTERNAL_PORT,
          ports: [
            {
              port: 443,
              handlers: ['tls', 'http'],
            },
            {
              port: 80,
              handlers: ['http'],
              force_https: true,
            },
          ],
          autostart: true,
          autostop: 'suspend',
          min_machines_running: 0,
          concurrency: {
            type: 'connections',
            hard_limit: 25,
            soft_limit: 20,
          },
        },
      ],
      checks: {
        health: {
          type: 'http',
          port: INTERNAL_PORT,
          path: '/healthz',
          interval: '15s',
          timeout: '5s',
          grace_period: '90s',
        },
      },
      // Mount the volume by ID — not by name.
      // The volume ID was returned by createVolume().
      mounts: [
        {
          volume: volumeId,
          path: '/workspace',
        },
      ],
    },
  };
}

// ── Health Check ────────────────────────────────────────────────────────────

async function waitForHealth(
  appName: string,
  token: string,
  machineId: string,
  timeoutMs = 300_000,
): Promise<void> {
  const start = Date.now();
  const healthUrl = `https://${appName}.fly.dev/healthz`;

  while (Date.now() - start < timeoutMs) {
    try {
      const machine = (await flyFetch(
        `/apps/${appName}/machines/${machineId}`,
        token,
      )) as { state: string };

      if (machine.state === 'started') {
        const resp = await fetch(healthUrl, {
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) return;
      }
    } catch {
      // Expected — machine still booting
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
    process.stdout.write('.');
  }

  throw new Error(
    `Machine failed to become healthy within ${timeoutMs / 1000}s. Check logs: fly logs -a ${appName}`,
  );
}

// ── CLI Parsing ─────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
  OpenClawnch Deploy — Personal DeFi Agent on Telegram

  Usage:
    npx openclawnch deploy \\
      --telegram-token "123456:ABC..." \\
      --fly-token "FlyV1..." \\
      --llm-key "sk-ant-..."

  Required:
    --telegram-token   Telegram bot token from @BotFather
    --fly-token        Fly.io personal access token
    --llm-key          Anthropic (sk-ant-...), OpenRouter (sk-or-...), or OpenAI (sk-...) API key

  Optional:
    --region           Fly.io region (default: iad)
    --memory           Machine memory in MB (default: 2048)
    --wc-project-id    WalletConnect project ID (uses default if omitted)
    --app-name         Resume a partial deploy with this app name
    --help             Show this message

  What happens:
    1. Creates a Fly app with a 1GB persistent volume
    2. Allocates shared IPv4 + IPv6 (required for public access)
    3. Deploys the OpenClawnch Telegram Docker image
    4. Sets your API keys as machine env vars (never written to disk)
    5. OpenClaw's gateway registers the Telegram webhook on startup
    6. Your bot is live — message it on Telegram!

  Cost: ~$3-5/month (machine suspends when idle, resumes in <1s)

  Resuming a partial deploy:
    npx openclawnch deploy --app-name openclawnch-a1b2c3 [same args]
`);
}

export function parseDeployArgs(argv: string[]): DeployConfig | null {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        'telegram-token': { type: 'string' },
        'fly-token': { type: 'string' },
        'llm-key': { type: 'string' },
        region: { type: 'string', default: DEFAULT_REGION },
        memory: { type: 'string', default: String(DEFAULT_MEMORY_MB) },
        'vm-size': { type: 'string', default: DEFAULT_VM_SIZE },
        'wc-project-id': { type: 'string' },
        'app-name': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });

    if (values.help) {
      printUsage();
      return null;
    }

    const telegramToken = values['telegram-token'];
    const flyToken = values['fly-token'];
    const llmKey = values['llm-key'];

    if (!telegramToken || !flyToken || !llmKey) {
      logError(
        'Missing required arguments. Use --help for usage information.',
      );
      console.log('');
      console.log(
        '  Required: --telegram-token, --fly-token, --llm-key',
      );
      console.log('');
      return null;
    }

    return {
      telegramToken,
      flyToken,
      llmKey,
      llmProvider: llmKey.startsWith('sk-ant-')
        ? 'anthropic'
        : llmKey.startsWith('sk-or-')
          ? 'openrouter'
          : 'openai',
      region: values.region ?? DEFAULT_REGION,
      vmSize: values['vm-size'] ?? DEFAULT_VM_SIZE,
      memoryMb: parseInt(values.memory ?? String(DEFAULT_MEMORY_MB), 10),
      wcProjectId: values['wc-project-id'],
      appName: values['app-name'],
    };
  } catch (err) {
    logError((err as Error).message);
    printUsage();
    return null;
  }
}

// ── Main Deploy Flow ────────────────────────────────────────────────────────

export async function deploy(config: DeployConfig): Promise<void> {
  const STEPS = 6;
  // Use provided app name (resume) or generate new one
  const appName = config.appName ?? generateAppName();
  const webhookSecret = generateWebhookSecret();

  console.log('');
  console.log(
    '  ╔═══════════════════════════════════════════════════════╗',
  );
  console.log(
    '  ║       OpenClawnch Deploy — Telegram DeFi Agent       ║',
  );
  console.log(
    '  ╚═══════════════════════════════════════════════════════╝',
  );
  console.log('');
  log(`App name: ${appName}`);

  // ── Step 1: Validate tokens ────────────────────────────────────────────
  logStep(1, STEPS, 'Validating tokens...');

  log('Checking Fly.io token...');
  await validateFlyToken(config.flyToken);
  log('Fly.io token valid.');

  log('Checking Telegram bot token...');
  const botInfo = await validateTelegramToken(config.telegramToken);
  log(`Telegram bot: @${botInfo.username} (${botInfo.first_name})`);

  log(`Checking ${config.llmProvider} API key...`);
  const provider = await validateLlmKey(config.llmKey);
  const providerName = provider === 'anthropic' ? 'Anthropic' : provider === 'openrouter' ? 'OpenRouter' : 'OpenAI';
  log(`${providerName} key valid.`);

  // ── Step 2: Create Fly app + volume ────────────────────────────────────
  logStep(2, STEPS, `Creating Fly app: ${appName}`);
  await createApp(appName, config.flyToken);
  log(`App created.`);

  log('Creating persistent volume (1GB)...');
  const volumeId = await createVolume(appName, config.flyToken, config.region);
  log(`Volume ready: ${volumeId}`);

  // ── Step 3: Allocate IPs ───────────────────────────────────────────────
  logStep(3, STEPS, 'Allocating IP addresses...');
  await allocateIps(appName, config.flyToken);
  log(`App reachable at https://${appName}.fly.dev`);

  // ── Step 4: Deploy machine ─────────────────────────────────────────────
  logStep(4, STEPS, 'Deploying machine (pulling image, this may take a minute)...');
  const machineId = await createMachine(
    appName,
    config.flyToken,
    config,
    volumeId,
    webhookSecret,
  );
  log(`Machine created: ${machineId}`);

  // ── Step 5: Wait for health ────────────────────────────────────────────
  logStep(5, STEPS, 'Waiting for health check...');
  process.stdout.write('  ');
  await waitForHealth(appName, config.flyToken, machineId);
  console.log(' healthy!');

  // ── Step 6: Verify webhook ─────────────────────────────────────────────
  // OpenClaw's Telegram adapter calls setWebhook on its own during gateway
  // startup (with the correct secret_token). We just verify it's registered.
  logStep(6, STEPS, 'Verifying Telegram webhook...');
  const whInfo = await fetch(
    `${TELEGRAM_API}/bot${config.telegramToken}/getWebhookInfo`,
  );
  const whData = (await whInfo.json()) as {
    ok: boolean;
    result?: { url?: string; pending_update_count?: number };
  };

  if (whData.ok && whData.result?.url) {
    log(`Webhook active: ${whData.result.url}`);
  } else {
    log('Warning: webhook not yet registered. OpenClaw may need a moment.');
    log(`Expected: https://${appName}.fly.dev${WEBHOOK_PATH}`);
    log('If it doesn\'t register, check: fly logs -a ' + appName);
  }

  // ── Done ───────────────────────────────────────────────────────────────
  console.log('');
  console.log(
    '  ╔═══════════════════════════════════════════════════════╗',
  );
  console.log(
    '  ║                   Deploy Complete!                    ║',
  );
  console.log(
    '  ╚═══════════════════════════════════════════════════════╝',
  );
  console.log('');
  console.log(`  Your DeFi agent is live!`);
  console.log('');
  console.log(`  Bot:      https://t.me/${botInfo.username}`);
  console.log(`  App:      https://${appName}.fly.dev`);
  console.log(`  Region:   ${config.region}`);
  console.log(`  Memory:   ${config.memoryMb}MB`);
  console.log(`  Provider: ${config.llmProvider}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    1. Open Telegram and message @${botInfo.username}`);
    console.log('    2. Use /connect to pair your wallet (deep link to your wallet app)');
  console.log('    3. Try: "What\'s trending on Base?" or "Show my portfolio"');
  console.log('');
  console.log('  Useful commands:');
  console.log(`    fly status -a ${appName}          # Machine state`);
  console.log(`    fly logs -a ${appName}            # View logs`);
  console.log(`    fly ssh console -a ${appName}     # SSH access`);
  console.log(`    fly apps destroy ${appName}       # Tear everything down`);
  console.log('');
  console.log('  Cost: ~$3-5/month (auto-suspends when idle, <1s wake)');
  console.log('');
  console.log(`  To resume a failed deploy with this app:`);
  console.log(`    npx openclawnch deploy --app-name ${appName} [same args]`);
  console.log('');
}

// ── CLI Entry ───────────────────────────────────────────────────────────────

export async function deployCli(argv: string[]): Promise<void> {
  const config = parseDeployArgs(argv);
  if (!config) {
    process.exit(1);
  }

  try {
    await deploy(config);
  } catch (err) {
    logError((err as Error).message);
    console.log('');
    if (config.appName) {
      console.log(
        `  Re-run with the same --app-name ${config.appName} to resume.`,
      );
    } else {
      console.log(
        '  Note the app name above and re-run with --app-name to resume.',
      );
    }
    console.log('');
    process.exit(1);
  }
}
