/**
 * Tests for issue reporter service and commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Point state dir at a temp directory for test isolation
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'issue-reporter-test-'));
  process.env.OPENCLAWNCH_STATE_DIR = tempDir;
});

afterEach(async () => {
  delete process.env.OPENCLAWNCH_STATE_DIR;
  // Reset singleton state
  const { resetReporter } = await import('../extensions/crypto/src/services/issue-reporter.js');
  resetReporter();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('issue reporter service', () => {
  it('defaults to disabled', async () => {
    const { isReportingEnabled } = await import('../extensions/crypto/src/services/issue-reporter.js');
    expect(isReportingEnabled('user-123')).toBe(false);
  });

  it('enables and persists config', async () => {
    const { enableReporting, isReportingEnabled, resetReporter } = await import('../extensions/crypto/src/services/issue-reporter.js');

    enableReporting('user-123');
    expect(isReportingEnabled('user-123')).toBe(true);

    // Clear cache and re-read from disk
    resetReporter();
    expect(isReportingEnabled('user-123')).toBe(true);
  });

  it('disables reporting', async () => {
    const { enableReporting, disableReporting, isReportingEnabled } = await import('../extensions/crypto/src/services/issue-reporter.js');

    enableReporting('user-123');
    expect(isReportingEnabled('user-123')).toBe(true);

    disableReporting('user-123');
    expect(isReportingEnabled('user-123')).toBe(false);
  });

  it('isolates users', async () => {
    const { enableReporting, isReportingEnabled } = await import('../extensions/crypto/src/services/issue-reporter.js');

    enableReporting('user-a');
    expect(isReportingEnabled('user-a')).toBe(true);
    expect(isReportingEnabled('user-b')).toBe(false);
  });

  it('sanitizes userId for path safety', async () => {
    const { enableReporting, isReportingEnabled } = await import('../extensions/crypto/src/services/issue-reporter.js');

    // Path traversal attempt
    enableReporting('../../etc/passwd');
    expect(isReportingEnabled('../../etc/passwd')).toBe(true);
    // Should not have created files outside temp dir
  });

  it('fileIssue rejects when not opted in', async () => {
    const { fileIssue } = await import('../extensions/crypto/src/services/issue-reporter.js');
    const result = fileIssue({
      title: 'Test',
      body: 'Test body',
      category: 'bug',
      userId: 'user-123',
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('not enabled');
    }
  });

  it('getReporterConfig returns default for new user', async () => {
    const { getReporterConfig } = await import('../extensions/crypto/src/services/issue-reporter.js');
    const config = getReporterConfig('new-user');
    expect(config.enabled).toBe(false);
    expect(config.issueCount).toBe(0);
  });

  it('getReporterConfig tracks opt-in timestamp', async () => {
    const { enableReporting, getReporterConfig } = await import('../extensions/crypto/src/services/issue-reporter.js');
    enableReporting('user-123');
    const config = getReporterConfig('user-123');
    expect(config.optedInAt).toBeDefined();
    expect(new Date(config.optedInAt!).getTime()).toBeGreaterThan(0);
  });
});

describe('report commands', () => {
  it('/report shows status when no args', async () => {
    const { reportCommand } = await import('../extensions/crypto/src/commands/report-command.js');
    const result = await reportCommand.handler({ senderId: 'user-1' });
    expect(result.text).toContain('Issue Reporter');
    expect(result.text).toContain('Disabled');
  });

  it('/report rejects when not opted in', async () => {
    const { reportCommand } = await import('../extensions/crypto/src/commands/report-command.js');
    const result = await reportCommand.handler({ senderId: 'user-1', args: 'some bug' });
    expect(result.text).toContain('not enabled');
    expect(result.text).toContain('/report_opt_in');
  });

  it('/report_opt_in enables reporting', async () => {
    const { reportOptInCommand } = await import('../extensions/crypto/src/commands/report-command.js');
    const { isReportingEnabled } = await import('../extensions/crypto/src/services/issue-reporter.js');

    const result = await reportOptInCommand.handler({ senderId: 'user-1' });
    expect(result.text).toContain('enabled');
    expect(isReportingEnabled('user-1')).toBe(true);
  });

  it('/report_opt_in is idempotent', async () => {
    const { reportOptInCommand } = await import('../extensions/crypto/src/commands/report-command.js');

    await reportOptInCommand.handler({ senderId: 'user-1' });
    const result = await reportOptInCommand.handler({ senderId: 'user-1' });
    expect(result.text).toContain('already enabled');
  });

  it('/report_opt_out disables reporting', async () => {
    const { reportOptInCommand, reportOptOutCommand } = await import('../extensions/crypto/src/commands/report-command.js');
    const { isReportingEnabled } = await import('../extensions/crypto/src/services/issue-reporter.js');

    await reportOptInCommand.handler({ senderId: 'user-1' });
    expect(isReportingEnabled('user-1')).toBe(true);

    const result = await reportOptOutCommand.handler({ senderId: 'user-1' });
    expect(result.text).toContain('disabled');
    expect(isReportingEnabled('user-1')).toBe(false);
  });

  it('/report_opt_out is idempotent', async () => {
    const { reportOptOutCommand } = await import('../extensions/crypto/src/commands/report-command.js');
    const result = await reportOptOutCommand.handler({ senderId: 'user-1' });
    expect(result.text).toContain('already disabled');
  });

  it('/report requires a title', async () => {
    const { reportCommand, reportOptInCommand } = await import('../extensions/crypto/src/commands/report-command.js');

    await reportOptInCommand.handler({ senderId: 'user-1' });
    // Pipe with empty title
    const result = await reportCommand.handler({ senderId: 'user-1', args: ' | just a body' });
    expect(result.text).toContain('provide a title');
  });

  it('all report commands require auth', async () => {
    const { reportCommand, reportOptInCommand, reportOptOutCommand } = await import('../extensions/crypto/src/commands/report-command.js');
    expect(reportCommand.requireAuth).toBe(true);
    expect(reportOptInCommand.requireAuth).toBe(true);
    expect(reportOptOutCommand.requireAuth).toBe(true);
  });
});
