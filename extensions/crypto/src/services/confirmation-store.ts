/**
 * Confirmation Store — manages pending step confirmations for the plan executor.
 *
 * When a plan step requires user confirmation (requireConfirmation: true),
 * the executor pauses and creates a pending confirmation. The user can
 * respond with /approve or /deny to resolve it.
 *
 * Confirmations time out after CONFIRMATION_TIMEOUT_MS (5 minutes).
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface PendingConfirmation {
  /** The plan execution ID. */
  executionId: string;
  /** Plan name for display. */
  planName: string;
  /** The step label (e.g., "Swap 1 ETH → USDC"). */
  stepLabel: string;
  /** The tool being called. */
  tool: string;
  /** Resolved params for display. */
  params: Record<string, unknown>;
  /** The userId who owns the plan. */
  userId: string;
  /** When this confirmation was created. */
  createdAt: number;
  /** Resolve the confirmation Promise. */
  resolve: (approved: boolean) => void;
}

// ─── Store ──────────────────────────────────────────────────────────────

const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Pending confirmations keyed by a compound key: `${userId}` (most recent wins). */
const pendingByUser = new Map<string, PendingConfirmation>();

/** All pending confirmations keyed by executionId for cleanup. */
const pendingByExecution = new Map<string, PendingConfirmation>();

/**
 * Create a pending confirmation for a step.
 * Returns a Promise<boolean> that resolves when the user responds.
 * Times out after 5 minutes (resolves false).
 */
export function createPendingConfirmation(opts: {
  executionId: string;
  planName: string;
  stepLabel: string;
  tool: string;
  params: Record<string, unknown>;
  userId: string;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const pending: PendingConfirmation = {
      ...opts,
      createdAt: Date.now(),
      resolve,
    };

    // Store by user (latest confirmation wins — older ones get auto-denied)
    const existing = pendingByUser.get(opts.userId);
    if (existing) {
      existing.resolve(false); // Auto-deny the previous one
      pendingByExecution.delete(existing.executionId);
    }

    pendingByUser.set(opts.userId, pending);
    pendingByExecution.set(opts.executionId, pending);

    // Auto-deny after timeout
    setTimeout(() => {
      const current = pendingByUser.get(opts.userId);
      if (current === pending) {
        pending.resolve(false);
        pendingByUser.delete(opts.userId);
        pendingByExecution.delete(opts.executionId);
      }
    }, CONFIRMATION_TIMEOUT_MS);
  });
}

/**
 * Respond to the most recent pending confirmation for a user.
 * Returns the confirmation details if found, or null if no pending confirmation.
 */
export function respondToConfirmation(
  userId: string,
  approved: boolean,
): PendingConfirmation | null {
  const pending = pendingByUser.get(userId);
  if (!pending) return null;

  pending.resolve(approved);
  pendingByUser.delete(userId);
  pendingByExecution.delete(pending.executionId);
  return pending;
}

/**
 * Get the pending confirmation for a user (for display purposes).
 */
export function getPendingConfirmation(userId: string): PendingConfirmation | null {
  const pending = pendingByUser.get(userId);
  if (!pending) return null;

  // Check if it's expired
  if (Date.now() - pending.createdAt > CONFIRMATION_TIMEOUT_MS) {
    pending.resolve(false);
    pendingByUser.delete(userId);
    pendingByExecution.delete(pending.executionId);
    return null;
  }

  return pending;
}

/**
 * Cancel all pending confirmations for an execution (e.g., when plan is cancelled).
 */
export function cancelExecutionConfirmations(executionId: string): void {
  const pending = pendingByExecution.get(executionId);
  if (pending) {
    pending.resolve(false);
    pendingByUser.delete(pending.userId);
    pendingByExecution.delete(executionId);
  }
}

/**
 * How many confirmations are pending.
 */
export function pendingCount(): number {
  return pendingByUser.size;
}
