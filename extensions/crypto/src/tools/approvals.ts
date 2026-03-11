/**
 * Token Approvals Tool — scan, audit, and revoke ERC-20 approvals.
 *
 * Actions:
 *   scan      — Scan all token approvals for the connected wallet
 *   revoke    — Revoke a specific token+spender approval
 *   revoke_all — Revoke all non-zero approvals found by scan
 *
 * Uses Etherscan/Basescan event log API for comprehensive scanning,
 * falls back to AllowanceManager's known-tokens heuristic when no API key.
 */

import { Type } from '@sinclair/typebox';
import { formatUnits } from 'viem';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { getAllowanceManager, type AllowanceInfo } from '../services/allowance-manager.js';
import { getCredentialVault } from '../services/credential-vault.js';
import { guardedFetch } from '../services/endpoint-allowlist.js';
import { getRpcManager } from '../services/rpc-provider.js';

const ACTIONS = ['scan', 'revoke', 'revoke_all'] as const;

/** Keccak-256 of Approval(address,address,uint256) */
const APPROVAL_EVENT_TOPIC =
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

const ERC20_MINIMAL_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const CHAIN_EXPLORER: Record<number, { apiUrl: string; keyPath: string; name: string }> = {
  8453: { apiUrl: 'https://api.basescan.org/api', keyPath: 'explorer.basescan.apiKey', name: 'Basescan' },
  1: { apiUrl: 'https://api.etherscan.io/api', keyPath: 'explorer.etherscan.apiKey', name: 'Etherscan' },
};

const ApprovalsSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'scan: audit all token approvals. revoke: revoke a specific approval. ' +
      'revoke_all: revoke every non-zero approval found.',
  }),
  chain: Type.Optional(Type.String({
    description: 'Chain: "base" (default) or "ethereum".',
  })),
  token: Type.Optional(Type.String({
    description: 'Token contract address (0x...). Required for revoke.',
  })),
  spender: Type.Optional(Type.String({
    description: 'Spender contract address (0x...). Required for revoke.',
  })),
});

export function createApprovalsTool() {
  return {
    name: 'approvals',
    label: 'Token Approvals',
    ownerOnly: true,
    description:
      'Scan, audit, and revoke ERC-20 token approvals. ' +
      'Detects unlimited approvals and unknown spenders. ' +
      'Uses Etherscan/Basescan for comprehensive event scanning, ' +
      'with on-chain verification of current allowance state.',
    parameters: ApprovalsSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'scan':
          return handleScan(params);
        case 'revoke':
          return handleRevoke(params);
        case 'revoke_all':
          return handleRevokeAll(params);
        default:
          return errorResult(`Unknown action: ${action}. Use: scan, revoke, revoke_all`);
      }
    },
  };
}

// ── Types ──────────────────────────────────────────────────────────────────

