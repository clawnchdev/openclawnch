/**
 * Veil.cash Service — privacy pool integration for private transfers on Base.
 *
 * Uses @veil-cash/sdk for ZK proof generation and relayer submission.
 * Supports ETH and USDC privacy pools.
 *
 * SDK provides:
 *   - Keypair.fromSigner() — derive privacy keypair from Bankr sign API
 *   - deposit() — deposit into privacy pool (public → private)
 *   - withdraw() — withdraw from privacy pool (private → public)
 *   - transfer() — private-to-private transfer
 *   - balance() — check shielded balance
 *
 * Requires: @veil-cash/sdk npm package (optional dep, ~50KB).
 */

import { getWalletState, requireWalletClient } from './walletconnect-service.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface VeilBalance {
  asset: string;
  shielded: string;
  pendingDeposits: string;
  pendingWithdrawals: string;
}

export interface VeilTxResult {
  action: string;
  asset: string;
  amount: string;
  txHash: string | null;
  noteHash: string | null;
  status: string;
}

export interface VeilDepositResult extends VeilTxResult {
  action: 'deposit';
  note: string; // encrypted note for withdrawal
}

export interface VeilWithdrawResult extends VeilTxResult {
  action: 'withdraw';
  recipient: string;
  relayerFee: string | null;
}

// ── Supported Assets ────────────────────────────────────────────────────────

const SUPPORTED_ASSETS: Record<string, { address: string; decimals: number; poolSize: string }> = {
  ETH: {
    address: '0x0000000000000000000000000000000000000000',
    decimals: 18,
    poolSize: '0.1', // pool denomination in ETH
  },
  USDC: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    poolSize: '100', // pool denomination in USDC
  },
};

// ── Service ─────────────────────────────────────────────────────────────────

export class VeilService {
  private sdk: any = null;
  private keypair: any = null;
  private keypairAddress: string | null = null; // Track which wallet derived the keypair

