import { describe, it, expect, vi } from 'vitest';
import plugin from '../extensions/crypto/index.js';

describe('crypto plugin structure', () => {
  it('exports correct plugin metadata', () => {
    expect(plugin.id).toBe('crypto');
    expect(plugin.name).toBe('Crypto DeFi Tools');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.register).toBe('function');
  });

  it('registers all 42 tools', () => {
    const registered: string[] = [];
    const mockApi = {
      registerTool: vi.fn((tool: any) => registered.push(tool.name)),
      registerCommand: vi.fn(),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    };

    plugin.register(mockApi);

    expect(mockApi.registerTool).toHaveBeenCalledTimes(42);
    // Original 7
    expect(registered).toContain('clawnchconnect');
    expect(registered).toContain('defi_price');
    expect(registered).toContain('defi_balance');
    expect(registered).toContain('defi_swap');
    expect(registered).toContain('clawnch_launch');
    expect(registered).toContain('clawnch_fees');
    expect(registered).toContain('market_intel');
    // Phase 2: 5 tools
    expect(registered).toContain('hummingbot');
    expect(registered).toContain('manage_orders');
    expect(registered).toContain('watch_activity');
    expect(registered).toContain('clawnx');
    expect(registered).toContain('herd_intelligence');
    // Phase 3: workflow orchestrator
    expect(registered).toContain('crypto_workflow');
    // Phase 4: critical gap coverage (4 new)
    expect(registered).toContain('transfer');
    expect(registered).toContain('liquidity');
    expect(registered).toContain('wayfinder');
    expect(registered).toContain('clawnch_info');
    // Phase 5: Molten agent matching
    expect(registered).toContain('molten');
    // Phase 6: Bankr Agent API (4 new)
    expect(registered).toContain('bankr_launch');
    expect(registered).toContain('bankr_automate');
    expect(registered).toContain('bankr_polymarket');
    expect(registered).toContain('bankr_leverage');
  });

  it('registers all 3 commands', () => {
    const commands: string[] = [];
    const mockApi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn((cmd: any) => commands.push(cmd.name)),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    };

    plugin.register(mockApi);

    // 4 core + 1 reset_confirm + 5 persona + 10 cap + 1 skip + 1 back + 5 mode + 9 connect (1 base + 8 wallets) + 1 disconnect + 1 model + 11 llm shortcuts + 1 reset + 1 molten + 2 bankr LLM (credits, usage) + 2 bankr agent (connect_bankr, automations) + 2 bankr credits (topup, autotopup) + 8 fly control (provider + 4 provider_X + flykeys, flystatus, flyrestart) + 1 setup + 4 plans + 2 confirm (approve, deny) + 4 help/portfolio/balance/chain + 1 readonly + 1 doctor + 1 rpc + 3 evolution (evolve, stable, evolution) + 5 wallet mgmt (create_wallet, import_wallet, recover, export_wallet, wallet_backup) + 4 forum (topics, topics_setup, topic_bind, topic_unbind) = 91
    expect(mockApi.registerCommand).toHaveBeenCalledTimes(91);
    expect(commands).toContain('wallet');
    expect(commands).toContain('policy');
    expect(commands).toContain('tx');
    expect(commands).toContain('connect');
    expect(commands).toContain('connect_metamask');
    expect(commands).toContain('connect_rainbow');
    expect(commands).toContain('connect_coinbase');
    expect(commands).toContain('connect_trust');
    expect(commands).toContain('connect_zerion');
    expect(commands).toContain('connect_uniswap');
    expect(commands).toContain('connect_rabby');
    expect(commands).toContain('connect_other');
    expect(commands).toContain('llm');
    expect(commands).toContain('molten');
    expect(commands).toContain('llmcredits');
    expect(commands).toContain('llmcost');
    expect(commands).toContain('connect_bankr');
    expect(commands).toContain('automations');
    expect(commands).toContain('factoryreset');
    expect(commands).toContain('safemode');
    expect(commands).toContain('professional');
    // Fly control commands
    expect(commands).toContain('provider');
    expect(commands).toContain('provider_anthropic');
    expect(commands).toContain('provider_bankr');
    expect(commands).toContain('provider_openrouter');
    expect(commands).toContain('flykeys');
    expect(commands).toContain('flystatus');
    expect(commands).toContain('flyrestart');
    // Setup
    expect(commands).toContain('setup');
    // Model shortcuts
    expect(commands).toContain('llm_opus');
    expect(commands).toContain('llm_sonnet');
    expect(commands).toContain('llm_haiku');
    expect(commands).toContain('llm_gemini');
    // Reset confirm
    expect(commands).toContain('factoryreset_confirm');
  });

  it('registers gateway_start hook', () => {
    const mockApi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    };

    plugin.register(mockApi);

    expect(mockApi.on).toHaveBeenCalledWith('gateway_start', expect.any(Function));
  });
});

describe('tool shapes', () => {
  it('all tools have required fields', () => {
    const tools: any[] = [];
    const mockApi = {
      registerTool: vi.fn((tool: any) => tools.push(tool)),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(mockApi);

    for (const tool of tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('parameters');
      expect(tool).toHaveProperty('execute');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.execute).toBe('function');
      // Parameters should be a TypeBox schema (object with `type` and `properties`)
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.properties).toBeDefined();
    }
  });

  it('all tools handle gracefully without a connected wallet', async () => {
    const tools: any[] = [];
    const mockApi = {
      registerTool: vi.fn((tool: any) => tools.push(tool)),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(mockApi);

    // Each tool should fail gracefully without a connected wallet
    for (const tool of tools) {
      // Use appropriate default params depending on tool
      const params = tool.name === 'crypto_workflow'
        ? { workflow: 'portfolio_snapshot' }
        : { action: 'status' };
      const result = await tool.execute('test-call-id', params);
      // Should return a result (not throw) with content
      expect(result.content).toBeDefined();
      expect(result.content[0].text).toBeDefined();
    }
  });
});

describe('command shapes', () => {
  it('all commands have required fields', () => {
    const commands: any[] = [];
    const mockApi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn((cmd: any) => commands.push(cmd)),
      on: vi.fn(),
    };

    plugin.register(mockApi);

    for (const cmd of commands) {
      expect(cmd).toHaveProperty('name');
      expect(cmd).toHaveProperty('description');
      expect(cmd).toHaveProperty('handler');
      expect(typeof cmd.name).toBe('string');
      expect(typeof cmd.description).toBe('string');
      expect(typeof cmd.handler).toBe('function');
    }
  });
});
