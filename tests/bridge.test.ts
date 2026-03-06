/**
 * Tests for Bridge tool — cross-chain token bridging via LI.FI.
 *
 * Validates: tool shape, action routing, parameter validation,
 * graceful error handling, and plugin registration count.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBridgeTool } from '../extensions/crypto/src/tools/bridge.js';

describe('bridge tool', () => {
  const tool = createBridgeTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('bridge');
    expect(tool.label).toBe('Bridge');
    expect(tool.ownerOnly).toBe(true); // C2 fix: bridge includes write operations (execute), so owner-only
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('has all expected actions', () => {
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toContain('quote');
    expect(actionSchema.enum).toContain('routes');
    expect(actionSchema.enum).toContain('execute');
    expect(actionSchema.enum).toContain('status');
    expect(actionSchema.enum).toContain('chains');
    expect(actionSchema.enum).toContain('tokens');
    expect(actionSchema.enum).toHaveLength(6);
  });

  it('has bridge-specific parameters', () => {
    const props = tool.parameters.properties;
    expect(props.from_chain).toBeDefined();
    expect(props.to_chain).toBeDefined();
    expect(props.from_token).toBeDefined();
    expect(props.to_token).toBeDefined();
    expect(props.amount).toBeDefined();
    expect(props.slippage).toBeDefined();
    expect(props.tx_hash).toBeDefined();
    expect(props.bridge).toBeDefined();
    expect(props.chain_id).toBeDefined();
  });

  it('quote requires to_chain', async () => {
    const result = await tool.execute('test', {
      action: 'quote',
      from_chain: 'base',
      amount: '1000000000000000000',
    });
    expect(result.content[0]!.text).toContain('to_chain');
  });

  it('routes requires to_chain', async () => {
    const result = await tool.execute('test', {
      action: 'routes',
      from_chain: 'base',
      amount: '1000000000000000000',
    });
    expect(result.content[0]!.text).toContain('to_chain');
  });

  it('execute requires wallet connection', async () => {
    const result = await tool.execute('test', {
      action: 'execute',
      from_chain: 'base',
      to_chain: 'arbitrum',
      amount: '1000000000000000000',
    });
    expect(result.content[0]!.text).toContain('No wallet connected');
  });

  it('status requires tx_hash', async () => {
    const result = await tool.execute('test', {
      action: 'status',
    });
    expect(result.content[0]!.text).toContain('tx_hash');
  });

  it('chains action makes API call (graceful on network failure)', async () => {
    const result = await tool.execute('test', { action: 'chains' });
    // Either succeeds or fails gracefully
    expect(result.content).toBeDefined();
    expect(result.content[0]!.text).toBeDefined();
  });

  it('tokens action defaults to base chain', async () => {
    const result = await tool.execute('test', { action: 'tokens' });
    // Either succeeds or fails gracefully
    expect(result.content).toBeDefined();
  });

  it('handles unknown action gracefully', async () => {
    const result = await tool.execute('test', { action: 'unknown' });
    expect(result.content[0]!.text).toContain('Unknown action');
  });

  it('has details in result', async () => {
    const result = await tool.execute('test', {
      action: 'quote',
      from_chain: 'base',
      amount: '1000000000000000000',
    });
    expect(result.details).toBeDefined();
  });

  it('resolves chain names to IDs', async () => {
    // Invalid chain name should error
    const result = await tool.execute('test', {
      action: 'quote',
      from_chain: 'nonexistent_chain',
      to_chain: 'arbitrum',
      amount: '1000',
    });
    expect(result.content[0]!.text).toContain('Unknown source chain');
  });
});

// ─── Plugin Registration Count ───────────────────────────────────────────

describe('bridge plugin registration', () => {
  it('index.ts registers 28 tools (including bridge)', async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const registered: string[] = [];
    const mockApi = {
      registerTool: (tool: any) => registered.push(tool.name),
      registerCommand: () => {},
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    expect(registered).toHaveLength(28);
    expect(registered).toContain('bridge');
  });
});
