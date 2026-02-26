/**
 * WalletConnect Service — manages the WC session lifecycle as a plugin service.
 * 
 * This is the core security model: the agent never holds private keys.
 * Every write transaction goes through the user's phone wallet for approval,
 * unless a spending policy auto-approves it.
 * 
 * Supports two modes:
 * 1. WalletConnect — human approves from MetaMask/Rainbow/etc. (production)
 * 2. Private key — for headless testing (set CLAWNCHER_PRIVATE_KEY)
 */

import type { Address } from 'viem';
import type {
  WalletConnectSigner,
  SpendingPolicy,
  SessionState,
  QueuedTransaction,
} from '@clawnch/sdk';
import type { TransactionRecord, WalletState } from '../lib/types.js';

// ─── Singleton State ─────────────────────────────────────────────────────
// Using `any` for client types to avoid viem version conflicts between
// the local install and @clawnch/sdk's bundled viem types.

let _walletClient: any = null;
let _publicClient: any = null;
let _wcSigner: WalletConnectSigner | null = null;
let _connectedAddress: Address | null = null;
let _mode: 'private_key' | 'walletconnect' | 'none' = 'none';
let _transactionHistory: TransactionRecord[] = [];

// ─── Configuration ───────────────────────────────────────────────────────

interface WalletServiceConfig {
  privateKey?: string;
  walletConnectProjectId?: string;
  rpcUrl?: string;
  network?: 'mainnet' | 'sepolia';
  sessionPath?: string;
  policies?: SpendingPolicy[];
  onSessionChange?: (state: SessionState) => void;
  onTransactionQueued?: (tx: QueuedTransaction) => void;
  onTransactionApproved?: (tx: QueuedTransaction, hash: string) => void;
  onTransactionRejected?: (tx: QueuedTransaction, reason: string) => void;
}

// ─── Initialization ──────────────────────────────────────────────────────

/**
 * Initialize the wallet service. Called at gateway startup.
 * 
 * Priority:
 * 1. Private key env var (headless/testing)
 * 2. WalletConnect (production)
 */
export async function initWalletService(config: WalletServiceConfig): Promise<{
  mode: 'private_key' | 'walletconnect' | 'none';
  pairingUri?: string;
  address?: Address;
}> {
  const { createPublicClient, http } = await import('viem');
  const { base, baseSepolia } = await import('viem/chains');

  const chain = config.network === 'sepolia' ? baseSepolia : base;
  const rpcUrl = config.rpcUrl || undefined; // let viem use default

  // Create public client
  _publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  // Mode 1: Private key (headless/testing)
  if (config.privateKey) {
    const { createWalletClient } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');

    const account = privateKeyToAccount(config.privateKey as `0x${string}`);
    _walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

    _connectedAddress = account.address;
    _mode = 'private_key';

    return { mode: 'private_key', address: account.address };
  }

  // Mode 2: WalletConnect
  if (config.walletConnectProjectId) {
    const { WalletConnectSigner } = await import('@clawnch/sdk');

    const sessionPath = config.sessionPath
      || `${process.env.HOME ?? ''}/.openclawnch/wc-session.json`;

    _wcSigner = new WalletConnectSigner({
      projectId: config.walletConnectProjectId,
      chain,
      sessionPath,
      policies: config.policies ?? [],
      metadata: {
        name: 'OpenClawnch',
        description: 'OpenClaw for crypto — AI assistant with DeFi capabilities',
        url: 'https://clawn.ch',
        icons: ['https://clawn.ch/icon.png'],
      },
      requestTimeout: 180_000, // 3 minutes for tx approval
      onSessionChange: (state) => {
        if (state.status === 'connected') {
          _connectedAddress = state.address;
        } else if (state.status === 'disconnected' || state.status === 'expired') {
          _connectedAddress = null;
          _walletClient = null;
        }
        config.onSessionChange?.(state);
      },
      onTransactionQueued: (tx) => {
        _transactionHistory.push({
          id: tx.id,
          status: 'pending',
          summary: tx.context?.summary ?? 'Transaction submitted',
          timestamp: tx.queuedAt,
          to: tx.transaction.to,
          value: tx.transaction.value?.toString(),
        });
        config.onTransactionQueued?.(tx);
      },
      onTransactionApproved: (tx, hash) => {
        const record = _transactionHistory.find(r => r.id === tx.id);
        if (record) {
          record.status = tx.policyLabel ? 'auto_approved' : 'approved';
          record.hash = hash;
          record.policyLabel = tx.policyLabel;
        }
        config.onTransactionApproved?.(tx, hash);
      },
      onTransactionRejected: (tx, reason) => {
        const record = _transactionHistory.find(r => r.id === tx.id);
        if (record) {
          record.status = 'rejected';
        }
        config.onTransactionRejected?.(tx, reason);
      },
    });

    const { uri, restored } = await _wcSigner.connect();

    if (restored) {
      // Session restored from disk — create wallet client immediately
      _walletClient = await _wcSigner.toWalletClient(_publicClient);
      _connectedAddress = _wcSigner.address;
      _mode = 'walletconnect';
      return { mode: 'walletconnect', address: _connectedAddress ?? undefined };
    }

    if (uri) {
      _mode = 'walletconnect';
      return { mode: 'walletconnect', pairingUri: uri };
    }
  }

  // No wallet configured
  _mode = 'none';
  return { mode: 'none' };
}

