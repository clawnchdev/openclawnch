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
import { getCredentialVault } from '../services/credential-vault.js';

const ACTIONS = [
  'pools', 'balances', 'quote', 'resolve_token',
  'gas_token', 'execute_swap', 'strategy',
  'lending', 'yield_vaults', 'perps', 'pnl',
] as const;

const WayfinderSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'pools: search DeFi yields. balances: multi-chain portfolio. quote: cross-chain swap quote. ' +
      'resolve_token: token lookup. gas_token: get gas token for chain. ' +
      'execute_swap: execute via CLI (needs Python). strategy: run DeFi strategy (needs Python). ' +
      'lending: Moonwell/Hyperlend positions and markets. yield_vaults: Pendle/Boros fixed-rate vaults. ' +
      'perps: Hyperliquid perpetual positions. pnl: cross-protocol P&L summary.',
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
    description: 'Wallet address for balances/lending/pnl. Defaults to connected wallet.',
  })),
  // Lending params
  lending_protocol: Type.Optional(Type.String({
    description: 'For lending: "moonwell", "hyperlend", or "aave". Shows all if omitted.',
  })),
  // Yield vault params
  vault_protocol: Type.Optional(Type.String({
    description: 'For yield_vaults: "pendle" or "boros". Shows all if omitted.',
  })),
  maturity: Type.Optional(Type.String({
    description: 'For yield_vaults: filter by maturity date (e.g. "2025-06").',
  })),
  // Perps params
  market: Type.Optional(Type.String({
    description: 'For perps: market symbol (e.g. "ETH-USD", "BTC-USD").',
  })),
  side: Type.Optional(Type.String({
    description: 'For perps: "long" or "short".',
  })),
});

