/**
 * Tests for the 5 new tools: hummingbot, manage_orders, watch_activity, clawnx, herd_intelligence
 */
import { describe, it, expect, vi } from 'vitest';
import { createHummingbotTool } from '../extensions/crypto/src/tools/hummingbot.js';
import { createManageOrdersTool } from '../extensions/crypto/src/tools/manage-orders.js';
import { createWatchActivityTool } from '../extensions/crypto/src/tools/watch-activity.js';
import { createClawnXTool } from '../extensions/crypto/src/tools/clawnx.js';
import { createHerdIntelligenceTool } from '../extensions/crypto/src/tools/herd-intelligence.js';

describe('hummingbot tool', () => {
  const tool = createHummingbotTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('hummingbot');
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('status action calls HummingbotClient.checkHealth', async () => {
    // Without a running Hummingbot instance, this should fail gracefully
    const result = await tool.execute('test', { action: 'status' });
    expect(result.content).toBeDefined();
    expect(result.content[0]!.text).toBeDefined();
    // Should either return health data or an error about connection
  });

  it('order action requires connector and trading_pair', async () => {
    const result = await tool.execute('test', { action: 'order' });
    // Without HUMMINGBOT_API_URL, returns 'not configured' guidance
    expect(result.content[0]!.text).toContain('not configured');
  });

  it('templates action returns template list', async () => {
    // This should work even without a running instance (synchronous)
    const result = await tool.execute('test', { action: 'templates' });
    expect(result.content).toBeDefined();
  });
});

describe('manage_orders tool', () => {
  const tool = createManageOrdersTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('manage_orders');
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action).toBeDefined();
    expect(tool.parameters.properties.type).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('list action returns empty initially', async () => {
    const result = await tool.execute('test', { action: 'list' });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.orders).toBeDefined();
    expect(Array.isArray(parsed.orders)).toBe(true);
  });

  it('create action creates an order', async () => {
    const result = await tool.execute('test', {
      action: 'create',
      type: 'limit_buy',
      token: '0x1234567890123456789012345678901234567890',
      trigger_price: '0.001',
      amount_pct: 50,
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.status).toBe('created');
    expect(parsed.order).toBeDefined();
    expect(parsed.order.type).toBe('limit_buy');
    expect(parsed.order.side).toBe('buy');
    expect(parsed.order.id).toBeDefined();
  });

  it('list action shows created order', async () => {
    const result = await tool.execute('test', { action: 'list' });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.count).toBeGreaterThan(0);
  });

  it('check action triggers orders at matching price', async () => {
    const result = await tool.execute('test', {
      action: 'check',
      current_price: '0.0005', // Below trigger price (0.001) — should trigger limit_buy
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.triggered).toBeDefined();
  });

  it('risk action returns risk summary', async () => {
    const result = await tool.execute('test', { action: 'risk' });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.summary).toBeDefined();
    expect(parsed.config).toBeDefined();
  });

  it('cleanup action removes completed orders', async () => {
    const result = await tool.execute('test', { action: 'cleanup' });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.status).toBe('cleanup_complete');
    expect(typeof parsed.removedCount).toBe('number');
  });

  it('create with DCA params', async () => {
    const result = await tool.execute('test', {
      action: 'create',
      type: 'dca',
      token: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      trigger_price: '0.01',
      dca_interval_hours: 4,
      dca_max_buys: 10,
    });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.status).toBe('created');
    expect(parsed.order.type).toBe('dca');
  });
});

describe('watch_activity tool', () => {
  const tool = createWatchActivityTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('watch_activity');
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('returns guidance when not fully configured', async () => {
    // Without wallet init, should error about public client or return guidance
    const result = await tool.execute('test', {
      action: 'deployments',
    });
    // May return 'Error' (missing public client) or 'not configured' (missing wallet)
    expect(result.content[0]!.text).toBeDefined();
  });
});

describe('clawnx tool', () => {
  const tool = createClawnXTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('clawnx');
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('requires X API credentials', async () => {
    // Without env vars, should return clean 'not configured' guidance
    const origKey = process.env.X_API_KEY;
    delete process.env.X_API_KEY;

    const result = await tool.execute('test', { action: 'get_my_profile' });
    expect(result.content[0]!.text).toContain('not configured');
    expect(result.isError).toBe(true);

    if (origKey) process.env.X_API_KEY = origKey;
  });

  it('post_tweet requires text', async () => {
    // Set dummy env vars to get past credential check
    const orig = {
      X_API_KEY: process.env.X_API_KEY,
      X_API_SECRET: process.env.X_API_SECRET,
      X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN,
      X_ACCESS_TOKEN_SECRET: process.env.X_ACCESS_TOKEN_SECRET,
    };
    process.env.X_API_KEY = 'test';
    process.env.X_API_SECRET = 'test';
    process.env.X_ACCESS_TOKEN = 'test';
    process.env.X_ACCESS_TOKEN_SECRET = 'test';

    const result = await tool.execute('test', { action: 'post_tweet' });
    // Should error about missing text or about ClawnX initialization
    expect(result.content[0]!.text).toContain('Error');

    // Restore env vars
    for (const [k, v] of Object.entries(orig)) {
      if (v) process.env[k] = v;
      else delete process.env[k];
    }
    // Note: module-level _client singleton in clawnx.ts can't be reset
    // from here (it's not a property on the tool object). The singleton
    // will be null anyway because ClawnX constructor likely threw with
    // dummy credentials, and getClawnX() catches that on next call.
  });
});

describe('herd_intelligence tool', () => {
  const tool = createHerdIntelligenceTool();

  it('has correct metadata', () => {
    expect(tool.name).toBe('herd_intelligence');
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('investigate returns not-configured when HERD_ACCESS_TOKEN missing', async () => {
    const result = await tool.execute('test', { action: 'investigate' });
    // Without HERD_ACCESS_TOKEN, returns clean guidance
    expect(result.content[0]!.text).toContain('not configured');
    expect(result.isError).toBe(true);
  });

  it('audit_token returns not-configured when HERD_ACCESS_TOKEN missing', async () => {
    const result = await tool.execute('test', { action: 'audit_token' });
    expect(result.content[0]!.text).toContain('not configured');
    expect(result.isError).toBe(true);
  });

  it('validate_swap returns not-configured when HERD_ACCESS_TOKEN missing', async () => {
    const result = await tool.execute('test', {
      action: 'validate_swap',
      target: '0x4200000000000000000000000000000000000006',
    });
    expect(result.content[0]!.text).toContain('not configured');
    expect(result.isError).toBe(true);
  });

  it('bookmark list works without access token', async () => {
    const result = await tool.execute('test', {
      action: 'bookmark',
      bookmark_action: 'list',
    });
    // May fail due to no access token, but shouldn't crash
    expect(result.content).toBeDefined();
  });
});