interface ApprovalEntry {
  token: string;
  tokenAddress: string;
  spender: string;
  spenderAddress: string;
  allowance: string;
  allowanceHuman: string;
  isUnlimited: boolean;
  riskLevel: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveChainId(chain?: string): number {
  if (!chain) return 8453;
  switch (chain.toLowerCase()) {
    case 'ethereum': case 'eth': case 'mainnet': return 1;
    case 'base': default: return 8453;
  }
}

/**
 * Scan via Etherscan/Basescan event logs API for all Approval events
 * where topic1 (owner) matches the wallet address.
 */
async function scanViaExplorer(
  ownerAddress: string,
  chainId: number,
): Promise<Array<{ tokenAddress: string; spenderAddress: string }> | null> {
  const explorer = CHAIN_EXPLORER[chainId];
  if (!explorer) return null;

  const apiKey = getCredentialVault().getSecret(explorer.keyPath, 'approvals');
  if (!apiKey) return null;

  // Pad owner address to 32 bytes for topic matching
  const paddedOwner = '0x' + ownerAddress.slice(2).toLowerCase().padStart(64, '0');

  const url = new URL(explorer.apiUrl);
  url.searchParams.set('module', 'logs');
  url.searchParams.set('action', 'getLogs');
  url.searchParams.set('fromBlock', '0');
  url.searchParams.set('toBlock', 'latest');
  url.searchParams.set('topic0', APPROVAL_EVENT_TOPIC);
  url.searchParams.set('topic1', paddedOwner);
  url.searchParams.set('topic0_1_opr', 'and');
  url.searchParams.set('apikey', apiKey);

  try {
    const response = await guardedFetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) return null;

    const data: any = await response.json();
    if (data.status === '0') return null;

    const logs: any[] = data.result ?? [];

    // Deduplicate: unique (tokenAddress, spenderAddress) pairs
    const seen = new Set<string>();
    const pairs: Array<{ tokenAddress: string; spenderAddress: string }> = [];

    for (const log of logs) {
      const tokenAddress = log.address?.toLowerCase();
      const spenderTopic = log.topics?.[2];
      if (!tokenAddress || !spenderTopic) continue;

      // Extract spender address from padded topic (last 40 hex chars)
      const spenderAddress = '0x' + spenderTopic.slice(-40);
      const key = `${tokenAddress}:${spenderAddress}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ tokenAddress, spenderAddress });
    }

    return pairs;
  } catch {
    return null;
  }
}

/**
 * Verify current on-chain allowance for a token+spender pair.
 * Returns null if the token isn't a valid ERC-20 or allowance is zero.
 */
async function verifyAllowance(
  ownerAddress: string,
  tokenAddress: string,
  spenderAddress: string,
  chainId: number,
): Promise<ApprovalEntry | null> {
  const rpcManager = getRpcManager();
  const client = await rpcManager.getClient(chainId);
  const manager = getAllowanceManager();

  try {
    const [allowance, symbol, decimals] = await Promise.all([
      client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_MINIMAL_ABI,
        functionName: 'allowance',
        args: [ownerAddress as `0x${string}`, spenderAddress as `0x${string}`],
      }) as Promise<bigint>,
      client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_MINIMAL_ABI,
        functionName: 'symbol',
      }).catch(() => 'UNKNOWN') as Promise<string>,
      client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_MINIMAL_ABI,
        functionName: 'decimals',
      }).catch(() => 18) as Promise<number>,
    ]);

    if (allowance === 0n) return null;

    const dec = Number(decimals);
    const humanStr = formatUnits(allowance, dec);
    const human = parseFloat(humanStr);
    const isUnlimited = human > 1e12;
    const spenderName = manager.resolveSpenderName(spenderAddress, chainId);

    let riskLevel: string;
    if (!isUnlimited && human < 1000) riskLevel = 'safe';
    else if (spenderName === 'Unknown') riskLevel = isUnlimited ? 'critical' : 'high';
    else if (isUnlimited) riskLevel = 'moderate';
    else riskLevel = 'safe';

    return {
      token: String(symbol),
      tokenAddress,
      spender: spenderName,
      spenderAddress,
      allowance: allowance.toString(),
      allowanceHuman: isUnlimited ? 'unlimited' : human.toLocaleString(),
      isUnlimited,
      riskLevel,
    };
  } catch {
    return null;
  }
}

// ── Cached scan results for revoke_all ─────────────────────────────────────

let _lastScanResult: ApprovalEntry[] = [];
let _lastScanChainId = 0;
let _lastScanTimestamp = 0;

// ── Action Handlers ────────────────────────────────────────────────────────

async function handleScan(params: Record<string, unknown>) {
  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const chainId = resolveChainId(readStringParam(params, 'chain'));
  const chainName = chainId === 1 ? 'ethereum' : 'base';

  // Try comprehensive scan via Etherscan/Basescan event logs
  const explorerPairs = await scanViaExplorer(state.address, chainId);

  let approvals: ApprovalEntry[];

  if (explorerPairs && explorerPairs.length > 0) {
    // Verify each pair on-chain (filter zero allowances, get current state)
    // Process in batches of 10 to avoid rate limits
    const batchSize = 10;
    const verified: ApprovalEntry[] = [];

    for (let i = 0; i < explorerPairs.length; i += batchSize) {
      const batch = explorerPairs.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(({ tokenAddress, spenderAddress }) =>
          verifyAllowance(state.address!, tokenAddress, spenderAddress, chainId),
        ),
      );
      for (const r of results) {
        if (r) verified.push(r);
      }
    }

    approvals = verified;
  } else {
    // Fallback: use AllowanceManager's known tokens × known spenders
    const manager = getAllowanceManager();
    const report = await manager.auditAllowances(state.address, chainId);
    approvals = report.allowances.map((a: AllowanceInfo) => ({
      token: a.token,
      tokenAddress: a.tokenAddress,
      spender: a.spenderName,
      spenderAddress: a.spenderAddress,
      allowance: a.allowance,
      allowanceHuman: a.allowanceHuman,
      isUnlimited: a.isUnlimited,
      riskLevel: a.riskLevel,
    }));
  }

  // Sort: critical > high > moderate > safe
  const riskOrder: Record<string, number> = { critical: 0, high: 1, moderate: 2, safe: 3 };
  approvals.sort((a, b) => (riskOrder[a.riskLevel] ?? 4) - (riskOrder[b.riskLevel] ?? 4));

  // Cache for revoke_all
  _lastScanResult = approvals;
  _lastScanChainId = chainId;
  _lastScanTimestamp = Date.now();

  const unlimited = approvals.filter(a => a.isUnlimited).length;
  const critical = approvals.filter(a => a.riskLevel === 'critical').length;
  const high = approvals.filter(a => a.riskLevel === 'high').length;

  const recommendations: string[] = [];
  if (critical > 0) {
    recommendations.push(
      `${critical} CRITICAL approval${critical > 1 ? 's' : ''} to unknown contracts — revoke immediately.`,
    );
  }
  if (unlimited > 0) {
    recommendations.push(
      `${unlimited} unlimited approval${unlimited > 1 ? 's' : ''} found. Revoke any you no longer use.`,
    );
  }
  if (high > 0) {
    recommendations.push(
      `${high} high-risk approval${high > 1 ? 's' : ''} detected. Review spender contracts.`,
    );
  }
  if (approvals.length === 0) {
    recommendations.push('No active approvals found — minimal token approval exposure.');
  }

  return jsonResult({
    chain: chainName,
    address: state.address,
    scanMethod: explorerPairs ? 'event_logs' : 'known_spenders',
    totalApprovals: approvals.length,
    unlimited,
    critical,
    highRisk: high,
    approvals: approvals.map(a => ({
      token: a.token,
      tokenAddress: a.tokenAddress,
      spender: a.spender,
      spenderAddress: a.spenderAddress,
      allowance: a.allowanceHuman,
      risk: a.riskLevel,
    })),
    recommendations,
    tip: approvals.length > 0
      ? 'Use approvals action=revoke token=<address> spender=<address> to revoke specific approvals, or action=revoke_all to revoke everything.'
      : undefined,
  });
}

async function handleRevoke(params: Record<string, unknown>) {
  const tokenAddress = readStringParam(params, 'token');
  const spenderAddress = readStringParam(params, 'spender');
  if (!tokenAddress || !spenderAddress) {
    return errorResult('Both token and spender addresses are required for revoke.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  try {
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();
    const chainId = resolveChainId(readStringParam(params, 'chain'));

    // Verify current allowance first
    const currentAllowance = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_MINIMAL_ABI,
      functionName: 'allowance',
      args: [state.address as `0x${string}`, spenderAddress as `0x${string}`],
    }) as bigint;

    if (currentAllowance === 0n) {
      return jsonResult({
        status: 'already_zero',
        token: tokenAddress,
        spender: spenderAddress,
        message: 'Approval is already zero — nothing to revoke.',
      });
    }

    // Get token symbol for reporting
    let symbol = 'UNKNOWN';
    try {
      symbol = await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_MINIMAL_ABI,
        functionName: 'symbol',
      }) as string;
    } catch { /* use UNKNOWN */ }

    // Send approve(spender, 0) transaction
    const hash = await wallet.writeContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_MINIMAL_ABI,
      functionName: 'approve',
      args: [spenderAddress as `0x${string}`, 0n],
    });

    // Wait for revoke tx to confirm
    await publicClient.waitForTransactionReceipt({ hash });

    // Resolve spender name
    const manager = getAllowanceManager();
    const spenderName = manager.resolveSpenderName(spenderAddress, chainId);

    return jsonResult({
      status: 'revoked',
      token: symbol,
      tokenAddress,
      spender: spenderName,
      spenderAddress,
      txHash: hash,
      previousAllowance: currentAllowance.toString(),
    });
  } catch (err) {
    return errorResult(`Revoke failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleRevokeAll(params: Record<string, unknown>) {
  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const chainId = resolveChainId(readStringParam(params, 'chain'));

  // Use cached scan if fresh (< 5 minutes), otherwise re-scan
  let approvals = _lastScanResult;
  if (_lastScanChainId !== chainId || Date.now() - _lastScanTimestamp > 300_000 || approvals.length === 0) {
    // Re-scan
    const scanResult = await handleScan(params);
    const scanData = scanResult.details as any;
    if (scanData?.error) return scanResult;
    approvals = _lastScanResult;
  }

  if (approvals.length === 0) {
    return jsonResult({
      status: 'nothing_to_revoke',
      message: 'No active approvals found.',
    });
  }

  const wallet = requireWalletClient();
  const publicClient = requirePublicClient();
  const results: Array<{ token: string; spender: string; txHash?: string; error?: string }> = [];

  for (const approval of approvals) {
    try {
      const hash = await wallet.writeContract({
        address: approval.tokenAddress as `0x${string}`,
        abi: ERC20_MINIMAL_ABI,
        functionName: 'approve',
        args: [approval.spenderAddress as `0x${string}`, 0n],
      });

      // Wait for each revoke to confirm before sending the next
      await publicClient.waitForTransactionReceipt({ hash });

      results.push({
        token: `${approval.token} (${approval.tokenAddress})`,
        spender: `${approval.spender} (${approval.spenderAddress})`,
        txHash: hash,
      });
    } catch (err) {
      results.push({
        token: `${approval.token} (${approval.tokenAddress})`,
        spender: `${approval.spender} (${approval.spenderAddress})`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter(r => r.txHash).length;
  const failed = results.filter(r => r.error).length;

  // Clear cache
  _lastScanResult = [];
  _lastScanTimestamp = 0;

  return jsonResult({
    status: 'batch_revoke_complete',
    total: results.length,
    succeeded,
    failed,
    results,
  });
}
