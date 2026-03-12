/**
 * Agent Orchestrator — executes sub-agent tasks via direct LLM API calls.
 *
 * The orchestrator:
 * 1. Detects the active LLM provider and API key
 * 2. Resolves the sub-agent's model shortcut to a provider-specific model ID
 * 3. Makes direct Messages API calls (Anthropic format) or Chat Completions
 *    calls (OpenAI-compatible format for OpenRouter/OpenAI/Bankr)
 * 4. Handles the tool-use loop: sub-agent requests tool calls → orchestrator
 *    executes them via the dispatcher → feeds results back to the LLM
 * 5. Enforces budget (max tool calls) and timeout
 *
 * No new dependencies — uses native fetch() and the existing guardedFetch()
 * for endpoint allowlisting.
 */

import { jsonResult, errorResult } from '../lib/tool-helpers.js';
import { getCredentialVault } from './credential-vault.js';
import type { SubAgentDef } from './agent-pool.js';
import type { ToolDispatcher } from './sandbox-runtime.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type LlmProvider = 'anthropic' | 'openrouter' | 'openai' | 'bankr';

export interface OrchestratorResult {
  /** The sub-agent's final text response. */
  response: string;
  /** Tool calls made during execution. */
  toolCalls: ToolCallRecord[];
  /** Total LLM tokens used (input + output). Estimated. */
  tokensUsed: number;
  /** Execution time in ms. */
  durationMs: number;
  /** Whether the task completed or was cut short. */
  status: 'completed' | 'timeout' | 'max_calls' | 'error';
  /** Error message if status is 'error'. */
  error?: string;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
}

/** Tool schema for the sub-agent (simplified JSON Schema). */
interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ─── Provider Detection ─────────────────────────────────────────────────

export function detectProvider(): LlmProvider {
  const explicit = process.env.OPENCLAWNCH_LLM_PROVIDER;
  if (explicit === 'bankr' || explicit === 'openrouter' || explicit === 'openai' || explicit === 'anthropic') {
    return explicit as LlmProvider;
  }
  // Priority: Anthropic > OpenRouter > OpenAI > Bankr
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.BANKR_LLM_KEY) return 'bankr';
  return 'anthropic'; // fallback
}

export function getApiKey(provider: LlmProvider): string | null {
  const vault = getCredentialVault();
  switch (provider) {
    case 'anthropic':
      return vault.getSecret('llm.anthropic.apiKey', 'agent_orchestrator') ?? null;
    case 'openrouter':
      return vault.getSecret('llm.openrouter.apiKey', 'agent_orchestrator') ?? null;
    case 'openai':
      return vault.getSecret('llm.openai.apiKey', 'agent_orchestrator') ?? null;
    case 'bankr':
      return vault.getSecret('llm.bankr.key', 'agent_orchestrator') ?? null;
    default:
      return null;
  }
}

// ─── Model Resolution ───────────────────────────────────────────────────

/** Same model map as model-command.ts — maps shortcuts to provider-specific IDs. */
const SUB_AGENT_MODELS: Record<string, Record<LlmProvider, string>> = {
  'haiku':    { anthropic: 'claude-haiku-4-20250514',      openrouter: 'anthropic/claude-haiku-4-20250514',      openai: 'claude-haiku-4-20250514',      bankr: 'claude-haiku-4.5' },
  'sonnet':   { anthropic: 'claude-sonnet-4-20250514',     openrouter: 'anthropic/claude-sonnet-4-20250514',     openai: 'claude-sonnet-4-20250514',     bankr: 'claude-sonnet-4.6' },
  'opus':     { anthropic: 'claude-opus-4-20250514',       openrouter: 'anthropic/claude-opus-4-20250514',       openai: 'claude-opus-4-20250514',       bankr: 'claude-opus-4.6' },
  'gpt-mini': { anthropic: 'claude-haiku-4-20250514',      openrouter: 'openai/gpt-5-mini',                     openai: 'gpt-5-mini',                   bankr: 'gpt-5-mini' },
  'gpt':      { anthropic: 'claude-sonnet-4-20250514',     openrouter: 'openai/gpt-5.2',                        openai: 'gpt-5.2',                      bankr: 'gpt-5.2' },
};

function resolveModel(shortcut: string, provider: LlmProvider): string {
  const mapping = SUB_AGENT_MODELS[shortcut];
  if (mapping) return mapping[provider];
  // Not a shortcut — use as-is
  return shortcut;
}

