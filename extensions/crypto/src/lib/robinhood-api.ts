/**
 * Robinhood Chain (4663) client — Clawnch launch router + Bags.fm API surface.
 *
 * Robinhood Chain launches do not go through Clanker. The flow is:
 *
 *   ticket path (agent pays + signs):
 *     POST /api/robinhood/ticket   → unsigned ClawnchLaunch.launch() tx + EIP-712 ticket
 *     sign + send from the registered agent wallet (pays ~0.02 ETH Bags creation fee)
 *     POST /api/robinhood/launch   { mode: 'confirm', txHash } → records provenance
 *
 *   deposit path (agent only pays ETH):
 *     send ETH to router.DEPOSIT_ADDRESS() (>= max(0.02 ETH, live creationFee))
 *     POST /api/robinhood/launch   { mode: 'deposit', depositTxHash, agentWallet, ... }
 *
 *   fees:
 *     GET  /api/robinhood/claim?token=&address= → claimable read (public)
 *     POST /api/robinhood/claim { token }       → unsigned BagsFeeShare.claim(true) tx
 *
 * All calls are authenticated with a registered agent API key
 * (Authorization: Bearer <key>) except the public GETs.
 *
 * Anything that only exists on the Base/Clanker side (vaults, dev buy,
 * $CLAWNCH burn-to-bypass) raises RobinhoodChainError with a clear
 * "not supported on Robinhood Chain" message — never a silent Base fallback.
 */

import { ROBINHOOD, TOKENS, type ClawnchChainKey } from './contract-registry.js';
import { guardedFetch } from '../services/endpoint-allowlist.js';

// ── Constants ────────────────────────────────────────────────────────────

export const RH_CHAIN_ID = ROBINHOOD.chainId;
export const RH_CHAIN_KEY: ClawnchChainKey = 'robinhood';
export const RH_LAUNCH_ROUTER = ROBINHOOD.launchRouter;
export const RH_BAGS_FACTORY = ROBINHOOD.bagsFactory;
export const RH_WETH = TOKENS.robinhood.WETH;
export const RH_CLAWNCH_TOKEN = TOKENS.robinhood.CLAWNCH;

/** Minimum ETH a deposit-path launch must carry (mirrors api/lib/launch-router.ts). */
export const RH_DEPOSIT_MIN_WEI = 20_000_000_000_000_000n;

/** Ticket TTL returned by the API (seconds). */
export const RH_TICKET_TTL_SECONDS = 600;

export function rhApiBaseUrl(): string {
  return (process.env.CLAWNCHER_API_URL || 'https://clawn.ch').replace(/\/+$/, '');
}

// ── Links ────────────────────────────────────────────────────────────────

/** Bags.fm trade page for a Robinhood Chain token. */
export function rhTradeUrl(token: string): string {
  return `${ROBINHOOD.tradeUrlBase}${token}`;
}

/** Blockscout token page for a Robinhood Chain token. */
export function rhExplorerTokenUrl(token: string): string {
  return `${ROBINHOOD.explorerUrl}/token/${token}`;
}

/** Blockscout address page (wallet or contract). */
export function rhExplorerAddressUrl(address: string): string {
  return `${ROBINHOOD.explorerUrl}/address/${address}`;
}

/** Blockscout transaction page. */
export function rhExplorerTxUrl(txHash: string): string {
  return `${ROBINHOOD.explorerUrl}/tx/${txHash}`;
}

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * Robinhood Chain error. `code` mirrors the API's `code` field when the
 * failure came from a Clawnch endpoint, or one of:
 *   'not_supported'  — feature genuinely does not exist on RHC
 *   'wrong_chain'    — response/transaction targeted a different chain
 *   'api'            — problem reported by the Clawnch API
 *   'transport'      — request failed / malformed response
 */
export class RobinhoodChainError extends Error {
  public readonly code: string;
  public readonly httpStatus?: number;

