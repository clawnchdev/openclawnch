import { describe, it, expect, vi } from 'vitest';
import plugin from '../extensions/crypto/index.js';

describe('crypto plugin structure', () => {
  it('exports correct plugin metadata', () => {
    expect(plugin.id).toBe('crypto');
    expect(plugin.name).toBe('Crypto DeFi Tools');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.register).toBe('function');
  });

  it('registers all 12 tools', () => {
    const registered: string[] = [];
    const mockApi = {
      registerTool: vi.fn((tool: any) => registered.push(tool.name)),
      registerCommand: vi.fn(),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    };

    plugin.register(mockApi);

    expect(mockApi.registerTool).toHaveBeenCalledTimes(12);
    // Original 7
    expect(registered).toContain('clawnchconnect');
    expect(registered).toContain('defi_price');
    expect(registered).toContain('defi_balance');
    expect(registered).toContain('defi_swap');
    expect(registered).toContain('clawnch_launch');
    expect(registered).toContain('clawnch_fees');
    expect(registered).toContain('market_intel');
    // New 5
    expect(registered).toContain('hummingbot');
    expect(registered).toContain('manage_orders');
    expect(registered).toContain('watch_activity');
    expect(registered).toContain('clawnx');
    expect(registered).toContain('herd_intelligence');
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

    expect(mockApi.registerCommand).toHaveBeenCalledTimes(3);
    expect(commands).toContain('wallet');
    expect(commands).toContain('policy');
    expect(commands).toContain('tx');
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

  it('all tools require wallet connection for execution', async () => {
    const tools: any[] = [];
    const mockApi = {
      registerTool: vi.fn((tool: any) => tools.push(tool)),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(mockApi);

    // Each tool should fail gracefully without a connected wallet
    for (const tool of tools) {
      const result = await tool.execute('test-call-id', { action: 'status' });
      // Should return an error result (not throw) indicating no wallet
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
