/**
 * Evolution Mode Service — stable vs evolving agent behavior.
 *
 * Two modes:
 *   stable   — default. The agent uses only static skills and does not
 *              modify any learned knowledge. Memory and skill tools are
 *              registered but return "disabled in stable mode" errors.
 *   evolving — full self-improvement. Memory writes, skill creation,
 *              skill patching, session recall, and periodic nudges.
 *
 * The mode is per-user and persisted to disk. A global default can be
 * set via OPENCLAWNCH_EVOLUTION_MODE env var.
 *
 * Nudge system:
 *   Every N turns, inject a system message reminder about:
 *   - Persisting important discoveries to agent memory
 *   - Creating skills from complex workflows
 *   The nudge intervals are configurable via env vars.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────

export type EvolutionMode = 'stable' | 'evolving';

export interface EvolutionConfig {
  /** Default mode for new users. Default: 'stable'. */
  defaultMode?: EvolutionMode;
  /** Turns between memory persistence nudges. Default: 10. */
  memoryNudgeInterval?: number;
  /** Turns between skill creation nudges. Default: 15. */
  skillNudgeInterval?: number;
  /** Minimum turns before first nudge. Default: 5. */
  minTurnsBeforeNudge?: number;
}

interface UserEvolutionState {
  mode: EvolutionMode;
  turnCount: number;
  lastMemoryNudgeTurn: number;
  lastSkillNudgeTurn: number;
}

// ─── Nudge Messages ──────────────────────────────────────────────────────

const MEMORY_NUDGE = `[Self-improvement reminder] If you discovered something useful in this conversation — a tool quirk, an environment fact, a user preference, or a lesson learned — save it to agent memory with the agent_memory tool (action: "add") so you remember it next time.`;

const SKILL_NUDGE = `[Self-improvement reminder] If you just completed a complex multi-step workflow (5+ tool calls), fixed a tricky error, or discovered a non-trivial DeFi strategy, consider saving it as a learned skill with the skill_evolve tool (action: "create") so you can reuse it efficiently next time.`;

// ─── Evolution Mode Service ──────────────────────────────────────────────

class EvolutionModeService {
  private config: Required<EvolutionConfig>;
  private users = new Map<string, UserEvolutionState>();

  constructor(config: EvolutionConfig = {}) {
    const envDefault = process.env.OPENCLAWNCH_EVOLUTION_MODE as EvolutionMode | undefined;
    this.config = {
      defaultMode: config.defaultMode ?? envDefault ?? 'stable',
      memoryNudgeInterval: config.memoryNudgeInterval
        ?? (parseInt(process.env.OPENCLAWNCH_MEMORY_NUDGE_INTERVAL ?? '', 10) || 10),
      skillNudgeInterval: config.skillNudgeInterval
        ?? (parseInt(process.env.OPENCLAWNCH_SKILL_NUDGE_INTERVAL ?? '', 10) || 15),
      minTurnsBeforeNudge: config.minTurnsBeforeNudge ?? 5,
    };
  }

  // ── Mode Management ────────────────────────────────────────────────

  getMode(userId: string): EvolutionMode {
    return this.getState(userId).mode;
  }

  setMode(userId: string, mode: EvolutionMode): void {
    const state = this.getState(userId);
    state.mode = mode;
    // Reset nudge counters on mode change
    state.turnCount = 0;
    state.lastMemoryNudgeTurn = 0;
    state.lastSkillNudgeTurn = 0;
    this.persistState(userId, state);
  }

  isEvolving(userId: string): boolean {
    return this.getMode(userId) === 'evolving';
  }

  // ── Turn Tracking & Nudges ─────────────────────────────────────────

  /**
   * Record a turn and return any nudge messages that should be injected.
   * Call this from after_tool_call or message_received.
   * Returns null if no nudge is needed.
   */
  recordTurn(userId: string): string | null {
    const state = this.getState(userId);
    if (state.mode !== 'evolving') return null;

    state.turnCount++;

    // Don't nudge too early in the session
    if (state.turnCount < this.config.minTurnsBeforeNudge) return null;

    // Check for memory nudge
    const turnsSinceMemoryNudge = state.turnCount - state.lastMemoryNudgeTurn;
    if (turnsSinceMemoryNudge >= this.config.memoryNudgeInterval) {
      state.lastMemoryNudgeTurn = state.turnCount;
      return MEMORY_NUDGE;
    }

    // Check for skill nudge
    const turnsSinceSkillNudge = state.turnCount - state.lastSkillNudgeTurn;
    if (turnsSinceSkillNudge >= this.config.skillNudgeInterval) {
      state.lastSkillNudgeTurn = state.turnCount;
      return SKILL_NUDGE;
    }

    return null;
  }

  /**
   * Get the current turn count for a user.
   */
  getTurnCount(userId: string): number {
    return this.getState(userId).turnCount;
  }

  // ── State Management ───────────────────────────────────────────────

  private getState(userId: string): UserEvolutionState {
    let state = this.users.get(userId);
    if (!state) {
      state = this.loadState(userId);
      this.users.set(userId, state);
    }
    return state;
  }

  private getStateDir(): string {
    return join(process.env.HOME ?? '/tmp', '.openclawnch', 'evolution');
  }

  private getStatePath(userId: string): string {
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return join(this.getStateDir(), `${safeId}.json`);
  }

  private loadState(userId: string): UserEvolutionState {
    try {
      const filePath = this.getStatePath(userId);
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        return {
          mode: data.mode === 'evolving' ? 'evolving' : 'stable',
          turnCount: 0, // Reset per session
          lastMemoryNudgeTurn: 0,
          lastSkillNudgeTurn: 0,
        };
      }
    } catch {
      // Fall through to default
    }

    return {
      mode: this.config.defaultMode,
      turnCount: 0,
      lastMemoryNudgeTurn: 0,
      lastSkillNudgeTurn: 0,
    };
  }

  private persistState(userId: string, state: UserEvolutionState): void {
    try {
      const dir = this.getStateDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(
        this.getStatePath(userId),
        JSON.stringify({ mode: state.mode }, null, 2),
        'utf8',
      );
    } catch {
      // Best effort
    }
  }

  // ── Diagnostics ────────────────────────────────────────────────────

  getStatus(): {
    defaultMode: EvolutionMode;
    memoryNudgeInterval: number;
    skillNudgeInterval: number;
    trackedUsers: number;
    config: Required<EvolutionConfig>;
  } {
    return {
      defaultMode: this.config.defaultMode,
      memoryNudgeInterval: this.config.memoryNudgeInterval,
      skillNudgeInterval: this.config.skillNudgeInterval,
      trackedUsers: this.users.size,
      config: this.config,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _instance: EvolutionModeService | null = null;

export function getEvolutionMode(config?: EvolutionConfig): EvolutionModeService {
  if (!_instance) {
    _instance = new EvolutionModeService(config);
  }
  return _instance;
}

export function resetEvolutionMode(): void {
  _instance = null;
}