  /**
   * Check if the Veil SDK is installed.
   */
  async isAvailable(): Promise<boolean> {
    try {
      // @ts-expect-error — optional dependency, not always installed
      await import('@veil-cash/sdk');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the SDK instance, lazily loaded.
   */
  private async getSdk(): Promise<any> {
    if (this.sdk) return this.sdk;
    try {
      // @ts-expect-error — optional dependency, not always installed
      this.sdk = await import('@veil-cash/sdk');
      return this.sdk;
    } catch {
      throw new Error(
        '@veil-cash/sdk not installed. Install with: pnpm add @veil-cash/sdk\n' +
        'This package provides ZK proof generation for private transactions on Base.',
      );
    }
  }

  /**
   * Derive a privacy keypair from the connected wallet's signer.
   * Invalidates the cached keypair if the wallet address has changed.
   */
  private async getKeypair(): Promise<any> {
    const state = getWalletState();
    const currentAddress = state.address ?? null;

    // Invalidate keypair if wallet changed
    if (this.keypair && this.keypairAddress !== currentAddress) {
      this.keypair = null;
      this.keypairAddress = null;
    }

    if (this.keypair) return this.keypair;

    const sdk = await this.getSdk();
    const walletClient = requireWalletClient();

    // Keypair.fromSigner works with any EIP-191 signer (including Bankr)
    this.keypair = await sdk.Keypair.fromSigner(walletClient);
    this.keypairAddress = currentAddress;
    return this.keypair;
  }

  getSupportedAssets() {
    return Object.entries(SUPPORTED_ASSETS).map(([symbol, info]) => ({
      symbol,
      address: info.address,
      poolDenomination: info.poolSize,
    }));
  }

  resolveAsset(input: string): { symbol: string; address: string; decimals: number; poolSize: string } | null {
    const upper = input.toUpperCase();
    const asset = SUPPORTED_ASSETS[upper];
    if (!asset) return null;
    return { symbol: upper, ...asset };
  }

  // ── Deposit (Public → Private) ─────────────────────────────────────

  async deposit(
    asset: string,
    amount: string,
  ): Promise<VeilDepositResult> {
    const sdk = await this.getSdk();
    const keypair = await this.getKeypair();
    const assetInfo = this.resolveAsset(asset);
    if (!assetInfo) throw new Error(`Unsupported asset: ${asset}. Supported: ETH, USDC`);

    const state = getWalletState();
    if (!state.connected || !state.address) {
      throw new Error('No wallet connected.');
    }

    const walletClient = requireWalletClient();

    const result = await sdk.deposit({
      keypair,
      asset: assetInfo.address,
      amount,
      signer: walletClient,
      chainId: 8453,
    });

    return {
      action: 'deposit',
      asset: assetInfo.symbol,
      amount,
      txHash: result.txHash ?? null,
      noteHash: result.noteHash ?? null,
      note: result.note ?? '',
      status: result.txHash ? 'confirmed' : 'pending',
    };
  }

  // ── Withdraw (Private → Public) ────────────────────────────────────

  async withdraw(
    asset: string,
    amount: string,
    recipient: string,
  ): Promise<VeilWithdrawResult> {
    const sdk = await this.getSdk();
    const keypair = await this.getKeypair();
    const assetInfo = this.resolveAsset(asset);
    if (!assetInfo) throw new Error(`Unsupported asset: ${asset}. Supported: ETH, USDC`);

    const result = await sdk.withdraw({
      keypair,
      asset: assetInfo.address,
      amount,
      recipient,
      chainId: 8453,
      useRelayer: true, // Use relayer for privacy (hides withdrawal address)
    });

    return {
      action: 'withdraw',
      asset: assetInfo.symbol,
      amount,
      recipient,
      txHash: result.txHash ?? null,
      noteHash: result.noteHash ?? null,
      relayerFee: result.relayerFee ?? null,
      status: result.txHash ? 'confirmed' : 'submitted_to_relayer',
    };
  }

  // ── Private Transfer ───────────────────────────────────────────────

  async transfer(
    asset: string,
    amount: string,
    recipientPublicKey: string,
  ): Promise<VeilTxResult> {
    const sdk = await this.getSdk();
    const keypair = await this.getKeypair();
    const assetInfo = this.resolveAsset(asset);
    if (!assetInfo) throw new Error(`Unsupported asset: ${asset}. Supported: ETH, USDC`);

    const result = await sdk.transfer({
      keypair,
      asset: assetInfo.address,
      amount,
      recipientPublicKey,
      chainId: 8453,
    });

    return {
      action: 'transfer',
      asset: assetInfo.symbol,
      amount,
      txHash: result.txHash ?? null,
      noteHash: result.noteHash ?? null,
      status: result.txHash ? 'confirmed' : 'pending',
    };
  }

  // ── Balance ────────────────────────────────────────────────────────

  async getBalance(asset?: string): Promise<VeilBalance[]> {
    const sdk = await this.getSdk();
    const keypair = await this.getKeypair();

    const assets = asset
      ? [this.resolveAsset(asset)].filter(Boolean)
      : Object.keys(SUPPORTED_ASSETS).map(s => this.resolveAsset(s)).filter(Boolean);

    const balances: VeilBalance[] = [];
    for (const a of assets) {
      if (!a) continue;
      try {
        const bal = await sdk.getBalance({
          keypair,
          asset: a.address,
          chainId: 8453,
        });
        balances.push({
          asset: a.symbol,
          shielded: bal.shielded ?? '0',
          pendingDeposits: bal.pendingDeposits ?? '0',
          pendingWithdrawals: bal.pendingWithdrawals ?? '0',
        });
      } catch {
        balances.push({
          asset: a.symbol,
          shielded: '0',
          pendingDeposits: '0',
          pendingWithdrawals: '0',
        });
      }
    }

    return balances;
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: VeilService | null = null;

export function getVeilService(): VeilService {
  if (!_instance) {
    _instance = new VeilService();
  }
  return _instance;
}

export function resetVeilService(): void {
  _instance = null;
}
