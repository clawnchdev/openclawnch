/**
 * Watch Activity Tool — on-chain monitoring via ClawnchWatcher
 *
 * Monitors swaps, transfers, whale activity, and new token deployments
 * on Base. Read-only — no wallet required.
 *
 * Uses ClawnchWatcher from @clawnch/clawncher-sdk.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { requirePublicClient } from '../services/walletconnect-service.js';

const ACTIONS = [
  'token_activity', 'recent_swaps', 'recent_transfers', 'deployments',
] as const;

const WatchActivitySchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'token_activity: full activity report (swaps + transfers + stats). ' +
      'recent_swaps: recent swaps for a pool. recent_transfers: token transfers. ' +
      'deployments: recent Clawnch token deployments.',
  }),
  token: Type.Optional(Type.String({
    description: 'Token contract address to monitor',
  })),
  pool_id: Type.Optional(Type.String({
    description: 'Pool ID (bytes32) for swap monitoring. Auto-derived from token if omitted.',
  })),
  blocks: Type.Optional(Type.Number({
    description: 'Number of blocks to look back (default: 5000, ~3 hours on Base)',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Max results to return (default: 50)',
  })),
  admin: Type.Optional(Type.String({
    description: 'Filter deployments by token admin address',
  })),
});

export function createWatchActivityTool() {
  return {
    name: 'watch_activity',
    label: 'Watch Activity',
    ownerOnly: false,
    description:
      'Monitor on-chain activity: token swaps, transfers, whale alerts, and new deployments. ' +
      'Read-only — no wallet connection needed, only a public RPC client. ' +
      'Tracks activity on Base mainnet.',
    parameters: WatchActivitySchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const p = args as Record<string, unknown>;
      const action = readStringParam(p, 'action', { required: true })!;

      try {
        const publicClient = requirePublicClient();
        const { ClawnchWatcher } = await import('@clawnch/clawncher-sdk');

        const network = (process.env.CLAWNCHER_NETWORK as 'mainnet' | 'sepolia') || 'mainnet';
        const watcher = new ClawnchWatcher({
          publicClient,
          network,
        });

        const blocks = readNumberParam(p, 'blocks') ?? 5000;
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock - BigInt(blocks);

        switch (action) {
          case 'token_activity': {
            const token = readStringParam(p, 'token', { required: true })! as `0x${string}`;
            const poolId = readStringParam(p, 'pool_id');

            if (!poolId) {
              // Try to get pool ID from ClawnchReader
              try {
                const { ClawnchReader } = await import('@clawnch/clawncher-sdk');
                const reader = new ClawnchReader({ publicClient, network });
                const rewards = await reader.getTokenRewards(token);
                const derivedPoolId = (rewards as any)?.poolId ?? (rewards as any)?.pool_id;

                if (derivedPoolId) {
                  const activity = await watcher.getTokenActivity(
                    token, derivedPoolId as `0x${string}`,
                    { fromBlock, transferLimit: 100, swapLimit: 100 },
                  );
                  return jsonResult(formatActivity(activity));
                }
              } catch {
                // Fall through to transfers-only
              }

              // No pool ID — just return transfers
              const transfers = await watcher.getRecentTransfers(token, {
                fromBlock,
                limit: readNumberParam(p, 'limit') ?? 50,
              });
              return jsonResult({
                token,
                transfers: transfers.map(formatTransfer),
                transferCount: transfers.length,
                note: 'No pool ID available — showing transfers only. Provide pool_id for swap data.',
              });
            }

            const activity = await watcher.getTokenActivity(
              token, poolId as `0x${string}`,
              { fromBlock, transferLimit: 100, swapLimit: 100 },
            );
            return jsonResult(formatActivity(activity));
          }

          case 'recent_swaps': {
            const poolId = readStringParam(p, 'pool_id', { required: true })! as `0x${string}`;
            const swaps = await watcher.getRecentSwaps(poolId, {
              fromBlock,
              limit: readNumberParam(p, 'limit') ?? 50,
            });
            return jsonResult({
              poolId,
              swaps: swaps.map(formatSwap),
              count: swaps.length,
            });
          }

          case 'recent_transfers': {
            const token = readStringParam(p, 'token', { required: true })! as `0x${string}`;
            const transfers = await watcher.getRecentTransfers(token, {
              fromBlock,
              limit: readNumberParam(p, 'limit') ?? 50,
            });
            return jsonResult({
              token,
              transfers: transfers.map(formatTransfer),
              count: transfers.length,
            });
          }

          case 'deployments': {
            const admin = readStringParam(p, 'admin') as `0x${string}` | undefined;
            const deployments = await watcher.getHistoricalDeployments({
              fromBlock,
              tokenAdmin: admin,
            });
            return jsonResult({
              deployments: deployments.map(d => ({
                tokenAddress: d.tokenAddress,
                name: d.tokenName,
                symbol: d.tokenSymbol,
                deployer: d.deployer,
                poolId: d.poolId,
                txHash: d.txHash,
                block: d.blockNumber?.toString(),
              })),
              count: deployments.length,
            });
          }

          default:
            return errorResult(`Unknown watch_activity action: ${action}`);
        }
      } catch (err) {
        return errorResult(`Watch activity error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ── Formatting helpers ─────────────────────────────────────────────────

function formatActivity(activity: any) {
  return {
    token: activity.token,
    fromBlock: activity.fromBlock?.toString(),
    toBlock: activity.toBlock?.toString(),
    stats: activity.stats ? {
      transferCount: activity.stats.transferCount,
      swapCount: activity.stats.swapCount,
      uniqueAddresses: activity.stats.uniqueAddresses,
      largestTransfer: activity.stats.largestTransfer?.toString(),
      totalVolume0: activity.stats.totalVolume0?.toString(),
      totalVolume1: activity.stats.totalVolume1?.toString(),
    } : undefined,
    transfers: activity.transfers?.slice(0, 20).map(formatTransfer),
    swaps: activity.swaps?.slice(0, 20).map(formatSwap),
  };
}

function formatTransfer(t: any) {
  return {
    from: t.from,
    to: t.to,
    amount: t.amountFormatted ?? t.amount?.toString(),
    txHash: t.txHash,
    block: t.blockNumber?.toString(),
  };
}

function formatSwap(s: any) {
  return {
    sender: s.sender,
    amount0: s.amount0?.toString(),
    amount1: s.amount1?.toString(),
    txHash: s.txHash,
    block: s.blockNumber?.toString(),
  };
}
