/**
 * Pull Command Tests
 *
 * Tests the /pull command that reads files from the running bot.
 *
 * Covers:
 *   1. No-args returns shortcuts help
 *   2. Path shortcut resolution
 *   3. Security: blocks .env, private keys, credentials, secrets
 *   4. File not found
 *   5. Directory listing
 *   6. Small file inline code block
 *   7. Large file truncation fallback
 *   8. Command shape (name, description, acceptsArgs, requireAuth)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.env.HOME ?? '/tmp', '.openclawnch-pull-test-' + Date.now());

function setupTestFiles() {
  mkdirSync(join(TEST_DIR, 'subdir'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'hello.txt'), 'Hello, world!');
  writeFileSync(join(TEST_DIR, 'big.txt'), 'X'.repeat(5000));
  writeFileSync(join(TEST_DIR, '.env'), 'SECRET=oops');
  writeFileSync(join(TEST_DIR, 'credentials.json'), '{"key":"val"}');
  writeFileSync(join(TEST_DIR, 'id_rsa'), 'private-key-data');
  writeFileSync(join(TEST_DIR, 'my_secret_config'), 'hidden');
  writeFileSync(join(TEST_DIR, 'bot_token.txt'), 'tok');
  writeFileSync(join(TEST_DIR, 'subdir', 'nested.txt'), 'nested content');
}

describe('Pull Command', () => {
  let pullCommand: any;

  beforeEach(async () => {
    setupTestFiles();
    // Dynamic import to get the command
    const mod = await import('../extensions/crypto/src/commands/pull-command.js');
    pullCommand = mod.pullCommand;
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  // ── Shape ──────────────────────────────────────────────────────

  it('has correct command shape', () => {
    expect(pullCommand.name).toBe('pull');
    expect(pullCommand.description).toContain('/pull');
    expect(pullCommand.acceptsArgs).toBe(true);
    expect(pullCommand.requireAuth).toBe(true);
    expect(typeof pullCommand.handler).toBe('function');
  });

  // ── No args: show shortcuts ───────────────────────────────────

  it('returns shortcuts help when no args provided', async () => {
    const result = await pullCommand.handler({ args: '' });
    expect(result.text).toContain('Shortcuts');
    expect(result.text).toContain('/pull');
    expect(result.text).toContain('plans');
    expect(result.text).toContain('memory');
  });

  it('returns shortcuts help when ctx is undefined', async () => {
    const result = await pullCommand.handler();
    expect(result.text).toContain('Shortcuts');
  });

  // ── Security: blocked files ───────────────────────────────────

  it('blocks .env files', async () => {
    const result = await pullCommand.handler({ args: join(TEST_DIR, '.env') });
    expect(result.text).toContain('Blocked');
    expect(result.text).toContain('sensitive');
  });

  it('blocks credentials.json', async () => {
    const result = await pullCommand.handler({ args: join(TEST_DIR, 'credentials.json') });
    expect(result.text).toContain('Blocked');
  });

  it('blocks private key files (id_rsa)', async () => {
    const result = await pullCommand.handler({ args: join(TEST_DIR, 'id_rsa') });
    expect(result.text).toContain('Blocked');
  });

  it('blocks files with "secret" in the name', async () => {
    const result = await pullCommand.handler({ args: join(TEST_DIR, 'my_secret_config') });
    expect(result.text).toContain('Blocked');
  });

  it('blocks bot_token files', async () => {
    const result = await pullCommand.handler({ args: join(TEST_DIR, 'bot_token.txt') });
    expect(result.text).toContain('Blocked');
  });

  // ── File not found ────────────────────────────────────────────

  it('returns not-found for nonexistent paths', async () => {
    const result = await pullCommand.handler({ args: '/tmp/definitely-does-not-exist-xyz-123' });
    expect(result.text).toContain('Not found');
  });

  // ── Directory listing ─────────────────────────────────────────

  it('lists directory contents', async () => {
    const result = await pullCommand.handler({ args: TEST_DIR });
    expect(result.text).toContain('subdir/');
    expect(result.text).toContain('hello.txt');
    expect(result.text).toContain('big.txt');
  });

  // ── Small file: inline ────────────────────────────────────────

  it('returns small file inline as code block', async () => {
    const result = await pullCommand.handler({ args: join(TEST_DIR, 'hello.txt') });
    expect(result.text).toContain('hello.txt');
    expect(result.text).toContain('Hello, world!');
    expect(result.text).toContain('```');
  });

  // ── Large file: truncation fallback ───────────────────────────

  it('truncates large files with fallback message', async () => {
    const result = await pullCommand.handler({ args: join(TEST_DIR, 'big.txt') });
    expect(result.text).toContain('big.txt');
    expect(result.text).toContain('truncated');
  });

  // ── Nested file via absolute path ─────────────────────────────

  it('reads nested files via absolute path', async () => {
    const result = await pullCommand.handler({ args: join(TEST_DIR, 'subdir', 'nested.txt') });
    expect(result.text).toContain('nested.txt');
    expect(result.text).toContain('nested content');
  });
});
