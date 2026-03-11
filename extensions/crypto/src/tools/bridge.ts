/**
 * Bridge Tool — Cross-chain token bridging via LI.FI aggregator.
 *
 * LI.FI aggregates all major bridges (LayerZero, Across, Stargate, Hop,
 * Synapse, Connext, etc.) behind a single REST API. This tool provides:
 *
 * Actions:
 *   quote      — Get bridge quotes from multiple protocols for a transfer
 *   routes     — Get full route breakdown with steps, fees, and times
 *   execute    — Execute a bridge transaction (requires wallet)
 *   status     — Check bridge transaction status
 *   chains     — List supported chains
 *   tokens     — List bridgeable tokens on a chain
 *
 * Requires no API key for basic usage. Set LIFI_API_KEY env var for higher rate limits.
 *
 * @see https://docs.li.fi/li.fi-api/li.fi-api
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
  getMevWalletClient,
} from '../services/walletconnect-service.js';
import { guardedFetch } from '../services/endpoint-allowlist.js';
import { getCredentialVault } from '../services/credential-vault.js';

const ACTIONS = ['quote', 'routes', 'execute', 'status', 'chains', 'tokens'] as const;

const LIFI_BASE_URL = 'https://li.quest/v1';

// ─── Well-known chain IDs ────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  8453: 'Base',
  42161: 'Arbitrum',
  10: 'Optimism',
  137: 'Polygon',
  43114: 'Avalanche',
  56: 'BNB Chain',
  250: 'Fantom',
  324: 'zkSync Era',
  59144: 'Linea',
  534352: 'Scroll',
  7777777: 'Zora',
};

const CHAIN_NAME_TO_ID: Record<string, number> = {
  ethereum: 1, eth: 1, mainnet: 1,
  base: 8453,
  arbitrum: 42161, arb: 42161,
  optimism: 10, op: 10,
  polygon: 137, matic: 137,
  avalanche: 43114, avax: 43114,
  bnb: 56, bsc: 56,
  fantom: 250, ftm: 250,
  zksync: 324,
  linea: 59144,
  scroll: 534352,
  zora: 7777777,
};

function resolveChainId(input: string | number): number {
  if (typeof input === 'number') return input;
  const num = parseInt(input, 10);
  if (!isNaN(num)) return num;
  return CHAIN_NAME_TO_ID[input.toLowerCase()] ?? 0;
}

// ─── LI.FI API Client ───────────────────────────────────────────────────

async function lifiFetch(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${LIFI_BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = getCredentialVault().getSecret('bridge.lifi.apiKey', 'bridge');
  if (apiKey) headers['x-lifi-api-key'] = apiKey;

  // H10: Add request timeout to prevent hanging
  const response = await guardedFetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LI.FI API error: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }

  return response.json();
}

async function lifiPost(path: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const apiKey = getCredentialVault().getSecret('bridge.lifi.apiKey', 'bridge');
  if (apiKey) headers['x-lifi-api-key'] = apiKey;

  // H10: Add request timeout to prevent hanging
  const response = await guardedFetch(`${LIFI_BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LI.FI API error: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
  }

  return response.json();
}

// ─── Schema ──────────────────────────────────────────────────────────────

const BridgeSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'quote: get bridge quotes. routes: detailed route breakdown. ' +
      'execute: execute a bridge transfer (requires wallet). ' +
      'status: check bridge tx status. ' +
      'chains: list supported chains. tokens: bridgeable tokens on a chain.',
  }),
  from_chain: Type.Optional(Type.String({
    description: 'Source chain: name (e.g. "base", "ethereum") or chain ID. Default: base.',
  })),
  to_chain: Type.Optional(Type.String({
    description: 'Destination chain: name (e.g. "arbitrum", "optimism") or chain ID.',
  })),
  from_token: Type.Optional(Type.String({
    description: 'Source token address (0x...) or symbol. Use 0x0000000000000000000000000000000000000000 for native token.',
  })),
  to_token: Type.Optional(Type.String({
    description: 'Destination token address (0x...) or symbol.',
  })),
  amount: Type.Optional(Type.String({
    description: 'Amount in smallest unit (wei) for quote/routes. Human-readable for execute.',
  })),
  slippage: Type.Optional(Type.Number({
    description: 'Slippage tolerance (e.g. 0.005 for 0.5%). Default: 0.005.',
  })),
  tx_hash: Type.Optional(Type.String({
    description: 'Transaction hash for status check.',
  })),
  bridge: Type.Optional(Type.String({
    description: 'Preferred bridge protocol (e.g. "across", "stargate", "hop"). Optional — LI.FI picks best by default.',
  })),
  chain_id: Type.Optional(Type.Number({
    description: 'Chain ID for tokens action.',
  })),
});

export function createBridgeTool() {
  return {
    name: 'bridge',
    label: 'Bridge',
    ownerOnly: true,
    description:
      'Cross-chain token bridging via LI.FI aggregator. Compares quotes from Across, ' +
      'Stargate, LayerZero, Hop, Synapse, and more. Use "quote" to compare, "execute" to bridge.',
    parameters: BridgeSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'quote':
          return handleQuote(params);
        case 'routes':
          return handleRoutes(params);
        case 'execute':
          return handleExecute(params);
        case 'status':
          return handleStatus(params);
        case 'chains':
          return handleChains();
        case 'tokens':
          return handleTokens(params);
        default:
          return errorResult(`Unknown action: ${action}. Use: ${ACTIONS.join(', ')}`);
      }
    },
  };
}

// ─── Native Token Addresses ──────────────────────────────────────────────

const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

const WELL_KNOWN_TOKENS: Record<string, Record<number, string>> = {
  ETH: { 1: NATIVE_TOKEN, 8453: NATIVE_TOKEN, 42161: NATIVE_TOKEN, 10: NATIVE_TOKEN },
  USDC: {
    1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    10: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  USDT: {
    1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    42161: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    10: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    137: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
};

function resolveTokenAddress(input: string, chainId: number): string {
  if (input.startsWith('0x') && input.length === 42) return input;
  const symbol = input.toUpperCase();
  const addr = WELL_KNOWN_TOKENS[symbol]?.[chainId];
  if (addr) return addr;
  // For unknown symbols, return as-is — LI.FI will resolve or error
  return input;
}

// ─── Action Handlers ──────────────────────────────────────────────────────

async function handleQuote(params: Record<string, unknown>) {
  const fromChainInput = readStringParam(params, 'from_chain') ?? readStringParam(params, 'fromChain') ?? 'base';
  const toChainInput = readStringParam(params, 'to_chain') ?? readStringParam(params, 'toChain');
  if (!toChainInput) return errorResult('to_chain is required for quote.');

  const fromChainId = resolveChainId(fromChainInput);
  const toChainId = resolveChainId(toChainInput);
  if (!fromChainId) return errorResult(`Unknown source chain: ${fromChainInput}`);
  if (!toChainId) return errorResult(`Unknown destination chain: ${toChainInput}`);

  const fromTokenInput = readStringParam(params, 'from_token') ?? readStringParam(params, 'fromToken') ?? 'ETH';
  const toTokenInput = readStringParam(params, 'to_token') ?? readStringParam(params, 'toToken') ?? 'ETH';
  const amount = readStringParam(params, 'amount', { required: true })!;
  const slippage = readNumberParam(params, 'slippage') ?? 0.005; // 0.5% default (was 3% — too high, sandwich-exploitable)

  const fromToken = resolveTokenAddress(fromTokenInput, fromChainId);
  const toToken = resolveTokenAddress(toTokenInput, toChainId);

  // Use connected wallet address or zero address for quote
  const state = getWalletState();
  const fromAddress = state.address ?? '0x0000000000000000000000000000000000000001';

  try {
    const data = await lifiFetch('/quote', {
      fromChain: String(fromChainId),
      toChain: String(toChainId),
      fromToken,
      toToken,
      fromAmount: amount,
      fromAddress,
      slippage: String(slippage),
    });

    const estimate = data.estimate ?? {};
    const toolData = data.toolDetails ?? data.tool ?? {};

    return jsonResult({
      fromChain: { id: fromChainId, name: CHAIN_NAMES[fromChainId] ?? String(fromChainId) },
      toChain: { id: toChainId, name: CHAIN_NAMES[toChainId] ?? String(toChainId) },
      fromToken: { address: fromToken, symbol: data.action?.fromToken?.symbol ?? fromTokenInput },
      toToken: { address: toToken, symbol: data.action?.toToken?.symbol ?? toTokenInput },
      fromAmount: amount,
      toAmount: estimate.toAmount ?? null,
      toAmountMin: estimate.toAmountMin ?? null,
      bridgeProtocol: toolData.name ?? data.tool ?? 'unknown',
      estimatedGasCostUsd: estimate.gasCosts?.[0]?.amountUSD ?? null,
      estimatedFeeCostUsd: estimate.feeCosts?.reduce?.((sum: number, f: any) => sum + parseFloat(f.amountUSD ?? '0'), 0) ?? null,
      executionDurationSeconds: estimate.executionDuration ?? null,
      slippage,
      transactionRequest: data.transactionRequest ? {
        to: data.transactionRequest.to,
        value: data.transactionRequest.value,
        gasLimit: data.transactionRequest.gasLimit,
      } : null,
    });
  } catch (err) {
    return errorResult(`Quote failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleRoutes(params: Record<string, unknown>) {
  const fromChainInput = readStringParam(params, 'from_chain') ?? readStringParam(params, 'fromChain') ?? 'base';
  const toChainInput = readStringParam(params, 'to_chain') ?? readStringParam(params, 'toChain');
  if (!toChainInput) return errorResult('to_chain is required for routes.');

  const fromChainId = resolveChainId(fromChainInput);
  const toChainId = resolveChainId(toChainInput);
  if (!fromChainId) return errorResult(`Unknown source chain: ${fromChainInput}`);
  if (!toChainId) return errorResult(`Unknown destination chain: ${toChainInput}`);

  const fromTokenInput = readStringParam(params, 'from_token') ?? readStringParam(params, 'fromToken') ?? 'ETH';
  const toTokenInput = readStringParam(params, 'to_token') ?? readStringParam(params, 'toToken') ?? 'ETH';
  const amount = readStringParam(params, 'amount', { required: true })!;
  const slippage = readNumberParam(params, 'slippage') ?? 0.005; // 0.5% default (was 3% — too high, sandwich-exploitable)
  const preferredBridge = readStringParam(params, 'bridge');

  const fromToken = resolveTokenAddress(fromTokenInput, fromChainId);
  const toToken = resolveTokenAddress(toTokenInput, toChainId);

  const state = getWalletState();
  const fromAddress = state.address ?? '0x0000000000000000000000000000000000000001';

  try {
    const body: any = {
      fromChainId,
      toChainId,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      fromAmount: amount,
      fromAddress,
      options: {
        slippage,
        order: 'RECOMMENDED',
      },
    };

    if (preferredBridge) {
      body.options.bridges = { allow: [preferredBridge] };
    }

    const data = await lifiPost('/advanced/routes', body);
    const routes = data.routes ?? [];

    return jsonResult({
      fromChain: { id: fromChainId, name: CHAIN_NAMES[fromChainId] ?? String(fromChainId) },
      toChain: { id: toChainId, name: CHAIN_NAMES[toChainId] ?? String(toChainId) },
      fromAmount: amount,
      routeCount: routes.length,
      routes: routes.slice(0, 5).map((route: any, idx: number) => ({
        rank: idx + 1,
        toAmount: route.toAmount,
        toAmountUsd: route.toAmountUSD,
        gasCostUsd: route.gasCostUSD,
        executionDurationSeconds: route.steps?.reduce?.((sum: number, s: any) => sum + (s.estimate?.executionDuration ?? 0), 0) ?? null,
        steps: route.steps?.map((step: any) => ({
          type: step.type,
          tool: step.toolDetails?.name ?? step.tool,
          fromChain: step.action?.fromChainId,
          toChain: step.action?.toChainId,
          fromToken: step.action?.fromToken?.symbol,
          toToken: step.action?.toToken?.symbol,
          estimatedOutput: step.estimate?.toAmount,
        })),
        tags: route.tags ?? [],
      })),
      preferredBridge: preferredBridge ?? null,
    });
  } catch (err) {
    return errorResult(`Routes failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleExecute(params: Record<string, unknown>) {
  const state = getWalletState();
  if (!state.connected) {
    return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
  }

  const fromChainInput = readStringParam(params, 'from_chain') ?? readStringParam(params, 'fromChain') ?? 'base';
  const toChainInput = readStringParam(params, 'to_chain') ?? readStringParam(params, 'toChain');
  if (!toChainInput) return errorResult('to_chain is required for execute.');

  const fromChainId = resolveChainId(fromChainInput);
  const toChainId = resolveChainId(toChainInput);
  if (!fromChainId) return errorResult(`Unknown source chain: ${fromChainInput}`);
  if (!toChainId) return errorResult(`Unknown destination chain: ${toChainInput}`);

  const fromTokenInput = readStringParam(params, 'from_token') ?? readStringParam(params, 'fromToken') ?? 'ETH';
  const toTokenInput = readStringParam(params, 'to_token') ?? readStringParam(params, 'toToken') ?? 'ETH';
  const amount = readStringParam(params, 'amount', { required: true })!;
  const slippage = readNumberParam(params, 'slippage') ?? 0.005; // 0.5% default (was 3% — too high, sandwich-exploitable)

  const fromToken = resolveTokenAddress(fromTokenInput, fromChainId);
  const toToken = resolveTokenAddress(toTokenInput, toChainId);

  try {
    // Step 1: Get quote with transaction data
    const quoteData = await lifiFetch('/quote', {
      fromChain: String(fromChainId),
      toChain: String(toChainId),
      fromToken,
      toToken,
      fromAmount: amount,
      fromAddress: state.address!,
      slippage: String(slippage),
    });

    const txRequest = quoteData.transactionRequest;
    if (!txRequest) {
      return errorResult('No transaction data returned from LI.FI. The route may not be available.');
    }

    // Step 2: Send transaction via wallet (MEV-protected when available)
    const wallet = await getMevWalletClient();
    const publicClient = requirePublicClient();

    const txHash = await wallet.sendTransaction({
      to: txRequest.to as `0x${string}`,
      data: txRequest.data as `0x${string}`,
      value: txRequest.value ? BigInt(txRequest.value) : 0n,
      gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : undefined,
    } as any);

    // Step 3: Wait for source chain confirmation (120s timeout — bridges can be slow)
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

    const estimate = quoteData.estimate ?? {};
    const toolData = quoteData.toolDetails ?? {};

    return jsonResult({
      status: receipt.status === 'reverted' ? 'source_reverted' : 'source_confirmed',
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      fromChain: { id: fromChainId, name: CHAIN_NAMES[fromChainId] ?? String(fromChainId) },
      toChain: { id: toChainId, name: CHAIN_NAMES[toChainId] ?? String(toChainId) },
      fromToken: fromTokenInput,
      toToken: toTokenInput,
      fromAmount: amount,
      expectedToAmount: estimate.toAmount ?? null,
      bridgeProtocol: toolData.name ?? quoteData.tool ?? 'unknown',
      estimatedDurationSeconds: estimate.executionDuration ?? null,
      note: 'Source chain transaction confirmed. Bridge transfer is in progress. Use action "status" with this tx_hash to check destination chain delivery.',
    });
  } catch (err) {
    return errorResult(`Execute failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleStatus(params: Record<string, unknown>) {
  const txHash = readStringParam(params, 'tx_hash') ?? readStringParam(params, 'txHash');
  if (!txHash) return errorResult('tx_hash is required for status.');

  const fromChainInput = readStringParam(params, 'from_chain') ?? readStringParam(params, 'fromChain') ?? 'base';
  const toChainInput = readStringParam(params, 'to_chain') ?? readStringParam(params, 'toChain') ?? 'ethereum';
  const fromChainId = resolveChainId(fromChainInput);
  const toChainId = resolveChainId(toChainInput);

  try {
    const data = await lifiFetch('/status', {
      txHash,
      fromChain: String(fromChainId),
      toChain: String(toChainId),
    });

    return jsonResult({
      txHash,
      status: data.status ?? 'UNKNOWN',
      substatus: data.substatus ?? null,
      fromChain: { id: fromChainId, name: CHAIN_NAMES[fromChainId] ?? String(fromChainId) },
      toChain: { id: toChainId, name: CHAIN_NAMES[toChainId] ?? String(toChainId) },
      sending: data.sending ? {
        txHash: data.sending.txHash,
        amount: data.sending.amount,
        token: data.sending.token?.symbol,
      } : null,
      receiving: data.receiving ? {
        txHash: data.receiving.txHash,
        amount: data.receiving.amount,
        token: data.receiving.token?.symbol,
      } : null,
      bridgeProtocol: data.tool ?? null,
      bridgeExplorerUrl: data.bridgeExplorerUrl ?? null,
    });
  } catch (err) {
    return errorResult(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleChains() {
  try {
    const data = await lifiFetch('/chains');
    const chains = data.chains ?? [];

    return jsonResult({
      totalChains: chains.length,
      chains: chains.map((c: any) => ({
        id: c.id,
        name: c.name,
        nativeToken: c.nativeToken?.symbol ?? null,
        type: c.chainType ?? 'EVM',
      })),
    });
  } catch (err) {
    return errorResult(`Chains lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleTokens(params: Record<string, unknown>) {
  const chainId = readNumberParam(params, 'chain_id') ?? readNumberParam(params, 'chainId') ?? 8453;

  try {
    const data = await lifiFetch('/tokens', {
      chains: String(chainId),
    });

    const tokens = data.tokens?.[String(chainId)] ?? [];

    return jsonResult({
      chainId,
      chainName: CHAIN_NAMES[chainId] ?? String(chainId),
      tokenCount: tokens.length,
      tokens: tokens.slice(0, 50).map((t: any) => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        logoURI: t.logoURI ?? null,
      })),
      note: tokens.length > 50 ? `Showing first 50 of ${tokens.length} tokens.` : undefined,
    });
  } catch (err) {
    return errorResult(`Tokens lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
