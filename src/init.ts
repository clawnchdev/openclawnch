/**
 * OpenClawnch Init — Interactive setup wizard.
 *
 * Walks the user through configuring their LLM provider, channel, wallet mode,
 * and optional API keys. Validates keys against live APIs where possible.
 * Writes results to .env (or prints export commands for shell sourcing).
 *
 * Uses only Node.js built-ins (readline/promises). No new dependencies.
 *
 * Usage:
 *   openclawnch init
 *   openclawnch init --env-file .env      # write to specific file
 *   openclawnch init --print              # print exports instead of writing file
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// ── Types ───────────────────────────────────────────────────────────────────

interface InitConfig {
  envFile: string;
  printOnly: boolean;
}

interface KeyResult {
  key: string;
  value: string;
  label: string;
  required: boolean;
}

// ── Constants ───────────────────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org';

const LLM_PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic (recommended)',
    envKey: 'ANTHROPIC_API_KEY',
    prefix: 'sk-ant-',
    url: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (multi-model)',
    envKey: 'OPENROUTER_API_KEY',
    prefix: 'sk-or-',
    url: 'https://openrouter.ai/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    prefix: 'sk-',
    url: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'bankr',
    label: 'Bankr Gateway (pay with crypto)',
    envKey: 'BANKR_LLM_KEY',
    prefix: '',
    url: 'https://bankr.bot/api',
  },
] as const;

const CHANNELS = [
  {
    id: 'telegram',
    label: 'Telegram',
    envKey: 'TELEGRAM_BOT_TOKEN',
    url: 'https://t.me/BotFather',
    hint: 'Message @BotFather, send /newbot, copy the token',
  },
  {
    id: 'discord',
    label: 'Discord',
    envKey: 'DISCORD_TOKEN',
    url: 'https://discord.com/developers/applications',
    hint: 'Create app → Bot → Copy token',
  },
  {
    id: 'slack',
    label: 'Slack',
    envKey: 'SLACK_BOT_TOKEN',
    url: 'https://api.slack.com/apps',
    hint: 'Create app → OAuth → Install to workspace → Copy Bot User OAuth Token',
  },
] as const;

const WALLET_MODES = [
  {
    id: 'walletconnect',
    label: 'WalletConnect (recommended — agent never holds keys)',
    envKey: 'WALLETCONNECT_PROJECT_ID',
    url: 'https://cloud.reown.com',
    hint: 'Create a project → copy Project ID',
  },
  {
    id: 'private_key',
    label: 'Private key (headless / testing)',
    envKey: 'CLAWNCHER_PRIVATE_KEY',
    url: '',
    hint: 'Export from MetaMask or generate a new one',
  },
  {
    id: 'bankr',
    label: 'Bankr (custodial, multi-chain, zero friction)',
    envKey: 'BANKR_API_KEY',
    url: 'https://bankr.bot/api',
    hint: 'Sign up and get an API key',
  },
  {
    id: 'skip',
    label: 'Skip for now (wallet features disabled until you connect in chat)',
    envKey: '',
    url: '',
    hint: '',
  },
] as const;

const OPTIONAL_KEYS = [
  { envKey: 'ALCHEMY_API_KEY', label: 'Alchemy (higher-tier RPC)', url: 'https://dashboard.alchemy.com' },
  { envKey: 'ZEROX_API_KEY', label: '0x DEX aggregator', url: 'https://dashboard.0x.org' },
  { envKey: 'BASESCAN_API_KEY', label: 'Basescan block explorer', url: 'https://basescan.org/apis' },
  { envKey: 'HERD_ACCESS_TOKEN', label: 'Herd Intelligence token auditing', url: 'https://herd.bot' },
] as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function logOk(msg: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function logWarn(msg: string): void {
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
}

function logFail(msg: string): void {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}

function logHeader(step: number, total: number, title: string): void {
  console.log(`\n  \x1b[1mStep ${step}/${total}: ${title}\x1b[0m`);
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Returned by validators: true = valid, false = rejected, 'network' = couldn't reach API. */
type ValidationResult = true | false | 'network';

async function validateAnthropicKey(key: string): Promise<ValidationResult> {
  try {
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
    // 200 or 429 (rate limited) both mean the key is valid
    return response.status !== 401 && response.status !== 403;
  } catch {
    return 'network';
  }
}

async function validateOpenRouterKey(key: string): Promise<ValidationResult> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return response.status !== 401;
  } catch {
    return 'network';
  }
}

async function validateOpenAIKey(key: string): Promise<ValidationResult> {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return response.status !== 401;
  } catch {
    return 'network';
  }
}

async function validateLlmKey(key: string, provider: string): Promise<ValidationResult> {
  switch (provider) {
    case 'anthropic':
      return validateAnthropicKey(key);
    case 'openrouter':
      return validateOpenRouterKey(key);
    case 'openai':
      return validateOpenAIKey(key);
    default:
      // Bankr — no public validation endpoint, accept anything non-empty
      return key.length > 0;
  }
}

