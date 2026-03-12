/**
 * WalletConnect Service — manages the WC session lifecycle as a plugin service.
 * 
 * This is the core security model: the agent never holds private keys.
 * Every write transaction goes through the user's phone wallet for approval,
 * unless a spending policy auto-approves it.
 * 
 * Supports three modes:
 * 1. WalletConnect — human approves from MetaMask/Rainbow/etc. (production)
 * 2. Private key — for headless testing (set CLAWNCHER_PRIVATE_KEY)
 * 3. Bankr — custodial wallet via Bankr Agent API (set BANKR_API_KEY)
 */

import type { Address } from 'viem';
import type {
  WalletConnectSigner,
  SpendingPolicy,
  SessionState,
  QueuedTransaction,
} from '@clawnch/sdk';
import type { TransactionRecord, WalletState } from '../lib/types.js';
import { wrapWithBuilderCode } from './builder-code.js';
import { hasKeychainWallet, loadAndDecrypt } from './keychain-wallet.js';

// ─── Singleton State ─────────────────────────────────────────────────────
// Using `any` for client types to avoid viem version conflicts between
// the local install and @clawnch/sdk's bundled viem types.
// All consumers receive the untyped client and pass it directly to
// external SDKs (ClawnchSwapper, etc.) — no intermediate `as any` casts
// are needed since the source is already untyped. If viem types align
// in the future, replace `any` with `WalletClient` / `PublicClient`.

/** viem WalletClient — untyped to avoid cross-package viem version conflicts */
let _walletClient: any = null;
/** viem PublicClient — untyped for the same reason */
let _publicClient: any = null;
let _wcSigner: WalletConnectSigner | null = null;
let _connectedAddress: Address | null = null;
let _mode: 'private_key' | 'walletconnect' | 'bankr' | 'none' = 'none';
let _transactionHistory: TransactionRecord[] = [];

// Bankr-specific state
let _bankrEvmAddress: string | null = null;
let _bankrSolAddress: string | null = null;
let _bankrClub: boolean = false;

// ─── Configuration ───────────────────────────────────────────────────────

interface WalletServiceConfig {
  privateKey?: string;
  walletConnectProjectId?: string;
  bankrApiKey?: string;
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
 * 3. Bankr API key (custodial wallet)
 */
let _initPromise: Promise<any> | null = null;

export async function initWalletService(config: WalletServiceConfig): Promise<{
  mode: 'private_key' | 'walletconnect' | 'bankr' | 'none';
  pairingUri?: string;
  address?: Address;
  solAddress?: string;
}> {
  // Mutex: prevent concurrent initialization which can create duplicate WC signers
  if (_initPromise) return _initPromise;
  _initPromise = _doInitWalletService(config);
  try {
    return await _initPromise;
  } finally {
    _initPromise = null;
  }
}

async function _doInitWalletService(config: WalletServiceConfig): Promise<{
  mode: 'private_key' | 'walletconnect' | 'bankr' | 'none';
  pairingUri?: string;
  address?: Address;
  solAddress?: string;
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

    // Wrap with ERC-8021 builder code attribution for Base transactions
    _walletClient = wrapWithBuilderCode(_walletClient, chain.id);

    _connectedAddress = account.address;
    _mode = 'private_key';

    return { mode: 'private_key', address: account.address };
  }

