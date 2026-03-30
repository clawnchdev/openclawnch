/**
 * Clawnch Info Tool — On-chain reads, portfolio, vault claims, agent management.
 *
 * Consolidates read-heavy operations that were previously missing:
 *   - token_info: On-chain token details via ClawnchReader
 *   - portfolio: Token discovery + portfolio view via ClawnchPortfolio
 *   - vault_claim: Check/claim vested vault allocations
 *   - agent_register: Register as a verified Clawnch agent
 *   - agent_status: Check agent registration status
 *   - platform_stats: Clawnch platform statistics
 *   - list_tokens: List tokens deployed through Clawnch
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

const CLAWNCH_API_URL = process.env.CLAWNCHER_API_URL || 'https://clawn.ch';
const ACTIONS = [
  'token_info', 'portfolio', 'vault_claim',
  'agent_register', 'agent_status', 'platform_stats', 'list_tokens',
] as const;

const ClawnchInfoSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'token_info: on-chain token details. portfolio: discovered tokens + values. ' +
      'vault_claim: check/claim vault allocation. agent_register: register as Clawnch agent. ' +
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
});

export function createClawnchInfoTool() {
  return {
    name: 'clawnch_info',
    label: 'Clawnch Info',
    ownerOnly: true, // vault_claim and agent_register are write operations
    description:
      'On-chain token information, portfolio discovery, vault claims, and Clawnch platform data. ' +
      'Most actions are read-only (no gas cost). ' +
      'vault_claim and agent_register are write operations requiring a connected wallet.',
    parameters: ClawnchInfoSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      try {
        switch (action) {
          case 'token_info':
            return handleTokenInfo(params);
          case 'portfolio':
            return handlePortfolio(params);
          case 'vault_claim':
            return handleVaultClaim(params);
          case 'agent_register':
            return handleAgentRegister(params);
          case 'agent_status':
            return handleAgentStatus(params);
          case 'platform_stats':
            return handlePlatformStats();
          case 'list_tokens':
            return handleListTokens(params);
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
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
    address,
    tokenCount: tokens.length,
    tokenAddresses: tokens,
    message: 'Token addresses discovered. Use token_info action to get details for each.',
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
      token: tokenAddress,
      hasVault: false,
      message: 'No vault allocation exists for this token.',
    });
  }

  const { formatEther } = await import('viem');

  const status: Record<string, unknown> = {
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
      })),
    });
  } catch (err) {
    return errorResult(`Token list failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