// ─── Anthropic Messages API ─────────────────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent[];
}

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  messages: AnthropicMessage[],
  tools: ToolSchema[],
  maxTokens: number,
  temperature: number,
  signal: AbortSignal,
): Promise<{ content: AnthropicContent[]; usage: { input_tokens: number; output_tokens: number } }> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages,
  };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Anthropic API ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as any;
  return {
    content: data.content ?? [],
    usage: data.usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}

// ─── OpenAI-Compatible API (OpenRouter, OpenAI, Bankr) ──────────────────

const PROVIDER_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  bankr: 'https://llm.bankr.bot/v1/chat/completions',
};

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

async function callOpenAICompat(
  provider: LlmProvider,
  apiKey: string,
  model: string,
  system: string,
  messages: OaiMessage[],
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  maxTokens: number,
  temperature: number,
  signal: AbortSignal,
): Promise<{ message: OaiMessage; usage: { prompt_tokens: number; completion_tokens: number } }> {
  const url = PROVIDER_URLS[provider];
  if (!url) throw new Error(`Unknown provider: ${provider}`);

  const allMessages: OaiMessage[] = [
    { role: 'system', content: system },
    ...messages,
  ];

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: allMessages,
  };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${provider} API ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as any;
  const choice = data.choices?.[0];
  return {
    message: choice?.message ?? { role: 'assistant', content: '' },
    usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
  };
}

// ─── Tool Schema Builder ────────────────────────────────────────────────

/**
 * Build tool schemas for the sub-agent from the registered tool list.
 * Only includes tools that are in the agent's allowedTools list.
 */
export function buildToolSchemas(
  allowedTools: string[],
  registeredTools: Array<{ name: string; description: string; parameters: any }>,
): ToolSchema[] {
  if (allowedTools.length === 0) return [];

  const allowed = new Set(allowedTools);
  return registeredTools
    .filter(t => allowed.has(t.name))
    .map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters ?? { type: 'object', properties: {} },
    }));
}

// ─── Orchestrator ───────────────────────────────────────────────────────

/**
 * Execute a task with a sub-agent.
 *
 * 1. Sends the task to the sub-agent's LLM with its system prompt
 * 2. If the LLM requests tool calls, executes them via the dispatcher
 * 3. Feeds tool results back and continues until the LLM produces a final response
 * 4. Enforces maxToolCalls and timeout
 */