  constructor(message: string, code = 'api', httpStatus?: number) {
    super(message);
    this.name = 'RobinhoodChainError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Throw a clear "not supported on Robinhood Chain" error for Base/Clanker-only
 * features. Use this instead of silently routing the caller to Base.
 */
export function rhNotSupported(feature: string, detail?: string): never {
  throw new RobinhoodChainError(
    `"${feature}" is not supported on Robinhood Chain (chainId ${RH_CHAIN_ID}).` +
      (detail ? ` ${detail}` : ''),
    'not_supported',
  );
}

/** True when an error is a "not supported on Robinhood Chain" error. */
export function isRhNotSupportedError(err: unknown): boolean {
  return err instanceof RobinhoodChainError && err.code === 'not_supported';
}

// ── ABIs (subsets used client-side) ──────────────────────────────────────

/** Clawnch launch router on Robinhood Chain. */
export const RH_LAUNCH_ROUTER_ABI = [
  {
    type: 'function',
    name: 'launch',
    stateMutability: 'payable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'metadataURI', type: 'string' },
      { name: 'agent', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'function',
    name: 'registerLaunch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'agent', type: 'address' },
      { name: 'depositHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isDepositUsed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'DEPOSIT_ADDRESS', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'CLAWNCH_PARTNER', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'BAGS_FACTORY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'signer', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'event',
    name: 'AgenticLaunch',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'feeRecipient', type: 'address', indexed: false },
      { name: 'mode', type: 'uint8', indexed: false },
      { name: 'depositHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;

/** Bags factory subset (creation fee + fee share registry). */
export const RH_BAGS_FACTORY_ABI = [
  { type: 'function', name: 'creationFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'partnerFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  {
    type: 'function',
    name: 'feeShareForToken',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'address' }],
  },
] as const;

/** BagsFeeShare subset — fees accrue in WETH, claimed by the claimer itself. */
export const RH_BAGS_FEE_SHARE_ABI = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'unwrap', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'claimable', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'getClaimers',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'addrs', type: 'address[]' },
      { name: 'bps', type: 'uint16[]' },
    ],
  },
  { type: 'function', name: 'claimerBps', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint16' }] },
] as const;

/** Minimal ERC-20 reads for token_info. */
export const RH_ERC20_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

// ── Types ────────────────────────────────────────────────────────────────

export interface RhUnsignedTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: `0x${string}` | string;
  chainId: number;
}

export interface RhTicket {
  agent: string;
  feeRecipient: string;
  paramsHash: string;
  nonce: string;
  deadline: string;
  signature: string;
}

export interface RhTicketResult {
  data: RhUnsignedTx;
  ticket: RhTicket;
  meta: {
    backend?: string;
    chain?: string;
    launcher?: string;
    router?: string;
    depositAddress?: string;
    creationFeeWei?: string;
    ttlSeconds?: number;
    agentName?: string;
    agentId?: string;
    params?: Record<string, unknown>;
    next?: string;
  };
}

export interface RhLaunchRecord {
  token: string;
  agent: string;
  name?: string;
  symbol?: string;
  metadataURI?: string;
  mode: 'ticket' | 'deposit';
  txHash: string;
  routerTxHash?: string;
  depositTxHash?: string;
  chainId?: number;
  launchedAt?: string;
  chain?: string;
  tradeUrl?: string;
  explorerUrl?: string;
  txUrl?: string;
  routerTxUrl?: string;
}

export interface RhClaimRead {
  token: string;
  address: string;
  feeShare: `0x${string}`;
  isClaimer: boolean;
  bps: number;
  claimableWei: string;
  claim: RhUnsignedTx | null;
}

// ── HTTP plumbing ────────────────────────────────────────────────────────

interface RhRequestOptions {
  method?: 'GET' | 'POST';
  apiKey?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

/**
 * Call a Clawnch API endpoint. Uses the endpoint allowlist (guardedFetch also
 * follows redirects manually, which preserves the Authorization header when
 * clawn.ch redirects to www.clawn.ch).
 */
export async function rhApiRequest<T>(path: string, opts: RhRequestOptions = {}): Promise<T> {
  const base = (opts.apiBaseUrl || rhApiBaseUrl()).replace(/\/+$/, '');
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && `${v}` !== '') url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await guardedFetch(url.toString(), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (err) {
    throw new RobinhoodChainError(
      `Robinhood Chain API request failed (${opts.method ?? 'GET'} ${url.pathname}): ` +
        (err instanceof Error ? err.message : String(err)),
      'transport',
    );
  }

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new RobinhoodChainError(
      `Robinhood Chain API returned a non-JSON response (HTTP ${res.status}) from ${url.pathname}: ${text.slice(0, 200)}`,
      'transport',
      res.status,
    );
  }

  if (!res.ok || json?.ok === false) {
    const serverCode = typeof json?.code === 'string' ? json.code : undefined;
    const message = json?.error || `HTTP ${res.status}`;
    throw new RobinhoodChainError(
      `Robinhood Chain API error (${opts.method ?? 'GET'} ${url.pathname}): ${message}` +
        (serverCode ? ` [${serverCode}]` : ''),
      serverCode ?? 'api',
      res.status,
    );
  }

