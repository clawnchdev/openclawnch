/**
 * Wayfinder Tool — Cross-chain DeFi via Wayfinder Paths.
 *
 * Breaks the single-chain (Base-only) limitation by providing:
 *   - Cross-chain swap quotes and execution
 *   - Multi-chain balance aggregation
 *   - DeFi pool/yield discovery
 *   - Token resolution across chains
 *   - Strategy execution (basis trading, yield farming, etc.)
 *
 * Two tiers:
 *   REST (always available): pools, balances, quote, resolve_token, gas_token
 *   CLI (requires Python + wayfinder-paths): execute_swap, strategy
 *
 * Requires WAYFINDER_API_KEY env var.
 * Uses WayfinderClient from @clawnch/clawncher-sdk.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { getWalletState } from '../services/walletconnect-service.js';

const ACTIONS = [
  'pools', 'balances', 'quote', 'resolve_token',
  'gas_token', 'execute_swap', 'strategy',
] as const;

const WayfinderSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'pools: search DeFi yields. balances: multi-chain portfolio. quote: cross-chain swap quote. ' +
      'resolve_token: token lookup. gas_token: get gas token for chain. ' +
      'execute_swap: execute via CLI (needs Python). strategy: run DeFi strategy (needs Python).',
  }),
  // Pool filters
  protocol: Type.Optional(Type.String({
    description: 'For pools: filter by protocol (e.g. "moonwell", "aave", "morpho").',
  })),
  min_apy: Type.Optional(Type.Number({
    description: 'For pools: minimum supply APY filter (e.g. 2.0 for 2%).',
  })),
  token_symbol: Type.Optional(Type.String({
    description: 'For pools: filter by underlying token symbol (e.g. "WETH", "USDC").',
  })),
  // Chain
  chain_id: Type.Optional(Type.Number({
    description: 'Chain ID. Default: 8453 (Base). Common: 1 (Ethereum), 42161 (Arbitrum), 10 (Optimism).',
  })),
  // Swap params
  from_token: Type.Optional(Type.String({
    description: 'Source token address or identifier (for quote/execute_swap).',
  })),
  to_token: Type.Optional(Type.String({
    description: 'Destination token address or identifier (for quote/execute_swap).',
  })),
  amount: Type.Optional(Type.String({
    description: 'Amount: raw units (wei) for quote, human-readable for execute_swap.',
  })),
  from_chain: Type.Optional(Type.Number({
    description: 'Source chain ID for cross-chain quote. Default: 8453.',
  })),
  to_chain: Type.Optional(Type.Number({
    description: 'Destination chain ID for cross-chain quote. Default: 8453.',
  })),
  slippage: Type.Optional(Type.Number({
    description: 'Slippage tolerance (e.g. 0.005 for 0.5%). Default: 0.005.',
  })),
  // Token resolution
  query: Type.Optional(Type.String({
    description: 'Token query for resolve_token (name, symbol, address, or CoinGecko ID).',
  })),
  // Strategy
  strategy_name: Type.Optional(Type.String({
    description: 'Strategy name (e.g. "basis_trading_strategy").',
  })),
  strategy_action: Type.Optional(Type.String({
    description: 'Strategy sub-action: status, deposit, update, exit, withdraw, analyze, quote.',
  })),
  main_token_amount: Type.Optional(Type.Number({
    description: 'Main token amount for strategy deposit.',
  })),
  wallet_label: Type.Optional(Type.String({
    description: 'Wallet label for CLI operations (must match wayfinder config). Default: "main".',
  })),
  // Address override
  address: Type.Optional(Type.String({
    description: 'Wallet address for balances. Defaults to connected wallet.',
  })),
});

export function createWayfinderTool() {
  return {
    name: 'wayfinder',
    label: 'Wayfinder',
    ownerOnly: false,
    description:
      'Cross-chain DeFi via Wayfinder Paths. ' +
      'Get multi-chain balances, search DeFi yields, quote cross-chain swaps, ' +
      'resolve tokens across chains, and execute swaps/strategies. ' +
      'Requires WAYFINDER_API_KEY. CLI actions (execute_swap, strategy) also need Python + wayfinder-paths.',
    parameters: WayfinderSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      // Check API key
      const apiKey = process.env.WAYFINDER_API_KEY;
      if (!apiKey) {
        return errorResult(
          'Wayfinder not configured. Set WAYFINDER_API_KEY environment variable. ' +
          'Get an API key at https://wayfinder.dev'
        );
      }

      try {
        const { WayfinderClient } = await import('@clawnch/clawncher-sdk');
        const client = new WayfinderClient({ apiKey });

        switch (action) {
          case 'pools':
            return handlePools(client, params);
          case 'balances':
            return handleBalances(client, params);
          case 'quote':
            return handleQuote(client, params);
          case 'resolve_token':
            return handleResolveToken(client, params);
          case 'gas_token':
            return handleGasToken(client, params);
          case 'execute_swap':
            return handleExecuteSwap(client, params);
          case 'strategy':
            return handleStrategy(client, params);
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(`Wayfinder operation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ─── Chain Names ──────────────────────────────────────────────────────────

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
  5000: 'Mantle',
  81457: 'Blast',
};

function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

// ─── REST Actions ─────────────────────────────────────────────────────────

async function handlePools(client: any, params: Record<string, unknown>) {
  const chainId = readNumberParam(params, 'chain_id') ?? 8453;
  const protocol = readStringParam(params, 'protocol');
  const minApy = readNumberParam(params, 'min_apy');
  const tokenSymbol = readStringParam(params, 'token_symbol')?.toUpperCase();

  let pools = await client.getPools(chainId, protocol);

  if (minApy !== undefined) {
    pools = pools.filter((p: any) => p.supplyApy >= minApy);
  }
  if (tokenSymbol) {
    pools = pools.filter((p: any) => p.tokenSymbol.toUpperCase() === tokenSymbol);
  }

  // Sort by APY descending
  pools.sort((a: any, b: any) => b.supplyApy - a.supplyApy);
  const topPools = pools.slice(0, 20);

  if (topPools.length === 0) {
    return jsonResult({
      count: 0,
      chain: chainName(chainId),
      filters: { protocol, minApy, tokenSymbol },
      message: 'No pools found matching filters. Try broadening your search.',
    });
  }

  const formatted = topPools.map((p: any) => ({
    protocol: p.protocol,
    token: p.tokenSymbol,
    apy: `${p.supplyApy.toFixed(2)}%`,
    tvl: p.totalSupplyUsd > 1_000_000
      ? `$${(p.totalSupplyUsd / 1_000_000).toFixed(1)}M`
      : `$${(p.totalSupplyUsd / 1_000).toFixed(0)}K`,
    address: p.address,
  }));

  return jsonResult({
    count: pools.length,
    showing: topPools.length,
    chain: chainName(chainId),
    pools: formatted,
  });
}

async function handleBalances(client: any, params: Record<string, unknown>) {
  const state = getWalletState();
  const address = readStringParam(params, 'address') ?? state.address;

  if (!address) {
    return errorResult('No address provided and no wallet connected.');
  }

  const balances = await client.getBalances(address);
  const tokens = balances.tokens
    .filter((t: any) => t.balanceUsd > 0.01)
    .sort((a: any, b: any) => b.balanceUsd - a.balanceUsd);

  if (tokens.length === 0) {
    return jsonResult({
      address,
      totalValueUsd: 0,
      tokens: [],
      message: 'No token balances found.',
    });
  }

  const formatted = tokens.map((t: any) => ({
    chain: t.chainName,
    symbol: t.symbol,
    balance: t.balanceFormatted,
    valueUsd: `$${t.balanceUsd.toFixed(2)}`,
  }));

  return jsonResult({
    address,
    totalValueUsd: `$${balances.totalValueUsd.toFixed(2)}`,
    tokenCount: tokens.length,
    tokens: formatted,
  });
}

async function handleQuote(client: any, params: Record<string, unknown>) {
  const fromToken = readStringParam(params, 'from_token', { required: true })!;
  const toToken = readStringParam(params, 'to_token', { required: true })!;
  const amount = readStringParam(params, 'amount', { required: true })!;
  const fromChain = readNumberParam(params, 'from_chain') ?? 8453;
  const toChain = readNumberParam(params, 'to_chain') ?? 8453;
  const slippage = readNumberParam(params, 'slippage');

  const state = getWalletState();
  const fromWallet = readStringParam(params, 'address') ?? state.address;
  if (!fromWallet) {
    return errorResult('No wallet connected and no address provided.');
  }

  const quote = await client.quoteSwap({
    fromToken,
    toToken,
    fromChain,
    toChain,
    fromWallet,
    amount,
    slippage,
  });

  if (!quote.bestQuote) {
    return jsonResult({
      found: false,
      fromToken,
      toToken,
      route: `${chainName(fromChain)} → ${chainName(toChain)}`,
      message: 'No routes found. Try different tokens, amounts, or chains.',
    });
  }

  const best = quote.bestQuote;
  const result: Record<string, unknown> = {
    found: true,
    route: `${chainName(fromChain)} → ${chainName(toChain)}`,
    provider: best.provider,
    input: {
      amount: best.inputAmount,
      valueUsd: `$${best.inputAmountUsd.toFixed(2)}`,
      native: best.nativeInput,
    },
    output: {
      amount: best.outputAmount,
      valueUsd: `$${best.outputAmountUsd.toFixed(2)}`,
      native: best.nativeOutput,
    },
    fees: `$${best.feeEstimate.feeTotalUsd.toFixed(2)}`,
  };

  if (best.gasEstimate) {
    result.gasEstimate = best.gasEstimate;
  }

  // Include alternative routes
  if (quote.quotes.length > 1) {
    result.alternatives = quote.quotes
      .filter((q: any) => q.provider !== best.provider)
      .slice(0, 4)
      .map((q: any) => ({
        provider: q.provider,
        output: q.error ? `failed: ${q.error}` : `${q.outputAmount} ($${q.outputAmountUsd.toFixed(2)})`,
      }));
    result.totalRoutesCompared = quote.quoteCount;
  }

  return jsonResult(result);
}

async function handleResolveToken(client: any, params: Record<string, unknown>) {
  const query = readStringParam(params, 'query', { required: true })!;
  const chainId = readNumberParam(params, 'chain_id');

  const token = await client.resolveToken(query, chainId);

  const result: Record<string, unknown> = {
    name: token.name,
    symbol: token.symbol,
    address: token.address,
    chain: chainName(token.chainId),
    chainId: token.chainId,
    decimals: token.decimals,
  };

  if (token.priceUsd !== undefined) result.priceUsd = `$${token.priceUsd.toFixed(6)}`;
  if (token.priceChange24h !== undefined) result.change24h = `${token.priceChange24h >= 0 ? '+' : ''}${token.priceChange24h.toFixed(2)}%`;
  if (token.marketCapUsd !== undefined) {
    result.marketCap = token.marketCapUsd > 1_000_000
      ? `$${(token.marketCapUsd / 1_000_000).toFixed(1)}M`
      : `$${(token.marketCapUsd / 1_000).toFixed(0)}K`;
  }
  if (token.coingeckoId) result.coingeckoId = token.coingeckoId;

  return jsonResult(result);
}

async function handleGasToken(client: any, params: Record<string, unknown>) {
  const chainId = readNumberParam(params, 'chain_id') ?? 8453;

  // Gas tokens per chain (Wayfinder uses these internally)
  const GAS_TOKENS: Record<number, { symbol: string; name: string }> = {
    1: { symbol: 'ETH', name: 'Ether' },
    8453: { symbol: 'ETH', name: 'Ether' },
    42161: { symbol: 'ETH', name: 'Ether' },
    10: { symbol: 'ETH', name: 'Ether' },
    137: { symbol: 'MATIC', name: 'Polygon' },
    43114: { symbol: 'AVAX', name: 'Avalanche' },
    56: { symbol: 'BNB', name: 'BNB' },
    250: { symbol: 'FTM', name: 'Fantom' },
    324: { symbol: 'ETH', name: 'Ether' },
    59144: { symbol: 'ETH', name: 'Ether' },
    534352: { symbol: 'ETH', name: 'Ether' },
    5000: { symbol: 'MNT', name: 'Mantle' },
    81457: { symbol: 'ETH', name: 'Ether' },
  };

  const gasToken = GAS_TOKENS[chainId] ?? { symbol: 'UNKNOWN', name: 'Unknown' };

  return jsonResult({
    chainId,
    chain: chainName(chainId),
    gasToken: gasToken.symbol,
    gasTokenName: gasToken.name,
  });
}

// ─── CLI Actions (require Python + wayfinder-paths) ───────────────────────

async function handleExecuteSwap(client: any, params: Record<string, unknown>) {
  // Check Python availability
  const pyStatus = await client.checkPython();
  if (!pyStatus.wayfinderInstalled) {
    return errorResult(
      pyStatus.available
        ? 'wayfinder-paths not installed. Install with: pip3 install wayfinder-paths'
        : 'Python 3 not found. Install Python 3.12+ first, then: pip3 install wayfinder-paths'
    );
  }

  const fromToken = readStringParam(params, 'from_token', { required: true })!;
  const toToken = readStringParam(params, 'to_token', { required: true })!;
  const amount = readStringParam(params, 'amount', { required: true })!;
  const walletLabel = readStringParam(params, 'wallet_label') ?? 'main';
  const chainId = readNumberParam(params, 'chain_id');

  const slippageBps = readNumberParam(params, 'slippage')
    ? Math.round(readNumberParam(params, 'slippage')! * 10000)
    : undefined;

  const result = await client.executeSwap({
    kind: 'swap',
    walletLabel,
    amount,
    fromToken,
    toToken,
    slippageBps,
    chainId,
  });

  if (!result.ok) {
    return errorResult(`Swap failed: ${result.error}`);
  }

  const r = result.result!;
  const effects = Object.values(r.effects) as any[];
  const txHashes = effects.map((e: any) => e.txnHash).filter(Boolean);

  return jsonResult({
    status: r.status,
    preview: r.preview,
    sender: r.sender,
    recipient: r.recipient,
    transactions: effects.map((e: any) => ({
      txHash: e.txnHash,
      chainId: e.chainId,
      chain: chainName(e.chainId),
      explorerUrl: e.explorerUrl,
    })),
    txHashes,
  });
}

async function handleStrategy(client: any, params: Record<string, unknown>) {
  // Check Python availability
  const pyStatus = await client.checkPython();
  if (!pyStatus.wayfinderInstalled) {
    return errorResult(
      pyStatus.available
        ? 'wayfinder-paths not installed. Install with: pip3 install wayfinder-paths'
        : 'Python 3 not found. Install Python 3.12+ first, then: pip3 install wayfinder-paths'
    );
  }

  const strategyName = readStringParam(params, 'strategy_name');
  const strategyAction = readStringParam(params, 'strategy_action') ?? 'status';
  const walletLabel = readStringParam(params, 'wallet_label') ?? 'main';
  const mainTokenAmount = readNumberParam(params, 'main_token_amount');

  // If no strategy name, list available strategies
  if (!strategyName) {
    const strategies = await client.listStrategies();
    if (strategies.length === 0) {
      return jsonResult({
        count: 0,
        message: 'No strategies available. Check wayfinder-paths installation.',
      });
    }

    return jsonResult({
      count: strategies.length,
      strategies: strategies.map((s: any) => ({
        name: s.name,
        description: s.description,
        riskLevel: s.riskLevel,
        chains: s.chains.map((c: number) => chainName(c)),
      })),
    });
  }

  // Run strategy action
  const result = await client.runStrategy({
    strategy: strategyName,
    action: strategyAction as any,
    mainTokenAmount,
    walletLabel,
  });

  if (!result.success) {
    return errorResult(`Strategy ${strategyAction} failed: ${result.error}`);
  }

  return jsonResult({
    strategy: strategyName,
    action: strategyAction,
    output: result.output,
  });
}
