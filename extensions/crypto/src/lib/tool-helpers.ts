/**
 * Tool helper utilities — matches OpenClaw's AnyAgentTool patterns.
 * 
 * These mirror the helpers from openclaw/plugin-sdk but are self-contained
 * so the extension can work without a direct import dependency on openclaw internals.
 */

import { Type, type TSchema, type Static } from '@sinclair/typebox';

// ─── TypeBox Schema Helpers ──────────────────────────────────────────────

/**
 * Create a string enum schema (required).
 * Matches OpenClaw's `stringEnum()` from src/agents/schema/typebox.ts
 */
export function stringEnum<T extends readonly string[]>(
  values: T,
  options: Record<string, unknown> = {},
) {
  return Type.Unsafe<T[number]>({
    type: 'string',
    enum: [...values],
    ...options,
  });
}

/**
 * Create an optional string enum schema.
 */
export function optionalStringEnum<T extends readonly string[]>(
  values: T,
  options: Record<string, unknown> = {},
) {
  return Type.Optional(stringEnum(values, options));
}

// ─── Tool Result Helpers ─────────────────────────────────────────────────

/**
 * Wrap a value as a JSON tool result.
 * Matches OpenClaw's `jsonResult()` from src/agents/tools/common.ts
 * Returns AgentToolResult shape: { content: [...], details: T }
 */
export function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }>; details: unknown } {
  return {
    content: [{
      type: 'text' as const,
      text: typeof data === 'string' ? data : JSON.stringify(data, bigintReplacer, 2),
    }],
    details: data,
  };
}

/**
 * Wrap a plain text string as a tool result.
 */
export function textResult(text: string): { content: Array<{ type: 'text'; text: string }>; details: unknown } {
  return {
    content: [{ type: 'text' as const, text }],
    details: { text },
  };
}

/**
 * Create an error result.
 */
export function errorResult(message: string): { content: Array<{ type: 'text'; text: string }>; details: unknown; isError: true } {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    details: { error: message },
    isError: true as const,
  };
}

// ─── Parameter Helpers ───────────────────────────────────────────────────

/**
 * Read a string parameter, supporting both camelCase and snake_case keys.
 * Matches OpenClaw's `readStringParam()`.
 */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean },
): string | undefined {
  const val = params[key] ?? params[toSnakeCase(key)];
  if (val === undefined || val === null) {
    if (opts?.required) throw new ToolInputError(`Missing required parameter: ${key}`);
    return undefined;
  }
  return String(val);
}

/**
 * Read a number parameter.
 */
export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean },
): number | undefined {
  const val = params[key] ?? params[toSnakeCase(key)];
  if (val === undefined || val === null) {
    if (opts?.required) throw new ToolInputError(`Missing required parameter: ${key}`);
    return undefined;
  }
  const num = Number(val);
  if (isNaN(num)) throw new ToolInputError(`Parameter ${key} must be a number, got: ${val}`);
  return num;
}

// ─── Error Classes ───────────────────────────────────────────────────────

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export class ToolAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolAuthorizationError';
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────

function toSnakeCase(s: string): string {
  return s.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}
