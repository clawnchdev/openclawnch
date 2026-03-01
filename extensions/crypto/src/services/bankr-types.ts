/**
 * Bankr Agent API — TypeScript interfaces
 *
 * Covers all request/response shapes for api.bankr.bot endpoints:
 *   - User info (GET /agent/me)
 *   - Balances (GET /agent/balances)
 *   - Prompt + job polling (POST /agent/prompt, GET /agent/job/{id})
 *   - Sign (POST /agent/sign)
 *   - Submit (POST /agent/submit)
 *   - Token deploy (POST /token-launches/deploy)
 */

// ─── Chains ──────────────────────────────────────────────────────────────

export type BankrChain = 'base' | 'mainnet' | 'polygon' | 'unichain' | 'solana';

/** Map from our chain names to Bankr chain names */
export const CHAIN_MAP: Record<string, BankrChain> = {
  base: 'base',
  ethereum: 'mainnet',
  mainnet: 'mainnet',
  eth: 'mainnet',
  polygon: 'polygon',
  unichain: 'unichain',
  solana: 'solana',
  sol: 'solana',
};

// ─── User Info ───────────────────────────────────────────────────────────

export interface BankrWallet {
  chain: 'evm' | 'solana';
  address: string;
}

export interface BankrSocialAccount {
  platform: string;
  username: string;
}

export interface BankrUserInfo {
  wallets: BankrWallet[];
  bankrClub: { active: boolean } | boolean;
  socialAccounts: BankrSocialAccount[];
  refCode?: string;
}

/** Normalize bankrClub to a boolean regardless of API shape */
export function isBankrClubActive(info: BankrUserInfo): boolean {
  if (typeof info.bankrClub === 'boolean') return info.bankrClub;
  return info.bankrClub?.active ?? false;
}

// ─── Balances ────────────────────────────────────────────────────────────

/** Raw token entry from Bankr API tokenBalances array */
export interface BankrRawTokenEntry {
  address: string;
  network: string;
  token: {
    balance: number;
    balanceUSD: number;
    baseToken: {
      name: string;
      address: string;
      symbol: string;
      imgUrl: string;
      price: number;
      decimals: number;
    };
  };
}

/** Raw per-chain balance from Bankr API */
export interface BankrRawChainBalance {
  nativeBalance: string;
  nativeUsd: string;
  tokenBalances: BankrRawTokenEntry[];
  total: string;
}

/** Raw balances response from GET /agent/balances */
export interface BankrRawBalancesResponse {
  success: boolean;
  evmAddress: string;
  solAddress: string;
  balances: Record<string, BankrRawChainBalance>;
}

/** Normalized token balance for our tools */
export interface BankrTokenBalance {
  symbol: string;
  name: string;
  address: string;
  balance: number;
  balanceUsd: number;
  price: number;
  decimals: number;
}

/** Normalized per-chain balance for our tools */
export interface BankrChainBalance {
  chain: string;
  nativeBalance: string;
  nativeBalanceUsd: number;
  tokens: BankrTokenBalance[];
  totalUsd: number;
}

/** Normalized balances response for our tools */
export interface BankrBalancesResponse {
  chains: BankrChainBalance[];
  totalUsd: number;
}

// ─── Prompt / Job ────────────────────────────────────────────────────────

export interface BankrPromptRequest {
  prompt: string;
  threadId?: string;
}

export interface BankrPromptResponse {
  jobId: string;
  threadId: string;
  status: 'pending';
}

export type BankrJobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface BankrTransaction {
  type: string; // 'swap', 'transfer', 'deploy', etc.
  hash?: string;
  chain?: string;
  metadata?: Record<string, unknown>;
}

export interface BankrRichData {
  tokenInfo?: Record<string, unknown>;
  chartUrl?: string;
  [key: string]: unknown;
}

export interface BankrJobResult {
  jobId: string;
  status: BankrJobStatus;
  response?: string;
  richData?: BankrRichData;
  transactions?: BankrTransaction[];
  error?: string;
}

// ─── Sign ────────────────────────────────────────────────────────────────

export type BankrSignatureType = 'personal_sign' | 'eth_signTypedData_v4' | 'eth_signTransaction';

export interface BankrSignRequest {
  signatureType: BankrSignatureType;
  message?: string;          // for personal_sign
  typedData?: unknown;       // for eth_signTypedData_v4
  transaction?: unknown;     // for eth_signTransaction
  chainId?: number;
}

export interface BankrSignResponse {
  signature: string;
  signer: string;
}

// ─── Submit ──────────────────────────────────────────────────────────────

export interface BankrSubmitRequest {
  signedTransaction: string;
  chainId: number;
  waitForConfirmation?: boolean;
}

export interface BankrSubmitResponse {
  hash: string;
  status: 'submitted' | 'confirmed';
  blockNumber?: number;
}

// ─── Token Deploy ────────────────────────────────────────────────────────

export interface BankrDeployRequest {
  name: string;
  symbol?: string;
  description?: string;
  imageUrl?: string;
  chain?: 'base' | 'solana';
  feeRecipient?: string;     // address, ENS, X handle, or Farcaster handle
  tweetUrl?: string;
  websiteUrl?: string;
  simulateOnly?: boolean;
  vault?: {
    percentage: number;       // 1-90
    lockDays: number;
  };
  vesting?: {
    cliffDays: number;
    vestingDays: number;
  };
}

export interface BankrFeeDistribution {
  creator: number;
  bankr: number;
  protocol: number;
  ecosystem?: number;
}

export interface BankrDeployResponse {
  tokenAddress: string;
  poolId?: string;
  txHash: string;
  chain: string;
  feeDistribution: BankrFeeDistribution;
  simulateOnly?: boolean;
}

// ─── Errors ──────────────────────────────────────────────────────────────

export class BankrAuthError extends Error {
  constructor(message = 'Invalid or expired BANKR_API_KEY') {
    super(message);
    this.name = 'BankrAuthError';
  }
}

export class BankrCreditsError extends Error {
  constructor(message = 'LLM credits exhausted') {
    super(message);
    this.name = 'BankrCreditsError';
  }
}

export class BankrAccessError extends Error {
  constructor(message = 'Agent API not enabled on this key. Enable at bankr.bot/api') {
    super(message);
    this.name = 'BankrAccessError';
  }
}

export class BankrReadOnlyError extends Error {
  constructor(message = 'Key is read-only — cannot sign or submit transactions') {
    super(message);
    this.name = 'BankrReadOnlyError';
  }
}

export class BankrRateLimitError extends Error {
  resetAt: number;
  limit: number;
  used: number;

  constructor(resetAt: number, limit: number, used: number) {
    super(`Rate limited. Resets at ${new Date(resetAt).toISOString()}. Used ${used}/${limit}.`);
    this.name = 'BankrRateLimitError';
    this.resetAt = resetAt;
    this.limit = limit;
    this.used = used;
  }
}

export class BankrServerError extends Error {
  statusCode: number;

  constructor(statusCode: number, message = 'Bankr API server error') {
    super(`${message} (${statusCode}). Try again in a moment.`);
    this.name = 'BankrServerError';
    this.statusCode = statusCode;
  }
}
