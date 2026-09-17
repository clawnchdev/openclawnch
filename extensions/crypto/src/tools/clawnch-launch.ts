/**
 * Clawnch Launch Tool — deploy tokens via the Clawnch launchpad
 *
 * Base (default): the verified deploy API (two-step challenge) via Clanker —
 * transaction approval goes through ClawnchConnect.
 *
 * Robinhood Chain (chain: "robinhood"): Bags.fm-backed launch through the
 * Clawnch launch router. Two paths:
 *   ticket  — POST /api/robinhood/ticket → the agent signs and pays for the
 *             launch() transaction itself (verified-agent launch)
 *   deposit — the agent sends ETH to the router's deposit address and the
 *             platform deploys on its behalf (POST /api/robinhood/launch)
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import { requireWalletClient, requirePublicClient, getWalletState } from '../services/walletconnect-service.js';
import { validateLaunch } from '../services/safety-service.js';
import { getCredentialVault } from '../services/credential-vault.js';
import {
  resolveClawnchChainKey,
  explorerTxUrl,
  explorerAddressUrl,
  tradeUrl,
  type ClawnchChainKey,
} from '../lib/contract-registry.js';
import * as rh from '../lib/robinhood-api.js';
import { formatEther } from 'viem';

const CHAINS = ['base', 'robinhood'] as const;
const MODES = ['ticket', 'deposit'] as const;

const ClawnchLaunchSchema = Type.Object({
  name: Type.String({
    description: 'Token name (e.g. "Lobster Coin"). Max 32 characters on Robinhood Chain.',
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
  chain: Type.Optional(stringEnum(CHAINS, {
    description:
      'Chain to launch on: "base" (Clanker, default) or "robinhood" (Robinhood Chain via Bags.fm). ' +
      'Robinhood Chain launches need a registered agent API key.',
  })),
  mode: Type.Optional(stringEnum(MODES, {
    description:
      'Robinhood Chain launches only. "ticket" (default): you sign and pay for the launch transaction ' +
      '(agent-verified launch). "deposit": send ETH to the Clawnch deposit address and the platform deploys for you.',
  })),
  deposit_tx_hash: Type.Optional(Type.String({
    description:
      'Robinhood Chain deposit mode only: the 0x… hash of an ETH transfer you already sent to the deposit address.',
  })),
  dry_run: Type.Optional(Type.Boolean({
    description:
      'Robinhood Chain only: return the launch plan (deposit address, required ETH, calldata) without sending a transaction.',
  })),
  vault_percentage: Type.Optional(Type.Number({
    description: 'Base only. Percentage of supply to lock in vault (1-90%). Locked for 7+ days.',
  })),
  dev_buy_eth: Type.Optional(Type.String({
    description: 'Base only. ETH amount for dev buy at launch (e.g. "0.01"). Tokens sent to your wallet.',
  })),
  bypass_rate_limit: Type.Optional(Type.Boolean({
    description: 'Base only. Burn 10,000 $CLAWNCH to bypass the 1-launch-per-hour rate limit',
  })),
});

export function createClawnchLaunchTool() {
  return {
    name: 'clawnch_launch',
    label: 'Clawnch Launch',
    ownerOnly: true,
    description:
      'Deploy a new ERC-20 token via the Clawnch launchpad. ' +
      'Base (default) launches go through Clanker/Uniswap V4 — vaults, dev buys and the ' +
      '$CLAWNCH burn rate-limit bypass only exist there. ' +
      'Robinhood Chain launches (chain: "robinhood") go through the Clawnch launch router and ' +
      'Bags.fm: ticket mode has you sign and pay the launch transaction as a verified agent, ' +
      'deposit mode sends ETH and lets the platform deploy. ' +
      'Requires a connected wallet and a Clawnch agent API key. ' +
      'Base rate limit: 1 launch per hour (bypass by burning 10K $CLAWNCH). ' +
      '80% of trading fees go to you, 20% to the platform on both chains.',
    parameters: ClawnchLaunchSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;

      const state = getWalletState();
      if (!state.connected) {
        return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
      }

      const chain = resolveLaunchChain(params);
      if (!chain) {
        const requested = readStringParam(params, 'chain');
        return errorResult(
          `Unknown chain "${requested}". Supported launch chains: ${CHAINS.join(', ')}.`,
        );
      }

      if (chain === 'robinhood') {
        return handleRobinhoodLaunch(params, state.address!);
      }

      // Robinhood-Chain-only parameters must not be silently ignored on Base.
      const rhOnly = readStringParam(params, 'mode')
        ?? readStringParam(params, 'deposit_tx_hash')
        ?? (params.dry_run === true ? 'dry_run' : undefined);
      if (rhOnly !== undefined) {
        return errorResult(
          `"${rhOnly}" is a Robinhood Chain launch option. Pass chain: "robinhood" to use it, ` +
          'or remove it for a Base (Clanker) launch.',
        );
      }

      return handleBaseLaunch(params, state.address!);
    },
  };
}

// ─── Chain resolution ─────────────────────────────────────────────────────

/**
 * Explicit `chain` param wins. Otherwise honor LAUNCH_CHAIN (same env var the
 * Clawnch backend uses) and fall back to Base, which is the historical default.
 */
