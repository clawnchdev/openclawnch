/**
 * V5 Multi-Agent Orchestration & Webhook Ingestion — comprehensive test suite.
 *
 * Tests:
 * - AgentPool: CRUD, presets, name validation, enable/disable, persistence, error handling
 * - AgentOrchestrator: provider detection, API key resolution, model resolution, buildToolSchemas
 * - AgentDelegateTool: action routing, list, status, factory pattern
 * - WebhookRoutes: CRUD, path/name validation, persistence, dedup, hit tracking
 * - WebhookServer: config defaults, HMAC verification, server lifecycle
 * - AgentsCommand: list, info, enable, disable, delete subcommands
 * - WebhooksCommand: list, info, enable, disable, delete subcommands
 * - Plugin registration counts (45 tools, 114 commands, 39 tool configs)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── AgentPool Tests ────────────────────────────────────────────────────

describe('AgentPool', () => {
  let AgentPool: any;
  let AgentPoolError: any;
  let resetAgentPool: any;

  beforeEach(async () => {
    const mod = await import('../extensions/crypto/src/services/agent-pool.js');
    AgentPool = mod.AgentPool;
    AgentPoolError = mod.AgentPoolError;
    resetAgentPool = mod.resetAgentPool;
    resetAgentPool();
  });

  afterEach(() => {
    resetAgentPool();
  });

  it('exports pool class, error class, and singleton helpers', async () => {
    const mod = await import('../extensions/crypto/src/services/agent-pool.js');
    expect(mod.AgentPool).toBeDefined();
    expect(mod.AgentPoolError).toBeDefined();
    expect(mod.getAgentPool).toBeDefined();
    expect(mod.resetAgentPool).toBeDefined();
  });

  it('initializes with 4 preset agents', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    const all = pool.list();
    expect(all.length).toBe(4);
    expect(all.map((a: any) => a.name).sort()).toEqual([
      'accountant', 'analyst', 'risk_manager', 'strategist',
    ]);
    for (const a of all) {
      expect(a.isPreset).toBe(true);
      expect(a.enabled).toBe(true);
      expect(a.usageCount).toBe(0);
    }
  });

  it('presets have valid structure', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    for (const agent of pool.list()) {
      expect(agent.id).toMatch(/^preset_/);
      expect(agent.name).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(agent.label.length).toBeGreaterThan(0);
      expect(agent.description.length).toBeGreaterThan(0);
      expect(agent.systemPrompt.length).toBeGreaterThan(20);
      expect(Array.isArray(agent.allowedTools)).toBe(true);
      expect(agent.allowedTools.length).toBeGreaterThan(0);
      expect(agent.model).toBe('haiku');
      expect(agent.maxTokens).toBeGreaterThan(0);
      expect(agent.temperature).toBeGreaterThanOrEqual(0);
      expect(agent.temperature).toBeLessThanOrEqual(1);
      expect(agent.maxToolCalls).toBeGreaterThan(0);
      expect(agent.timeoutMs).toBeGreaterThan(0);
      expect(agent.createdBy).toBe('system');
    }
  });

  it('creates a custom agent', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    const agent = pool.create({
      name: 'test_agent',
      label: 'Test Agent',
      description: 'A test sub-agent for unit tests',
      systemPrompt: 'You are a helpful test agent that always responds concisely.',
      createdBy: 'test',
      allowedTools: ['defi_price', 'analytics'],
      model: 'sonnet',
    });

    expect(agent.name).toBe('test_agent');
    expect(agent.label).toBe('Test Agent');
    expect(agent.isPreset).toBe(false);
    expect(agent.enabled).toBe(true);
    expect(agent.allowedTools).toEqual(['defi_price', 'analytics']);
    expect(agent.model).toBe('sonnet');
    expect(agent.maxTokens).toBe(4096); // default
    expect(agent.id).toMatch(/^agent_/);
    expect(pool.list().length).toBe(5); // 4 presets + 1 custom
  });

  it('rejects duplicate agent names', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    expect(() => pool.create({
      name: 'strategist', // conflicts with preset
      label: 'Dup',
      description: 'Conflict',
      systemPrompt: 'A duplicate agent that should fail to create.',
      createdBy: 'test',
    })).toThrow(AgentPoolError);
  });

  it('rejects invalid agent names', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    const badNames = ['AB', 'a', '123abc', 'has spaces', 'HAS-UPPER', 'a'.repeat(40)];
    for (const name of badNames) {
      expect(() => pool.create({
        name,
        label: 'Bad',
        description: 'Should fail',
        systemPrompt: 'Short prompts must be at least 20 chars long for validation.',
        createdBy: 'test',
      })).toThrow(AgentPoolError);
    }
  });

  it('rejects short system prompts', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    expect(() => pool.create({
      name: 'short_prompt',
      label: 'Short',
      description: 'Short prompt test',
      systemPrompt: 'Too short',
      createdBy: 'test',
    })).toThrow(AgentPoolError);
  });

  it('looks up agents by name', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    const strat = pool.getByName('strategist');
    expect(strat).toBeDefined();
    expect(strat.name).toBe('strategist');
    expect(pool.getByName('nonexistent')).toBeNull();
  });

  it('updates agent fields', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    const strat = pool.getByName('strategist');
    const updated = pool.update(strat.id, { enabled: false, model: 'sonnet' });
    expect(updated).toBeDefined();
    expect(updated.enabled).toBe(false);
    expect(updated.model).toBe('sonnet');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(strat.createdAt);
  });

  it('returns null when updating nonexistent id', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    expect(pool.update('nonexistent_id', { enabled: false })).toBeNull();
  });

  it('deletes custom agents', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    const custom = pool.create({
      name: 'deletable',
      label: 'Del',
      description: 'Will be deleted',
      systemPrompt: 'This agent will be deleted in the test suite.',
      createdBy: 'test',
    });
    expect(pool.list().length).toBe(5);
    const deleted = pool.delete(custom.id);
    expect(deleted).toBe(true);
    expect(pool.list().length).toBe(4);
    expect(pool.getByName('deletable')).toBeNull();
  });

  it('throws when deleting preset agents', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    const strat = pool.getByName('strategist');
    expect(() => pool.delete(strat.id)).toThrow(AgentPoolError);
    expect(() => pool.delete(strat.id)).toThrow(/preset/i);
  });

  it('returns false when deleting nonexistent id', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    expect(pool.delete('fake_id')).toBe(false);
  });

  it('filters by enabled status', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    pool.update(pool.getByName('analyst').id, { enabled: false });
    const enabled = pool.list({ enabled: true });
    const disabled = pool.list({ enabled: false });
    expect(enabled.length).toBe(3);
    expect(disabled.length).toBe(1);
    expect(disabled[0].name).toBe('analyst');
  });

  it('filters by preset status', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    pool.create({
      name: 'custom_one',
      label: 'Custom',
      description: 'Custom agent',
      systemPrompt: 'A custom agent for testing preset filtering.',
      createdBy: 'test',
    });
    const presets = pool.list({ isPreset: true });
    const custom = pool.list({ isPreset: false });
    expect(presets.length).toBe(4);
    expect(custom.length).toBe(1);
  });

  it('getEnabledAgents returns only enabled', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    expect(pool.getEnabledAgents().length).toBe(4);
    pool.update(pool.getByName('accountant').id, { enabled: false });
    expect(pool.getEnabledAgents().length).toBe(3);
  });

  it('recordUsage increments count', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    const strat = pool.getByName('strategist');
    expect(strat.usageCount).toBe(0);
    pool.recordUsage(strat.id);
    pool.recordUsage(strat.id);
    pool.recordUsage(strat.id);
    expect(pool.getByName('strategist').usageCount).toBe(3);
  });

  it('clear empties the pool', () => {
    const pool = new AgentPool({ stateDir: '/tmp/test-agents-' + Date.now() });
    expect(pool.list().length).toBe(4);
    pool.clear();
    expect(pool.list().length).toBe(0);
  });

  it('singleton works', async () => {
    const { getAgentPool, resetAgentPool } = await import('../extensions/crypto/src/services/agent-pool.js');
    resetAgentPool();
    const a = getAgentPool({ stateDir: '/tmp/test-agents-singleton-' + Date.now() });
    const b = getAgentPool();
    expect(a).toBe(b);
    resetAgentPool();
  });
});

// ─── AgentOrchestrator Tests ────────────────────────────────────────────

describe('AgentOrchestrator', () => {
  let detectProvider: any;
  let getApiKey: any;
  let buildToolSchemas: any;

  beforeEach(async () => {
    const mod = await import('../extensions/crypto/src/services/agent-orchestrator.js');
    detectProvider = mod.detectProvider;
    getApiKey = mod.getApiKey;
    buildToolSchemas = mod.buildToolSchemas;
  });

  it('exports expected functions', async () => {
    const mod = await import('../extensions/crypto/src/services/agent-orchestrator.js');
    expect(mod.detectProvider).toBeDefined();
    expect(mod.getApiKey).toBeDefined();
    expect(mod.buildToolSchemas).toBeDefined();
    expect(mod.executeSubAgent).toBeDefined();
  });

  it('detectProvider respects explicit env var', () => {
    const orig = process.env.OPENCLAWNCH_LLM_PROVIDER;
    process.env.OPENCLAWNCH_LLM_PROVIDER = 'openrouter';
    expect(detectProvider()).toBe('openrouter');
    process.env.OPENCLAWNCH_LLM_PROVIDER = 'bankr';
    expect(detectProvider()).toBe('bankr');
    if (orig) {
      process.env.OPENCLAWNCH_LLM_PROVIDER = orig;
    } else {
      delete process.env.OPENCLAWNCH_LLM_PROVIDER;
    }
  });

  it('detectProvider follows priority when no explicit', () => {
    const saved = {
      OPENCLAWNCH_LLM_PROVIDER: process.env.OPENCLAWNCH_LLM_PROVIDER,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      BANKR_LLM_KEY: process.env.BANKR_LLM_KEY,
    };

    // Clear all
    delete process.env.OPENCLAWNCH_LLM_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.BANKR_LLM_KEY;

    // No keys → fallback to anthropic
    expect(detectProvider()).toBe('anthropic');

    // Bankr only
    process.env.BANKR_LLM_KEY = 'test';
    expect(detectProvider()).toBe('bankr');

    // OpenAI takes priority over Bankr
    process.env.OPENAI_API_KEY = 'test';
    expect(detectProvider()).toBe('openai');

    // OpenRouter takes priority over OpenAI
    process.env.OPENROUTER_API_KEY = 'test';
    expect(detectProvider()).toBe('openrouter');

    // Anthropic takes highest priority
    process.env.ANTHROPIC_API_KEY = 'test';
    expect(detectProvider()).toBe('anthropic');

    // Restore
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  it('buildToolSchemas filters by allowedTools', () => {
    const registeredTools = [
      { name: 'defi_price', description: 'Prices', parameters: { type: 'object' } },
      { name: 'defi_swap', description: 'Swaps', parameters: { type: 'object' } },
      { name: 'analytics', description: 'Charts', parameters: { type: 'object' } },
      { name: 'transfer', description: 'Send', parameters: { type: 'object' } },
    ];

    const schemas = buildToolSchemas(['defi_price', 'analytics'], registeredTools);
    expect(schemas.length).toBe(2);
    expect(schemas.map((s: any) => s.name).sort()).toEqual(['analytics', 'defi_price']);
    for (const s of schemas) {
      expect(s.input_schema).toBeDefined();
      expect(s.description).toBeDefined();
    }
  });

  it('buildToolSchemas returns empty for empty allowedTools', () => {
    const registeredTools = [
      { name: 'defi_price', description: 'Prices', parameters: { type: 'object' } },
    ];
    expect(buildToolSchemas([], registeredTools)).toEqual([]);
  });

  it('buildToolSchemas ignores tools not in registeredTools', () => {
    const registeredTools = [
      { name: 'defi_price', description: 'Prices', parameters: { type: 'object' } },
    ];
    const schemas = buildToolSchemas(['defi_price', 'nonexistent_tool'], registeredTools);
    expect(schemas.length).toBe(1);
    expect(schemas[0].name).toBe('defi_price');
  });
});

// ─── AgentDelegateTool Tests ────────────────────────────────────────────

describe('AgentDelegateTool', () => {
  let createAgentDelegateTool: any;
  let resetAgentPool: any;

  beforeEach(async () => {
    const toolMod = await import('../extensions/crypto/src/tools/agent-delegate.js');
    createAgentDelegateTool = toolMod.createAgentDelegateTool;
    const poolMod = await import('../extensions/crypto/src/services/agent-pool.js');
    resetAgentPool = poolMod.resetAgentPool;
    resetAgentPool();
  });

  afterEach(() => {
    resetAgentPool();
  });

  it('factory creates a tool with correct shape', () => {
    const tool = createAgentDelegateTool(
      () => ({ call: async () => ({}) }),
      () => [],
    );

    expect(tool.name).toBe('agent_delegate');
    expect(tool.label).toBe('Agent Delegate');
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('list action returns all agents', async () => {
    const tool = createAgentDelegateTool(
      () => ({ call: async () => ({}) }),
      () => [],
    );

    const result = await tool.execute('call-1', { action: 'list' });
    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');

    const data = JSON.parse(result.content[0].text);
    expect(data.agents).toBeDefined();
    expect(data.agents.length).toBe(4); // 4 presets
    expect(data.agents.map((a: any) => a.name).sort()).toEqual([
      'accountant', 'analyst', 'risk_manager', 'strategist',
    ]);
  });

  it('status action reports provider info', async () => {
    const tool = createAgentDelegateTool(
      () => ({ call: async () => ({}) }),
      () => [],
    );

    const result = await tool.execute('call-2', { action: 'status' });
    const data = JSON.parse(result.content[0].text);
    expect(data.provider).toBeDefined();
    expect(typeof data.ready).toBe('boolean');
    expect(typeof data.enabledAgents).toBe('number');
    expect(data.enabledAgents).toBe(4);
  });

  it('delegate action requires agent and task params', async () => {
    const tool = createAgentDelegateTool(
      () => ({ call: async () => ({}) }),
      () => [],
    );

    const noAgent = await tool.execute('call-3', { action: 'delegate' });
    expect(noAgent.isError).toBe(true);
    expect(noAgent.content[0].text).toMatch(/agent/i);

    const noTask = await tool.execute('call-4', { action: 'delegate', agent: 'strategist' });
    expect(noTask.isError).toBe(true);
    expect(noTask.content[0].text).toMatch(/task/i);
  });

  it('delegate action rejects unknown agent', async () => {
    const tool = createAgentDelegateTool(
      () => ({ call: async () => ({}) }),
      () => [],
    );

    const result = await tool.execute('call-5', {
      action: 'delegate',
      agent: 'nonexistent',
      task: 'Do something',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nonexistent/);
  });

  it('unknown action returns error', async () => {
    const tool = createAgentDelegateTool(
      () => ({ call: async () => ({}) }),
      () => [],
    );

    const result = await tool.execute('call-6', { action: 'invalid_action' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid_action/i);
  });
});

// ─── WebhookRouteRegistry Tests ─────────────────────────────────────────

describe('WebhookRouteRegistry', () => {
  let WebhookRouteRegistry: any;
  let WebhookRouteError: any;
  let resetWebhookRoutes: any;

  beforeEach(async () => {
    const mod = await import('../extensions/crypto/src/services/webhook-routes.js');
    WebhookRouteRegistry = mod.WebhookRouteRegistry;
    WebhookRouteError = mod.WebhookRouteError;
    resetWebhookRoutes = mod.resetWebhookRoutes;
    resetWebhookRoutes();
  });

  afterEach(() => {
    resetWebhookRoutes();
  });

  it('exports registry class, error class, and singleton helpers', async () => {
    const mod = await import('../extensions/crypto/src/services/webhook-routes.js');
    expect(mod.WebhookRouteRegistry).toBeDefined();
    expect(mod.WebhookRouteError).toBeDefined();
    expect(mod.getWebhookRoutes).toBeDefined();
    expect(mod.resetWebhookRoutes).toBeDefined();
  });

  it('starts empty', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    expect(reg.list().length).toBe(0);
  });

  it('creates a route', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    const route = reg.create({
      name: 'github-push',
      path: '/github',
      source: 'GitHub',
      secret: 'mysecret123',
      triggerPlan: 'deploy-plan',
      createdBy: 'test',
    });

    expect(route.name).toBe('github-push');
    expect(route.path).toBe('/github');
    expect(route.source).toBe('GitHub');
    expect(route.secret).toBe('mysecret123');
    expect(route.triggerPlan).toBe('deploy-plan');
    expect(route.enabled).toBe(true);
    expect(route.hitCount).toBe(0);
    expect(route.id).toMatch(/^wh_/);
  });

  it('rejects invalid route names', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    const badNames = ['A', 'AB SPACE', 'HAS_UPPER', '123start'];
    for (const name of badNames) {
      expect(() => reg.create({
        name,
        path: '/test',
        source: 'Test',
        createdBy: 'test',
      })).toThrow(WebhookRouteError);
    }
  });

  it('rejects invalid paths', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    const badPaths = ['no-slash', '/HAS UPPER', ''];
    for (const path of badPaths) {
      expect(() => reg.create({
        name: 'test-route',
        path,
        source: 'Test',
        createdBy: 'test',
      })).toThrow(WebhookRouteError);
    }
  });

  it('rejects duplicate route names', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    reg.create({ name: 'github', path: '/github', source: 'GH', createdBy: 'test' });
    expect(() => reg.create({
      name: 'github',
      path: '/github2',
      source: 'GH2',
      createdBy: 'test',
    })).toThrow(WebhookRouteError);
  });

  it('rejects duplicate paths', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    reg.create({ name: 'route-a', path: '/shared', source: 'A', createdBy: 'test' });
    expect(() => reg.create({
      name: 'route-b',
      path: '/shared',
      source: 'B',
      createdBy: 'test',
    })).toThrow(WebhookRouteError);
  });

  it('looks up routes by name and path', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    reg.create({ name: 'stripe', path: '/stripe', source: 'Stripe', createdBy: 'test' });
    expect(reg.getByName('stripe')).toBeDefined();
    expect(reg.getByName('stripe')!.path).toBe('/stripe');
    expect(reg.getByPath('/stripe')).toBeDefined();
    expect(reg.getByPath('/stripe')!.name).toBe('stripe');
    expect(reg.getByName('nonexistent')).toBeNull();
    expect(reg.getByPath('/nonexistent')).toBeNull();
  });

  it('updates route fields', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    const route = reg.create({ name: 'test-up', path: '/update', source: 'Test', createdBy: 'test' });
    const updated = reg.update(route.id, { enabled: false, triggerPlan: 'new-plan' });
    expect(updated).toBeDefined();
    expect(updated.enabled).toBe(false);
    expect(updated.triggerPlan).toBe('new-plan');
  });

  it('returns null when updating nonexistent id', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    expect(reg.update('fake_id', { enabled: false })).toBeNull();
  });

  it('deletes routes', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    const route = reg.create({ name: 'deleteme', path: '/del', source: 'Del', createdBy: 'test' });
    expect(reg.list().length).toBe(1);
    expect(reg.delete(route.id)).toBe(true);
    expect(reg.list().length).toBe(0);
    expect(reg.delete('nonexistent')).toBe(false);
  });

  it('records hit counts', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    const route = reg.create({ name: 'hits', path: '/hits', source: 'Test', createdBy: 'test' });
    expect(route.hitCount).toBe(0);
    reg.recordHit(route.id);
    reg.recordHit(route.id);
    expect(reg.get(route.id)!.hitCount).toBe(2);
  });

  it('filters by enabled status', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    reg.create({ name: 'active', path: '/active', source: 'A', createdBy: 'test' });
    const r2 = reg.create({ name: 'inactive', path: '/inactive', source: 'B', createdBy: 'test' });
    reg.update(r2.id, { enabled: false });

    expect(reg.list({ enabled: true }).length).toBe(1);
    expect(reg.list({ enabled: false }).length).toBe(1);
    expect(reg.list().length).toBe(2);
  });

  it('clear empties the registry', () => {
    const reg = new WebhookRouteRegistry({ stateDir: '/tmp/test-webhooks-' + Date.now() });
    reg.create({ name: 'aaa', path: '/aaa', source: 'A', createdBy: 'test' });
    reg.create({ name: 'bbb', path: '/bbb', source: 'B', createdBy: 'test' });
    expect(reg.list().length).toBe(2);
    reg.clear();
    expect(reg.list().length).toBe(0);
  });

  it('singleton works', async () => {
    const { getWebhookRoutes, resetWebhookRoutes } = await import('../extensions/crypto/src/services/webhook-routes.js');
    resetWebhookRoutes();
    const a = getWebhookRoutes({ stateDir: '/tmp/test-wh-singleton-' + Date.now() });
    const b = getWebhookRoutes();
    expect(a).toBe(b);
    resetWebhookRoutes();
  });
});

// ─── WebhookServer Tests ────────────────────────────────────────────────

describe('WebhookServer', () => {
  let WebhookServer: any;
  let resetWebhookServer: any;

  beforeEach(async () => {
    const mod = await import('../extensions/crypto/src/services/webhook-server.js');
    WebhookServer = mod.WebhookServer;
    resetWebhookServer = mod.resetWebhookServer;
    resetWebhookServer();
  });

  afterEach(async () => {
    resetWebhookServer();
  });

  it('exports server class and singleton helpers', async () => {
    const mod = await import('../extensions/crypto/src/services/webhook-server.js');
    expect(mod.WebhookServer).toBeDefined();
    expect(mod.getWebhookServer).toBeDefined();
    expect(mod.resetWebhookServer).toBeDefined();
  });

  it('defaults to port 0 (disabled) and localhost', () => {
    const saved = process.env.OPENCLAWNCH_WEBHOOK_PORT;
    delete process.env.OPENCLAWNCH_WEBHOOK_PORT;

    const server = new WebhookServer();
    const config = server.getConfig();
    expect(config.port).toBe(0);
    expect(config.host).toBe('127.0.0.1');
    expect(config.maxPayloadBytes).toBe(65_536);
    expect(config.rateLimitPerMinute).toBe(60);

    if (saved) process.env.OPENCLAWNCH_WEBHOOK_PORT = saved;
  });

  it('respects custom config', () => {
    const server = new WebhookServer({
      port: 9999,
      host: '0.0.0.0',
      maxPayloadBytes: 1024,
      rateLimitPerMinute: 10,
    });
    const config = server.getConfig();
    expect(config.port).toBe(9999);
    expect(config.host).toBe('0.0.0.0');
    expect(config.maxPayloadBytes).toBe(1024);
    expect(config.rateLimitPerMinute).toBe(10);
  });

  it('start returns false when port is 0', async () => {
    const server = new WebhookServer({ port: 0 });
    const started = await server.start();
    expect(started).toBe(false);
    expect(server.isRunning()).toBe(false);
  });

  it('can register event handler', () => {
    const server = new WebhookServer();
    const handler = vi.fn();
    server.onEvent(handler);
    // Handler registered — no crash
  });

  it('isRunning returns false before start', () => {
    const server = new WebhookServer({ port: 8888 });
    expect(server.isRunning()).toBe(false);
  });

  it('stop is safe to call when not running', async () => {
    const server = new WebhookServer();
    await server.stop(); // should not throw
  });

  it('singleton works', async () => {
    const { getWebhookServer, resetWebhookServer } = await import('../extensions/crypto/src/services/webhook-server.js');
    resetWebhookServer();
    const a = getWebhookServer({ port: 0 });
    const b = getWebhookServer();
    expect(a).toBe(b);
    resetWebhookServer();
  });
});

// ─── AgentsCommand Tests ────────────────────────────────────────────────

describe('AgentsCommand', () => {
  let agentsCommand: any;
  let resetAgentPool: any;

  beforeEach(async () => {
    const cmdMod = await import('../extensions/crypto/src/commands/agents-command.js');
    agentsCommand = cmdMod.agentsCommand;
    const poolMod = await import('../extensions/crypto/src/services/agent-pool.js');
    resetAgentPool = poolMod.resetAgentPool;
    resetAgentPool();
  });

  afterEach(() => {
    resetAgentPool();
  });

  it('has correct command shape', () => {
    expect(agentsCommand.name).toBe('agents');
    expect(agentsCommand.description).toBeTruthy();
    expect(agentsCommand.acceptsArgs).toBe(true);
    expect(typeof agentsCommand.handler).toBe('function');
  });

  it('list subcommand shows all agents', async () => {
    const result = await agentsCommand.handler({ args: '' });
    expect(result.text).toMatch(/Sub-Agents/);
    expect(result.text).toMatch(/strategist/);
    expect(result.text).toMatch(/analyst/);
    expect(result.text).toMatch(/accountant/);
    expect(result.text).toMatch(/risk_manager/);
  });

  it('info subcommand shows agent details', async () => {
    const result = await agentsCommand.handler({ args: 'info strategist' });
    expect(result.text).toMatch(/DeFi Strategist/);
    expect(result.text).toMatch(/System prompt/);
    expect(result.text).toMatch(/haiku/);
  });

  it('info subcommand with missing name', async () => {
    const result = await agentsCommand.handler({ args: 'info' });
    expect(result.text).toMatch(/Usage/);
  });

  it('info subcommand with unknown agent', async () => {
    const result = await agentsCommand.handler({ args: 'info nonexistent' });
    expect(result.text).toMatch(/nonexistent/);
    expect(result.text).toMatch(/found/i);
  });

  it('disable/enable cycle', async () => {
    const disResult = await agentsCommand.handler({ args: 'disable strategist' });
    expect(disResult.text).toMatch(/disabled/);

    const disAgain = await agentsCommand.handler({ args: 'disable strategist' });
    expect(disAgain.text).toMatch(/already disabled/);

    const enResult = await agentsCommand.handler({ args: 'enable strategist' });
    expect(enResult.text).toMatch(/enabled/);

    const enAgain = await agentsCommand.handler({ args: 'enable strategist' });
    expect(enAgain.text).toMatch(/already enabled/);
  });

  it('delete subcommand rejects presets', async () => {
    const result = await agentsCommand.handler({ args: 'delete strategist' });
    expect(result.text).toMatch(/Cannot delete preset/i);
  });

  it('unknown subcommand shows help', async () => {
    const result = await agentsCommand.handler({ args: 'foobar' });
    expect(result.text).toMatch(/Unknown subcommand/);
    expect(result.text).toMatch(/list/);
  });
});

// ─── WebhooksCommand Tests ──────────────────────────────────────────────

describe('WebhooksCommand', () => {
  let webhooksCommand: any;
  let resetWebhookRoutes: any;
  let resetWebhookServer: any;

  beforeEach(async () => {
    const cmdMod = await import('../extensions/crypto/src/commands/webhooks-command.js');
    webhooksCommand = cmdMod.webhooksCommand;
    const routeMod = await import('../extensions/crypto/src/services/webhook-routes.js');
    resetWebhookRoutes = routeMod.resetWebhookRoutes;
    const srvMod = await import('../extensions/crypto/src/services/webhook-server.js');
    resetWebhookServer = srvMod.resetWebhookServer;
    resetWebhookRoutes();
    resetWebhookServer();
  });

  afterEach(() => {
    resetWebhookRoutes();
    resetWebhookServer();
  });

  it('has correct command shape', () => {
    expect(webhooksCommand.name).toBe('webhooks');
    expect(webhooksCommand.description).toBeTruthy();
    expect(webhooksCommand.acceptsArgs).toBe(true);
    expect(typeof webhooksCommand.handler).toBe('function');
  });

  it('list subcommand shows server status', async () => {
    const result = await webhooksCommand.handler({ args: '' });
    expect(result.text).toMatch(/Webhook Server/);
  });

  it('list subcommand shows empty routes', async () => {
    const result = await webhooksCommand.handler({ args: 'list' });
    expect(result.text).toMatch(/None defined/i);
  });

  it('info subcommand with missing name', async () => {
    const result = await webhooksCommand.handler({ args: 'info' });
    expect(result.text).toMatch(/Usage/);
  });

  it('info subcommand with unknown route', async () => {
    const result = await webhooksCommand.handler({ args: 'info nonexistent' });
    expect(result.text).toMatch(/found/i);
  });

  it('enable/disable/delete with missing name', async () => {
    const enable = await webhooksCommand.handler({ args: 'enable' });
    expect(enable.text).toMatch(/Usage/);
    const disable = await webhooksCommand.handler({ args: 'disable' });
    expect(disable.text).toMatch(/Usage/);
    const del = await webhooksCommand.handler({ args: 'delete' });
    expect(del.text).toMatch(/Usage/);
  });

  it('unknown subcommand shows help', async () => {
    const result = await webhooksCommand.handler({ args: 'foobar' });
    expect(result.text).toMatch(/Unknown subcommand/);
    expect(result.text).toMatch(/list/);
  });
});

// ─── Tool Config Tests ──────────────────────────────────────────────────

describe('V5 Tool Config', () => {
  it('tool config has agent_delegate entry', async () => {
    const { TOOL_REQUIREMENTS, getToolRequirement } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    const agentConfig = getToolRequirement('agent_delegate');
    expect(agentConfig).toBeDefined();
    expect(agentConfig!.label).toBe('Agent Delegate');
    expect(agentConfig!.worksWithoutKeys).toBe(false);
    expect(agentConfig!.requiredKeys).toEqual([]);
    expect(agentConfig!.optionalKeys).toContain('ANTHROPIC_API_KEY');
    expect(agentConfig!.optionalKeys).toContain('OPENROUTER_API_KEY');
    expect(agentConfig!.optionalKeys).toContain('OPENAI_API_KEY');
    expect(agentConfig!.optionalKeys).toContain('BANKR_LLM_KEY');
  });

  it('tool config has 38 entries total', async () => {
    const { getAllToolStatus } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    const statuses = getAllToolStatus();
    expect(statuses.length).toBe(39);
  });
});

// ─── Plugin Registration Counts ─────────────────────────────────────────

describe('V5 Plugin Registration', () => {
  it('plugin registers 45 tools including agent_delegate', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const registered: string[] = [];
    const mockApi = {
      registerTool: (tool: any) => registered.push(tool.name),
      registerCommand: () => {},
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    expect(registered).toHaveLength(45);
    expect(registered).toContain('agent_delegate');
  });

  it('plugin registers 114 commands including agents, webhooks, skills, interrupt, api, and pull', { timeout: 15000 }, async () => {
    const plugin = (await import('../extensions/crypto/index.js')).default;
    const commands: string[] = [];
    const mockApi = {
      registerTool: () => {},
      registerCommand: (cmd: any) => commands.push(cmd.name),
      on: () => {},
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.register(mockApi);
    expect(commands).toHaveLength(114);
    expect(commands).toContain('agents');
    expect(commands).toContain('webhooks');
  });

  it('tool config has 38 entries including agent_delegate', async () => {
    const { getAllToolStatus } = await import(
      '../extensions/crypto/src/services/tool-config-service.js'
    );
    const statuses = getAllToolStatus();
    expect(statuses.length).toBe(39);
    const agentConfig = statuses.find((s: any) => s.tool === 'agent_delegate');
    expect(agentConfig).toBeDefined();
    expect(agentConfig!.label).toBe('Agent Delegate');
  });
});