  return json as T;
}

// ── Launch: ticket path ──────────────────────────────────────────────────

export interface RhTicketRequest {
  apiKey: string;
  agentWallet: string;
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  feeRecipient?: string;
  apiBaseUrl?: string;
}

/** POST /api/robinhood/ticket — unsigned launch tx + EIP-712 ticket. */
export async function requestRhLaunchTicket(req: RhTicketRequest): Promise<RhTicketResult> {
  const res = await rhApiRequest<any>('/api/robinhood/ticket', {
    method: 'POST',
    apiKey: req.apiKey,
    apiBaseUrl: req.apiBaseUrl,
    body: {
      agentWallet: req.agentWallet,
      name: req.name,
      symbol: req.symbol,
      ...(req.description ? { description: req.description } : {}),
      ...(req.image ? { image: req.image } : {}),
      ...(req.feeRecipient ? { feeRecipient: req.feeRecipient } : {}),
    },
  });

  assertRhUnsignedTx(res?.data, '/api/robinhood/ticket');
  return res as RhTicketResult;
}

/** POST /api/robinhood/launch { mode: 'confirm', txHash }. */
export async function confirmRhLaunch(opts: {
  apiKey: string;
  txHash: string;
  apiBaseUrl?: string;
}): Promise<{ launch?: RhLaunchRecord; alreadyRecorded?: boolean }> {
  return rhApiRequest('/api/robinhood/launch', {
    method: 'POST',
    apiKey: opts.apiKey,
    apiBaseUrl: opts.apiBaseUrl,
    body: { mode: 'confirm', txHash: opts.txHash },
  });
}

/** POST /api/robinhood/launch { mode: 'deposit', ... }. */
export async function submitRhDepositLaunch(opts: {
  apiKey: string;
  depositTxHash: string;
  agentWallet: string;
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  apiBaseUrl?: string;
}): Promise<{ launch?: RhLaunchRecord }> {
  return rhApiRequest('/api/robinhood/launch', {
    method: 'POST',
    apiKey: opts.apiKey,
    apiBaseUrl: opts.apiBaseUrl,
    // Deposit deploys can take a while server-side (deploy + provenance tx).
    timeoutMs: 120_000,
    body: {
      mode: 'deposit',
      depositTxHash: opts.depositTxHash,
      agentWallet: opts.agentWallet,
      name: opts.name,
      symbol: opts.symbol,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.image ? { image: opts.image } : {}),
    },
  });
}

// ── Launch feed ──────────────────────────────────────────────────────────

/** GET /api/robinhood/launches — public feed, optional agent filter. */
export async function getRhLaunches(opts: {
  agent?: string;
  limit?: number;
  offset?: number;
  apiBaseUrl?: string;
} = {}): Promise<{ launches: RhLaunchRecord[]; pagination: { limit: number; offset: number; total: number; hasMore: boolean } }> {
  const res = await rhApiRequest<any>('/api/robinhood/launches', {
    apiBaseUrl: opts.apiBaseUrl,
    query: {
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
    },
  });
  return {
    launches: Array.isArray(res?.launches) ? res.launches : [],
    pagination: res?.pagination ?? { limit: opts.limit ?? 50, offset: opts.offset ?? 0, total: 0, hasMore: false },
  };
}

// ── Fees ─────────────────────────────────────────────────────────────────

/** GET /api/robinhood/claim — claimable read (public, no auth). */
export async function readRhClaim(opts: {
  token: string;
  address: string;
  apiBaseUrl?: string;
}): Promise<RhClaimRead> {
  const res = await rhApiRequest<any>('/api/robinhood/claim', {
    apiBaseUrl: opts.apiBaseUrl,
    query: { token: opts.token, address: opts.address },
  });
  return {
    token: res?.token ?? opts.token,
    address: res?.address ?? opts.address,
    feeShare: res?.feeShare,
    isClaimer: res?.isClaimer === true,
    bps: Number(res?.bps ?? 0),
    claimableWei: String(res?.claimableWei ?? '0'),
    claim: res?.claim ?? null,
  };
}

export interface RhClaimTxResult {
  ready: boolean;
  claimableWei: string;
  claimableEth?: string;
  claim: RhUnsignedTx | null;
  meta?: { agent?: string; bps?: number; note?: string };
  note?: string;
}

