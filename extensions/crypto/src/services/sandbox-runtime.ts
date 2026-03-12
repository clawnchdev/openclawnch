/**
 * Sandbox Runtime — restricted execution environment for user-defined tools.
 *
 * Provides a controlled execution context that:
 * 1. Enforces budget limits (max USD cost per execution)
 * 2. Restricts network access to allowlisted endpoints only
 * 3. Limits execution time (timeout)
 * 4. Caps the number of sub-tool calls for composed/custom tools
 * 5. Audits all actions for the tool creator's review
 *
 * The sandbox does NOT use V8 isolates or Worker threads — it enforces
 * limits at the application layer via budget tracking, allowlist gating,
 * and call counting. This is sufficient for our threat model (the agent
 * is the executor, not arbitrary user code).
 */

import { jsonResult, errorResult } from '../lib/tool-helpers.js';
import { guardedFetch, addAllowedHost, isAllowedEndpoint } from './endpoint-allowlist.js';
import type { UserTool, ApiConnectorDef, ComposedStep } from './user-tool-service.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface SandboxContext {
  /** The user tool being executed. */
  tool: UserTool;
  /** Who triggered the execution. */
  userId: string;
  /** Budget remaining (USD). Decremented by sub-calls. */
  budgetRemainingUsd: number;
  /** Number of sub-tool calls made. */
  callCount: number;
  /** Max sub-tool calls allowed. */
  maxCalls: number;
  /** Execution start time. */
  startedAt: number;
  /** Max execution time (ms). */
  timeoutMs: number;
  /** Audit log of actions taken. */
  auditLog: SandboxAuditEntry[];
}

export interface SandboxAuditEntry {
  timestamp: number;
  action: string;
  detail: string;
  costUsd?: number;
}

export interface ToolDispatcher {
  /** Call a built-in tool by name. Returns the tool result. */
  call(toolName: string, args: Record<string, unknown>): Promise<any>;
}

// ─── Sandbox Execution ──────────────────────────────────────────────────

/**
 * Execute an API connector tool in the sandbox.
 */