export function createWayfinderTool() {
  return {
    name: 'wayfinder',
    label: 'Wayfinder',
    ownerOnly: true, // execute_swap and strategy are write operations
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
      const apiKey = getCredentialVault().getSecret('bot.wayfinder.apiKey', 'wayfinder');
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
          case 'lending':
            return handleLending(client, params);
          case 'yield_vaults':
            return handleYieldVaults(client, params);
          case 'perps':
            return handlePerps(client, params);
          case 'pnl':
            return handlePnl(client, params);
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

// ─── Extended Actions (Strategies Upgrade) ────────────────────────────────

/**
 * Lending: Moonwell, Hyperlend, and Aave positions and market rates
 * via Wayfinder's lending aggregation endpoints.
 */
async function handleLending(client: any, params: Record<string, unknown>) {
  const state = getWalletState();
  const address = readStringParam(params, 'address') ?? state.address;
  const lendingProtocol = readStringParam(params, 'lending_protocol');
  const chainId = readNumberParam(params, 'chain_id') ?? 8453;

  // Fetch lending markets via the pools endpoint filtered for lending protocols
  const lendingProtocols = lendingProtocol
    ? [lendingProtocol]
    : ['moonwell', 'hyperlend', 'aave-v3'];

  const allMarkets: any[] = [];
  for (const proto of lendingProtocols) {
    try {
      const pools = await client.getPools(chainId, proto);
      allMarkets.push(...pools.map((p: any) => ({
        protocol: proto,
        token: p.tokenSymbol,
        supplyApy: `${p.supplyApy?.toFixed(2) ?? '?'}%`,
        borrowApy: p.borrowApy !== undefined ? `${p.borrowApy.toFixed(2)}%` : 'N/A',
        tvl: p.totalSupplyUsd > 1_000_000
          ? `$${(p.totalSupplyUsd / 1_000_000).toFixed(1)}M`
          : `$${(p.totalSupplyUsd / 1_000).toFixed(0)}K`,
        address: p.address,
        chain: chainName(chainId),
      })));
    } catch {
      // Protocol may not be available on this chain
    }
  }

  // Sort by supply APY descending
  allMarkets.sort((a, b) => {
    const aApy = parseFloat(a.supplyApy) || 0;
    const bApy = parseFloat(b.supplyApy) || 0;
    return bApy - aApy;
  });

  // If address provided, try to get positions
  let positions: any[] | undefined;
  if (address) {
    try {
      const balances = await client.getBalances(address);
      // Filter for lending receipt tokens (aTokens, mTokens, etc.)
      positions = balances.tokens
        ?.filter((t: any) =>
          t.balanceUsd > 0.01 && (
            t.symbol?.startsWith('a') || // Aave aTokens
            t.symbol?.startsWith('m') || // Moonwell mTokens
            t.symbol?.includes('Debt')   // Debt tokens
          ),
        )
        .map((t: any) => ({
          token: t.symbol,
          balance: t.balanceFormatted,
          valueUsd: `$${t.balanceUsd.toFixed(2)}`,
          chain: t.chainName,
          type: t.symbol?.includes('Debt') ? 'borrow' : 'supply',
        }));
    } catch {
      // Balance fetch failed — continue without positions
    }
  }

  return jsonResult({
    chain: chainName(chainId),
    markets: allMarkets.slice(0, 30),
    marketCount: allMarkets.length,
    positions: positions?.length ? positions : undefined,
    tip: 'Use defi_lend tool for direct supply/borrow execution on Aave V3.',
  });
}

/**
 * Yield vaults: Pendle and Boros fixed-rate strategies
 * via Wayfinder's yield discovery endpoints.
 */
async function handleYieldVaults(client: any, params: Record<string, unknown>) {
  const chainId = readNumberParam(params, 'chain_id') ?? 8453;
  const vaultProtocol = readStringParam(params, 'vault_protocol');
  const maturity = readStringParam(params, 'maturity');

  const protocols = vaultProtocol
    ? [vaultProtocol]
    : ['pendle', 'boros'];

  const allVaults: any[] = [];
  for (const proto of protocols) {
    try {
      const pools = await client.getPools(chainId, proto);
      let filtered = pools;

      if (maturity) {
        filtered = pools.filter((p: any) =>
          p.maturity?.includes(maturity) || p.expiry?.includes(maturity),
        );
      }

      allVaults.push(...filtered.map((p: any) => ({
        protocol: proto,
        token: p.tokenSymbol,
        fixedApy: p.fixedApy !== undefined ? `${p.fixedApy.toFixed(2)}%` : undefined,
        impliedApy: p.impliedApy !== undefined ? `${p.impliedApy.toFixed(2)}%` : undefined,
        supplyApy: `${p.supplyApy?.toFixed(2) ?? '?'}%`,
        maturity: p.maturity ?? p.expiry ?? 'N/A',
        tvl: p.totalSupplyUsd > 1_000_000
          ? `$${(p.totalSupplyUsd / 1_000_000).toFixed(1)}M`
          : `$${(p.totalSupplyUsd / 1_000).toFixed(0)}K`,
        chain: chainName(chainId),
      })));
    } catch {
      // Protocol may not be available
    }
  }

  // Sort by APY descending
  allVaults.sort((a, b) => {
    const aApy = parseFloat(a.fixedApy ?? a.supplyApy) || 0;
    const bApy = parseFloat(b.fixedApy ?? b.supplyApy) || 0;
    return bApy - aApy;
  });

  return jsonResult({
    chain: chainName(chainId),
    vaultCount: allVaults.length,
    vaults: allVaults.slice(0, 20),
    note: 'Fixed-rate vaults lock funds until maturity. Check maturity dates before depositing.',
    tip: 'Use action=strategy strategy_name=<name> for managed vault execution.',
  });
}

/**
 * Perps: Hyperliquid perpetual futures positions and markets.
 */
async function handlePerps(client: any, params: Record<string, unknown>) {
  const state = getWalletState();
  const address = readStringParam(params, 'address') ?? state.address;
  const market = readStringParam(params, 'market');

  if (!address) {
    return errorResult('No wallet connected and no address provided.');
  }

  try {
    // Fetch Hyperliquid positions via Wayfinder
    // The SDK exposes perps data through the balances/positions aggregation
    const balances = await client.getBalances(address);

    // Filter for perp positions (Hyperliquid tokens)
    const perpPositions = balances.tokens
      ?.filter((t: any) =>
        t.balanceUsd > 0.01 && (
          t.protocol === 'hyperliquid' ||
          t.chainName?.toLowerCase().includes('hyperliquid')
        ),
      )
      .map((t: any) => ({
        market: t.symbol,
        size: t.balanceFormatted,
        valueUsd: `$${t.balanceUsd.toFixed(2)}`,
        chain: t.chainName,
      }));

    // Also fetch available perp markets via pools
    let markets: any[] = [];
    try {
      const pools = await client.getPools(42161, 'hyperliquid'); // Hyperliquid settles on Arbitrum
      markets = pools
        .filter((p: any) => !market || p.tokenSymbol?.includes(market.replace('-USD', '')))
        .slice(0, 20)
        .map((p: any) => ({
          market: p.tokenSymbol,
          fundingRate: p.fundingRate !== undefined ? `${(p.fundingRate * 100).toFixed(4)}%` : undefined,
          openInterest: p.totalSupplyUsd > 1_000_000
            ? `$${(p.totalSupplyUsd / 1_000_000).toFixed(1)}M`
            : `$${(p.totalSupplyUsd / 1_000).toFixed(0)}K`,
          volume24h: p.volume24h ? `$${(p.volume24h / 1_000_000).toFixed(1)}M` : undefined,
        }));
    } catch {
      // Perp markets fetch may not be supported
    }

    return jsonResult({
      address,
      positions: perpPositions?.length ? perpPositions : [],
      availableMarkets: markets.length > 0 ? markets : undefined,
      tip: 'Use action=strategy for managed perp strategies via Wayfinder CLI.',
    });
  } catch (err) {
    return errorResult(`Perps fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * PnL: Cross-protocol profit and loss summary.
 */
async function handlePnl(client: any, params: Record<string, unknown>) {
  const state = getWalletState();
  const address = readStringParam(params, 'address') ?? state.address;

  if (!address) {
    return errorResult('No wallet connected and no address provided.');
  }

  try {
    // Fetch multi-chain balances as the basis for PnL
    const balances = await client.getBalances(address);
    const tokens = balances.tokens
      .filter((t: any) => t.balanceUsd > 0.01)
      .sort((a: any, b: any) => b.balanceUsd - a.balanceUsd);

    // Group by chain
    const byChain: Record<string, { tokens: any[]; total: number }> = {};
    for (const t of tokens) {
      const chain = t.chainName ?? 'Unknown';
      if (!byChain[chain]) byChain[chain] = { tokens: [], total: 0 };
      byChain[chain].tokens.push({
        symbol: t.symbol,
        balance: t.balanceFormatted,
        valueUsd: t.balanceUsd,
        change24h: t.priceChange24h !== undefined
          ? `${t.priceChange24h >= 0 ? '+' : ''}${t.priceChange24h.toFixed(2)}%`
          : undefined,
      });
      byChain[chain].total += t.balanceUsd;
    }

    // Calculate portfolio-level metrics
    const totalValueUsd = tokens.reduce((sum: number, t: any) => sum + t.balanceUsd, 0);

    // Weighted average 24h change
    let weightedChange = 0;
    let weightTotal = 0;
    for (const t of tokens) {
      if (t.priceChange24h !== undefined && t.balanceUsd > 0) {
        weightedChange += t.priceChange24h * t.balanceUsd;
        weightTotal += t.balanceUsd;
      }
    }
    const portfolioChange24h = weightTotal > 0 ? weightedChange / weightTotal : 0;
    const pnl24h = totalValueUsd * (portfolioChange24h / 100);

    return jsonResult({
      address,
      totalValueUsd: `$${totalValueUsd.toFixed(2)}`,
      change24h: `${portfolioChange24h >= 0 ? '+' : ''}${portfolioChange24h.toFixed(2)}%`,
      pnl24hUsd: `${pnl24h >= 0 ? '+' : ''}$${Math.abs(pnl24h).toFixed(2)}`,
      chainBreakdown: Object.entries(byChain).map(([chain, data]) => ({
        chain,
        totalUsd: `$${data.total.toFixed(2)}`,
        tokenCount: data.tokens.length,
        topHoldings: data.tokens.slice(0, 5).map(t => ({
          symbol: t.symbol,
          valueUsd: `$${t.valueUsd.toFixed(2)}`,
          change24h: t.change24h,
        })),
      })),
      note: '24h P&L is estimated from price changes. For accurate cost-basis tracking, use the cost-basis skill.',
    });
  } catch (err) {
    return errorResult(`PnL fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
