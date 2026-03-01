/**
 * Shared types for the OpenClawnch crypto extension.
 */

import type { WalletClient, PublicClient, Transport, Chain, Account, Address, Hash } from 'viem';
import type { WalletConnectSigner, SpendingPolicy, SessionState } from '@clawnch/sdk';

// ─── Plugin Configuration ────────────────────────────────────────────────

export interface CryptoPluginConfig {
  /** WalletConnect project ID (get one at cloud.walletconnect.com) */
  walletConnectProjectId?: string;
  /** Private key for headless/testing mode (takes precedence over WalletConnect) */
  privateKey?: string;
  /** RPC URL for Base (default: public RPC) */
  rpcUrl?: string;
  /** Network: 'mainnet' or 'sepolia' (default: 'mainnet') */
  network?: 'mainnet' | 'sepolia';
  /** Clawnch API URL (default: https://clawn.ch) */
  apiUrl?: string;
  /** Clawnch API key for verified agent operations */
  apiKey?: string;
  /** WalletConnect session persistence path */
  sessionPath?: string;
  /** Initial spending policies (natural language or structured) */
  policies?: string | SpendingPolicy[];
  /** DexScreener API base URL */
  dexScreenerUrl?: string;
  /** CoinGecko API key (optional, for higher rate limits) */
  coinGeckoApiKey?: string;
}

// ─── Wallet State ────────────────────────────────────────────────────────

export interface WalletState {
  /** Whether any wallet is connected (private key or WalletConnect) */
  connected: boolean;
  /** Connected wallet address */
  address: Address | null;
  /** Chain ID */
  chainId: number | null;
  /** Connection mode */
  mode: 'private_key' | 'walletconnect' | 'bankr' | 'none';
  /** Active spending policies */
  policies: SpendingPolicy[];
  /** WalletConnect session state (null if using private key) */
  wcState: SessionState | null;
  /** Bankr EVM address (only in bankr mode) */
  bankrEvmAddress?: string;
  /** Bankr Solana address (only in bankr mode) */
  bankrSolAddress?: string;
  /** Bankr Club membership status */
  bankrClub?: boolean;
}

// ─── Tool Result Helpers ─────────────────────────────────────────────────

export interface ToolResult<T = unknown> {
  content: Array<{ type: 'text'; text: string }>;
  data?: T;
}

// ─── Transaction History ─────────────────────────────────────────────────

export interface TransactionRecord {
  id: string;
  hash?: Hash;
  status: 'approved' | 'rejected' | 'auto_approved' | 'pending';
  policyLabel?: string;
  summary: string;
  timestamp: number;
  value?: string;
  to?: Address;
}

// ─── Market Data ─────────────────────────────────────────────────────────

export interface TokenPrice {
  address: Address;
  symbol: string;
  name: string;
  priceUsd: number;
  priceEth?: number;
  change24h: number;
  volume24h: number;
  liquidity: number;
  marketCap?: number;
  source: 'dexscreener' | 'coingecko' | 'onchain';
}

export interface PortfolioToken {
  address: Address;
  symbol: string;
  name: string;
  balance: string;
  balanceFormatted: string;
  valueUsd?: number;
  priceUsd?: number;
}

export interface PortfolioSummary {
  address: Address;
  ethBalance: string;
  ethValueUsd: number;
  tokens: PortfolioToken[];
  totalValueUsd: number;
}