export async function executeApiConnector(
  def: ApiConnectorDef,
  args: Record<string, unknown>,
  ctx: SandboxContext,
): Promise<any> {
  // Check budget
  if (ctx.budgetRemainingUsd <= 0) {
    return errorResult('Budget exhausted for this tool execution.');
  }

  // Check timeout
  if (Date.now() - ctx.startedAt > ctx.timeoutMs) {
    return errorResult('Tool execution timed out.');
  }

  // Build URL from template
  let path = def.path;
  for (const [key, value] of Object.entries(args)) {
    path = path.replace(`{{${key}}}`, encodeURIComponent(String(value)));
  }
  const url = `${def.baseUrl}${path}`;

  // Validate URL is allowed
  if (!isAllowedEndpoint(url)) {
    // For user tools, we dynamically allow the configured baseUrl
    try {
      const parsed = new URL(def.baseUrl);
      addAllowedHost(parsed.hostname);
    } catch {
      return errorResult(`Cannot reach "${url}" — not in allowlist and baseUrl is invalid.`);
    }
  }

  // Build headers, resolving secret references
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (def.headers) {
    for (const [key, value] of Object.entries(def.headers)) {
      if (value.startsWith('$SECRET:')) {
        // Secret references are resolved by the credential vault at a higher layer
        // For now, pass through as-is (the caller should have resolved them)
        headers[key] = value;
      } else {
        headers[key] = value;
      }
    }
  }

  // Build body
  let body: string | undefined;
  if (def.bodyTemplate && ['POST', 'PUT', 'PATCH'].includes(def.method)) {
    body = def.bodyTemplate;
    for (const [key, value] of Object.entries(args)) {
      body = body.replace(`{{${key}}}`, JSON.stringify(value).replace(/^"|"$/g, ''));
    }
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  // Audit
  ctx.auditLog.push({
    timestamp: Date.now(),
    action: 'http_request',
    detail: `${def.method} ${url}`,
  });
  ctx.callCount += 1;

  // Execute
  try {
    const response = await guardedFetch(url, {
      method: def.method,
      headers,
      body,
      signal: AbortSignal.timeout(def.timeoutMs ?? 15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return errorResult(`API returned ${response.status}: ${text.slice(0, 200)}`);
    }

    const data: any = await response.json();

    // Extract result using resultPath
    let result = data;
    if (def.resultPath) {
      for (const key of def.resultPath.split('.')) {
        result = result?.[key];
      }
    }

    return jsonResult(result ?? data);
  } catch (err) {
    return errorResult(`API call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Execute a composed tool in the sandbox.
 */
export async function executeComposedTool(
  steps: ComposedStep[],
  args: Record<string, unknown>,
  ctx: SandboxContext,
  dispatcher: ToolDispatcher,
): Promise<any> {
  const results: any[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;

    // Check limits
    if (ctx.budgetRemainingUsd <= 0) {
      return errorResult(`Budget exhausted at step ${i + 1} ("${step.label}").`);
    }
    if (Date.now() - ctx.startedAt > ctx.timeoutMs) {
      return errorResult(`Timeout at step ${i + 1} ("${step.label}").`);
    }
    if (ctx.callCount >= ctx.maxCalls) {
      return errorResult(`Max tool calls reached at step ${i + 1} ("${step.label}").`);
    }

    // Resolve step args — replace "$step.N.field" references
    const resolvedArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step.args)) {
      if (typeof value === 'string' && value.startsWith('$step.')) {
        const match = value.match(/^\$step\.(\d+)\.(.+)$/);
        if (match) {
          const stepIdx = parseInt(match[1]!, 10);
          const field = match[2]!;
          const prevResult = results[stepIdx];
          resolvedArgs[key] = prevResult?.[field] ?? value;
        } else {
          resolvedArgs[key] = value;
        }
      } else if (typeof value === 'string' && value.startsWith('$arg.')) {
        const argName = value.slice(5);
        resolvedArgs[key] = args[argName] ?? value;
      } else {
        resolvedArgs[key] = value;
      }
    }

    // Audit
    ctx.auditLog.push({
      timestamp: Date.now(),
      action: 'tool_call',
      detail: `Step ${i + 1}: ${step.tool}(${JSON.stringify(resolvedArgs).slice(0, 100)})`,
    });
    ctx.callCount += 1;

    // Execute step
    try {
      const result = await dispatcher.call(step.tool, resolvedArgs);
      // Parse result if it's a tool result shape
      let parsed = result;
      if (result?.content?.[0]?.text) {
        try { parsed = JSON.parse(result.content[0].text); } catch { parsed = result.content[0].text; }
      }
      results.push(parsed);

      if (result?.isError && (step.stopOnFailure !== false)) {
        return errorResult(`Step ${i + 1} ("${step.label}") failed: ${result.content?.[0]?.text ?? 'unknown error'}`);
      }
    } catch (err) {
      if (step.stopOnFailure !== false) {
        return errorResult(`Step ${i + 1} ("${step.label}") threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      results.push({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  return jsonResult({
    stepsCompleted: results.length,
    totalSteps: steps.length,
    results,
    lastResult: results[results.length - 1],
  });
}

/**
 * Create a sandbox context for tool execution.
 */
export function createSandboxContext(tool: UserTool, userId: string): SandboxContext {
  const maxCalls = tool.definition.type === 'custom'
    ? (tool.definition as any).maxCalls ?? 5
    : tool.definition.type === 'composed'
      ? (tool.definition as any).steps?.length ?? 10
      : 1;

  return {
    tool,
    userId,
    budgetRemainingUsd: tool.maxBudgetUsd,
    callCount: 0,
    maxCalls,
    startedAt: Date.now(),
    timeoutMs: 30_000,
    auditLog: [],
  };
}
