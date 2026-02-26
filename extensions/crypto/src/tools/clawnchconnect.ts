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
  addPolicy,
  removePolicy,
  clearPolicies,
} from '../services/walletconnect-service.js';

const ACTIONS = [
  'connect',
  'status',
  'disconnect',
  'send_tx',
  'set_policy',
  'sign_message',
] as const;

const ClawnchConnectSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'The action to perform',
  }),
  // connect
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

export function createClawnchConnectTool() {
  return {
    name: 'clawnchconnect',
    label: 'ClawnchConnect',
    ownerOnly: true,
    description:
      'Connect a mobile wallet for human-approved blockchain transactions. ' +
      'Actions: connect (pair wallet via QR), status (check connection), ' +
      'disconnect, send_tx (submit transaction for approval), ' +
      'set_policy (configure auto-approval rules in natural language), ' +
      'sign_message (request signature).',
    parameters: ClawnchConnectSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'connect':
          return handleConnect(params);
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

async function handleConnect(params: Record<string, unknown>) {
  const state = getWalletState();

  if (state.connected) {
    return jsonResult({
      status: 'already_connected',
      address: state.address,
      chainId: state.chainId,
      mode: state.mode,
    });
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
    const result = await initWalletService({
      privateKey,
      walletConnectProjectId: projectId,
      rpcUrl: process.env.CLAWNCHER_RPC_URL,
      network: (process.env.CLAWNCHER_NETWORK as 'mainnet' | 'sepolia') || 'mainnet',
      sessionPath: process.env.WALLETCONNECT_SESSION
        || `${process.env.HOME ?? ''}/.openclawnch/wc-session.json`,
    });

    if (result.mode === 'private_key') {
      return jsonResult({
        status: 'connected',
        mode: 'private_key',
        address: result.address,
        note: 'Using private key (headless mode). Transactions are auto-signed.',
      });
    }

    if (result.pairingUri) {
      // Generate QR for the channel
      let qrText = '';
      try {
        const { qrTerminal } = await import('@clawnch/sdk');
        qrText = qrTerminal(result.pairingUri);
      } catch {
        // QR generation failed, just show the URI
      }

      return textResult(
        `Scan this QR code with your wallet app (MetaMask, Rainbow, Coinbase Wallet, etc.):\n\n` +
        (qrText ? `${qrText}\n\n` : '') +
        `Or paste this URI manually:\n${result.pairingUri}\n\n` +
        `Waiting for you to approve the connection on your phone...`
      );
    }

    if (result.address) {
      return jsonResult({
        status: 'connected',
        mode: 'walletconnect',
        address: result.address,
        note: 'Session restored from previous connection.',
      });
    }

    return errorResult('Failed to establish wallet connection.');
  } catch (err) {
    return errorResult(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleStatus() {
  const state = getWalletState();

  if (!state.connected) {
    return jsonResult({
      status: 'disconnected',
      message: 'No wallet connected. Use action "connect" to pair a wallet.',
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

async function handleSendTx(params: Record<string, unknown>) {
  const signer = getWCSigner();
  if (!signer && !getWalletState().connected) {
    return errorResult('No wallet connected. Use action "connect" first.');
  }

  const to = readStringParam(params, 'to', { required: true })!;
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

  const signer = getWCSigner();
  if (!signer) {
    return errorResult('Message signing requires WalletConnect. Not available in private key mode.');
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
