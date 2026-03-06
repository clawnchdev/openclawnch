/**
 * ClawnchConnect Tool — wallet connection and transaction signing
 * 
 * The core security model. The agent never holds private keys.
 * Every transaction goes to the user's phone wallet for approval,
 * unless spending policies auto-approve it.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, textResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import {
  initWalletService,
  waitForWalletSession,
  disconnectWallet,
  getWalletState,
  getWCSigner,
  getTransactionHistory,
  addPolicy,
  removePolicy,
  clearPolicies,
  isBankrMode,
} from '../services/walletconnect-service.js';

const ACTIONS = [
  'connect',
  'status',
  'disconnect',
  'send_tx',
  'set_policy',
  'sign_message',
] as const;

const WALLETS = [
  'metamask',
  'rainbow',
  'coinbase',
  'trust',
  'zerion',
  'uniswap',
  'rabby',
  'bankr',
  'other',
] as const;

// Mobile wallet deep links — tappable on phone
const WALLET_DEEPLINKS: Record<string, string> = {
  metamask: 'https://metamask.app.link/wc?uri=',
  rainbow: 'https://rnbwapp.com/wc?uri=',
  coinbase: 'https://go.cb-w.com/wc?uri=',
  trust: 'https://link.trustwallet.com/wc?uri=',
  zerion: 'https://wallet.zerion.io/wc?uri=',
  uniswap: 'https://uniswap.org/app/wc?uri=',
};

// Desktop/browser extension wallets — need raw URI to paste
const DESKTOP_WALLETS = new Set(['rabby', 'other']);

const ClawnchConnectSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'The action to perform',
  }),
  // connect
  wallet: Type.Optional(stringEnum(WALLETS, {
    description: 'Which wallet app the user wants to connect. ASK THE USER which wallet they use before calling connect. Mobile: metamask, rainbow, coinbase, trust, zerion, uniswap. Desktop: rabby, other.',
  })),
  project_id: Type.Optional(Type.String({
    description: 'WalletConnect project ID (if not set via env)',
  })),
  // send_tx
  to: Type.Optional(Type.String({
    description: 'Target contract or wallet address (0x...)',
  })),
  value: Type.Optional(Type.String({
    description: 'ETH value to send (in ETH, e.g. "0.01")',
  })),
  data: Type.Optional(Type.String({
    description: 'Transaction calldata (hex)',
  })),
  summary: Type.Optional(Type.String({
    description: 'Human-readable description of the transaction',
  })),
  // set_policy
  policy: Type.Optional(Type.String({
    description: 'Spending policy in natural language, e.g. "approve under 0.05 ETH, max 10/hour"',
  })),
  // sign_message
  message: Type.Optional(Type.String({
    description: 'Message to sign',
  })),
});

/**
 * @param api - OpenClawPluginApi instance (optional). When provided, the connect
 *   action sends the WalletConnect link directly to the user via the channel,
 *   bypassing LLM summarization which tends to drop URLs.
 */
export function createClawnchConnectTool(api?: any) {
  return {
    name: 'clawnchconnect',
    label: 'ClawnchConnect',
    ownerOnly: true,
    description:
      'Connect a wallet for human-approved blockchain transactions. ' +
      'IMPORTANT: For the connect action, you MUST ask the user which wallet app they use BEFORE calling this tool, then pass it as the wallet parameter. ' +
      'Actions: connect (pair wallet — requires wallet param), status (check connection), ' +
      'disconnect, send_tx (submit transaction for approval), ' +
      'set_policy (configure auto-approval rules in natural language), ' +
      'sign_message (request signature).',
    parameters: ClawnchConnectSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'connect':
          return handleConnect(params, api);
        case 'status':
          return handleStatus();
        case 'disconnect':
          return handleDisconnect();
        case 'send_tx':
          return handleSendTx(params);
        case 'set_policy':
          return handleSetPolicy(params);
        case 'sign_message':
          return handleSignMessage(params);
        default:
          return errorResult(`Unknown action: ${action}`);
      }
    },
  };
}

// ─── Action Handlers ─────────────────────────────────────────────────────

