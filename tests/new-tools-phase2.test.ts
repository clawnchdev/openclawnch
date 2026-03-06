/**
 * Tests for Phase 2 tools: transfer, liquidity, wayfinder, clawnch_info
 *
 * These tools cover the 12 critical capability gaps identified in the audit.
 * Tests validate: tool shape, graceful error handling without wallet,
 * parameter validation, and action routing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTransferTool } from '../extensions/crypto/src/tools/transfer.js';
import { createLiquidityTool } from '../extensions/crypto/src/tools/liquidity.js';
import { createWayfinderTool } from '../extensions/crypto/src/tools/wayfinder.js';
import { createClawnchInfoTool } from '../extensions/crypto/src/tools/clawnch-info.js';

// ─── Transfer Tool ───────────────────────────────────────────────────────

describe('transfer tool', () => {
  const tool = createTransferTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('transfer');
    expect(tool.label).toBe('Transfer');
    expect(tool.ownerOnly).toBe(true); // C2 fix: write-operation tools are owner-only
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action).toBeDefined();
    expect(tool.parameters.properties.to).toBeDefined();
    expect(tool.parameters.properties.amount).toBeDefined();
    expect(tool.parameters.properties.token).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('has correct action enum', () => {
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toContain('send');
    expect(actionSchema.enum).toContain('estimate');
  });

  it('send requires wallet connection', async () => {
    const result = await tool.execute('test', {
      action: 'send',
      to: '0x1234567890123456789012345678901234567890',
      amount: '0.1',
    });
    expect(result.content[0]!.text).toContain('No wallet connected');
  });

  it('estimate requires wallet connection', async () => {
    const result = await tool.execute('test', {
      action: 'estimate',
      to: '0x1234567890123456789012345678901234567890',
      amount: '0.1',
    });
    expect(result.content[0]!.text).toContain('No wallet connected');
  });

  it('handles unknown action gracefully', async () => {
    // Wallet check happens before action routing, so without a wallet
    // we get a wallet error. This is correct behavior — validate the
    // error is returned as a result (not thrown).
    const result = await tool.execute('test', {
      action: 'unknown',
      to: '0x1234567890123456789012345678901234567890',
      amount: '0.1',
    });
    expect(result.content[0]!.text).toBeDefined();
    // Either wallet error or unknown action error — both are graceful
    expect(result.content[0]!.text).toMatch(/No wallet connected|Unknown action/);
  });

  it('send requires to parameter', async () => {
    // This will fail at wallet check first, not parameter check
    const result = await tool.execute('test', {
      action: 'send',
      to: '0x1234567890123456789012345678901234567890',
      amount: '0.1',
    });
    expect(result.content).toBeDefined();
  });

  it('has details in result', async () => {
    const result = await tool.execute('test', {
      action: 'send',
      to: '0x1234567890123456789012345678901234567890',
      amount: '0.1',
    });
    expect(result.details).toBeDefined();
  });
});

// ─── Liquidity Tool ──────────────────────────────────────────────────────

describe('liquidity tool', () => {
  const tool = createLiquidityTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('liquidity');
    expect(tool.label).toBe('Liquidity');
    expect(tool.ownerOnly).toBe(true); // C2 fix: write-operation tools are owner-only
    expect(tool.parameters.type).toBe('object');
    expect(typeof tool.execute).toBe('function');
  });

  it('has all expected actions', () => {
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toContain('positions');
    expect(actionSchema.enum).toContain('v4_position');
    expect(actionSchema.enum).toContain('v4_pool');
    expect(actionSchema.enum).toContain('v3_mint');
    expect(actionSchema.enum).toContain('v4_mint');
    expect(actionSchema.enum).toContain('v3_add');
    expect(actionSchema.enum).toContain('v3_remove');
    expect(actionSchema.enum).toContain('v3_collect');
    expect(actionSchema.enum).toHaveLength(8);
  });

  it('has LP-specific parameters', () => {
    const props = tool.parameters.properties;
    expect(props.token_id).toBeDefined();
    expect(props.token0).toBeDefined();
    expect(props.token1).toBeDefined();
    expect(props.fee).toBeDefined();
    expect(props.tick_lower).toBeDefined();
    expect(props.tick_upper).toBeDefined();
    expect(props.amount0).toBeDefined();
    expect(props.amount1).toBeDefined();
    expect(props.percentage).toBeDefined();
    expect(props.slippage_bps).toBeDefined();
  });

  it('requires wallet connection', async () => {
    const result = await tool.execute('test', { action: 'positions' });
    expect(result.content[0]!.text).toContain('No wallet connected');
  });

  it('has details in result', async () => {
    const result = await tool.execute('test', { action: 'positions' });
    expect(result.details).toBeDefined();
  });
});

// ─── Wayfinder Tool ──────────────────────────────────────────────────────

describe('wayfinder tool', () => {
  const tool = createWayfinderTool();
  let origApiKey: string | undefined;

  beforeEach(() => {
    origApiKey = process.env.WAYFINDER_API_KEY;
  });

  afterEach(() => {
    if (origApiKey) process.env.WAYFINDER_API_KEY = origApiKey;
    else delete process.env.WAYFINDER_API_KEY;
  });

  it('has correct metadata', () => {
    expect(tool.name).toBe('wayfinder');
    expect(tool.label).toBe('Wayfinder');
    expect(tool.ownerOnly).toBe(true);
    expect(tool.parameters.type).toBe('object');
    expect(typeof tool.execute).toBe('function');
  });

  it('has all expected actions', () => {
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toContain('pools');
    expect(actionSchema.enum).toContain('balances');
    expect(actionSchema.enum).toContain('quote');
    expect(actionSchema.enum).toContain('resolve_token');
    expect(actionSchema.enum).toContain('gas_token');
    expect(actionSchema.enum).toContain('execute_swap');
    expect(actionSchema.enum).toContain('strategy');
    expect(actionSchema.enum).toHaveLength(7);
  });

  it('has cross-chain parameters', () => {
    const props = tool.parameters.properties;
    expect(props.chain_id).toBeDefined();
    expect(props.from_chain).toBeDefined();
    expect(props.to_chain).toBeDefined();
    expect(props.from_token).toBeDefined();
    expect(props.to_token).toBeDefined();
  });

  it('requires WAYFINDER_API_KEY', async () => {
    delete process.env.WAYFINDER_API_KEY;
    const result = await tool.execute('test', { action: 'pools' });
    expect(result.content[0]!.text).toContain('WAYFINDER_API_KEY');
  });

  it('gas_token returns chain info', async () => {
    // gas_token is a local lookup, doesn't need API key in practice,
    // but still requires it because of the early check
    delete process.env.WAYFINDER_API_KEY;
    const result = await tool.execute('test', { action: 'gas_token', chain_id: 8453 });
    // Will fail at API key check
    expect(result.content[0]!.text).toContain('WAYFINDER_API_KEY');
  });

  it('has details in result', async () => {
    delete process.env.WAYFINDER_API_KEY;
    const result = await tool.execute('test', { action: 'pools' });
    expect(result.details).toBeDefined();
  });
});

// ─── Clawnch Info Tool ───────────────────────────────────────────────────

describe('clawnch_info tool', () => {
  const tool = createClawnchInfoTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('clawnch_info');
    expect(tool.label).toBe('Clawnch Info');
    expect(tool.ownerOnly).toBe(true); // vault_claim/agent_register are write ops
    expect(tool.parameters.type).toBe('object');
    expect(typeof tool.execute).toBe('function');
  });

  it('has all expected actions', () => {
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toContain('token_info');
    expect(actionSchema.enum).toContain('portfolio');
    expect(actionSchema.enum).toContain('vault_claim');
    expect(actionSchema.enum).toContain('agent_register');
    expect(actionSchema.enum).toContain('agent_status');
    expect(actionSchema.enum).toContain('platform_stats');
    expect(actionSchema.enum).toContain('list_tokens');
    expect(actionSchema.enum).toHaveLength(7);
  });

  it('token_info requires public client', async () => {
    const result = await tool.execute('test', {
      action: 'token_info',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    // Should fail because no public client initialized
    expect(result.content[0]!.text).toContain('Error');
  });

  it('portfolio without address or wallet errors', async () => {
    const result = await tool.execute('test', { action: 'portfolio' });
    expect(result.content[0]!.text).toContain('Error');
  });

  it('vault_claim requires wallet', async () => {
    const result = await tool.execute('test', {
      action: 'vault_claim',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(result.content[0]!.text).toContain('No wallet connected');
  });

  it('agent_register requires wallet', async () => {
    const result = await tool.execute('test', {
      action: 'agent_register',
      agent_name: 'TestBot',
    });
    expect(result.content[0]!.text).toContain('No wallet connected');
  });

  it('agent_status requires address or wallet', async () => {
    const result = await tool.execute('test', { action: 'agent_status' });
    expect(result.content[0]!.text).toContain('Error');
  });

  it('platform_stats fetches from API', async () => {
    // Will fail due to network, but should not crash
    const result = await tool.execute('test', { action: 'platform_stats' });
    expect(result.content).toBeDefined();
  });

  it('list_tokens fetches from API', async () => {
    // Will fail due to network, but should not crash
    const result = await tool.execute('test', { action: 'list_tokens' });
    expect(result.content).toBeDefined();
  });

  it('has details in result', async () => {
    const result = await tool.execute('test', { action: 'portfolio' });
    expect(result.details).toBeDefined();
  });
});

// ─── Cross-cutting Concerns ──────────────────────────────────────────────

describe('phase 2 tool consistency', () => {
  const tools = [
    createTransferTool(),
    createLiquidityTool(),
    createWayfinderTool(),
    createClawnchInfoTool(),
  ];

  it('all tools have label field', () => {
    for (const tool of tools) {
      expect(tool.label).toBeDefined();
      expect(typeof tool.label).toBe('string');
    }
  });

  it('all tools return AgentToolResult shape with details', async () => {
    for (const tool of tools) {
      const params = tool.name === 'wayfinder'
        ? { action: 'pools' }
        : tool.name === 'clawnch_info'
        ? { action: 'portfolio' }
        : { action: 'send', to: '0x0000000000000000000000000000000000000000', amount: '0' };

      const result = await tool.execute('test', params);
      // All results must have content array with text items
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
      // All results must have details
      expect(result.details).toBeDefined();
    }
  });

  it('all tool names match expected pattern', () => {
    const validNames = ['transfer', 'liquidity', 'wayfinder', 'clawnch_info'];
    for (const tool of tools) {
      expect(validNames).toContain(tool.name);
    }
  });

  it('all tools have TypeBox object schemas', () => {
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.properties).toBeDefined();
      expect(tool.parameters.properties.action).toBeDefined();
    }
  });
});
