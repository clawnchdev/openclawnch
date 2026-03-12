/**
 * Tool Compiler — converts UserTool definitions into AnyAgentTool-compatible objects.
 *
 * This is the bridge between the user-tool-service (CRUD / persistence) and
 * the OpenClaw plugin registration system. It:
 *
 * 1. Generates TypeBox schemas from UserToolParam[] definitions
 * 2. Creates execute functions that route to the sandbox runtime
 * 3. Returns objects matching the AnyAgentTool shape expected by api.registerTool()
 *
 * User tools are compiled at plugin init time (for all enabled tools) and
 * on-demand when new tools are created at runtime.
 */

import { Type, type TSchema } from '@sinclair/typebox';
import { jsonResult, errorResult } from '../lib/tool-helpers.js';
import type { UserTool, UserToolParam, ApiConnectorDef, ComposedToolDef } from './user-tool-service.js';
import { getUserToolService } from './user-tool-service.js';
import {
  createSandboxContext,
  executeApiConnector,
  executeComposedTool,
  type ToolDispatcher,
} from './sandbox-runtime.js';

// ─── Types ──────────────────────────────────────────────────────────────

/** Shape matching AnyAgentTool from OpenClaw plugin SDK. */
export interface CompiledTool {
  name: string;
  label: string;
  ownerOnly: boolean;
  description: string;
  parameters: TSchema;
  execute: (toolCallId: string, args: unknown, ctx?: any) => Promise<any>;
}

// ─── Schema Generation ──────────────────────────────────────────────────

/**
 * Build a TypeBox schema from UserToolParam[] definitions.
 *
 * Each param becomes a property in a Type.Object schema. Required params
 * are listed in the object's `required` array (handled by TypeBox's
 * Type.Optional wrapper for non-required params).
 */
export function buildSchemaFromParams(params: UserToolParam[]): TSchema {
  if (params.length === 0) {
    return Type.Object({});
  }

  const properties: Record<string, TSchema> = {};

  for (const param of params) {
    let schema: TSchema;

    switch (param.type) {
      case 'string':
        schema = Type.String({ description: param.description });
        break;
      case 'number':
        schema = Type.Number({ description: param.description });
        break;
      case 'boolean':
        schema = Type.Boolean({ description: param.description });
        break;
      default:
        // Fallback to string for unknown types
        schema = Type.String({ description: param.description });
    }

    // Add default value if specified
    if (param.default !== undefined) {
      schema = Type.Optional({ ...schema, default: param.default } as any);
    }

    // Wrap optional params
    if (!param.required) {
      schema = Type.Optional(schema);
    }

    properties[param.name] = schema;
  }

  return Type.Object(properties);
}

// ─── Tool Compilation ───────────────────────────────────────────────────

/**
 * Compile a UserTool into an AnyAgentTool-compatible object.
 *
 * The returned object has the same shape as built-in tools (name, label,
 * ownerOnly, description, parameters, execute) and can be passed directly
 * to api.registerTool().
 *
 * @param tool - The user tool definition from UserToolService
 * @param dispatcher - Interface for calling built-in tools (for composed/custom types)
 * @returns CompiledTool ready for registration
 */
export function compileTool(tool: UserTool, dispatcher: ToolDispatcher): CompiledTool {
  const schema = buildSchemaFromParams(tool.params);

  return {
    name: tool.name,
    label: tool.label,
    ownerOnly: tool.isWrite,
    description: `[User Tool] ${tool.description}`,
    parameters: schema,

    execute: async (_toolCallId: string, args: unknown, ctx?: any) => {
      // Ensure the tool is still enabled
      const current = getUserToolService().get(tool.id);
      if (!current || !current.enabled) {
        return errorResult(`User tool "${tool.name}" is disabled or has been deleted.`);
      }

      // Create sandbox context
      const userId = ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'unknown';
      const sandbox = createSandboxContext(current, userId);

      try {
        const params = (args ?? {}) as Record<string, unknown>;
        let result: any;

        switch (current.definition.type) {
          case 'api_connector':
            result = await executeApiConnector(
              current.definition as ApiConnectorDef,
              params,
              sandbox,
            );
            break;

          case 'composed':
            result = await executeComposedTool(
              (current.definition as ComposedToolDef).steps,
              params,
              sandbox,
              dispatcher,
            );
            break;

          case 'custom':
            // Custom tools are LLM-interpreted: return the behavior description
            // along with context so the LLM can decide how to fulfill the request.
            // The LLM will use the allowedTools to call sub-tools as needed.
            result = jsonResult({
              type: 'custom_tool_invocation',
              behavior: current.definition.behavior,
              allowedTools: (current.definition as any).allowedTools,
              maxCalls: (current.definition as any).maxCalls ?? 5,
              inputArgs: params,
              instructions: `This is a user-defined custom tool. Follow the behavior description above ` +
                `to fulfill the request. You may call the listed allowedTools (up to ${(current.definition as any).maxCalls ?? 5} ` +
                `times) to achieve the goal. Return the final result.`,
            });
            break;

          default:
            result = errorResult(`Unknown tool type: ${(current.definition as any).type}`);
        }

        // Record usage
        getUserToolService().recordUsage(current.id);

        // Attach audit log to result details
        if (result?.details && typeof result.details === 'object') {
          (result.details as any)._audit = {
            callCount: sandbox.callCount,
            budgetUsedUsd: current.maxBudgetUsd - sandbox.budgetRemainingUsd,
            entries: sandbox.auditLog,
          };
        }

        return result;
      } catch (err) {
        return errorResult(
          `User tool "${tool.name}" failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  };
}

// ─── Batch Compilation ──────────────────────────────────────────────────

/**
 * Compile all enabled user tools into registerable tool objects.
 *
 * Called at plugin init time to load persisted user tools.
 */
export function compileAllEnabledTools(dispatcher: ToolDispatcher): CompiledTool[] {
  const service = getUserToolService();
  const enabled = service.getEnabledTools();
  return enabled.map(tool => compileTool(tool, dispatcher));
}
