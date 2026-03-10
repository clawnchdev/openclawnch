/**
 * Tests for Phase 3 tools: permit2, cost_basis, analytics, block_explorer
 *
 * Validates: tool shape, graceful error handling, parameter validation,
 * action routing, cost basis FIFO logic, and plugin registration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createPermit2Tool } from '../extensions/crypto/src/tools/permit2.js';
import { createCostBasisTool, recordSwapTrade } from '../extensions/crypto/src/tools/cost-basis.js';
import { createAnalyticsTool } from '../extensions/crypto/src/tools/analytics.js';
import { createBlockExplorerTool } from '../extensions/crypto/src/tools/block-explorer.js';

// ─── Permit2 Tool ────────────────────────────────────────────────────────

describe('permit2 tool', () => {
  const tool = createPermit2Tool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('permit2');
    expect(tool.label).toBe('Permit2');
    expect(tool.ownerOnly).toBe(true); // C2 fix: write-operation tools are owner-only
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('has all expected actions', () => {
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toContain('check_allowance');
    expect(actionSchema.enum).toContain('approve');
    expect(actionSchema.enum).toContain('approve_batch');
    expect(actionSchema.enum).toContain('revoke');
    expect(actionSchema.enum).toContain('lockdown');
    expect(actionSchema.enum).toHaveLength(5);
  });

  it('has permit2-specific parameters', () => {
    const props = tool.parameters.properties;
    expect(props.token).toBeDefined();
    expect(props.tokens).toBeDefined();
    expect(props.spender).toBeDefined();
    expect(props.pairs).toBeDefined();
  });

  it('requires wallet connection for check_allowance', async () => {
    const result = await tool.execute('test', {
      action: 'check_allowance',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      spender: 'universal_router',
    });
    expect(result.content[0]!.text).toContain('No wallet connected');
  });

  it('requires wallet connection for approve', async () => {
    const result = await tool.execute('test', {
      action: 'approve',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(result.content[0]!.text).toContain('No wallet connected');
  });

  it('requires wallet connection for lockdown', async () => {
    const result = await tool.execute('test', {
      action: 'lockdown',
      pairs: [{ token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: 'universal_router' }],
    });
    expect(result.content[0]!.text).toContain('No wallet connected');
  });

  it('has details in result', async () => {
    const result = await tool.execute('test', {
      action: 'check_allowance',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      spender: 'universal_router',
    });
    expect(result.details).toBeDefined();
  });
});

// ─── Cost Basis Tool ─────────────────────────────────────────────────────

describe('cost_basis tool', () => {
  const tool = createCostBasisTool();
  let tmpDir: string;
  let origTxDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join('/tmp', 'cost-basis-test-'));
    origTxDir = process.env.OPENCLAWNCH_TX_DIR;
    process.env.OPENCLAWNCH_TX_DIR = tmpDir;
  });

  afterEach(() => {
    if (origTxDir) process.env.OPENCLAWNCH_TX_DIR = origTxDir;
    else delete process.env.OPENCLAWNCH_TX_DIR;
    // Clean up
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('has correct metadata', () => {
    expect(tool.name).toBe('cost_basis');
    expect(tool.label).toBe('Cost Basis');
    expect(tool.ownerOnly).toBe(true);
    expect(tool.parameters.type).toBe('object');
    expect(typeof tool.execute).toBe('function');
  });

  it('has all expected actions', () => {
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toContain('record_trade');
    expect(actionSchema.enum).toContain('portfolio_pnl');
    expect(actionSchema.enum).toContain('token_pnl');
    expect(actionSchema.enum).toContain('history');
    expect(actionSchema.enum).toContain('export');
    expect(actionSchema.enum).toHaveLength(5);
  });

  it('records a trade', async () => {
    const result = await tool.execute('test', {
      action: 'record_trade',
      token: '0xa1f72459dfa10bad200ac160ecd78c6b77a747be',
      symbol: 'CLAWNCH',
      type: 'buy',
      amount: 1000,
      price_usd: 0.05,
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.status).toBe('recorded');
    expect(data.trade.type).toBe('buy');
    expect(data.trade.amount).toBe(1000);
    expect(data.trade.priceUsd).toBe(0.05);
    expect(data.trade.totalUsd).toBe(50);
    expect(data.totalTrades).toBe(1);
  });

  it('record_trade requires price_usd', async () => {
    const result = await tool.execute('test', {
      action: 'record_trade',
      token: '0xa1f72459dfa10bad200ac160ecd78c6b77a747be',
      symbol: 'CLAWNCH',
      type: 'buy',
      amount: 1000,
    });
    expect(result.content[0]!.text).toContain('price_usd');
  });

  it('portfolio_pnl returns empty for no trades', async () => {
    const result = await tool.execute('test', { action: 'portfolio_pnl' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.status).toBe('empty');
    expect(data.holdings).toEqual([]);
  });

  it('portfolio_pnl computes P&L after trades', async () => {
    // Record a buy
    await tool.execute('test', {
      action: 'record_trade',
      token: '0xa1f7',
      symbol: 'TEST',
      type: 'buy',
      amount: 100,
      price_usd: 1.0,
    });

    const result = await tool.execute('test', {
      action: 'portfolio_pnl',
      current_price: 1.5,
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.totalHoldings).toBe(1);
    expect(data.totalCurrentValue).toBe(150);
    expect(data.totalUnrealizedPnl).toBe(50);
  });

  it('FIFO cost basis works for partial sells', async () => {
    // Buy 100 @ $1.00
    await tool.execute('test', {
      action: 'record_trade',
      token: '0xtest',
      symbol: 'TST',
      type: 'buy',
      amount: 100,
      price_usd: 1.0,
    });
    // Buy 100 @ $2.00
    await tool.execute('test', {
      action: 'record_trade',
      token: '0xtest',
      symbol: 'TST',
      type: 'buy',
      amount: 100,
      price_usd: 2.0,
    });
    // Sell 50 @ $3.00 (consumes from first lot: cost $1, profit $2 per unit = $100)
    await tool.execute('test', {
      action: 'record_trade',
      token: '0xtest',
      symbol: 'TST',
      type: 'sell',
      amount: 50,
      price_usd: 3.0,
    });

    const result = await tool.execute('test', {
      action: 'token_pnl',
      token: '0xtest',
      current_price: 2.5,
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.holdingAmount).toBe(150); // 50 remaining from lot1 + 100 from lot2
    expect(data.realizedPnl).toBe(100); // (3-1)*50
    expect(data.totalBought).toBe(200);
    expect(data.totalSold).toBe(50);
  });

  it('history returns recent trades', async () => {
    await tool.execute('test', {
      action: 'record_trade',
      token: '0xa1f7',
      symbol: 'TEST',
      type: 'buy',
      amount: 100,
      price_usd: 1.0,
    });

    const result = await tool.execute('test', { action: 'history', limit: 10 });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.totalRecords).toBe(1);
    expect(data.showing).toBe(1);
    expect(data.trades[0].symbol).toBe('TEST');
  });

  it('export returns all trades', async () => {
    await tool.execute('test', {
      action: 'record_trade',
      token: '0xa1f7',
      symbol: 'TEST',
      type: 'buy',
      amount: 50,
      price_usd: 2.0,
    });

    const result = await tool.execute('test', { action: 'export' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.totalTrades).toBe(1);
    expect(data.trades).toHaveLength(1);
    expect(data.exportDate).toBeDefined();
  });

  it('recordSwapTrade function writes to store', () => {
    recordSwapTrade({
      token: '0xswap',
      symbol: 'SWP',
      amount: 500,
      priceUsd: 0.1,
      type: 'buy',
      txHash: '0xabc123',
    });

    const storePath = path.join(tmpDir, 'trade-history.json');
    expect(fs.existsSync(storePath)).toBe(true);
    const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(store.trades).toHaveLength(1);
    expect(store.trades[0].symbol).toBe('SWP');
    expect(store.trades[0].txHash).toBe('0xabc123');
  });

  it('has details in result', async () => {
    const result = await tool.execute('test', { action: 'portfolio_pnl' });
    expect(result.details).toBeDefined();
  });
});

// ─── Analytics Tool ──────────────────────────────────────────────────────

describe('analytics tool', () => {
  const tool = createAnalyticsTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('analytics');
    expect(tool.label).toBe('Analytics');
    expect(tool.ownerOnly).toBe(false);
    expect(tool.parameters.type).toBe('object');
    expect(typeof tool.execute).toBe('function');
  });

  it('has all expected actions', () => {
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toContain('candles');
    expect(actionSchema.enum).toContain('rsi');
    expect(actionSchema.enum).toContain('macd');
    expect(actionSchema.enum).toContain('bollinger');
    expect(actionSchema.enum).toContain('sma');
    expect(actionSchema.enum).toContain('ema');
    expect(actionSchema.enum).toContain('summary');
    expect(actionSchema.enum).toHaveLength(7);
  });

  it('has analytics-specific parameters', () => {
    const props = tool.parameters.properties;
    expect(props.token).toBeDefined();
    expect(props.chain).toBeDefined();
    expect(props.interval).toBeDefined();
    expect(props.period).toBeDefined();
    expect(props.limit).toBeDefined();
  });

  it('candles action requires token (fails gracefully on network)', async () => {
    const result = await tool.execute('test', { action: 'candles', token: '0xFAKE' });
    // Will fail due to network/API, but should not crash
    expect(result.content).toBeDefined();
    expect(result.content[0]!.text).toBeDefined();
  });

  it('handles unknown action gracefully', async () => {
    const result = await tool.execute('test', { action: 'unknown' });
    expect(result.content[0]!.text).toContain('Unknown action');
  });

  it('rsi action handles gracefully', async () => {
    const result = await tool.execute('test', { action: 'rsi', token: '0xFAKE' });
    expect(result.content).toBeDefined();
  });

  it('has details in result', async () => {
    const result = await tool.execute('test', { action: 'candles', token: '0xFAKE' });
    expect(result.details).toBeDefined();
  });
});

// ─── Block Explorer Tool ─────────────────────────────────────────────────

describe('block_explorer tool', () => {
  const tool = createBlockExplorerTool();
  let origBasescan: string | undefined;
  let origEtherscan: string | undefined;

  beforeEach(() => {
    origBasescan = process.env.BASESCAN_API_KEY;
    origEtherscan = process.env.ETHERSCAN_API_KEY;
  });

  afterEach(() => {
    if (origBasescan) process.env.BASESCAN_API_KEY = origBasescan;
    else delete process.env.BASESCAN_API_KEY;
    if (origEtherscan) process.env.ETHERSCAN_API_KEY = origEtherscan;
    else delete process.env.ETHERSCAN_API_KEY;
  });

  it('has correct metadata', () => {
    expect(tool.name).toBe('block_explorer');
    expect(tool.label).toBe('Block Explorer');
    expect(tool.ownerOnly).toBe(false);
    expect(tool.parameters.type).toBe('object');
    expect(typeof tool.execute).toBe('function');
  });

  it('has all expected actions', () => {
    const actionSchema = tool.parameters.properties.action;
    expect(actionSchema.enum).toContain('tx_lookup');
    expect(actionSchema.enum).toContain('contract_source');
    expect(actionSchema.enum).toContain('gas_tracker');
    expect(actionSchema.enum).toContain('token_holders');
    expect(actionSchema.enum).toContain('internal_txs');
    expect(actionSchema.enum).toHaveLength(5);
  });

  it('has explorer-specific parameters', () => {
    const props = tool.parameters.properties;
    expect(props.chain).toBeDefined();
    expect(props.tx_hash).toBeDefined();
    expect(props.address).toBeDefined();
    expect(props.token).toBeDefined();
    expect(props.page).toBeDefined();
    expect(props.limit).toBeDefined();
  });

  it('tx_lookup requires BASESCAN_API_KEY for base chain', async () => {
    delete process.env.BASESCAN_API_KEY;
    const result = await tool.execute('test', {
      action: 'tx_lookup',
      tx_hash: '0xabc123',
    });
    expect(result.content[0]!.text).toContain('BASESCAN_API_KEY');
  });

  it('tx_lookup requires ETHERSCAN_API_KEY for ethereum', async () => {
    delete process.env.ETHERSCAN_API_KEY;
    delete process.env.BASESCAN_API_KEY;
    const result = await tool.execute('test', {
      action: 'tx_lookup',
      tx_hash: '0xabc123',
      chain: 'ethereum',
    });
    // Without BASESCAN_API_KEY (the primary required key), returns 'not configured' guidance
    expect(result.content[0]!.text).toContain('not configured');
  });

  it('gas_tracker requires API key', async () => {
    delete process.env.BASESCAN_API_KEY;
    const result = await tool.execute('test', { action: 'gas_tracker' });
    expect(result.content[0]!.text).toContain('BASESCAN_API_KEY');
  });

  it('internal_txs requires address or tx_hash', async () => {
    process.env.BASESCAN_API_KEY = 'test-key';
    const result = await tool.execute('test', { action: 'internal_txs' });
    expect(result.content[0]!.text).toContain('address or tx_hash');
  });

  it('handles unknown action gracefully', async () => {
    // Set key so we get past config check and hit the action handler
    process.env.BASESCAN_API_KEY = 'test-key';
    const result = await tool.execute('test', { action: 'unknown' });
    expect(result.content[0]!.text).toContain('Unknown action');
  });

  it('has details in result', async () => {
    delete process.env.BASESCAN_API_KEY;
    const result = await tool.execute('test', { action: 'gas_tracker' });
    expect(result.details).toBeDefined();
  });
});

// ─── Cross-cutting: Phase 3 Tool Consistency ─────────────────────────────

describe('phase 3 tool consistency', () => {
  const tools = [
    createPermit2Tool(),
    createCostBasisTool(),
    createAnalyticsTool(),
    createBlockExplorerTool(),
  ];

  it('all tools have label field', () => {
    for (const tool of tools) {
      expect(tool.label).toBeDefined();
      expect(typeof tool.label).toBe('string');
    }
  });

  it('all tools return AgentToolResult shape with details', async () => {
    for (const tool of tools) {
      let params: Record<string, unknown>;
      switch (tool.name) {
        case 'permit2':
          params = { action: 'check_allowance', token: '0x0', spender: '0x0' };
          break;
        case 'cost_basis':
          params = { action: 'portfolio_pnl' };
          break;
        case 'analytics':
          params = { action: 'candles', token: '0xFAKE' };
          break;
        case 'block_explorer':
          params = { action: 'gas_tracker' };
          break;
        default:
          params = { action: 'unknown' };
      }

      const result = await tool.execute('test', params);
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
      expect(result.details).toBeDefined();
    }
  });

  it('all tool names match expected pattern', () => {
    const validNames = ['permit2', 'cost_basis', 'analytics', 'block_explorer'];
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

// ─── Plugin Registration ─────────────────────────────────────────────────

describe('phase 3 plugin registration', () => {
  it('index.ts registers 31 tools', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const registered: string[] = [];
    const mockApi = {
      registerTool: (tool: any) => registered.push(tool.name),
      registerCommand: () => {},
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    expect(registered).toHaveLength(31);
    // Verify Phase 3 tools are included
    expect(registered).toContain('permit2');
    expect(registered).toContain('cost_basis');
    expect(registered).toContain('analytics');
    expect(registered).toContain('block_explorer');
    expect(registered).toContain('bridge');
  });
});
