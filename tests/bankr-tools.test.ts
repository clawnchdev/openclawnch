import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import plugin from '../extensions/crypto/index.js';

// ─── Tool Shape Tests ────────────────────────────────────────────────────

describe('bankr tool shapes', () => {
  let tools: any[] = [];

  beforeEach(() => {
    tools = [];
    const mockApi = {
      registerTool: vi.fn((tool: any) => tools.push(tool)),
      registerCommand: vi.fn(),
      on: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    plugin.register(mockApi);
  });

  function findTool(name: string) {
    return tools.find(t => t.name === name);
  }

  describe('bankr_launch', () => {
    it('has correct tool shape', () => {
      const tool = findTool('bankr_launch');
      expect(tool).toBeDefined();
      expect(tool.name).toBe('bankr_launch');
      expect(tool.label).toBe('Bankr Launch');
      expect(tool.ownerOnly).toBe(true); // C2 fix: write-operation tools are owner-only
      expect(tool.description).toContain('Deploy tokens');
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.properties.action).toBeDefined();
      expect(tool.parameters.properties.name).toBeDefined();
      expect(tool.parameters.properties.chain).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    });

    it('handles missing BANKR_API_KEY gracefully', async () => {
      const prev = process.env.BANKR_API_KEY;
      delete process.env.BANKR_API_KEY;
      try {
        const tool = findTool('bankr_launch');
        const result = await tool.execute('test', { action: 'deploy', name: 'TestToken' });
        expect(result.content[0].text).toContain('Bankr API key not configured');
      } finally {
        if (prev) process.env.BANKR_API_KEY = prev;
      }
    });
  });

  describe('bankr_automate', () => {
    it('has correct tool shape', () => {
      const tool = findTool('bankr_automate');
      expect(tool).toBeDefined();
      expect(tool.name).toBe('bankr_automate');
      expect(tool.label).toBe('Bankr Automate');
      expect(tool.ownerOnly).toBe(true); // C2 fix: write-operation tools are owner-only
      expect(tool.description).toContain('automations');
      expect(tool.parameters.properties.action).toBeDefined();
      expect(tool.parameters.properties.token).toBeDefined();
      expect(tool.parameters.properties.trigger).toBeDefined();
      expect(tool.parameters.properties.interval).toBeDefined();
    });

    it('handles missing BANKR_API_KEY gracefully', async () => {
      const prev = process.env.BANKR_API_KEY;
      delete process.env.BANKR_API_KEY;
      try {
        const tool = findTool('bankr_automate');
        const result = await tool.execute('test', { action: 'list' });
        expect(result.content[0].text).toContain('Bankr API key not configured');
      } finally {
        if (prev) process.env.BANKR_API_KEY = prev;
      }
    });

    it('validates required params for limit_buy', async () => {
      process.env.BANKR_API_KEY = 'bk_test_validation';
      try {
        const tool = findTool('bankr_automate');
        // Missing token
        const result = await tool.execute('test', { action: 'limit_buy', amount: '100', trigger: 'drops 10%' });
        expect(result.content[0].text).toContain('token');
      } finally {
        delete process.env.BANKR_API_KEY;
      }
    });

    it('validates required params for dca', async () => {
      process.env.BANKR_API_KEY = 'bk_test_validation';
      try {
        const tool = findTool('bankr_automate');
        // Missing interval
        const result = await tool.execute('test', { action: 'dca', token: 'ETH', amount: '100' });
        expect(result.content[0].text).toContain('interval');
      } finally {
        delete process.env.BANKR_API_KEY;
      }
    });
  });

  describe('bankr_polymarket', () => {
    it('has correct tool shape', () => {
      const tool = findTool('bankr_polymarket');
      expect(tool).toBeDefined();
      expect(tool.name).toBe('bankr_polymarket');
      expect(tool.label).toBe('Bankr Polymarket');
      expect(tool.ownerOnly).toBe(true); // C2 fix: write-operation tools are owner-only
      expect(tool.description).toContain('Polymarket');
      expect(tool.parameters.properties.action).toBeDefined();
      expect(tool.parameters.properties.query).toBeDefined();
      expect(tool.parameters.properties.market).toBeDefined();
      expect(tool.parameters.properties.outcome).toBeDefined();
      expect(tool.parameters.properties.amount).toBeDefined();
    });

    it('handles missing BANKR_API_KEY gracefully', async () => {
      const prev = process.env.BANKR_API_KEY;
      delete process.env.BANKR_API_KEY;
      try {
        const tool = findTool('bankr_polymarket');
        const result = await tool.execute('test', { action: 'positions' });
        expect(result.content[0].text).toContain('Bankr API key not configured');
      } finally {
        if (prev) process.env.BANKR_API_KEY = prev;
      }
    });

    it('validates query required for search', async () => {
      process.env.BANKR_API_KEY = 'bk_test_validation';
      try {
        const tool = findTool('bankr_polymarket');
        const result = await tool.execute('test', { action: 'search' });
        expect(result.content[0].text).toContain('query');
      } finally {
        delete process.env.BANKR_API_KEY;
      }
    });
  });

  describe('bankr_leverage', () => {
    it('has correct tool shape', () => {
      const tool = findTool('bankr_leverage');
      expect(tool).toBeDefined();
      expect(tool.name).toBe('bankr_leverage');
      expect(tool.label).toBe('Bankr Leverage');
      expect(tool.ownerOnly).toBe(true); // C2 fix: write-operation tools are owner-only
      expect(tool.description).toContain('Leveraged trading');
      expect(tool.description).toContain('WARNING');
      expect(tool.parameters.properties.action).toBeDefined();
      expect(tool.parameters.properties.pair).toBeDefined();
      expect(tool.parameters.properties.leverage).toBeDefined();
      expect(tool.parameters.properties.stop_loss).toBeDefined();
      expect(tool.parameters.properties.take_profit).toBeDefined();
    });

    it('handles missing BANKR_API_KEY gracefully', async () => {
      const prev = process.env.BANKR_API_KEY;
      delete process.env.BANKR_API_KEY;
      try {
        const tool = findTool('bankr_leverage');
        const result = await tool.execute('test', { action: 'positions' });
        expect(result.content[0].text).toContain('Bankr API key not configured');
      } finally {
        if (prev) process.env.BANKR_API_KEY = prev;
      }
    });

    it('validates leverage range', async () => {
      process.env.BANKR_API_KEY = 'bk_test_validation';
      try {
        const tool = findTool('bankr_leverage');
        const result = await tool.execute('test', {
          action: 'long', pair: 'BTC/USD', amount: '100', leverage: 15,
        });
        expect(result.content[0].text).toContain('between 1 and 10');
      } finally {
        delete process.env.BANKR_API_KEY;
      }
    });

    it('validates pair required for long', async () => {
      process.env.BANKR_API_KEY = 'bk_test_validation';
      try {
        const tool = findTool('bankr_leverage');
        const result = await tool.execute('test', { action: 'long', amount: '100' });
        expect(result.content[0].text).toContain('pair');
      } finally {
        delete process.env.BANKR_API_KEY;
      }
    });
  });
});

// ─── Graceful Degradation ────────────────────────────────────────────────

describe('bankr tools graceful degradation', () => {
  it('all 4 bankr tools return error without API key (no throw)', async () => {
    const prev = process.env.BANKR_API_KEY;
    delete process.env.BANKR_API_KEY;

    try {
      const tools: any[] = [];
      const mockApi = {
        registerTool: vi.fn((tool: any) => tools.push(tool)),
        registerCommand: vi.fn(),
        on: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn() },
      };
      plugin.register(mockApi);

      const bankrTools = tools.filter(t => t.name.startsWith('bankr_'));
      expect(bankrTools).toHaveLength(4);

      for (const tool of bankrTools) {
        const result = await tool.execute('test', { action: 'list' });
        expect(result.content).toBeDefined();
        expect(result.content[0].text).toBeDefined();
        // Should mention missing key, not throw
        expect(result.isError).toBe(true);
      }
    } finally {
      if (prev) process.env.BANKR_API_KEY = prev;
    }
  });
});