async function handleConnect(params: Record<string, unknown>, api?: any) {
  const state = getWalletState();
  console.log(`[clawnchconnect:connect] state: connected=${state.connected} mode=${state.mode} address=${state.address}`);

  if (state.connected && state.address) {
    return jsonResult({
      status: 'already_connected',
      address: state.address,
      chainId: state.chainId,
      mode: state.mode,
      bankrEvmAddress: state.bankrEvmAddress,
      bankrSolAddress: state.bankrSolAddress,
    });
  }

  // Bankr wallet — simplified connect (no pairing URI)
  const wallet = readStringParam(params, 'wallet') || 'other';
  if (wallet === 'bankr') {
    const bankrApiKey = process.env.BANKR_API_KEY;
    if (!bankrApiKey) {
      return errorResult(
        'BANKR_API_KEY not set. Get a key at bankr.bot/api with Agent API enabled, ' +
        'then set: fly secrets set BANKR_API_KEY="bk_your_key" -a <your-app>'
      );
    }
    try {
      const result = await initWalletService({ bankrApiKey });
      if (result.mode === 'bankr') {
        return jsonResult({
          status: 'connected',
          mode: 'bankr',
          address: result.address,
          solAddress: result.solAddress,
          note: 'Connected via Bankr custodial wallet. Transactions execute server-side.',
        });
      }
      return errorResult('Bankr wallet initialization failed.');
    } catch (err) {
      return errorResult(`Bankr connect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const projectId = readStringParam(params, 'project_id')
    || process.env.WALLETCONNECT_PROJECT_ID;
  const privateKey = process.env.CLAWNCHER_PRIVATE_KEY;

  if (!projectId && !privateKey) {
    return errorResult(
      'No wallet configuration found. Set WALLETCONNECT_PROJECT_ID env var ' +
      'or pass project_id parameter to connect via WalletConnect. ' +
      'For testing, set CLAWNCHER_PRIVATE_KEY.'
    );
  }

  try {
    console.log(`[clawnchconnect:connect] Calling initWalletService (fresh)`);
    const result = await initWalletService({
      privateKey,
      walletConnectProjectId: projectId,
      rpcUrl: process.env.CLAWNCHER_RPC_URL,
      network: (process.env.CLAWNCHER_NETWORK as 'mainnet' | 'sepolia') || 'mainnet',
      sessionPath: process.env.WALLETCONNECT_SESSION
        || `${process.env.HOME ?? ''}/.openclawnch/wc-session.json`,
    });

    console.log(`[clawnchconnect:connect] initWalletService result: mode=${result.mode} hasUri=${!!result.pairingUri} hasAddress=${!!result.address}`);

    if (result.mode === 'private_key') {
      return jsonResult({
        status: 'connected',
        mode: 'private_key',
        address: result.address,
        note: 'Using private key (headless mode). Transactions are auto-signed.',
      });
    }

    if (result.pairingUri) {
      const wallet = readStringParam(params, 'wallet') || 'other';

      // Start background session wait. When the user approves in their wallet,
      // this resolves and sets _walletClient so subsequent tools can use it.
      // We don't await it here — the tool returns the link immediately,
      // and the session establishes in the background.
      waitForWalletSession(300_000)
        .then((session) => {
          console.log(`[clawnchconnect] Session established: ${session.address} (chain ${session.chainId})`);
          // Proactively confirm wallet pairing to the user
          if (api) {
            const sendFn = api.runtime?.channel?.telegram?.sendMessageTelegram;
            // Try to find the chat ID from the current context
            const chatId = params._chatId ?? params._senderId;
            if (sendFn && chatId) {
              sendFn(String(chatId),
                `Wallet connected!\n\nAddress: ${session.address.slice(0, 6)}...${session.address.slice(-4)}\nChain: ${session.chainId}\n\nYou're ready to trade. Try: "What's the price of ETH?" or "Show my balance"`,
                { accountId: 'default' }
              ).catch((err: any) => console.log(`[clawnchconnect] Failed to send confirmation: ${err}`));
            } else {
              api.logger?.info?.(`[clawnchconnect] Wallet connected: ${session.address} — no chatId available to send confirmation`);
            }
          }
        })
        .catch((err) => {
          console.log(`[clawnchconnect] Session wait failed: ${err instanceof Error ? err.message : String(err)}`);
        });

      return returnConnectLink(result.pairingUri, wallet);
    }

    if (result.address) {
      return jsonResult({
        status: 'connected',
        mode: 'walletconnect',
        address: result.address,
        note: 'Session restored from previous connection.',
      });
    }

    return errorResult('WalletConnect failed to generate a pairing link. The relay server may be down. Try again in a minute.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[clawnchconnect:connect] Error: ${msg}`);
    return errorResult(`Connection failed: ${msg}`);
  }
}