async function validateTelegramToken(token: string): Promise<string | null> {
  try {
    const response = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    const data = (await response.json()) as {
      ok: boolean;
      result?: { username: string };
    };
    if (data.ok && data.result) {
      return data.result.username;
    }
    return null;
  } catch {
    return null;
  }
}

async function validateDiscordToken(token: string): Promise<string | null> {
  try {
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    const data = (await response.json()) as { username?: string };
    return data.username ?? null;
  } catch {
    return null;
  }
}

// ── Menu helpers ────────────────────────────────────────────────────────────

async function promptMenu(
  rl: ReturnType<typeof createInterface>,
  items: readonly { label: string }[],
  allowSkip: boolean = false,
): Promise<number> {
  for (let i = 0; i < items.length; i++) {
    log(`  ${i + 1}. ${items[i]!.label}`);
  }
  if (allowSkip) {
    log('');
    log('  Press Enter to skip');
  }

  while (true) {
    const answer = await rl.question('\n  > ');
    if (allowSkip && answer.trim() === '') return -1;

    const num = parseInt(answer.trim(), 10);
    if (num >= 1 && num <= items.length) return num - 1;
    log(`  Enter a number between 1 and ${items.length}`);
  }
}

async function promptSecret(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  allowEmpty: boolean = false,
): Promise<string> {
  while (true) {
    const answer = await rl.question(`  ${prompt}: `);
    const value = answer.trim();
    if (value || allowEmpty) return value;
    log('  Cannot be empty. Try again.');
  }
}

// ── File writing ────────────────────────────────────────────────────────────