/**
 * Wait for WalletConnect session to be established (after QR scan).
 */
export async function waitForWalletSession(timeoutMs = 300_000): Promise<{
  address: Address;
  chainId: number;
}> {
  if (!_wcSigner) {
    throw new Error('WalletConnect not initialized. Set WALLETCONNECT_PROJECT_ID.');
  }

  const result = await _wcSigner.waitForSession(timeoutMs);
  _walletClient = await _wcSigner.toWalletClient(_publicClient!);
  _connectedAddress = result.address;

  return result;
}

// ─── Getters ─────────────────────────────────────────────────────────────

export function getWalletClient(): any {
  return _walletClient;
}

export function getPublicClient(): any {
  return _publicClient;
}

export function getWCSigner(): WalletConnectSigner | null {
  return _wcSigner;
}

export function getWalletState(): WalletState {
  return {
    connected: _connectedAddress !== null,
    address: _connectedAddress,
    chainId: _publicClient ? (_publicClient as any).chain?.id ?? null : null,
    mode: _mode,
    policies: _wcSigner?.getPolicies() ?? [],
    wcState: _wcSigner?.getState() ?? null,
  };
}

export function getTransactionHistory(): TransactionRecord[] {
  return [..._transactionHistory];
}

export function requireWalletClient(): any {
  if (!_walletClient) {
    throw new Error(
      'No wallet connected. Use the clawnchconnect tool with action "connect" first, ' +
      'or set CLAWNCHER_PRIVATE_KEY for headless mode.'
    );
  }
  return _walletClient;
}

export function requirePublicClient(): any {
  if (!_publicClient) {
    throw new Error('Public client not initialized. The wallet service must be started first.');
  }
  return _publicClient;
}

// ─── Disconnect ──────────────────────────────────────────────────────────

export async function disconnectWallet(): Promise<void> {
  if (_wcSigner) {
    await _wcSigner.disconnect();
  }
  _walletClient = null;
  _connectedAddress = null;
  _mode = 'none';
}

// ─── Policy Management ───────────────────────────────────────────────────

export function addPolicy(policy: SpendingPolicy): void {
  _wcSigner?.addPolicy(policy);
}

export function removePolicy(label: string): boolean {
  return _wcSigner?.removePolicy(label) ?? false;
}

export function clearPolicies(): void {
  const policies = _wcSigner?.getPolicies() ?? [];
  for (const p of policies) {
    _wcSigner?.removePolicy(p.label);
  }
}