function resolveLaunchChain(params: Record<string, unknown>): ClawnchChainKey | null {
  const requested = readStringParam(params, 'chain');
  if (requested) {
    return resolveClawnchChainKey(requested) ?? null;
  }
  const fromEnv = resolveClawnchChainKey(process.env.LAUNCH_CHAIN || process.env.CLAWNCH_LAUNCH_CHAIN);
  return fromEnv ?? 'base';
}

// ─── Base path (Clanker — unchanged behavior) ─────────────────────────────

async function handleBaseLaunch(params: Record<string, unknown>, address: string) {
  const apiKey = getCredentialVault().getSecret('clawnch.launcherApiKey', 'clawnch-launch');
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
  const vaultPercentageRaw = readNumberParam(params, 'vault_percentage');
  const vaultPercentage = vaultPercentageRaw !== undefined
    ? Math.max(1, Math.min(90, Math.round(vaultPercentageRaw)))
    : undefined;
  const devBuyEth = readStringParam(params, 'dev_buy_eth');
  const bypassRateLimit = params.bypass_rate_limit === true;

  // Validate
  if (symbol.length > 10) {
    return errorResult('Symbol must be 10 characters or less.');
  }

  // Pre-flight safety: check balance for gas + dev buy
  try {
    const safety = await validateLaunch({
      devBuyEth: devBuyEth ? parseFloat(devBuyEth) : undefined,
    });
    if (!safety.safe) {
      return errorResult(
        `Launch blocked by safety checks:\n` +
        safety.blockers.map(b => `  ✗ ${b}`).join('\n')
      );
    }
  } catch (err) {
    // Safety check infrastructure failure — log but don't block the launch.
    console.warn('[clawnch-launch] Safety pre-flight failed, proceeding without validation:', err instanceof Error ? err.message : String(err));
  }

  try {
    const { ClawnchApiDeployer } = await import('@clawnch/clawncher-sdk');
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const deployer = new ClawnchApiDeployer({
      apiKey,
      wallet,
      publicClient,
      apiBaseUrl: process.env.CLAWNCHER_API_URL || 'https://clawn.ch',
    });

    const deployOptions: any = {
      name,
      symbol,
      description,
      image,
      bypassRateLimit,
      // Attribute launches to openclawnch in the Clawnch index
      source: 'openclawnch',
    };

    if (vaultPercentage) {
      deployOptions.vault = {
        percentage: vaultPercentage,
        lockupDuration: 7 * 24 * 60 * 60, // 7 days minimum
        recipient: address,
      };
    }

    if (devBuyEth) {
      deployOptions.devBuy = {
        ethAmount: devBuyEth,
        recipient: address,
      };
    }

    const result = await deployer.deploy(deployOptions);

    return jsonResult({
      status: 'success',
      chain: 'base',
      chainId: 8453,
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
}

// ─── Robinhood Chain path (launch router + Bags.fm) ───────────────────────

async function handleRobinhoodLaunch(params: Record<string, unknown>, address: string) {
  const name = readStringParam(params, 'name', { required: true })!;
  const symbol = readStringParam(params, 'symbol', { required: true })!;
  const description = readStringParam(params, 'description');
  const image = readStringParam(params, 'image');
  const modeParam = readStringParam(params, 'mode') ?? 'ticket';
  const depositTxHash = readStringParam(params, 'deposit_tx_hash');
  const dryRun = params.dry_run === true;

  if (!MODES.includes(modeParam as (typeof MODES)[number])) {
    return errorResult(`Unknown mode "${modeParam}". Supported: ${MODES.join(', ')}.`);
  }
  const mode = modeParam as 'ticket' | 'deposit';

  if (symbol.length > 10) {
    return errorResult('Symbol must be 10 characters or less.');
  }
  if (name.length > 32) {
    return errorResult('Name must be 32 characters or less on Robinhood Chain.');
  }

  // Base/Clanker-only launch features — fail loudly instead of silently using Base.
  try {
    assertRhLaunchParamsSupported(params);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  const apiKey = getCredentialVault().getSecret('clawnch.launcherApiKey', 'clawnch-launch');
  if (!apiKey) {
    return errorResult(
      'Clawnch agent API key required for Robinhood Chain launches. Set CLAWNCHER_API_KEY env var ' +
      '(register at https://clawn.ch/agents — the key is bound to your wallet, and the launch ' +
      'must be signed by that same wallet).'
    );
  }

  try {
    return mode === 'deposit'
      ? await handleRobinhoodDeposit({ address, apiKey, name, symbol, description, image, depositTxHash, dryRun })
      : await handleRobinhoodTicket({ address, apiKey, name, symbol, description, image, dryRun });
  } catch (err) {
    return errorResult(
      `Robinhood Chain launch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Base-only parameters that have no Robinhood Chain equivalent. */
function assertRhLaunchParamsSupported(params: Record<string, unknown>) {
  if (readNumberParam(params, 'vault_percentage') !== undefined) {
    rh.rhNotSupported(
      'vault_percentage',
      'Bags.fm has no vault/lockup primitive — the whole supply is on the curve at launch.',
    );
  }
  if (readStringParam(params, 'dev_buy_eth') !== undefined) {
    rh.rhNotSupported(
      'dev_buy_eth',
      'The Clawnch launch router does not bundle a dev buy. Buy on bags.fm after launch instead.',
    );
  }
  if (params.bypass_rate_limit === true) {
    rh.rhNotSupported(
      'bypass_rate_limit',
      'The $CLAWNCH burn bypass is Base-only; Robinhood Chain launches are not rate limited.',
    );
  }
}

async function handleRobinhoodTicket(opts: {
  address: string;
  apiKey: string;
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  dryRun: boolean;
}) {
  const ticket = await rh.requestRhLaunchTicket({
    apiKey: opts.apiKey,
    agentWallet: opts.address,
    name: opts.name,
    symbol: opts.symbol,
    description: opts.description,
    image: opts.image,
  });

  const creationFeeWei = toBigInt(ticket.meta?.creationFeeWei, 0n);
  const base = {
    chain: 'robinhood',
    chainId: rh.RH_CHAIN_ID,
    mode: 'ticket' as const,
    name: opts.name,
    symbol: opts.symbol,
    agentWallet: opts.address,
    router: rh.RH_LAUNCH_ROUTER,
    creationFeeEth: formatEther(creationFeeWei),
    ticket: {
      nonce: ticket.ticket?.nonce,
      deadline: ticket.ticket?.deadline,
      feeRecipient: ticket.ticket?.feeRecipient,
    },
  };

  if (opts.dryRun) {
    return jsonResult({
      status: 'dry_run',
      ...base,
      transaction: {
        to: ticket.data.to,
        data: ticket.data.data,
        valueWei: String(ticket.data.value ?? '0x0'),
        chainId: ticket.data.chainId,
      },
      note: 'Ticket issued. Re-run without dry_run to sign and broadcast this launch() transaction.',
    });
  }

  const publicClient = await rh.getRhPublicClient();
  const safety = await checkRhBalance(opts.address, creationFeeWei);
  if (!safety.safe) {
    return errorResult(`Launch blocked by safety checks:\n${safety.blockers.map(b => `  ✗ ${b}`).join('\n')}`);
  }

  const txHash = await rh.sendRhTransaction(ticket.data);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== 'success') {
    return errorResult(
      `Launch transaction reverted on Robinhood Chain. Tx: ${txHash} — ${explorerTxUrl('robinhood', txHash)}`
    );
  }

  const confirmed = await rh.confirmRhLaunch({ apiKey: opts.apiKey, txHash });
  const launch = confirmed.launch;
  const tokenAddress = launch?.token;

  return jsonResult({
    status: 'success',
    ...base,
    txHash,
    tokenAddress,
    alreadyRecorded: confirmed.alreadyRecorded ?? false,
    tradeUrl: tokenAddress ? tradeUrl('robinhood', tokenAddress) : undefined,
    explorerUrl: tokenAddress ? explorerAddressUrl('robinhood', tokenAddress) : undefined,
    txUrl: explorerTxUrl('robinhood', txHash),
    note: 'Verified-agent launch recorded. Trading is live on Bags.fm (Robinhood Chain). ' +
      'Trading fees accrue in the token fee share — claim them with clawnch_fees.',
  });
}

async function handleRobinhoodDeposit(opts: {
  address: string;
  apiKey: string;
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  depositTxHash?: string;
  dryRun: boolean;
}) {
  // Path A: the ETH transfer already happened — hand the hash to the platform.
  if (opts.depositTxHash) {
    const submitted = await rh.submitRhDepositLaunch({
      apiKey: opts.apiKey,
      depositTxHash: opts.depositTxHash,
      agentWallet: opts.address,
      name: opts.name,
      symbol: opts.symbol,
      description: opts.description,
      image: opts.image,
    });
    const launch = submitted.launch;

    return jsonResult({
      status: 'success',
      chain: 'robinhood',
      chainId: rh.RH_CHAIN_ID,
      mode: 'deposit',
      name: opts.name,
      symbol: opts.symbol,
      depositTxHash: opts.depositTxHash,
      tokenAddress: launch?.token,
      deployTxHash: launch?.txHash,
      routerTxHash: launch?.routerTxHash,
      tradeUrl: launch?.token ? tradeUrl('robinhood', launch.token) : undefined,
      explorerUrl: launch?.token ? explorerAddressUrl('robinhood', launch.token) : undefined,
      txUrl: launch?.txHash ? explorerTxUrl('robinhood', launch.txHash) : undefined,
      note: 'Deposit launch recorded. Trading is live on Bags.fm (Robinhood Chain).',
    });
  }

  // Path B: read the deposit terms from the router + Bags factory.
  const publicClient = await rh.getRhPublicClient();
  const [depositAddress, creationFee] = await Promise.all([
    rh.readRhDepositAddress(publicClient),
    rh.readRhBagsCreationFee(publicClient),
  ]);
  const requiredWei = creationFee > rh.RH_DEPOSIT_MIN_WEI ? creationFee : rh.RH_DEPOSIT_MIN_WEI;

  if (opts.dryRun) {
    return jsonResult({
      status: 'dry_run',
      chain: 'robinhood',
      chainId: rh.RH_CHAIN_ID,
      mode: 'deposit',
      depositAddress,
      requiredEth: formatEther(requiredWei),
      requiredWei: String(requiredWei),
      next: `Send at least ${formatEther(requiredWei)} ETH from ${opts.address} to ${depositAddress}, ` +
        'then call clawnch_launch again with mode "deposit" and deposit_tx_hash set to that transaction hash.',
    });
  }

  const safety = await checkRhBalance(opts.address, 0n);
  if (!safety.safe) {
    return errorResult(`Launch blocked by safety checks:\n${safety.blockers.map(b => `  ✗ ${b}`).join('\n')}`);
  }

  // The deposit sender must be the registered agent wallet (server-side rule).
  const depositHash = await rh.sendRhTransaction({
    to: depositAddress,
    data: '0x',
    value: `0x${requiredWei.toString(16)}`,
    chainId: rh.RH_CHAIN_ID,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash, timeout: 120_000 });
  if (receipt.status !== 'success') {
    return errorResult(
      `Deposit transaction reverted. Tx: ${depositHash} — ${explorerTxUrl('robinhood', depositHash)}`
    );
  }

  const submitted = await rh.submitRhDepositLaunch({
    apiKey: opts.apiKey,
    depositTxHash: depositHash,
    agentWallet: opts.address,
    name: opts.name,
    symbol: opts.symbol,
    description: opts.description,
    image: opts.image,
  });
  const launch = submitted.launch;

  return jsonResult({
    status: 'success',
    chain: 'robinhood',
    chainId: rh.RH_CHAIN_ID,
    mode: 'deposit',
    name: opts.name,
    symbol: opts.symbol,
    depositAddress,
    depositTxHash: depositHash,
    depositEth: formatEther(requiredWei),
    tokenAddress: launch?.token,
    deployTxHash: launch?.txHash,
    routerTxHash: launch?.routerTxHash,
    tradeUrl: launch?.token ? tradeUrl('robinhood', launch.token) : undefined,
    explorerUrl: launch?.token ? explorerAddressUrl('robinhood', launch.token) : undefined,
    txUrl: launch?.txHash ? explorerTxUrl('robinhood', launch.txHash) : undefined,
    note: 'Deposit launch complete — the platform deployed through Bags.fm with your wallet as the fee claimer.',
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** ETH balance check against the Robinhood Chain RPC (not the Base client). */
async function checkRhBalance(
  address: string,
  requiredWei: bigint,
): Promise<{ safe: boolean; balanceWei: bigint; blockers: string[] }> {
  const gasBufferWei = 2_000_000_000_000_000n; // 0.002 ETH for RHC gas (Bags fee is separate)
  const needed = requiredWei + gasBufferWei;
  const publicClient = await rh.getRhPublicClient();
  const balanceWei: bigint = await publicClient.getBalance({ address: address as `0x${string}` });

  if (balanceWei < needed) {
    return {
      safe: false,
      balanceWei,
      blockers: [
        `Insufficient ETH on Robinhood Chain. Have ${formatEther(balanceWei)} ETH, ` +
        `need ~${formatEther(needed)} ETH (${formatEther(requiredWei)} launch fee/creation fee + ` +
        `${formatEther(gasBufferWei)} gas buffer).`,
      ],
    };
  }
  return { safe: true, balanceWei, blockers: [] };
}

function toBigInt(value: unknown, fallback: bigint): bigint {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    return BigInt(value as string);
  } catch {
    return fallback;
  }
}