/** POST /api/robinhood/claim — unsigned BagsFeeShare.claim(true) tx. */
export async function requestRhClaimTx(opts: {
  apiKey: string;
  token: string;
  apiBaseUrl?: string;
}): Promise<RhClaimTxResult> {
  const res = await rhApiRequest<any>('/api/robinhood/claim', {
    method: 'POST',
    apiKey: opts.apiKey,
    apiBaseUrl: opts.apiBaseUrl,
    body: { token: opts.token },
  });

  const claim: RhUnsignedTx | null = res?.claim ?? null;
  // A ready claim always carries a transaction — never treat a missing one as success.
  if (res?.ready === true && !claim) {
    throw new RobinhoodChainError(
      'Robinhood claim API reported a claimable balance but returned no transaction to sign.',
      'transport',
    );
  }
  if (claim) assertRhUnsignedTx(claim, '/api/robinhood/claim');

  return {
    ready: res?.ready === true,
    claimableWei: String(res?.claimableWei ?? '0'),
    claimableEth: res?.claimableEth,
    claim,
    meta: res?.meta,
    note: res?.note,
  };
}

// ── Chain reads ──────────────────────────────────────────────────────────

/** Public client for Robinhood Chain, with RPC failover via the RpcManager. */
export async function getRhPublicClient(): Promise<any> {
  const { getRpcManager } = await import('../services/rpc-provider.js');
  return getRpcManager().getClient(RH_CHAIN_ID);
}

/** Read the router's deposit address (deposit-path instructions). */
export async function readRhDepositAddress(publicClient?: any): Promise<`0x${string}`> {
  const client = publicClient ?? (await getRhPublicClient());
  return (await client.readContract({
    address: RH_LAUNCH_ROUTER,
    abi: RH_LAUNCH_ROUTER_ABI,
    functionName: 'DEPOSIT_ADDRESS',
  })) as `0x${string}`;
}

/** Live Bags creation fee (min 0.02 ETH is also enforced server-side). */
export async function readRhBagsCreationFee(publicClient?: any): Promise<bigint> {
  const client = publicClient ?? (await getRhPublicClient());
  return (await client.readContract({
    address: RH_BAGS_FACTORY,
    abi: RH_BAGS_FACTORY_ABI,
    functionName: 'creationFee',
  })) as bigint;
}

/** Minimal on-chain ERC-20 details for a Robinhood Chain token. */
export async function readRhTokenInfo(token: string, publicClient?: any): Promise<{
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
}> {
  const client = publicClient ?? (await getRhPublicClient());
  const address = token as `0x${string}`;
  const read = async (functionName: string): Promise<any> => {
    try {
      return await client.readContract({ address, abi: RH_ERC20_ABI, functionName });
    } catch {
      return undefined;
    }
  };

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    read('name'),
    read('symbol'),
    read('decimals'),
    read('totalSupply'),
  ]);

  if (name === undefined && symbol === undefined && decimals === undefined) {
    throw new RobinhoodChainError(
      `No ERC-20 contract found at ${token} on Robinhood Chain (chainId ${RH_CHAIN_ID}).`,
      'transport',
    );
  }

  return {
    name,
    symbol,
    decimals: decimals === undefined ? undefined : Number(decimals),
    totalSupply: totalSupply === undefined ? undefined : String(totalSupply),
  };
}

// ── Transaction sending ──────────────────────────────────────────────────

/** Reject a transaction the API (or caller) prepared for a different chain. */
export function assertRhUnsignedTx(tx: unknown, source = 'Robinhood Chain'): asserts tx is RhUnsignedTx {
  const t = tx as RhUnsignedTx | undefined;
  if (!t || typeof t.to !== 'string' || typeof t.data !== 'string') {
    throw new RobinhoodChainError(`${source} returned an unusable transaction payload: ${JSON.stringify(tx)}`, 'transport');
  }
  if (Number(t.chainId) !== RH_CHAIN_ID) {
    throw new RobinhoodChainError(
      `${source} returned a transaction for chainId ${t.chainId}, expected ${RH_CHAIN_ID} (Robinhood Chain). ` +
        'Refusing to send it — no cross-chain fallback.',
      'wrong_chain',
    );
  }
}

/**
 * Sign + broadcast a Robinhood Chain transaction from the connected wallet.
 * The chain is passed explicitly so the Base-configured wallet client routes
 * this transaction to the Robinhood Chain RPC (and a WalletConnect wallet is
 * asked to switch chains) instead of silently using Base.
 */
export async function sendRhTransaction(tx: RhUnsignedTx, walletClient?: any): Promise<`0x${string}`> {
  assertRhUnsignedTx(tx, 'Robinhood Chain transaction');

  const wallet = walletClient ?? (await import('../services/walletconnect-service.js')).requireWalletClient();
  const { robinhoodChain } = await import('../services/rpc-provider.js');

  const hash = await wallet.sendTransaction({
    account: wallet.account,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value ?? '0x0'),
    chain: robinhoodChain,
  } as any);

  return hash as `0x${string}`;
}