/**
 * Build a wallet-specific connect link and return it.
 * Mobile wallets get a tappable deep link. Desktop/extension wallets get the raw wc: URI to paste.
 */
function returnConnectLink(pairingUri: string, wallet: string) {
  const encodedUri = encodeURIComponent(pairingUri);

  if (DESKTOP_WALLETS.has(wallet)) {
    // Desktop/extension wallets — user copies the raw URI and pastes into wallet
    console.log(`[clawnchconnect] Desktop wallet "${wallet}" — returning raw URI`);
    return textResult(
      `Copy this connection code and paste it in your wallet's WalletConnect input:\n\n` +
      `${pairingUri}\n\n` +
      `Expires in 5 minutes.`
    );
  }

  // Mobile wallet — return tappable deep link
  const deepLinkBase = WALLET_DEEPLINKS[wallet];
  if (deepLinkBase) {
    const deepLink = `${deepLinkBase}${encodedUri}`;
    console.log(`[clawnchconnect] Deep link for "${wallet}" (${deepLink.length} chars)`);
    return textResult(deepLink);
  }

  // Unknown wallet — return raw URI with instructions
  console.log(`[clawnchconnect] Unknown wallet "${wallet}" — returning raw URI`);
  return textResult(
    `Copy this connection code and paste it in your wallet's WalletConnect scanner:\n\n` +
    `${pairingUri}\n\n` +
    `Expires in 5 minutes.`
  );
}

async function handleStatus() {
  const state = getWalletState();

  if (!state.connected) {
    return jsonResult({
      status: 'disconnected',
      message: 'No wallet connected. Use action "connect" to pair a wallet.',
    });
  }

  // Bankr mode: show both EVM and Solana addresses, Club status
  if (state.mode === 'bankr') {
    return jsonResult({
      status: 'connected',
      mode: 'bankr',
      evmAddress: state.bankrEvmAddress,
      solanaAddress: state.bankrSolAddress,
      bankrClub: state.bankrClub,
      chains: ['base', 'ethereum', 'polygon', 'unichain', 'solana'],
      security: 'Bankr Sentinel (server-side transaction screening)',
      note: 'Custodial wallet — transactions execute server-side. No phone approval needed.',
    });
  }

  // Try to get ETH balance
  let ethBalance: string | undefined;
  try {
    const { requirePublicClient } = await import('../services/walletconnect-service.js');
    const publicClient = requirePublicClient();
    const balance = await publicClient.getBalance({ address: state.address! });
    const { formatEther } = await import('viem');
    ethBalance = formatEther(balance);
  } catch {
    // Non-fatal
  }

  // Include recent transaction history
  const txHistory = getTransactionHistory();
  const recentTxs = txHistory.slice(-5).reverse().map(tx => ({
    status: tx.status,
    summary: tx.summary,
    hash: tx.hash,
    policyLabel: tx.policyLabel,
  }));

  return jsonResult({
    status: 'connected',
    address: state.address,
    chainId: state.chainId,
    mode: state.mode,
    ethBalance,
    policies: state.policies.map(p => ({
      label: p.label,
      maxValueEth: p.maxValueWei ? Number(p.maxValueWei) / 1e18 : 'unlimited',
      allowedContracts: p.allowedContracts?.length ?? 'any',
      maxPerHour: p.maxPerHour ?? 'unlimited',
      enabled: p.enabled !== false,
    })),
    recentTransactions: recentTxs.length > 0 ? recentTxs : undefined,
    transactionCount: txHistory.length || undefined,
  });
}

async function handleDisconnect() {
  const state = getWalletState();
  if (!state.connected) {
    return textResult('No wallet is currently connected.');
  }

  await disconnectWallet();
  return textResult(`Disconnected wallet ${state.address}. Session cleared.`);
}

// H4: Address validation helper
function isValidAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

