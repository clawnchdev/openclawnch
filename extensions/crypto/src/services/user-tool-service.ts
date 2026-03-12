/**
 * User-Defined Tool Service — CRUD for user-created tools with persistence.
 *
 * Users define tools in plain English or structured JSON. The service:
 * 1. Stores tool definitions to disk (~/.openclawnch/user-tools/)
 * 2. Compiles definitions into executable AnyAgentTool-compatible objects
 * 3. Manages lifecycle: create, update, disable, delete, list
 * 4. Provides a registry that the plugin can query for dynamic tool loading
 *
 * Tool types:
 * - api_connector: wraps an HTTP API endpoint as a tool
 * - composed: chains existing tools into a higher-level operation
 * - custom: user-defined logic via natural language description (LLM-interpreted)
 *
 * All user tools run through the SandboxRuntime for safety.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────

export type UserToolType = 'api_connector' | 'composed' | 'custom';

export interface UserToolParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: string | number | boolean;
}

/** API connector definition: wraps an HTTP endpoint as a tool. */
export interface ApiConnectorDef {
  type: 'api_connector';
  /** Base URL (e.g. "https://api.example.com/v1"). */
  baseUrl: string;
  /** HTTP method. */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** URL path template (e.g. "/users/{{userId}}/balance"). */
  path: string;
  /** Request headers (values can reference secrets: "$SECRET:my_api_key"). */
  headers?: Record<string, string>;
  /** Body template (for POST/PUT/PATCH). JSON string with {{param}} placeholders. */
  bodyTemplate?: string;
  /** How to extract the result from the response. JSONPath-like (e.g. "data.balance"). */
  resultPath?: string;
  /** Timeout in ms. Default: 15000. */
  timeoutMs?: number;
}

/** Composed tool: chains existing tools in sequence. */
export interface ComposedToolDef {
  type: 'composed';
  /** Steps to execute in order. Each step calls an existing tool. */
  steps: ComposedStep[];
}

export interface ComposedStep {
  /** Step label for display. */
  label: string;
  /** Tool name to call. */
  tool: string;
  /** Arguments to pass. Values can reference prior step outputs: "$step.0.balance". */
  args: Record<string, string | number | boolean>;
  /** If true, stop the chain on failure. Default: true. */
  stopOnFailure?: boolean;
}

/** Custom tool: LLM-interpreted behavior from natural language. */
export interface CustomToolDef {
  type: 'custom';
  /** Natural language description of what the tool does. */
  behavior: string;
  /** Which existing tools this custom tool is allowed to invoke. */
  allowedTools: string[];
  /** Max number of internal tool calls per execution. Default: 5. */
  maxCalls?: number;
}

export type UserToolDefinition = ApiConnectorDef | ComposedToolDef | CustomToolDef;

export interface UserTool {
  /** Unique ID. */
  id: string;
  /** Tool name (snake_case, must not conflict with built-in tools). */
  name: string;
  /** Human-readable label. */
  label: string;
  /** LLM-facing description. */
  description: string;
  /** Who created this tool. */
  createdBy: string;
  /** Tool parameters the user can pass. */
  params: UserToolParam[];
  /** The tool definition (api_connector, composed, or custom). */
  definition: UserToolDefinition;
  /** Whether this tool can write (affects readonly gate). */
  isWrite: boolean;
  /** Whether this tool is currently enabled. */
  enabled: boolean;
  /** Usage count (how many times executed). */
  usageCount: number;
  /** Max budget per execution in USD (for sandboxing). Default: 1. */
  maxBudgetUsd: number;
  /** Tags for organization. */
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

// ─── Reserved Names (cannot conflict with built-in tools) ───────────────

const RESERVED_PREFIXES = [
  'defi_', 'clawnch', 'bankr_', 'compound_', 'agent_', 'skill_', 'session_',
  'fiat_', 'market_', 'herd_', 'crypto_', 'watch_', 'manage_',
];

const RESERVED_NAMES = new Set([
  'transfer', 'bridge', 'permit2', 'cost_basis', 'analytics', 'block_explorer',
  'liquidity', 'wayfinder', 'molten', 'hummingbot', 'privacy', 'browser',
  'governance', 'farcaster', 'safe', 'airdrop', 'nft', 'yield', 'approvals',
]);

function isNameReserved(name: string): boolean {
  if (RESERVED_NAMES.has(name)) return true;
  for (const prefix of RESERVED_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

function isValidToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]{2,40}$/.test(name);
}

// ─── Service ────────────────────────────────────────────────────────────

export class UserToolService {
  private tools = new Map<string, UserTool>();
  private stateDir: string;

  constructor(opts?: { stateDir?: string }) {
    this.stateDir = opts?.stateDir ?? join(
      process.env.HOME ?? '', '.openclawnch', 'user-tools'
    );
    this.loadState();
  }

