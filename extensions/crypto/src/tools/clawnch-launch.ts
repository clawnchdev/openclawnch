/**
 * Clawnch Launch Tool — deploy tokens via the Clawnch launchpad
 * 
 * Uses the verified deploy API (two-step challenge) for safe, rate-limited launches.
 * Transaction approval goes through ClawnchConnect.
 */

import { Type } from '@sinclair/typebox';
import { jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { requireWalletClient, requirePublicClient, getWalletState } from '../services/walletconnect-service.js';

const ClawnchLaunchSchema = Type.Object({
  name: Type.String({
    description: 'Token name (e.g. "Lobster Coin")',
  }),
  symbol: Type.String({
    description: 'Token ticker symbol (e.g. "LOBSTR"). Max 10 characters.',
  }),
  description: Type.Optional(Type.String({
    description: 'Token description',
  })),
  image: Type.Optional(Type.String({
    description: 'Token logo — URL to an image or base64-encoded image data',
  })),
  vault_percentage: Type.Optional(Type.Number({
    description: 'Percentage of supply to lock in vault (1-90%). Locked for 7+ days.',
  })),
  dev_buy_eth: Type.Optional(Type.String({
    description: 'ETH amount for dev buy at launch (e.g. "0.01"). Tokens sent to your wallet.',
  })),
  bypass_rate_limit: Type.Optional(Type.Boolean({
    description: 'Burn 10,000 $CLAWNCH to bypass the 1-launch-per-hour rate limit',
  })),
});

export function createClawnchLaunchTool() {
  return {
    name: 'clawnch_launch',
    label: 'Clawnch Launch',
    ownerOnly: true,
    description:
      'Deploy a new ERC-20 token on Base via the Clawnch launchpad. ' +
      'Creates a Uniswap V4 pool with MEV protection and fee distribution. ' +
      'Requires a connected wallet and Clawnch API key. ' +
      'Rate limited to 1 launch per hour (bypass by burning 10K $CLAWNCH). ' +
      '80% of trading fees go to you, 20% to the platform.',
    parameters: ClawnchLaunchSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;

      const state = getWalletState();
      if (!state.connected) {
        return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
      }

      const apiKey = process.env.CLAWNCHER_API_KEY;
      if (!apiKey) {
        return errorResult(
          'Clawnch API key required for token launches. Set CLAWNCHER_API_KEY env var. ' +
          'Get one at https://clawn.ch/agents'
        );
      }

      const name = readStringParam(params, 'name', { required: true })!;
      const symbol = readStringParam(params, 'symbol', { required: true })!;
      const description = readStringParam(params, 'description');
      const image = readStringParam(params, 'image');
      const vaultPercentage = params.vault_percentage as number | undefined;
      const devBuyEth = readStringParam(params, 'dev_buy_eth');
      const bypassRateLimit = params.bypass_rate_limit as boolean | undefined;

      // Validate
      if (symbol.length > 10) {
        return errorResult('Symbol must be 10 characters or less.');
      }

      try {
        const { ClawnchApiDeployer } = await import('@clawnch/clawncher-sdk');
        const wallet = requireWalletClient();
        const publicClient = requirePublicClient();

        const deployer = new ClawnchApiDeployer({
          apiKey,
          wallet: wallet as any,
          publicClient: publicClient as any,
          apiBaseUrl: process.env.CLAWNCHER_API_URL || 'https://clawn.ch',
        });

        const deployOptions: any = {
          name,
          symbol,
          description,
          image,
          bypassRateLimit,
        };

        if (vaultPercentage) {
          deployOptions.vault = {
            percentage: vaultPercentage,
            lockupDuration: 7 * 24 * 60 * 60, // 7 days minimum
            recipient: state.address,
          };
        }

        if (devBuyEth) {
          deployOptions.devBuy = {
            ethAmount: devBuyEth,
            recipient: state.address,
          };
        }

        const result = await deployer.deploy(deployOptions);

        return jsonResult({
          status: 'success',
          name,
          symbol,
          txHash: result.txHash,
          tokenAddress: result.tokenAddress,
          clawnchUrl: `https://clawn.ch/token/${result.tokenAddress}`,
          clawnchBurned: result.clawnchBurned ? '10,000 $CLAWNCH' : undefined,
          burnTxHash: result.burnTxHash,
          note: 'Token deployed! Trading is live on Uniswap V4. ' +
            'MEV protection active for first 30 seconds.',
        });
      } catch (err) {
        return errorResult(`Launch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