async function handleSendTx(params: Record<string, unknown>) {
  const state = getWalletState();
  if (!state.connected) {
    return errorResult('No wallet connected. Use action "connect" first.');
  }

  // Bankr mode: submit via Bankr prompt API
  if (isBankrMode()) {
    const to = readStringParam(params, 'to', { required: true })!;
    // H4: Validate address
    if (!isValidAddress(to)) {
      return errorResult(`Invalid target address: "${to}". Must be a valid 0x... Ethereum address.`);
    }
    const valueStr = readStringParam(params, 'value');
    const summary = readStringParam(params, 'summary') || 'Transaction submitted by agent';

    try {
      const { bankrPromptAndPoll } = await import('../services/bankr-api.js');
      const prompt = valueStr
        ? `send ${valueStr} ETH to ${to}`
        : `send transaction to ${to}`;
      const result = await bankrPromptAndPoll(prompt, { timeoutMs: 60_000 });

      if (result.status === 'failed') {
        return errorResult(`Transaction failed: ${result.error ?? 'Unknown error'}`);
      }

      const txData = result.transactions?.[0];
      return jsonResult({
        status: 'sent',
        mode: 'bankr',
        hash: txData?.hash,
        summary,
        response: result.response,
      });
    } catch (err) {
      return errorResult(`Transaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const signer = getWCSigner();

  const to = readStringParam(params, 'to', { required: true })!;
  // H4: Validate address
  if (!isValidAddress(to)) {
    return errorResult(`Invalid target address: "${to}". Must be a valid 0x... Ethereum address.`);
  }
  const valueStr = readStringParam(params, 'value');
  const data = readStringParam(params, 'data');
  const summary = readStringParam(params, 'summary') || 'Transaction submitted by agent';

  try {
    const { parseEther } = await import('viem');
    const value = valueStr ? parseEther(valueStr) : undefined;

    if (signer) {
      // WalletConnect path — goes through policies + user approval
      const result = await signer.sendTransaction(
        {
          to: to as `0x${string}`,
          value,
          data: data as `0x${string}` | undefined,
        },
        {
          summary,
          estimatedGasCostEth: 'estimating...',
        },
      );

      return jsonResult({
        status: result.autoApproved ? 'auto_approved' : 'approved',
        hash: result.hash,
        policyLabel: result.policyLabel,
        summary,
      });
    } else {
      // Private key path — direct send
      const { requireWalletClient } = await import('../services/walletconnect-service.js');
      const wallet = requireWalletClient();
      const hash = await wallet.sendTransaction({
        to: to as `0x${string}`,
        value,
        data: data as `0x${string}` | undefined,
      });

      return jsonResult({
        status: 'sent',
        hash,
        summary,
        note: 'Sent directly (private key mode, no approval required)',
      });
    }
  } catch (err) {
    return errorResult(`Transaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleSetPolicy(params: Record<string, unknown>) {
  const policyInput = readStringParam(params, 'policy', { required: true })!;

  try {
    const { parsePolicies, formatPolicy } = await import('@clawnch/sdk');
    const result = parsePolicies(policyInput);

    if (result.clearAll) {
      clearPolicies();
      return textResult('All spending policies cleared. Every transaction will require manual approval.');
    }

    if (result.unrecognized.length > 0 && result.policies.length === 0) {
      return errorResult(
        `Could not parse policy: "${policyInput}"\n\n` +
        'Examples:\n' +
        '  "approve under 0.05 ETH"\n' +
        '  "auto-approve below 0.01 ETH, max 10/hour"\n' +
        '  "allow only 0xABC...DEF"\n' +
        '  "no auto-approve" (clear all)'
      );
    }

    // Add each parsed policy
    for (const policy of result.policies) {
      addPolicy(policy);
    }

    const formatted = result.policies.map(p => formatPolicy(p));

    return jsonResult({
      status: 'policies_updated',
      added: formatted,
      unrecognized: result.unrecognized.length > 0 ? result.unrecognized : undefined,
      allPolicies: getWalletState().policies.map(p => formatPolicy(p)),
    });
  } catch (err) {
    return errorResult(`Failed to set policy: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleSignMessage(params: Record<string, unknown>) {
  const message = readStringParam(params, 'message', { required: true })!;

  // Bankr mode: use Bankr sign endpoint
  if (isBankrMode()) {
    try {
      const { bankrSign } = await import('../services/bankr-api.js');
      const result = await bankrSign({
        signatureType: 'personal_sign',
        message,
      });
      return jsonResult({
        status: 'signed',
        signature: result.signature,
        signer: result.signer,
        mode: 'bankr',
        message,
      });
    } catch (err) {
      return errorResult(`Bankr signing failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const signer = getWCSigner();
  if (!signer) {
    return errorResult('Message signing requires WalletConnect or Bankr. Not available in private key mode.');
  }

  try {
    const result = await signer.signMessage(message);
    return jsonResult({
      status: 'signed',
      signature: result.signature,
      message,
    });
  } catch (err) {
    return errorResult(`Signing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