  // Mode 1b: Keychain-stored encrypted mnemonic (local wallet generation)
  // Same runtime path as private_key — identical walletClient, same _mode.
  // Only the key acquisition differs: Keychain + password vs raw env var.
  if (!config.privateKey && hasKeychainWallet()) {
    const walletPassword = process.env.CLAWNCHER_WALLET_PASSWORD;
    if (walletPassword) {
      try {
        const { account: keychainAccount } = await loadAndDecrypt(walletPassword);
        const { createWalletClient } = await import('viem');

        _walletClient = createWalletClient({
          account: keychainAccount,
          chain,
          transport: http(rpcUrl),
        });
        _walletClient = wrapWithBuilderCode(_walletClient, chain.id);
        _connectedAddress = keychainAccount.address;
        _mode = 'private_key';

        return { mode: 'private_key', address: keychainAccount.address };
      } catch (err) {
        // Wrong password or corrupted data — fall through to WalletConnect/Bankr
        console.warn(
          `[wallet] Keychain wallet decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Wallet exists but no password env var — can't unlock headlessly.
      // Interactive unlock (via onboarding/channel prompt) is handled separately.
      console.info(
        '[wallet] Keychain wallet found but CLAWNCHER_WALLET_PASSWORD not set — skipping auto-unlock. ' +
        'Set CLAWNCHER_WALLET_PASSWORD env var for headless mode, or use onboarding to unlock interactively.',
      );
    }
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
      _walletClient = wrapWithBuilderCode(_walletClient, chain.id);
      _connectedAddress = _wcSigner.address;
      _mode = 'walletconnect';
      return { mode: 'walletconnect', address: _connectedAddress ?? undefined };
    }

    if (uri) {
      _mode = 'walletconnect';
      return { mode: 'walletconnect', pairingUri: uri };
    }
  }

  // Mode 3: Bankr custodial wallet
  if (config.bankrApiKey) {
    try {
      const { getBankrUserInfo } = await import('./bankr-api.js');

      // KNOWN TRADE-OFF: We mutate process.env to make the Bankr API key
      // available to getBankrApiKey() (which reads from credential vault →
      // process.env). This is idempotent (guarded) and happens once at init.
      // TODO: Refactor bankr-api to accept an explicit key parameter instead
      // of reading from process.env, eliminating this env mutation.
      if (!process.env.BANKR_API_KEY) {
        process.env.BANKR_API_KEY = config.bankrApiKey;
      }

      const userInfo = await getBankrUserInfo();
      const { isBankrClubActive } = await import('./bankr-types.js');

      const evmWallet = userInfo.wallets.find(w => w.chain === 'evm');
      const solWallet = userInfo.wallets.find(w => w.chain === 'solana');

      _bankrEvmAddress = evmWallet?.address ?? null;
      _bankrSolAddress = solWallet?.address ?? null;
      _bankrClub = isBankrClubActive(userInfo);
      _connectedAddress = (_bankrEvmAddress as Address) ?? null;
      _mode = 'bankr';

      return {
        mode: 'bankr',
        address: _connectedAddress ?? undefined,
        solAddress: _bankrSolAddress ?? undefined,
      };
    } catch (err) {
      // Bankr init failed — fall through to none
      console.warn(`[wallet] Bankr init failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // No wallet configured
  _mode = 'none';
  return { mode: 'none' };
}

/**
 * Wait for WalletConnect session to be established (after wallet approval).
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
  _walletClient = wrapWithBuilderCode(_walletClient, _publicClient?.chain?.id);
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
    chainId: _mode === 'bankr' ? 8453 : (_publicClient ? (_publicClient as any).chain?.id ?? null : null),
    mode: _mode,
    policies: _wcSigner?.getPolicies() ?? [],
    wcState: _wcSigner?.getState() ?? null,
    bankrEvmAddress: _bankrEvmAddress ?? undefined,
    bankrSolAddress: _bankrSolAddress ?? undefined,
    bankrClub: _bankrClub || undefined,
  };
}

// ─── Bankr Mode Helpers ──────────────────────────────────────────────────

/**
 * Check if the wallet is in Bankr custodial mode.
 */
export function isBankrMode(): boolean {
  return _mode === 'bankr';
}

/**
 * Returns the appropriate execution context for tools that support both
 * local wallet and Bankr paths.
 */
export function requireBankrOrWallet(): { mode: 'bankr' } | { mode: 'local'; client: any } {
  if (_mode === 'bankr') {
    return { mode: 'bankr' };
  }
  if (_walletClient) {
    return { mode: 'local', client: _walletClient };
  }
  throw new Error(
    'No wallet connected. Use /connect or /connect_bankr to connect a wallet first.'
  );
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

/**
 * Get a wallet client that routes write transactions through MEV-protected RPCs
 * (Flashbots Protect, MEV Blocker) when available. Protects against sandwich
 * attacks and frontrunning by bypassing the public mempool.
 *
 * Only effective in private_key mode — WalletConnect transactions are broadcast
 * by the phone wallet (out of our control), and Bankr transactions are broadcast
 * by the Bankr API.
 *
 * Falls back to the regular wallet client if:
 * - MEV protection is disabled in RpcManager config
 * - No MEV RPCs are available for the current chain
 * - Mode is not private_key (WC, Bankr)
 */
export async function getMevWalletClient(): Promise<any> {
  const wallet = requireWalletClient();

  // MEV routing only works when we control transaction broadcasting (private_key mode).
  // WC mode: phone wallet broadcasts. Bankr mode: Bankr API broadcasts.
  if (_mode !== 'private_key') return wallet;

  try {
    const { getRpcManager } = await import('./rpc-provider.js');
    const rpcManager = getRpcManager();
    const chainId = _publicClient?.chain?.id ?? 8453;

    if (!rpcManager.isMevProtectionEnabled()) return wallet;

    const mevTransport = rpcManager.getMevTransport(chainId);
    if (!mevTransport) return wallet;

    const { createWalletClient } = await import('viem');
    const mevClient = createWalletClient({
      account: wallet.account,
      chain: _publicClient?.chain,
      transport: mevTransport,
    });

    return wrapWithBuilderCode(mevClient, chainId);
  } catch {
    // MEV client creation failed — fall back to regular wallet client
    return wallet;
  }
}

// ─── Disconnect ──────────────────────────────────────────────────────────

export async function disconnectWallet(): Promise<void> {
  if (_wcSigner) {
    await _wcSigner.disconnect();
  }
  _walletClient = null;
  _connectedAddress = null;
  _bankrEvmAddress = null;
  _bankrSolAddress = null;
  _bankrClub = false;
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
