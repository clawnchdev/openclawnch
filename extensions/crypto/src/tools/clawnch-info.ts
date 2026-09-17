/**
 * Clawnch Info Tool — On-chain reads, portfolio, vault claims, agent management.
 *
 * Consolidates read-heavy operations that were previously missing:
 *   - token_info: On-chain token details via ClawnchReader (Base) / viem (Robinhood Chain)
 *   - portfolio: Token discovery + portfolio view via ClawnchPortfolio
 *   - vault_claim: Check/claim vested vault allocations (Base only)
 *   - agent_register: Register as a verified Clawnch agent
 *   - agent_status: Check agent registration status
 *   - platform_stats: Clawnch platform statistics
 *   - list_tokens: List tokens deployed through Clawnch
 *
 * Chain-aware: pass chain: "robinhood" for Robinhood Chain reads, which use the
 * API launch feed + Robinhood Chain RPC and return Blockscout explorer links and
 * bags.fm trade links. Base stays the default. Base-only features (vaults) raise
 * a clear "not supported on Robinhood Chain" error instead of silently reading Base.
 *
 * Most actions are read-only (no gas). vault_claim and agent_register
 * are write operations that go through ClawnchConnect.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { checkBalance } from '../services/safety-service.js';
import { guardedFetch } from '../services/endpoint-allowlist.js';
import { getCredentialVault } from '../services/credential-vault.js';
import {
  resolveClawnchChainKey,
  explorerTxUrl,
  explorerAddressUrl,
  tradeUrl,
  type ClawnchChainKey,
} from '../lib/contract-registry.js';
import * as rh from '../lib/robinhood-api.js';
import { formatUnits } from 'viem';

const CLAWNCH_API_URL = process.env.CLAWNCHER_API_URL || 'https://clawn.ch';
const ACTIONS = [
  'token_info', 'portfolio', 'vault_claim',
  'agent_register', 'agent_status', 'platform_stats', 'list_tokens',
] as const;
const CHAINS = ['base', 'robinhood'] as const;

const ClawnchInfoSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'token_info: on-chain token details. portfolio: discovered tokens + values. ' +
      'vault_claim: check/claim vault allocation (Base only). agent_register: register as Clawnch agent. ' +
      'agent_status: check registration. platform_stats: Clawnch stats. list_tokens: deployed tokens.',
  }),
  token: Type.Optional(Type.String({
    description: 'Token contract address (for token_info, vault_claim).',
  })),
  address: Type.Optional(Type.String({
    description: 'Wallet address (for portfolio, agent_status). Defaults to connected wallet.',
  })),
  agent_name: Type.Optional(Type.String({
    description: 'Agent display name (for agent_register).',
  })),
  agent_description: Type.Optional(Type.String({
    description: 'Agent description (for agent_register).',
  })),
  page: Type.Optional(Type.Number({
    description: 'Page number for list_tokens (default: 1).',
  })),
  page_size: Type.Optional(Type.Number({
    description: 'Items per page for list_tokens (default: 20).',
  })),
  chain: Type.Optional(stringEnum(CHAINS, {
    description:
      'Chain for on-chain reads: "base" (default) or "robinhood" (Robinhood Chain, Blockscout + bags.fm links).',
  })),
});

export function createClawnchInfoTool() {
  return {
    name: 'clawnch_info',
    label: 'Clawnch Info',
    ownerOnly: true, // vault_claim and agent_register are write operations
    description:
      'On-chain token information, portfolio discovery, vault claims, and Clawnch platform data. ' +
      'Most actions are read-only (no gas cost). ' +
      'Pass chain: "robinhood" for Robinhood Chain reads (Blockscout explorer + bags.fm trade links); ' +
      'vault_claim is Base-only and errors clearly on Robinhood Chain. ' +
      'vault_claim and agent_register are write operations requiring a connected wallet.',
    parameters: ClawnchInfoSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      try {
        const requestedChain = readStringParam(params, 'chain');
        const chain: ClawnchChainKey | null = requestedChain
          ? resolveClawnchChainKey(requestedChain) ?? null
          : 'base';
        if (!chain) {
          return errorResult(
            `Unknown chain "${requestedChain}". Supported chains: ${CHAINS.join(', ')}.`,
          );
        }

        switch (action) {
          case 'token_info':
            return chain === 'robinhood'
              ? handleRhTokenInfo(params)
              : handleTokenInfo(params);
          case 'portfolio':
            return chain === 'robinhood'
              ? handleRhPortfolio(params)
              : handlePortfolio(params);
          case 'vault_claim':
            if (chain === 'robinhood') {
              rh.rhNotSupported(
                'vault_claim',
                'Bags.fm launches have no vault/lockup — the full supply is on the curve from block one.',
              );
            }
            return handleVaultClaim(params);
          case 'agent_register':
            return handleAgentRegister(params);
          case 'agent_status':
            return handleAgentStatus(params);
          case 'platform_stats':
            return chain === 'robinhood'
              ? handleRhPlatformStats()
              : handlePlatformStats();
          case 'list_tokens':
            return chain === 'robinhood'
              ? handleRhListTokens(params)
              : handleListTokens(params);
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        if (rh.isRhNotSupportedError(err)) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        return errorResult(`Clawnch info failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ─── Token Info (ClawnchReader) ───────────────────────────────────────────

async function handleTokenInfo(params: Record<string, unknown>) {
  const tokenAddress = readStringParam(params, 'token', { required: true })!;

  let publicClient: any;
  try {
    publicClient = requirePublicClient();
  } catch {
    return errorResult('Public client not initialized. Connect a wallet first or ensure the wallet service is started.');
  }
  const { ClawnchReader } = await import('@clawnch/clawncher-sdk');

  const reader = new ClawnchReader({
    publicClient,
    network: 'mainnet',
  });

  const details = await reader.getTokenDetails(tokenAddress as `0x${string}`) as any;

  if (!details) {
    return errorResult(`Token not found or unreadable: ${tokenAddress}`);
  }

  return jsonResult({
    chain: 'base',
    chainId: 8453,
    address: tokenAddress,
    name: details.name,
    symbol: details.symbol,
    decimals: details.decimals,
    totalSupply: details.totalSupply?.toString(),
    owner: details.owner,
    // Clawnch-specific fields (present for Clawnch-deployed tokens)
    isClawnchToken: details.isClawnchToken ?? false,
    creator: details.creator,
    launchDate: details.launchDate,
    liquidityLocked: details.liquidityLocked,
    taxBuy: details.taxBuy,
    taxSell: details.taxSell,
    maxWallet: details.maxWallet,
    vault: details.vault ? {
      hasVault: true,
      lockupEndTime: details.vault.lockupEndTime,
      vestingDuration: details.vault.vestingDuration,
      totalAllocation: details.vault.totalAllocation?.toString(),
    } : { hasVault: false },
  });
}

// ─── Robinhood Chain: token info ──────────────────────────────────────────

async function handleRhTokenInfo(params: Record<string, unknown>) {
  const tokenAddress = readStringParam(params, 'token', { required: true })!;
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    return errorResult(`Token must be a 0x address: ${tokenAddress}`);
  }

  const publicClient = await rh.getRhPublicClient();
  const info = await rh.readRhTokenInfo(tokenAddress, publicClient);

  // Is this a Clawnch/Bags launch? Look it up in the public launch feed.
  let launch: rh.RhLaunchRecord | undefined;
  let launchLookupError: string | undefined;
  try {
    const feed = await rh.getRhLaunches({ limit: 200 });
    launch = feed.launches.find(l => l.token?.toLowerCase() === tokenAddress.toLowerCase());
  } catch (err) {
    launchLookupError = err instanceof Error ? err.message : String(err);
  }

  // Bags fee share for the token (where trading fees accrue).
  let feeShare: string | undefined;
  let creationFeeEth: string | undefined;
  try {
    feeShare = (await publicClient.readContract({
      address: rh.RH_BAGS_FACTORY,
      abi: rh.RH_BAGS_FACTORY_ABI,
      functionName: 'feeShareForToken',
      args: [tokenAddress as `0x${string}`],
    })) as string;
    const fee = await publicClient.readContract({
      address: rh.RH_BAGS_FACTORY,
      abi: rh.RH_BAGS_FACTORY_ABI,
      functionName: 'creationFee',
    });
    creationFeeEth = formatUnits(fee as bigint, 18);
  } catch {
    // Factory read failures are non-fatal — the token details still stand.
  }

  return jsonResult({
    chain: 'robinhood',
    chainId: rh.RH_CHAIN_ID,
    address: tokenAddress,
    name: info.name,
    symbol: info.symbol,
    decimals: info.decimals,
    totalSupply: info.totalSupply,
    isClawnchToken: Boolean(launch),
    launchMode: launch?.mode,
    agent: launch?.agent,
    launchedAt: launch?.launchedAt,
    feeShare,
    bagsCreationFeeEth: creationFeeEth,
    tradeUrl: rh.rhTradeUrl(tokenAddress),
    explorerUrl: rh.rhExplorerTokenUrl(tokenAddress),
    explorerAddressUrl: rh.rhExplorerAddressUrl(tokenAddress),
    launchLookupError,
    note: 'Robinhood Chain token details read directly from chain; trade links point at bags.fm.',
  });
}

// ─── Portfolio (ClawnchPortfolio) ─────────────────────────────────────────

async function handlePortfolio(params: Record<string, unknown>) {
  const state = getWalletState();
  const address = readStringParam(params, 'address') ?? state.address;

  if (!address) {
    return errorResult('No address provided and no wallet connected.');
  }

  let publicClient: any;
  try {
    publicClient = requirePublicClient();
  } catch {
    return errorResult('Public client not initialized. Connect a wallet first or ensure the wallet service is started.');
  }
  const { ClawnchPortfolio } = await import('@clawnch/clawncher-sdk');

  const portfolio = new ClawnchPortfolio({
    publicClient,
    network: 'mainnet',
  });

  // Discover tokens held by this wallet
  const discovered = await portfolio.discoverTokens(address as `0x${string}`) as any;

  // discoverTokens may return an array of addresses or a portfolio object
  // Normalize to handle both shapes
  const tokens = Array.isArray(discovered)
    ? discovered
    : (discovered?.tokens ?? []);

  if (!tokens || tokens.length === 0) {
    return jsonResult({
      chain: 'base',
      chainId: 8453,
      address,
      totalValueUsd: 0,
      tokens: [],
      message: 'No tokens discovered for this address.',
    });
  }

  // If we got full portfolio objects, sort by value
  if (typeof tokens[0] === 'object' && tokens[0].valueUsd !== undefined) {
    const sorted = [...tokens].sort(
      (a: any, b: any) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)
    );

    return jsonResult({
      chain: 'base',
      chainId: 8453,
      address,
      ethBalance: discovered.ethBalance?.toString(),
      ethValueUsd: discovered.ethValueUsd,
      totalValueUsd: discovered.totalValueUsd,
      tokenCount: sorted.length,
      tokens: sorted.map((t: any) => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        balance: t.balanceFormatted,
        priceUsd: t.priceUsd,
        valueUsd: t.valueUsd,
        isClawnchToken: t.isClawnchToken ?? false,
      })),
    });
  }

  // Bare address list — return as-is for the agent to process
  return jsonResult({
    chain: 'base',
    chainId: 8453,
    address,
    tokenCount: tokens.length,
    tokenAddresses: tokens,
    message: 'Token addresses discovered. Use token_info action to get details for each.',
  });
}

// ─── Robinhood Chain: portfolio ───────────────────────────────────────────

async function handleRhPortfolio(params: Record<string, unknown>) {
  const state = getWalletState();
  const address = readStringParam(params, 'address') ?? state.address;

  if (!address) {
    return errorResult('No address provided and no wallet connected.');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return errorResult(`Address must be a 0x address: ${address}`);
  }

  const publicClient = await rh.getRhPublicClient();
  const ethBalance = (await publicClient.getBalance({ address: address as `0x${string}` })) as bigint;

  // Robinhood Chain has no Base-side index: the portfolio is the agent's
  // launched tokens (public feed) plus their on-chain balances.
  const feed = await rh.getRhLaunches({ agent: address, limit: 200 });
  const tokens: Record<string, unknown>[] = [];

  for (const launch of feed.launches) {
    if (!launch?.token) continue;
    let balance: bigint | undefined;
    let decimals: number | undefined;
    try {
      const [bal, dec] = await Promise.all([
        publicClient.readContract({
          address: launch.token as `0x${string}`,
          abi: rh.RH_ERC20_ABI,
          functionName: 'balanceOf',
          args: [address as `0x${string}`],
        }),
        publicClient.readContract({
          address: launch.token as `0x${string}`,
          abi: rh.RH_ERC20_ABI,
          functionName: 'decimals',
        }),
      ]);
      balance = bal as bigint;
      decimals = Number(dec as number);
    } catch {
      // Token read failure — still report the launch, without a balance.
    }

    tokens.push({
      address: launch.token,
      name: launch.name,
      symbol: launch.symbol,
      balance: balance === undefined || decimals === undefined
        ? undefined
        : formatUnits(balance, decimals),
      mode: launch.mode,
      launchedAt: launch.launchedAt,
      tradeUrl: launch.tradeUrl ?? rh.rhTradeUrl(launch.token),
      explorerUrl: launch.explorerUrl ?? rh.rhExplorerTokenUrl(launch.token),
    });
  }

  return jsonResult({
    chain: 'robinhood',
    chainId: rh.RH_CHAIN_ID,
    address,
    ethBalance: formatUnits(ethBalance, 18),
    launchCount: tokens.length,
    tokens,
    pricingNote:
      'USD pricing is not available for Robinhood Chain tokens — no Base-side price index or oracle feed. ' +
      'Use the bags.fm trade links for live quotes.',
    message: tokens.length
      ? 'Tokens discovered from your Robinhood Chain launches.'
      : 'No Robinhood Chain launches found for this address.',
  });
}

// ─── Vault Claim (ClawncherClaimer) ───────────────────────────────────────

async function handleVaultClaim(params: Record<string, unknown>) {
  const tokenAddress = readStringParam(params, 'token', { required: true })!;

  const state = getWalletState();
  if (!state.connected) {
    return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
  }

  const publicClient = requirePublicClient();
  const { ClawnchReader } = await import('@clawnch/clawncher-sdk');

  const reader = new ClawnchReader({
    publicClient,
    network: 'mainnet',
  });

  // Check vault allocation status first (read-only)
  const vault = await reader.getVaultAllocation(tokenAddress as `0x${string}`);

  if (!vault) {
    return jsonResult({
      chain: 'base',
      chainId: 8453,
      token: tokenAddress,
      hasVault: false,
      message: 'No vault allocation exists for this token.',
    });
  }

  const { formatEther } = await import('viem');

  const status: Record<string, unknown> = {
    chain: 'base',
    chainId: 8453,
    token: tokenAddress,
    hasVault: true,
    totalAllocation: formatEther(vault.amountTotal),
    claimed: formatEther(vault.amountClaimed),
    available: formatEther(vault.amountAvailable),
    percentVested: vault.percentVested,
    isUnlocked: vault.isUnlocked,
    isFullyVested: vault.isFullyVested,
  };

  if (!vault.isUnlocked) {
    status.lockupEnds = new Date(Number(vault.lockupEndTime) * 1000).toISOString();
    status.message = 'Vault is still locked. Cannot claim yet.';
    return jsonResult(status);
  }

  if (vault.amountAvailable === 0n) {
    status.message = vault.isFullyVested
      ? 'Fully vested and fully claimed. Nothing left.'
      : 'No tokens available to claim yet. Vesting in progress.';
    return jsonResult(status);
  }

  // Pre-flight gas check
  const safety = await checkBalance({ requiredEth: 0 });
  if (!safety.safe) {
    status.message = `Cannot claim: ${safety.blockers.join('; ')}`;
    return jsonResult(status);
  }

  // Execute claim
  const wallet = requireWalletClient();
  const { ClawncherClaimer } = await import('@clawnch/clawncher-sdk');

  const claimer = new ClawncherClaimer({
    wallet,
    publicClient,
    network: 'mainnet',
  });

  const result = await claimer.claimVault(tokenAddress as `0x${string}`);
  await result.wait();

  status.claimExecuted = true;
  status.txHash = result.txHash;
  status.amountClaimed = formatEther(vault.amountAvailable);
  status.message = `Successfully claimed ${formatEther(vault.amountAvailable)} tokens.`;

  return jsonResult(status);
}

// ─── Agent Registration (ClawnchApiDeployer) ──────────────────────────────

async function handleAgentRegister(params: Record<string, unknown>) {
  const state = getWalletState();
  if (!state.connected) {
    return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
  }

  const agentName = readStringParam(params, 'agent_name', { required: true })!;
  const agentDescription = readStringParam(params, 'agent_description') ?? '';

  const apiKey = getCredentialVault().getSecret('clawnch.apiKey', 'clawnch-info');
  if (!apiKey) {
    return errorResult('CLAWNCH_API_KEY not set. Required for agent registration.');
  }

  const wallet = requireWalletClient();
  const publicClient = requirePublicClient();
  const { ClawnchApiDeployer } = await import('@clawnch/clawncher-sdk');

  const deployer = new ClawnchApiDeployer({
    apiBaseUrl: CLAWNCH_API_URL,
    apiKey,
    wallet,
    publicClient,
  });

  // register is a static method on ClawnchApiDeployer
  const result = await (ClawnchApiDeployer as any).register({
    address: state.address!,
    name: agentName,
    description: agentDescription,
    apiKey,
    apiBaseUrl: CLAWNCH_API_URL,
  });

  return jsonResult({
    status: 'registered',
    agentId: (result as any).agentId,
    address: state.address,
    name: agentName,
    verified: (result as any).verified,
    note: 'Agent registration is chain-agnostic — the same key signs launches on Base and Robinhood Chain.',
  });
}

async function handleAgentStatus(params: Record<string, unknown>) {
  const state = getWalletState();
  const address = readStringParam(params, 'address') ?? state.address;

  if (!address) {
    return errorResult('No address provided and no wallet connected.');
  }

  const apiKey = getCredentialVault().getSecret('clawnch.apiKey', 'clawnch-info');
  if (!apiKey) {
    return errorResult('CLAWNCH_API_KEY not set. Required for agent status queries.');
  }

  // Agent status is a read operation — query the API directly using the
  // address parameter. No wallet client needed (we're not signing anything).
  const apiBaseUrl = CLAWNCH_API_URL;

  try {
    const response = await guardedFetch(
      `${apiBaseUrl}/api/agents/${address}`,
      {
        headers: {
          'x-api-key': apiKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        return jsonResult({
          address,
          registered: false,
          agentId: null,
          name: null,
          verified: false,
          registeredAt: null,
          tokenAddress: null,
        });
      }
      throw new Error(`API returned ${response.status}: ${await response.text()}`);
    }

    const agentStatus = (await response.json()) as any;

    return jsonResult({
      address,
      registered: agentStatus.registeredAt != null,
      agentId: agentStatus.agentId,
      name: agentStatus.name,
      verified: agentStatus.verified,
      registeredAt: agentStatus.registeredAt,
      tokenAddress: agentStatus.tokenAddress,
    });
  } catch (err) {
    return errorResult(
      `Failed to query agent status for ${address}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Platform Stats ───────────────────────────────────────────────────────

async function handlePlatformStats() {
  const apiUrl = CLAWNCH_API_URL;

  try {
    const response = await guardedFetch(`${apiUrl}/api/stats`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return errorResult(`Platform stats unavailable: HTTP ${response.status}`);
    }

    const stats = await response.json() as any;

    return jsonResult({
      chain: 'base',
      chainId: 8453,
      platform: 'Clawnch',
      totalTokensDeployed: stats.totalTokens,
      totalAgents: stats.totalAgents,
      totalVolumeUsd: stats.totalVolumeUsd,
      totalLiquidityUsd: stats.totalLiquidityUsd,
      activeTokens24h: stats.activeTokens24h,
      topTokens: stats.topTokens?.slice(0, 5),
    });
  } catch (err) {
    return errorResult(`Platform stats failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Robinhood Chain: platform stats ──────────────────────────────────────

async function handleRhPlatformStats() {
  try {
    const feed = await rh.getRhLaunches({ limit: 1 });
    const recent = await rh.getRhLaunches({ limit: 5 });

    return jsonResult({
      chain: 'robinhood',
      chainId: rh.RH_CHAIN_ID,
      platform: 'Clawnch (Bags.fm launch router)',
      router: rh.RH_LAUNCH_ROUTER,
      bagsFactory: rh.RH_BAGS_FACTORY,
      totalAgenticLaunches: feed.pagination.total,
      recentLaunches: recent.launches.map(l => ({
        token: l.token,
        name: l.name,
        symbol: l.symbol,
        agent: l.agent,
        mode: l.mode,
        launchedAt: l.launchedAt,
        tradeUrl: l.tradeUrl ?? rh.rhTradeUrl(l.token),
        explorerUrl: l.explorerUrl ?? rh.rhExplorerTokenUrl(l.token),
      })),
      note: 'Base-side totals (volume, liquidity, top tokens) are not indexed for Robinhood Chain — ' +
        'use clawnch_info list_tokens with chain "robinhood" for the launch feed, or bags.fm for market data.',
    });
  } catch (err) {
    return errorResult(`Robinhood Chain stats failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── List Tokens ──────────────────────────────────────────────────────────

async function handleListTokens(params: Record<string, unknown>) {
  const page = readNumberParam(params, 'page') ?? 1;
  const pageSize = readNumberParam(params, 'page_size') ?? 20;

  const apiUrl = CLAWNCH_API_URL;

  try {
    const queryParams = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
    });

    const response = await guardedFetch(`${apiUrl}/api/tokens?${queryParams}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return errorResult(`Token list unavailable: HTTP ${response.status}`);
    }

    const data = await response.json() as any;

    return jsonResult({
      chain: 'base',
      chainId: 8453,
      page,
      pageSize,
      total: data.total,
      totalPages: Math.ceil(data.total / pageSize),
      tokens: (data.tokens ?? []).map((t: any) => ({
        address: t.address,
        name: t.name,
        symbol: t.symbol,
        creator: t.creator,
        launchDate: t.launchDate,
        priceUsd: t.priceUsd,
        marketCap: t.marketCapUsd,
        volume24h: t.volume24hUsd,
        holderCount: t.holderCount,
        explorerUrl: explorerAddressUrl('base', t.address),
      })),
    });
  } catch (err) {
    return errorResult(`Token list failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Robinhood Chain: list tokens ─────────────────────────────────────────

async function handleRhListTokens(params: Record<string, unknown>) {
  const page = readNumberParam(params, 'page') ?? 1;
  const pageSize = Math.min(readNumberParam(params, 'page_size') ?? 20, 200);
  const offset = Math.max(0, (page - 1) * pageSize);

  try {
    const feed = await rh.getRhLaunches({ limit: pageSize, offset });

    return jsonResult({
      chain: 'robinhood',
      chainId: rh.RH_CHAIN_ID,
      page,
      pageSize,
      total: feed.pagination.total,
      totalPages: Math.ceil(feed.pagination.total / pageSize),
      hasMore: feed.pagination.hasMore,
      tokens: feed.launches.map(l => ({
        address: l.token,
        name: l.name,
        symbol: l.symbol,
        creator: l.agent,
        launchDate: l.launchedAt,
        mode: l.mode,
        txHash: l.txHash,
        txUrl: l.txUrl ?? explorerTxUrl('robinhood', l.txHash),
        tradeUrl: l.tradeUrl ?? tradeUrl('robinhood', l.token),
        explorerUrl: l.explorerUrl ?? rh.rhExplorerTokenUrl(l.token),
        // Base-side market data (price/market cap/holders) is not indexed for RHC.
        priceUsd: null,
      })),
    });
  } catch (err) {
    return errorResult(`Robinhood Chain token list failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
