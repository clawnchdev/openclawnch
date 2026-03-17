/**
 * Command History — Ring buffer of recent slash command results.
 *
 * Injected into the LLM prompt via before_prompt_build so the agent
 * can see what slash commands were run and their results. This bridges
 * the gap where the framework handles commands directly without passing
 * the results through the LLM's conversation history.
 *
 * Per-user, in-memory only (no persistence needed — current session only).
 */

const MAX_ENTRIES = 10;

interface CommandEntry {
  command: string;
  result: string;
  timestamp: number;
}

const _history = new Map<string, CommandEntry[]>();

/** Record a slash command result. */
export function recordCommand(userId: string, command: string, result: string): void {
  let entries = _history.get(userId);
  if (!entries) {
    entries = [];
    _history.set(userId, entries);
  }
  // Truncate result to avoid prompt bloat
  const truncated = result.length > 300 ? result.slice(0, 300) + '...' : result;
  entries.push({ command, result: truncated, timestamp: Date.now() });
  // Ring buffer
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

/** Get recent command history for prompt injection. */
export function getRecentCommands(userId: string, maxAge = 600_000): string | null {
  const entries = _history.get(userId);
  if (!entries || entries.length === 0) return null;

  const cutoff = Date.now() - maxAge; // 10 min default
  const recent = entries.filter(e => e.timestamp > cutoff);
  if (recent.length === 0) return null;

  const lines = recent.map(e => {
    const ago = Math.floor((Date.now() - e.timestamp) / 1000);
    const agoStr = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`;
    return `  ${e.command} (${agoStr}) → ${e.result}`;
  });

  return [
    '<recent_commands>',
    'These slash commands were run recently by the user:',
    ...lines,
    'These results are authoritative. Do not contradict them.',
    '</recent_commands>',
  ].join('\n');
}

/** Clear history for a user (on /new). */
export function clearCommandHistory(userId: string): void {
  _history.delete(userId);
}