  /** Create a new user-defined tool. */
  create(params: {
    name: string;
    label: string;
    description: string;
    createdBy: string;
    params: UserToolParam[];
    definition: UserToolDefinition;
    isWrite?: boolean;
    maxBudgetUsd?: number;
    tags?: string[];
  }): UserTool {
    // Validate name
    if (!isValidToolName(params.name)) {
      throw new UserToolError(
        `Invalid tool name "${params.name}". Must be 3-40 chars, lowercase alphanumeric + underscores, starting with a letter.`
      );
    }
    if (isNameReserved(params.name)) {
      throw new UserToolError(
        `Tool name "${params.name}" conflicts with a built-in tool or reserved prefix.`
      );
    }
    if (this.getByName(params.name)) {
      throw new UserToolError(`A user tool named "${params.name}" already exists.`);
    }

    // Validate definition
    this.validateDefinition(params.definition);

    const id = `ut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const tool: UserTool = {
      id,
      name: params.name,
      label: params.label,
      description: params.description,
      createdBy: params.createdBy,
      params: params.params,
      definition: params.definition,
      isWrite: params.isWrite ?? false,
      enabled: true,
      usageCount: 0,
      maxBudgetUsd: params.maxBudgetUsd ?? 1,
      tags: params.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.tools.set(id, tool);
    this.saveState();
    return tool;
  }

  /** Update an existing user tool. */
  update(id: string, updates: Partial<Pick<UserTool, 'label' | 'description' | 'params' | 'definition' | 'isWrite' | 'enabled' | 'maxBudgetUsd' | 'tags'>>): UserTool | null {
    const tool = this.tools.get(id);
    if (!tool) return null;

    if (updates.definition) this.validateDefinition(updates.definition);

    Object.assign(tool, updates, { updatedAt: Date.now() });
    this.saveState();
    return tool;
  }

  /** Delete a user tool. */
  delete(id: string): boolean {
    const existed = this.tools.delete(id);
    if (existed) this.saveState();
    return existed;
  }

  /** Get a user tool by ID. */
  get(id: string): UserTool | null {
    return this.tools.get(id) ?? null;
  }

  /** Get a user tool by name. */
  getByName(name: string): UserTool | null {
    for (const t of this.tools.values()) {
      if (t.name === name) return t;
    }
    return null;
  }

  /** List all user tools, optionally filtered. */
  list(opts?: { createdBy?: string; enabled?: boolean; type?: UserToolType }): UserTool[] {
    let all = Array.from(this.tools.values());
    if (opts?.createdBy) all = all.filter(t => t.createdBy === opts.createdBy);
    if (opts?.enabled !== undefined) all = all.filter(t => t.enabled === opts.enabled);
    if (opts?.type) all = all.filter(t => t.definition.type === opts.type);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get all enabled user tools (for runtime registration). */
  getEnabledTools(): UserTool[] {
    return Array.from(this.tools.values()).filter(t => t.enabled);
  }

  /** Increment usage count after a tool execution. */
  recordUsage(id: string): void {
    const tool = this.tools.get(id);
    if (tool) {
      tool.usageCount += 1;
      tool.updatedAt = Date.now();
      this.saveState();
    }
  }

  /** Check if a name is available for a new tool. */
  isNameAvailable(name: string): { available: boolean; reason?: string } {
    if (!isValidToolName(name)) {
      return { available: false, reason: 'Invalid format. Must be 3-40 chars, lowercase alphanumeric + underscores.' };
    }
    if (isNameReserved(name)) {
      return { available: false, reason: 'Conflicts with a built-in tool or reserved prefix.' };
    }
    if (this.getByName(name)) {
      return { available: false, reason: 'A user tool with this name already exists.' };
    }
    return { available: true };
  }

  /** Clear all state (for testing). */
  clear(): void {
    this.tools.clear();
  }

  // ── Validation ──────────────────────────────────────────────────────

  private validateDefinition(def: UserToolDefinition): void {
    switch (def.type) {
      case 'api_connector':
        if (!def.baseUrl) throw new UserToolError('API connector requires a baseUrl.');
        if (!def.path) throw new UserToolError('API connector requires a path.');
        if (!def.method) throw new UserToolError('API connector requires a method.');
        try { new URL(def.baseUrl); } catch {
          throw new UserToolError(`Invalid baseUrl: "${def.baseUrl}".`);
        }
        break;

      case 'composed':
        if (!def.steps || def.steps.length === 0) {
          throw new UserToolError('Composed tool requires at least one step.');
        }
        if (def.steps.length > 10) {
          throw new UserToolError('Composed tool cannot have more than 10 steps.');
        }
        for (const step of def.steps) {
          if (!step.tool) throw new UserToolError(`Step "${step.label}" requires a tool name.`);
        }
        break;

      case 'custom':
        if (!def.behavior || def.behavior.length < 10) {
          throw new UserToolError('Custom tool requires a behavior description (at least 10 chars).');
        }
        if (!def.allowedTools || def.allowedTools.length === 0) {
          throw new UserToolError('Custom tool requires at least one allowed tool.');
        }
        if ((def.maxCalls ?? 5) > 20) {
          throw new UserToolError('Custom tool maxCalls cannot exceed 20.');
        }
        break;

      default:
        throw new UserToolError(`Unknown tool type: ${(def as any).type}`);
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private loadState(): void {
    try {
      const filePath = join(this.stateDir, 'tools.json');
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        for (const t of data) {
          this.tools.set(t.id, t);
        }
      }
    } catch { /* fresh start */ }
  }

  private saveState(): void {
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
      const filePath = join(this.stateDir, 'tools.json');
      writeFileSync(filePath, JSON.stringify(Array.from(this.tools.values()), null, 2), 'utf8');
    } catch { /* best effort */ }
  }
}

// ─── Error Class ────────────────────────────────────────────────────────

export class UserToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserToolError';
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: UserToolService | null = null;

export function getUserToolService(opts?: { stateDir?: string }): UserToolService {
  if (!instance) {
    instance = new UserToolService(opts);
  }
  return instance;
}

export function resetUserToolService(): void {
  instance?.clear();
  instance = null;
}
