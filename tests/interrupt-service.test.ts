/**
 * Interrupt Service Tests
 *
 * Tests the interrupt flag service used by /interrupt and /interrupt_plan.
 *
 * Covers:
 *   1. InterruptService — flag lifecycle (set, consume, expire)
 *   2. InterruptService — duplicate detection
 *   3. InterruptService — TTL expiry (30s)
 *   4. InterruptService — isPending (peek without consume)
 *   5. InterruptService — sweep cleans stale entries
 *   6. InterruptService — stop() clears sweep timer
 *   7. /interrupt command handler
 *   8. /interrupt_plan command handler
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// 1. InterruptService — Core Flag Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('InterruptService — Flag Lifecycle', () => {
  beforeEach(async () => {
    const { resetInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    resetInterruptService();
  });

  afterEach(async () => {
    const { resetInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    resetInterruptService();
  });

  it('sets a new interrupt flag and returns true', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    expect(svc.interrupt('session-1')).toBe(true);
    expect(svc.size).toBe(1);
  });

  it('consume returns true and removes the flag', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    svc.interrupt('session-1');
    expect(svc.consume('session-1')).toBe(true);
    expect(svc.size).toBe(0);
    // Second consume returns false
    expect(svc.consume('session-1')).toBe(false);
  });

  it('consume returns false for nonexistent session', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    expect(svc.consume('nonexistent')).toBe(false);
  });

  it('returns false if session already has active flag', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    expect(svc.interrupt('session-1')).toBe(true);
    expect(svc.interrupt('session-1')).toBe(false); // Already active
  });

  it('allows re-interrupt after consume', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    svc.interrupt('session-1');
    svc.consume('session-1');
    expect(svc.interrupt('session-1')).toBe(true); // Can set again
  });

  it('manages multiple sessions independently', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    svc.interrupt('session-1');
    svc.interrupt('session-2');
    expect(svc.size).toBe(2);
    svc.consume('session-1');
    expect(svc.size).toBe(1);
    expect(svc.consume('session-2')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. InterruptService — isPending (peek)
// ═══════════════════════════════════════════════════════════════════════════

describe('InterruptService — isPending', () => {
  beforeEach(async () => {
    const { resetInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    resetInterruptService();
  });

  afterEach(async () => {
    const { resetInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    resetInterruptService();
  });

  it('returns true without consuming the flag', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    svc.interrupt('session-1');
    expect(svc.isPending('session-1')).toBe(true);
    // Flag still exists
    expect(svc.size).toBe(1);
    expect(svc.isPending('session-1')).toBe(true);
  });

  it('returns false for nonexistent session', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    expect(svc.isPending('nonexistent')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. InterruptService — TTL Expiry
// ═══════════════════════════════════════════════════════════════════════════

describe('InterruptService — TTL Expiry', () => {
  beforeEach(async () => {
    const { resetInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    resetInterruptService();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { resetInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    resetInterruptService();
  });

  it('consume returns false after TTL expires (30s)', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    svc.interrupt('session-1');

    // Advance past TTL
    vi.advanceTimersByTime(31_000);

    expect(svc.consume('session-1')).toBe(false);
  });

  it('isPending returns false after TTL expires', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    svc.interrupt('session-1');

    vi.advanceTimersByTime(31_000);

    expect(svc.isPending('session-1')).toBe(false);
    // Expired flag gets cleaned up on access
    expect(svc.size).toBe(0);
  });

  it('allows re-interrupt after TTL expiry', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    svc.interrupt('session-1');

    vi.advanceTimersByTime(31_000);

    // Expired — can set again
    expect(svc.interrupt('session-1')).toBe(true);
  });

  it('flag is still valid before TTL expires', async () => {
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    const svc = getInterruptService();
    svc.interrupt('session-1');

    vi.advanceTimersByTime(29_000); // Just under TTL

    expect(svc.isPending('session-1')).toBe(true);
    expect(svc.consume('session-1')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. InterruptService — Stop / Cleanup
// ═══════════════════════════════════════════════════════════════════════════

describe('InterruptService — Stop', () => {
  it('stop() clears the sweep timer without error', async () => {
    const { getInterruptService, resetInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    resetInterruptService();

    const svc = getInterruptService();
    svc.interrupt('session-1');
    // Should not throw
    svc.stop();
    expect(svc.size).toBe(1); // Stop doesn't clear flags, just the timer
    resetInterruptService();
  });

  it('resetInterruptService stops timer and clears singleton', async () => {
    const { getInterruptService, resetInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    resetInterruptService();

    const svc1 = getInterruptService();
    svc1.interrupt('session-1');

    resetInterruptService();

    const svc2 = getInterruptService();
    expect(svc2.size).toBe(0); // Fresh instance
    expect(svc1).not.toBe(svc2);
    resetInterruptService();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. /interrupt Command
// ═══════════════════════════════════════════════════════════════════════════

describe('/interrupt Command', () => {
  beforeEach(async () => {
    const { resetInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    resetInterruptService();
  });

  afterEach(async () => {
    const { resetInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    resetInterruptService();
  });

  it('has correct command metadata', async () => {
    const { interruptCommand } = await import(
      '../extensions/crypto/src/commands/interrupt-command.js'
    );
    expect(interruptCommand.name).toBe('interrupt');
    expect(interruptCommand.acceptsArgs).toBe(false);
    expect(interruptCommand.requireAuth).toBe(true);
  });

  it('returns confirmation on first interrupt', async () => {
    const { interruptCommand } = await import(
      '../extensions/crypto/src/commands/interrupt-command.js'
    );
    const result = await interruptCommand.handler({ sessionKey: 'test-session' });
    expect(result.text).toContain('Interrupted');
    expect(result.text).toContain('cancelled');
  });

  it('returns already-interrupted on duplicate call', async () => {
    const { interruptCommand } = await import(
      '../extensions/crypto/src/commands/interrupt-command.js'
    );
    await interruptCommand.handler({ sessionKey: 'test-session' });
    const result = await interruptCommand.handler({ sessionKey: 'test-session' });
    expect(result.text).toContain('Already interrupted');
  });

  it('uses default session key when none provided', async () => {
    const { interruptCommand } = await import(
      '../extensions/crypto/src/commands/interrupt-command.js'
    );
    const result = await interruptCommand.handler({});
    expect(result.text).toContain('Interrupted');

    // The service should have a flag for "default"
    const { getInterruptService } = await import(
      '../extensions/crypto/src/services/interrupt-service.js'
    );
    expect(getInterruptService().isPending('default')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. /interrupt_plan Command
// ═══════════════════════════════════════════════════════════════════════════

describe('/interrupt_plan Command', () => {
  it('has correct command metadata', async () => {
    const { interruptPlanCommand } = await import(
      '../extensions/crypto/src/commands/interrupt-command.js'
    );
    expect(interruptPlanCommand.name).toBe('interrupt_plan');
    expect(interruptPlanCommand.acceptsArgs).toBe(true);
    expect(interruptPlanCommand.requireAuth).toBe(true);
  });

  it('reports no active plans when scheduler is empty', async () => {
    const { interruptPlanCommand } = await import(
      '../extensions/crypto/src/commands/interrupt-command.js'
    );
    const result = await interruptPlanCommand.handler({ args: '' });
    expect(result.text).toContain('No active plans');
  });
});