function buildEnvContents(results: KeyResult[]): string {
  const lines: string[] = [
    '# OpenClawnch Configuration',
    '# Generated by `openclawnch init`',
    `# ${new Date().toISOString()}`,
    '',
  ];

  const required = results.filter(r => r.required);
  const optional = results.filter(r => !r.required);

  if (required.length > 0) {
    lines.push('# ── Required ─────────────────────────────────────────────────────');
    for (const r of required) {
      lines.push(`# ${r.label}`);
      lines.push(`${r.key}=${r.value}`);
      lines.push('');
    }
  }

  if (optional.length > 0) {
    lines.push('# ── Optional ─────────────────────────────────────────────────────');
    for (const r of optional) {
      lines.push(`# ${r.label}`);
      lines.push(`${r.key}=${r.value}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function printExports(results: KeyResult[]): void {
  console.log('\n  # Add these to your shell profile:\n');
  for (const r of results) {
    console.log(`  export ${r.key}="${r.value}"`);
  }
}

// ── Main flow ───────────────────────────────────────────────────────────────

export async function initCli(argv: string[]): Promise<void> {
  // Parse args
  let envFile = '.env';
  let printOnly = false;

  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        'env-file': { type: 'string', default: '.env' },
        print: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });

    if (parsed.values.help) {
      console.log(`
  Usage: openclawnch init [options]

  Interactive setup wizard. Prompts for API keys, validates them,
  and writes your configuration.

  Options:
    --env-file <path>   Write to specific file (default: .env)
    --print             Print export commands instead of writing file
    -h, --help          Show this help
`);
      return;
    }

    envFile = (parsed.values['env-file'] as string) ?? '.env';
    printOnly = parsed.values.print as boolean;
  } catch {
    // parseArgs failed — continue with defaults
  }

  const resolvedEnvFile = resolve(envFile);
  const results: KeyResult[] = [];

  console.log(`
  \x1b[1mOpenClawnch Setup\x1b[0m
  ─────────────────

  This wizard configures your LLM provider, messaging channel,
  wallet, and optional API keys. Each key is validated live.
`);

  const rl = createInterface({ input: stdin, output: stdout });
  rl.on('close', () => {
    console.log('\n\nSetup cancelled.');
    process.exit(0);
  });

  try {
    // ── Step 1: LLM Provider ──────────────────────────────────────────
    logHeader(1, 4, 'LLM Provider');
    log('You need at least one LLM API key for the AI agent.\n');

    const llmIdx = await promptMenu(rl, LLM_PROVIDERS);
    const provider = LLM_PROVIDERS[llmIdx]!;

    log(`\n  Get a key: ${provider.url}\n`);

    let llmKey = '';
    while (true) {
      llmKey = await promptSecret(rl, `${provider.envKey}`);

      if (provider.prefix && !llmKey.startsWith(provider.prefix)) {
        logWarn(`Expected key to start with "${provider.prefix}". Double-check it.`);
      }

      log('  Validating...');
      const valid = await validateLlmKey(llmKey, provider.id);

      if (valid === true) {
        logOk('Key is valid.');
        break;
      } else if (valid === 'network') {
        logWarn('Could not reach API to validate — check your internet connection.');
        log('  Proceeding with the key as-is. You can re-run init later to verify.');
        break;
      } else {
        logFail('Key was rejected. Check your key and try again.');
      }
    }

    results.push({
      key: provider.envKey,
      value: llmKey,
      label: `${provider.label.split(' (')[0]} API key`,
      required: true,
    });

    if (provider.id !== 'anthropic') {
      results.push({
        key: 'OPENCLAWNCH_LLM_PROVIDER',
        value: provider.id,
        label: 'LLM provider override',
        required: true,
      });
    }

    // ── Step 2: Channel ───────────────────────────────────────────────
    logHeader(2, 4, 'Messaging Channel');
    log('Which channel will your bot listen on?\n');

    const chanIdx = await promptMenu(rl, CHANNELS);
    const channel = CHANNELS[chanIdx]!;

    log(`\n  ${channel.hint}`);
    log(`  ${channel.url}\n`);

    let channelToken = '';

    while (true) {
      channelToken = await promptSecret(rl, `${channel.envKey}`);

      if (channel.id === 'telegram') {
        log('  Validating...');
        const botName = await validateTelegramToken(channelToken);
        if (botName) {
          logOk(`Connected to @${botName}`);
          break;
        } else {
          logFail('Invalid token. Get one from @BotFather and try again.');
        }
      } else if (channel.id === 'discord') {
        log('  Validating...');
        const botName = await validateDiscordToken(channelToken);
        if (botName) {
          logOk(`Connected as ${botName}`);
          break;
        } else {
          logFail('Invalid token. Check your Discord developer portal.');
        }
      } else {
        // Slack — no simple validation, accept non-empty
        if (channelToken.startsWith('xoxb-')) {
          logOk('Token format looks correct.');
        } else {
          logWarn('Expected token to start with "xoxb-". Double-check it.');
        }
        break;
      }
    }

    results.push({
      key: channel.envKey,
      value: channelToken,
      label: `${channel.label} bot token`,
      required: true,
    });

    // ── Step 3: Wallet ────────────────────────────────────────────────
    logHeader(3, 4, 'Wallet Mode');
    log('How will you connect a wallet? (You can change this later.)\n');

    const walletIdx = await promptMenu(rl, WALLET_MODES);
    const walletMode = WALLET_MODES[walletIdx]!;

      if (walletMode.id !== 'skip' && walletMode.envKey) {
      if (walletMode.url) {
        log(`\n  ${walletMode.hint}`);
        log(`  ${walletMode.url}\n`);
      } else {
        log(`\n  ${walletMode.hint}\n`);
      }

      let walletValue: string;
      if (walletMode.id === 'private_key') {
        // Validate hex format for private keys
        while (true) {
          walletValue = await promptSecret(rl, `${walletMode.envKey}`);
          const clean = walletValue.startsWith('0x') ? walletValue : `0x${walletValue}`;
          if (/^0x[0-9a-fA-F]{64}$/.test(clean)) {
            walletValue = clean;
            break;
          }
          logFail('Invalid private key format. Must be a 64-character hex string (with or without 0x prefix).');
        }
      } else {
        walletValue = await promptSecret(rl, `${walletMode.envKey}`);
      }
      results.push({
        key: walletMode.envKey,
        value: walletValue,
        label: `${walletMode.label.split(' (')[0]} key`,
        required: false,
      });

      if (walletMode.id === 'private_key') {
        results.push({
          key: 'ALLOW_PRIVATE_KEY_MODE',
          value: 'true',
          label: 'Enable private key mode',
          required: false,
        });
      }
    } else if (walletMode.id === 'skip') {
      logOk('Skipped. Use /connect in chat later to pair a wallet.');
    }

    // ── Step 4: Optional APIs ─────────────────────────────────────────
    logHeader(4, 4, 'Optional API Keys');
    log('These unlock additional tools. Press Enter to skip any.\n');

    for (const opt of OPTIONAL_KEYS) {
      const value = await promptSecret(rl, `${opt.envKey} (${opt.label})`, true);
      if (value) {
        results.push({
          key: opt.envKey,
          value,
          label: opt.label,
          required: false,
        });
      }
    }

    // ── Write results ─────────────────────────────────────────────────
    console.log('\n  ─────────────────\n');

    if (printOnly) {
      printExports(results);
    } else {
      // Check for existing .env
      if (existsSync(resolvedEnvFile)) {
        log(`${resolvedEnvFile} already exists.`);
        const answer = await rl.question('  Overwrite? [y/N] ');
        if (answer.trim().toLowerCase() !== 'y') {
          log('Aborted. Your existing .env is unchanged.');
          printExports(results);
          log('\n  Copy the exports above to use them instead.');
          return;
        }
      }

      const contents = buildEnvContents(results);
      writeFileSync(resolvedEnvFile, contents, 'utf8');
      logOk(`Configuration saved to ${resolvedEnvFile}`);
    }

    // ── Summary ───────────────────────────────────────────────────────
    const requiredCount = results.filter(r => r.required).length;
    const optionalCount = results.filter(r => !r.required).length;

    console.log('');
    log(`${requiredCount} required keys set`);
    if (optionalCount > 0) log(`${optionalCount} optional keys set`);

    console.log(`
  \x1b[1mNext steps:\x1b[0m

  1. Start your agent:
     ${printOnly ? 'source the exports above, then:' : ''}
      openclawnch

  2. Message your bot on ${channel.label}.
     The bot walks you through onboarding (persona, capabilities, wallet).

  3. Run /setup in chat to see which tools are ready.
     Run /doctor for a full diagnostic check.
`);
  } finally {
    rl.close();
  }
}