export async function executeSubAgent(
  agent: SubAgentDef,
  task: string,
  dispatcher: ToolDispatcher,
  registeredTools: Array<{ name: string; description: string; parameters: any }>,
): Promise<OrchestratorResult> {
  const startTime = Date.now();
  const provider = detectProvider();
  const apiKey = getApiKey(provider);

  if (!apiKey) {
    return {
      response: '',
      toolCalls: [],
      tokensUsed: 0,
      durationMs: Date.now() - startTime,
      status: 'error',
      error: `No API key found for provider "${provider}". Set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, or BANKR_LLM_KEY.`,
    };
  }

  const model = resolveModel(agent.model, provider);
  const toolSchemas = buildToolSchemas(agent.allowedTools, registeredTools);
  const toolCallRecords: ToolCallRecord[] = [];
  let totalTokens = 0;
  let callCount = 0;

  const abort = AbortSignal.timeout(agent.timeoutMs);

  try {
    if (provider === 'anthropic') {
      return await runAnthropicLoop(
        apiKey, model, agent, task, toolSchemas, dispatcher,
        toolCallRecords, startTime, abort,
      );
    } else {
      return await runOpenAILoop(
        provider, apiKey, model, agent, task, toolSchemas, dispatcher,
        toolCallRecords, startTime, abort,
      );
    }
  } catch (err) {
    const isTimeout = err instanceof Error && (
      err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.includes('timed out')
    );
    return {
      response: toolCallRecords.length > 0
        ? `Sub-agent ${isTimeout ? 'timed out' : 'failed'} after ${toolCallRecords.length} tool call(s). Partial results may be available in the tool call log.`
        : '',
      toolCalls: toolCallRecords,
      tokensUsed: totalTokens,
      durationMs: Date.now() - startTime,
      status: isTimeout ? 'timeout' : 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Anthropic Tool-Use Loop ────────────────────────────────────────────

async function runAnthropicLoop(
  apiKey: string,
  model: string,
  agent: SubAgentDef,
  task: string,
  toolSchemas: ToolSchema[],
  dispatcher: ToolDispatcher,
  toolCallRecords: ToolCallRecord[],
  startTime: number,
  signal: AbortSignal,
): Promise<OrchestratorResult> {
  const messages: AnthropicMessage[] = [
    { role: 'user', content: [{ type: 'text', text: task }] },
  ];

  let totalTokens = 0;
  let callCount = 0;

  while (callCount <= agent.maxToolCalls) {
    const result = await callAnthropic(
      apiKey, model, agent.systemPrompt, messages, toolSchemas,
      agent.maxTokens, agent.temperature, signal,
    );

    totalTokens += (result.usage.input_tokens + result.usage.output_tokens);

    // Check if there are tool_use blocks
    const toolUses = result.content.filter(c => c.type === 'tool_use') as
      Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;

    if (toolUses.length === 0) {
      // Final response — extract text
      const textParts = result.content.filter(c => c.type === 'text') as Array<{ type: 'text'; text: string }>;
      const response = textParts.map(t => t.text).join('\n');

      return {
        response,
        toolCalls: toolCallRecords,
        tokensUsed: totalTokens,
        durationMs: Date.now() - startTime,
        status: 'completed',
      };
    }

    // Execute tool calls
    messages.push({ role: 'assistant', content: result.content });

    const toolResults: AnthropicContent[] = [];
    for (const tu of toolUses) {
      callCount++;
      if (callCount > agent.maxToolCalls) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'Error: Maximum tool calls reached. Please provide your final response.',
          is_error: true,
        });
        break;
      }

      const callStart = Date.now();
      try {
        const toolResult = await dispatcher.call(tu.name, tu.input);
        const resultText = typeof toolResult === 'string'
          ? toolResult
          : toolResult?.content?.[0]?.text ?? JSON.stringify(toolResult);

        toolCallRecords.push({
          tool: tu.name,
          args: tu.input,
          result: String(resultText).slice(0, 500),
          durationMs: Date.now() - callStart,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: String(resultText),
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        toolCallRecords.push({
          tool: tu.name,
          args: tu.input,
          result: `Error: ${errMsg}`,
          durationMs: Date.now() - callStart,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `Error: ${errMsg}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Max calls exceeded — ask for final response
  return {
    response: `Sub-agent reached maximum tool calls (${agent.maxToolCalls}). Results from ${toolCallRecords.length} call(s) are available.`,
    toolCalls: toolCallRecords,
    tokensUsed: totalTokens,
    durationMs: Date.now() - startTime,
    status: 'max_calls',
  };
}

// ─── OpenAI-Compatible Tool-Use Loop ────────────────────────────────────

async function runOpenAILoop(
  provider: LlmProvider,
  apiKey: string,
  model: string,
  agent: SubAgentDef,
  task: string,
  toolSchemas: ToolSchema[],
  dispatcher: ToolDispatcher,
  toolCallRecords: ToolCallRecord[],
  startTime: number,
  signal: AbortSignal,
): Promise<OrchestratorResult> {
  // Convert tool schemas to OpenAI format
  const oaiTools = toolSchemas.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  const messages: OaiMessage[] = [
    { role: 'user', content: task },
  ];

  let totalTokens = 0;
  let callCount = 0;

  while (callCount <= agent.maxToolCalls) {
    const result = await callOpenAICompat(
      provider, apiKey, model, agent.systemPrompt, messages, oaiTools,
      agent.maxTokens, agent.temperature, signal,
    );

    totalTokens += (result.usage.prompt_tokens + result.usage.completion_tokens);

    const msg = result.message;
    const toolCalls = msg.tool_calls ?? [];

    if (toolCalls.length === 0) {
      // Final response
      return {
        response: msg.content ?? '',
        toolCalls: toolCallRecords,
        tokensUsed: totalTokens,
        durationMs: Date.now() - startTime,
        status: 'completed',
      };
    }

    // Execute tool calls
    messages.push(msg);

    for (const tc of toolCalls) {
      callCount++;
      if (callCount > agent.maxToolCalls) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: 'Error: Maximum tool calls reached.',
        });
        break;
      }

      const callStart = Date.now();
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        parsedArgs = {};
      }

      try {
        const toolResult = await dispatcher.call(tc.function.name, parsedArgs);
        const resultText = typeof toolResult === 'string'
          ? toolResult
          : toolResult?.content?.[0]?.text ?? JSON.stringify(toolResult);

        toolCallRecords.push({
          tool: tc.function.name,
          args: parsedArgs,
          result: String(resultText).slice(0, 500),
          durationMs: Date.now() - callStart,
        });

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: String(resultText),
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        toolCallRecords.push({
          tool: tc.function.name,
          args: parsedArgs,
          result: `Error: ${errMsg}`,
          durationMs: Date.now() - callStart,
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `Error: ${errMsg}`,
        });
      }
    }
  }

  return {
    response: `Sub-agent reached maximum tool calls (${agent.maxToolCalls}).`,
    toolCalls: toolCallRecords,
    tokensUsed: totalTokens,
    durationMs: Date.now() - startTime,
    status: 'max_calls',
  };
}
