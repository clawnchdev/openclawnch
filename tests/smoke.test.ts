/**
 * E2E smoke test — verifies the extension can be loaded, tools can be invoked,
 * and the CLI entry point exists. Runs without any wallet config (read-only mode).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('E2E smoke: project files', () => {
  it('CLI entry point exists', () => {
    expect(existsSync(resolve(ROOT, 'bin/openclawnch.mjs'))).toBe(true);
  });

  it('SOUL.md exists', () => {
    expect(existsSync(resolve(ROOT, 'SOUL.md'))).toBe(true);
  });

  it('extension index exists', () => {
    expect(existsSync(resolve(ROOT, 'extensions/crypto/index.ts'))).toBe(true);
  });

  it('all skill files exist', () => {
    const skills = [
      'clawnchconnect',
      'defi-trading',
      'clawnch-launchpad',
      'market-intel',
    ];
    for (const skill of skills) {
      const path = resolve(ROOT, `extensions/crypto/skills/${skill}/SKILL.md`);
      expect(existsSync(path), `Missing skill: ${skill}`).toBe(true);
    }
  });

  it('build output exists after build', () => {
    // dist/ should exist if build was run before tests
    expect(existsSync(resolve(ROOT, 'dist/wrapper.js'))).toBe(true);
  });
});

describe('E2E smoke: tool execution without wallet', () => {
  let tools: any[] = [];

  beforeAll(async () => {
    const { default: plugin } = await import('../extensions/crypto/index.js');
    const mockApi = {
      registerTool: vi.fn((tool: any) => tools.push(tool)),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    plugin.register(mockApi);
  });

  it('defi_price tool returns results for "search" (no wallet needed)', async () => {
    const priceTool = tools.find(t => t.name === 'defi_price');
    expect(priceTool).toBeDefined();

    // Search should work without a wallet (it's read-only)
    const result = await priceTool.execute('test', { action: 'search', token: 'ETH' });
    expect(result.content).toBeDefined();
    expect(result.content[0].text).toBeDefined();
    // Should not be an error about wallet connection
    expect(result.content[0].text).not.toContain('No wallet connected');
  });

  it('defi_price tool returns results for "trending" (no wallet needed)', async () => {
    const priceTool = tools.find(t => t.name === 'defi_price');
    const result = await priceTool.execute('test', { action: 'trending' });
    expect(result.content).toBeDefined();
    // Trending may fail due to API, but should not error about wallet
    expect(result.content[0].text).not.toContain('No wallet connected');
  });

  it('market_intel tool returns results for "trending" (no wallet needed)', async () => {
    const intelTool = tools.find(t => t.name === 'market_intel');
    expect(intelTool).toBeDefined();

    const result = await intelTool.execute('test', { action: 'trending' });
    expect(result.content).toBeDefined();
    expect(result.content[0].text).not.toContain('No wallet connected');
  });

  it('defi_swap tool requires wallet connection', async () => {
    const swapTool = tools.find(t => t.name === 'defi_swap');
    expect(swapTool).toBeDefined();

    const result = await swapTool.execute('test', {
      action: 'quote',
      token_in: 'ETH',
      token_out: 'USDC',
      amount: '0.01',
    });
    expect(result.content[0].text).toContain('No wallet connected');
  });

  it('clawnch_launch tool requires wallet connection', async () => {
    const launchTool = tools.find(t => t.name === 'clawnch_launch');
    expect(launchTool).toBeDefined();

    const result = await launchTool.execute('test', {
      name: 'Test Token',
      symbol: 'TEST',
    });
    expect(result.content[0].text).toContain('No wallet connected');
  });

  it('clawnch_fees tool requires wallet connection', async () => {
    const feesTool = tools.find(t => t.name === 'clawnch_fees');
    expect(feesTool).toBeDefined();

    const result = await feesTool.execute('test', { action: 'check' });
    expect(result.content[0].text).toContain('No wallet connected');
  });
});

describe('E2E smoke: gateway hook', () => {
  it('gateway_start hook runs without error when no wallet env is set', async () => {
    const { default: plugin } = await import('../extensions/crypto/index.js');

    let hookFn: Function | null = null;
    const mockApi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, fn: Function) => {
        if (event === 'gateway_start') hookFn = fn;
      }),
      logger: { info: vi.fn(), warn: vi.fn() },
    };

    plugin.register(mockApi);
    expect(hookFn).toBeDefined();

    // With no WALLETCONNECT_PROJECT_ID or CLAWNCHER_PRIVATE_KEY, should log and return
    const origWC = process.env.WALLETCONNECT_PROJECT_ID;
    const origPK = process.env.CLAWNCHER_PRIVATE_KEY;
    delete process.env.WALLETCONNECT_PROJECT_ID;
    delete process.env.CLAWNCHER_PRIVATE_KEY;

    await expect(hookFn!()).resolves.not.toThrow();
    expect(mockApi.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('No wallet configured'),
    );

    // Restore
    if (origWC) process.env.WALLETCONNECT_PROJECT_ID = origWC;
    if (origPK) process.env.CLAWNCHER_PRIVATE_KEY = origPK;
  });
});
