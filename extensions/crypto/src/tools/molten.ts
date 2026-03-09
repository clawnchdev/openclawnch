/**
 * Molten Tool — Intent resolution layer for AI agents via api.molten.gg
 *
 * Three interaction modes:
 *   1. Conversations (guided) — describe what you need, Molten's concierge guides you
 *   2. Direct search — programmatic capability search with optional auto-execute
 *   3. Intents (async) — post offers/requests, ClawRank matches across the network
 *
 * Plus: matches, messaging, events, profile management, capability browsing.
 *
 * API docs: https://molten.gg/skill.md
 * Base URL: https://api.molten.gg/api/v1
 *
 * Requires MOLTEN_API_KEY for authenticated operations.
 * Use the `register` action first to get an API key.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { getWalletState } from '../services/walletconnect-service.js';
import { checkToolConfig } from '../services/tool-config-service.js';
import { guardedFetch } from '../services/endpoint-allowlist.js';
import { getCredentialVault } from '../services/credential-vault.js';

// ─── API Client ──────────────────────────────────────────────────────────

const MOLTEN_BASE_URL = 'https://api.molten.gg/api/v1';

function getBaseUrl(): string {
  return process.env.MOLTEN_BASE_URL || MOLTEN_BASE_URL;
}

function getMoltenApiKey(): string | undefined {
  return getCredentialVault().getSecret('bot.molten.apiKey', 'molten') ?? _inMemoryApiKey ?? undefined;
}

let _inMemoryApiKey: string | undefined;

function setMoltenApiKey(apiKey: string): void {
  // M10 FIX: Only store in memory, not process.env (reduces blast radius)
  _inMemoryApiKey = apiKey;
}

async function moltenFetch(
  method: string,
  path: string,
  body?: unknown,
  requireAuth = true,
): Promise<any> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Client-Type': 'openclaw',
  };

  if (requireAuth) {
    const apiKey = getMoltenApiKey();
    if (!apiKey) throw new MoltenApiError(401, 'No API key set');
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await guardedFetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errMsg = data?.error?.message || data?.message || response.statusText;
    const errCode = data?.error?.code || undefined;
    throw new MoltenApiError(response.status, errMsg, errCode);
  }

  return data;
}

class MoltenApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'MoltenApiError';
    this.status = status;
    this.code = code;
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────

const ACTIONS = [
  // Registration & profile
  'register', 'profile', 'update_profile', 'claim_status',
  // Conversations (guided flow)
  'conversation', 'conversation_reply', 'conversation_status', 'list_conversations',
  // Search (programmatic)
  'search',
  // Browse capabilities (no auth)
  'browse', 'capability_details',
  // Intents (async matching)
  'create_intent', 'list_intents', 'cancel_intent',
  // Matches
  'list_matches', 'accept_match', 'reject_match', 'complete_match', 'match_message',
  // Events
  'check_events', 'ack_events',
  // Webhooks
  'setup_webhook',
] as const;

const INTENT_TYPES = ['offer', 'request'] as const;

// ─── Schema ──────────────────────────────────────────────────────────────

const MoltenSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'register: register agent (returns API key). profile: get your profile. update_profile: update info. ' +
      'conversation: start guided conversation. conversation_reply: reply to conversation. ' +
      'search: direct capability search. browse: list all capabilities (no auth). ' +
      'create_intent: post async offer/request. list_intents: your intents. cancel_intent: cancel. ' +
      'list_matches: browse matches. accept_match/reject_match/complete_match: manage matches. ' +
      'match_message: message a match. check_events: poll events. ack_events: acknowledge.',
  }),

  // Registration
  name: Type.Optional(Type.String({ description: 'Agent name (lowercase, 2-64 chars)' })),
  description: Type.Optional(Type.String({ description: 'Agent/intent description (up to 500 chars)' })),
  client_type: Type.Optional(Type.String({ description: 'Client type: "openclaw", "conway", or "generic" (default: openclaw)' })),
  wallet_address: Type.Optional(Type.String({ description: 'EVM wallet address (0x...)' })),
  twitter_handle: Type.Optional(Type.String({ description: 'X/Twitter handle' })),

  // Conversation
  message: Type.Optional(Type.String({ description: 'Message for conversation/reply/match_message' })),
  session_id: Type.Optional(Type.String({ description: 'Conversation session ID (for replies)' })),
  confirm: Type.Optional(Type.Boolean({ description: 'Confirm execution in conversation' })),
  cancel: Type.Optional(Type.Boolean({ description: 'Cancel current conversation flow' })),
  selection: Type.Optional(Type.Number({ description: 'Select a match by index (1-based) in conversation' })),

  // Search
  query: Type.Optional(Type.String({ description: 'Natural language search query' })),
  category: Type.Optional(Type.String({ description: 'Category filter for search/intents' })),
  auto_execute: Type.Optional(Type.Boolean({ description: 'Auto-execute top search result (default: false)' })),

  // Intents
  intent_type: Type.Optional(stringEnum(INTENT_TYPES, { description: '"offer" or "request"' })),
  attributes: Type.Optional(Type.String({ description: 'JSON attributes for intent' })),
  expires_at: Type.Optional(Type.String({ description: 'Expiration timestamp (ISO 8601)' })),
  min_match_score: Type.Optional(Type.Number({ description: 'Minimum ClawRank score for matches (0-100)' })),
  auto_accept: Type.Optional(Type.Boolean({ description: 'Auto-accept matches above min score' })),

  // IDs
  intent_id: Type.Optional(Type.String({ description: 'Intent ID' })),
  match_id: Type.Optional(Type.String({ description: 'Match ID' })),
  plugin_id: Type.Optional(Type.String({ description: 'Capability/plugin ID for details' })),

  // Events
  event_ids: Type.Optional(Type.String({ description: 'Comma-separated event IDs to acknowledge' })),

  // Webhooks
  webhook_url: Type.Optional(Type.String({ description: 'Webhook URL for notifications' })),
  webhook_events: Type.Optional(Type.String({ description: 'Comma-separated webhook event types' })),
});

// ─── Tool ────────────────────────────────────────────────────────────────

export function createMoltenTool() {
  return {
    name: 'molten',
    label: 'Molten',
    ownerOnly: true,
    description:
      'Intent resolution layer for AI agents on molten.gg. ' +
      'Start conversations to find capabilities, search the network, post offers/requests, ' +
      'and match with other agents. Use "browse" to see available capabilities (no auth needed). ' +
      'Use "conversation" for guided discovery. Use "search" for direct programmatic lookups.',
    parameters: MoltenSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const p = args as Record<string, unknown>;
      const action = readStringParam(p, 'action', { required: true })!;

      // browse and capability_details don't need auth
      const noAuthActions = ['browse', 'capability_details', 'register'];
      if (!noAuthActions.includes(action)) {
        const notReady = checkToolConfig('molten');
        if (notReady) return notReady;
      }

      try {
        switch (action) {
          // ── Registration & Profile ──────────────────────────────────
          case 'register': {
            const name = readStringParam(p, 'name', { required: true })!;
            const description = readStringParam(p, 'description') || 'OpenClawnch DeFi agent';
            const clientType = readStringParam(p, 'client_type') || 'openclaw';
            const twitterHandle = readStringParam(p, 'twitter_handle');

            // Auto-detect wallet from ClawnchConnect
            let walletAddress = readStringParam(p, 'wallet_address');
            if (!walletAddress) {
              const walletState = getWalletState();
              if (walletState.connected && walletState.address) {
                walletAddress = walletState.address;
              }
            }
            if (!walletAddress) {
              return errorResult(
                'wallet_address is required for registration. Connect a wallet first (/connect) ' +
                'or provide wallet_address explicitly.'
              );
            }

            const body: Record<string, unknown> = {
              name,
              client_type: clientType,
              wallet_address: walletAddress,
              description,
            };
            if (twitterHandle) body.twitter_handle = twitterHandle;

            const result = await moltenFetch('POST', '/agents/register', body, false);

            // Save the API key
            if (result?.agent?.api_key) {
              setMoltenApiKey(result.agent.api_key);
            }

            // H2 FIX: Never return API key in LLM-visible tool response
            const maskedKey = result?.agent?.api_key
              ? `${result.agent.api_key.slice(0, 8)}...${result.agent.api_key.slice(-4)}`
              : undefined;
            const { api_key: _stripped, ...safeResult } = result?.agent ?? {};
            return jsonResult({
              ...result,
              agent: safeResult,
              setup: maskedKey
                ? `API key active (${maskedKey}). To persist, use /flykeys set MOLTEN_API_KEY with the full key shown during registration.`
                : undefined,
              claim: result?.agent?.claim_url
                ? `Claim your agent: ${result.agent.claim_url}`
                : undefined,
            });
          }

          case 'profile': {
            const result = await moltenFetch('GET', '/agents/me');
            return jsonResult(result);
          }

          case 'update_profile': {
            const body: Record<string, unknown> = {};
            const description = readStringParam(p, 'description');
            const twitterHandle = readStringParam(p, 'twitter_handle');
            if (description) body.description = description;
            if (twitterHandle) body.twitter_handle = twitterHandle;

            const result = await moltenFetch('PATCH', '/agents/me', body);
            return jsonResult(result);
          }

          case 'claim_status': {
            const result = await moltenFetch('GET', '/agents/status');
            return jsonResult(result);
          }

          // ── Conversations (Guided) ──────────────────────────────────
          case 'conversation': {
            const message = readStringParam(p, 'message', { required: true })!;
            const result = await moltenFetch('POST', '/conversations', { message });
            return jsonResult(result);
          }

          case 'conversation_reply': {
            const sessionId = readStringParam(p, 'session_id', { required: true })!;
            const message = readStringParam(p, 'message') || '';
            const body: Record<string, unknown> = { message };
            if (p.confirm === true) body.confirm = true;
            if (p.cancel === true) body.cancel = true;
            if (p.selection !== undefined) body.selection = p.selection;

            const result = await moltenFetch('POST', `/conversations/${sessionId}/message`, body);
            return jsonResult(result);
          }

          case 'conversation_status': {
            const sessionId = readStringParam(p, 'session_id', { required: true })!;
            const result = await moltenFetch('GET', `/conversations/${sessionId}`);
            return jsonResult(result);
          }

          case 'list_conversations': {
            const result = await moltenFetch('GET', '/conversations');
            return jsonResult(result);
          }

          // ── Search (Programmatic) ───────────────────────────────────
          case 'search': {
            const query = readStringParam(p, 'query', { required: true })!;
            const body: Record<string, unknown> = { query };
            const category = readStringParam(p, 'category');
            if (category) body.category = category;
            if (p.auto_execute === true) body.autoExecute = true;

            const result = await moltenFetch('POST', '/search', body);
            return jsonResult(result);
          }

          // ── Browse Capabilities (No Auth) ───────────────────────────
          case 'browse': {
            const result = await moltenFetch('GET', '/plugins', undefined, false);
            return jsonResult(result);
          }

          case 'capability_details': {
            const pluginId = readStringParam(p, 'plugin_id', { required: true })!;
            const result = await moltenFetch('GET', `/plugins/${pluginId}`, undefined, false);
            return jsonResult(result);
          }

          // ── Intents (Async Matching) ────────────────────────────────
          case 'create_intent': {
            const intentType = readStringParam(p, 'intent_type', { required: true })!;
            const description = readStringParam(p, 'description', { required: true })!;
            const category = readStringParam(p, 'category');
            const attributesStr = readStringParam(p, 'attributes');
            const expiresAt = readStringParam(p, 'expires_at');
            const minMatchScore = p.min_match_score as number | undefined;
            const autoAccept = p.auto_accept as boolean | undefined;

            let attributes: Record<string, unknown> | undefined;
            if (attributesStr) {
              try {
                attributes = JSON.parse(attributesStr);
              } catch {
                return errorResult('attributes must be valid JSON');
              }
            }

            const body: Record<string, unknown> = {
              type: intentType,
              description,
            };
            if (category) body.category = category;
            if (attributes) body.attributes = attributes;
            if (expiresAt) body.constraints = { expiresAt };
            if (minMatchScore !== undefined || autoAccept !== undefined) {
              body.matching = {
                ...(minMatchScore !== undefined ? { minMatchScore } : {}),
                ...(autoAccept !== undefined ? { autoAccept } : {}),
              };
            }

            const result = await moltenFetch('POST', '/intents', body);
            return jsonResult(result);
          }

          case 'list_intents': {
            const result = await moltenFetch('GET', '/intents');
            return jsonResult(result);
          }

          case 'cancel_intent': {
            const intentId = readStringParam(p, 'intent_id', { required: true })!;
            const result = await moltenFetch('DELETE', `/intents/${intentId}`);
            return jsonResult({ status: 'cancelled', intentId, ...result });
          }

          // ── Matches ─────────────────────────────────────────────────
          case 'list_matches': {
            const result = await moltenFetch('GET', '/matches');
            return jsonResult(result);
          }

          case 'accept_match': {
            const matchId = readStringParam(p, 'match_id', { required: true })!;
            const result = await moltenFetch('POST', `/matches/${matchId}/accept`);
            return jsonResult(result);
          }

          case 'reject_match': {
            const matchId = readStringParam(p, 'match_id', { required: true })!;
            const result = await moltenFetch('POST', `/matches/${matchId}/reject`);
            return jsonResult(result);
          }

          case 'complete_match': {
            const matchId = readStringParam(p, 'match_id', { required: true })!;
            const result = await moltenFetch('POST', `/matches/${matchId}/complete`);
            return jsonResult(result);
          }

          case 'match_message': {
            const matchId = readStringParam(p, 'match_id', { required: true })!;
            const content = readStringParam(p, 'message', { required: true })!;
            const result = await moltenFetch('POST', `/matches/${matchId}/message`, { content });
            return jsonResult(result);
          }

          // ── Events ──────────────────────────────────────────────────
          case 'check_events': {
            const result = await moltenFetch('GET', '/events');
            return jsonResult(result);
          }

          case 'ack_events': {
            const eventIdsStr = readStringParam(p, 'event_ids', { required: true })!;
            const event_ids = eventIdsStr.split(',').map(id => id.trim());
            const result = await moltenFetch('POST', '/events/ack', { event_ids });
            return jsonResult({ status: 'acknowledged', event_ids, ...result });
          }

          // ── Webhooks ────────────────────────────────────────────────
          case 'setup_webhook': {
            const webhookUrl = readStringParam(p, 'webhook_url', { required: true })!;
            const eventsStr = readStringParam(p, 'webhook_events');
            const events = eventsStr
              ? eventsStr.split(',').map(e => e.trim())
              : ['match.created', 'match.accepted', 'match.message'];

            const result = await moltenFetch('POST', '/webhooks', { url: webhookUrl, events });
            return jsonResult(result);
          }

          default:
            return errorResult(`Unknown molten action: ${action}`);
        }
      } catch (err: any) {
        if (err instanceof MoltenApiError) {
          if (err.status === 401) {
            return errorResult(
              'Molten API key is invalid or expired.\n\nUpdate: `/flykeys set MOLTEN_API_KEY your_new_key`'
            );
          }
          if (err.status === 403 && err.code === 'AGENT_NOT_CLAIMED') {
            return errorResult(
              'Your Molten agent hasn\'t been claimed yet. Visit the claim URL from registration to activate it.'
            );
          }
          if (err.status === 404) {
            return errorResult(
              `Molten returned 404: ${err.message}\n\n` +
              'The resource may not exist, or the agent may need to be registered first.\n' +
              'Try "register" or "browse" to verify the API is reachable.'
            );
          }
          if (err.status === 429) {
            return errorResult('Molten rate limit exceeded. Wait a moment and try again.');
          }
          return errorResult(`Molten API error (${err.status}): ${err.message}`);
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
          return errorResult(
            'Could not reach api.molten.gg. The platform may be offline.\n' +
            'Check https://molten.gg for status.'
          );
        }
        return errorResult(`Molten error: ${msg}`);
      }
    },
  };
}
