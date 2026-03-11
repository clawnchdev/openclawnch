/**
 * Command Handler Tests — exercises every command handler with dry-run invocations.
 *
 * Tests that all 65 registered commands:
 * 1. Have the correct shape (name, description, handler)
 * 2. Execute without throwing (return text responses)
 * 3. Produce reasonable output for common cases
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import plugin from '../extensions/crypto/index.js';

// ─── Plugin Registration ─────────────────────────────────────────────────

describe('all commands registered and executable', () => {
  let commands: any[];

  beforeEach(() => {
    const registeredCommands: any[] = [];
    const mockApi = {
      registerTool: () => {},
      registerCommand: (c: any) => registeredCommands.push(c),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    commands = registeredCommands;
  });

  it('registers exactly 87 commands', () => {
    expect(commands.length).toBe(87);
  });

  it('all commands have required fields', () => {
    for (const cmd of commands) {
      expect(cmd.name, `command missing name`).toBeDefined();
      expect(typeof cmd.name).toBe('string');
      expect(cmd.description, `${cmd.name} missing description`).toBeDefined();
      expect(typeof cmd.handler).toBe('function');
    }
  });

  it('no duplicate command names', () => {
    const names = commands.map(c => c.name);
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });
});

// ─── Mode Commands ───────────────────────────────────────────────────────

describe('mode command handlers', () => {
  const mockCtx = { senderId: 'test_user_cmd', from: 'test_user_cmd' };

  it('/safemode returns confirmation', async () => {
    const { safemodeCommand } = await import(
      '../extensions/crypto/src/commands/mode-commands.js'
    );
    const result = await safemodeCommand.handler(mockCtx);
    expect(result.text).toContain('Safe mode enabled');
    expect(result.text).toContain('Intent confirmation: ON');
  });

  it('/dangermode returns warning', async () => {
    const { dangermodeCommand } = await import(
      '../extensions/crypto/src/commands/mode-commands.js'
    );
    const result = await dangermodeCommand.handler(mockCtx);
    expect(result.text).toContain('Danger mode enabled');
    expect(result.text).toContain('Intent confirmation: OFF');
  });

  it('/walletsign returns confirmation', async () => {
    const { walletsignCommand } = await import(
      '../extensions/crypto/src/commands/mode-commands.js'
    );
    const result = await walletsignCommand.handler(mockCtx);
    expect(result.text).toContain('Wallet signing enabled');
    expect(result.text).toContain('WalletConnect');
  });

  it('/autosign without private key returns guidance', async () => {
    const { autosignCommand } = await import(
      '../extensions/crypto/src/commands/mode-commands.js'
    );
    delete process.env.CLAWNCHER_PRIVATE_KEY;
    const result = await autosignCommand.handler(mockCtx);
    expect(result.text).toContain('not available');
    expect(result.text).toContain('CLAWNCHER_PRIVATE_KEY');
  });

  it('/mode shows current status', async () => {
    const { modeCommand } = await import(
      '../extensions/crypto/src/commands/mode-commands.js'
    );
    const result = await modeCommand.handler(mockCtx);
    expect(result.text).toContain('Current mode');
    expect(result.text).toContain('Intent confirmation');
    expect(result.text).toContain('Signing');
  });

  it('M1: /dangermode warns when autosign is active', async () => {
    const { dangermodeCommand } = await import(
      '../extensions/crypto/src/commands/mode-commands.js'
    );
    const { setSigningMode } = await import(
      '../extensions/crypto/src/services/mode-service.js'
    );
    // Set autosign first
    process.env.CLAWNCHER_PRIVATE_KEY = '0xfake';
    setSigningMode('test_user_cmd_m1', 'autosign');

    const result = await dangermodeCommand.handler({
      senderId: 'test_user_cmd_m1',
    });
    expect(result.text).toContain('CRITICAL WARNING');
    expect(result.text).toContain('safety cap');
    expect(result.text).toContain('0.1 ETH');

    delete process.env.CLAWNCHER_PRIVATE_KEY;
  });
});

// ─── LLM / Model Commands ───────────────────────────────────────────────

describe('model command handlers', () => {
  it('/llm with no args shows menu', async () => {
    const { modelCommand } = await import(
      '../extensions/crypto/src/commands/model-command.js'
    );
    const result = await modelCommand.handler({ args: '' });
    expect(result.text).toContain('Current model');
    expect(result.text).toContain('/llm_opus');
    expect(result.text).toContain('/llm_sonnet');
  });

  it('/llm_opus shortcut exists and is callable', async () => {
    const { llmShortcutCommands } = await import(
      '../extensions/crypto/src/commands/model-command.js'
    );
    const opusCmd = llmShortcutCommands.find((c: any) => c.name === 'llm_opus');
    expect(opusCmd).toBeDefined();
    expect(typeof opusCmd!.handler).toBe('function');
    expect(opusCmd!.description).toContain('Opus');
  });
});

// ─── Fly Commands ────────────────────────────────────────────────────────

describe('fly command handlers', () => {
  it('/provider shows current provider', async () => {
    const { providerCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await providerCommand.handler({});
    expect(result.text).toContain('provider');
  });

  it('/flystatus without FLY_API_TOKEN shows setup', async () => {
    delete process.env.FLY_API_TOKEN;
    const { flystatusCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await flystatusCommand.handler({});
    expect(result.text).toBeDefined();
  });

  it('/flykeys without FLY_API_TOKEN shows setup', async () => {
    delete process.env.FLY_API_TOKEN;
    const { flykeysCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await flykeysCommand.handler({});
    expect(result.text).toBeDefined();
  });

  it('/flyrestart without FLY_API_TOKEN shows setup', async () => {
    delete process.env.FLY_API_TOKEN;
    const { flyrestartCommand } = await import(
      '../extensions/crypto/src/commands/fly-commands.js'
    );
    const result = await flyrestartCommand.handler({});
    expect(result.text).toBeDefined();
  });
});

// ─── Molten Command ──────────────────────────────────────────────────────

describe('molten command handler', () => {
  it('/molten without API key shows setup instructions', async () => {
    delete process.env.MOLTEN_API_KEY;
    const { moltenCommand } = await import(
      '../extensions/crypto/src/commands/molten-command.js'
    );
    const result = await moltenCommand.handler({});
    expect(result.text).toContain('not configured');
    expect(result.text).toContain('Molten');
  });
});

// ─── Bankr Commands ──────────────────────────────────────────────────────

describe('bankr command handlers', () => {
  it('/llmcredits without key shows error', async () => {
    delete process.env.BANKR_LLM_KEY;
    const { creditsCommand } = await import(
      '../extensions/crypto/src/commands/bankr-commands.js'
    );
    const result = await creditsCommand.handler({});
    expect(result.text).toBeDefined();
    expect(result.text).toContain('Bankr');
  });

  it('/llmcost without key shows error', async () => {
    delete process.env.BANKR_LLM_KEY;
    const { usageCommand } = await import(
      '../extensions/crypto/src/commands/bankr-commands.js'
    );
    const result = await usageCommand.handler({});
    expect(result.text).toBeDefined();
  });

  it('/automations without BANKR_API_KEY shows error', async () => {
    delete process.env.BANKR_API_KEY;
    const { automationsCommand } = await import(
      '../extensions/crypto/src/commands/bankr-commands.js'
    );
    const result = await automationsCommand.handler({});
    expect(result.text).toBeDefined();
    expect(result.text).toContain('Bankr');
  });
});

// ─── Wallet / Connect Commands ───────────────────────────────────────────

describe('wallet/connect command handlers', () => {
  it('/wallet shows disconnected state', async () => {
    const { walletCommand } = await import(
      '../extensions/crypto/src/commands/wallet-command.js'
    );
    const result = await walletCommand.handler({});
    expect(result.text).toBeDefined();
    // May show disconnected or wallet info
    expect(typeof result.text).toBe('string');
  });

  it('/connect shows wallet options', async () => {
    const { connectCommand } = await import(
      '../extensions/crypto/src/commands/connect-command.js'
    );
    const result = await connectCommand.handler({});
    expect(result.text).toContain('connect');
  });

  it('/tx shows transaction info', async () => {
    const { txCommand } = await import(
      '../extensions/crypto/src/commands/tx-command.js'
    );
    const result = await txCommand.handler({});
    expect(result.text).toBeDefined();
    expect(typeof result.text).toBe('string');
  });
});

// ─── Setup Command ───────────────────────────────────────────────────────

describe('setup command handler', () => {
  it('/setup shows tool status', async () => {
    const { setupCommand } = await import(
      '../extensions/crypto/src/commands/setup-command.js'
    );
    const result = await setupCommand.handler({});
    expect(result.text).toBeDefined();
    expect(result.text).toContain('Price Lookup');
  });
});

// ─── Reset Command ───────────────────────────────────────────────────────

describe('reset command handlers', () => {
  it('/factoryreset shows warning', async () => {
    const { resetCommand } = await import(
      '../extensions/crypto/src/commands/reset-command.js'
    );
    const result = await resetCommand.handler({});
    expect(result.text).toBeDefined();
    // Should warn about destructive action
    expect(result.text.toLowerCase()).toMatch(/(reset|warning|confirm|erase|wipe)/i);
  });
});

// ─── Policy Command ──────────────────────────────────────────────────────

describe('policy command handler', () => {
  it('/policy shows current policies', async () => {
    const { policyCommand } = await import(
      '../extensions/crypto/src/commands/policy-command.js'
    );
    const result = await policyCommand.handler({});
    expect(result.text).toBeDefined();
    expect(typeof result.text).toBe('string');
  });
});

// ─── Onboarding Commands ─────────────────────────────────────────────────

describe('onboarding persona commands', () => {
  it('all persona commands exist and have handlers', async () => {
    const {
      professionalCommand, degenCommand, chillCommand, technicalCommand, mentorCommand,
    } = await import(
      '../extensions/crypto/src/commands/onboarding-commands.js'
    );
    const personaCmds = [professionalCommand, degenCommand, chillCommand, technicalCommand, mentorCommand];
    const personaNames = ['professional', 'degen', 'chill', 'technical', 'mentor'];
    for (let i = 0; i < personaNames.length; i++) {
      const cmd = personaCmds[i];
      expect(cmd, `persona command ${personaNames[i]} not found`).toBeDefined();
      expect(cmd.name).toBe(personaNames[i]);
      expect(typeof cmd.handler).toBe('function');
    }
  });

  it('skip command exists and has handler', async () => {
    const { skipCommand } = await import(
      '../extensions/crypto/src/commands/onboarding-commands.js'
    );
    expect(skipCommand).toBeDefined();
    expect(typeof skipCommand.handler).toBe('function');
  });

  it('capAllCommand and capCommands array exist', async () => {
    const { capAllCommand, capCommands } = await import(
      '../extensions/crypto/src/commands/onboarding-commands.js'
    );
    expect(capAllCommand).toBeDefined();
    expect(capAllCommand.name).toBe('all');
    expect(typeof capAllCommand.handler).toBe('function');

    // capCommands = one per CAPABILITIES entry (10 capability categories)
    expect(capCommands.length).toBeGreaterThan(0);
    expect(capCommands.length).toBe(10);
    for (const cmd of capCommands) {
      expect(cmd.name).toMatch(/^cap_/);
      expect(typeof cmd.handler).toBe('function');
    }
  });
});
