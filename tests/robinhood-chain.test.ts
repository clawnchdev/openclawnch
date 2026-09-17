/**
 * Robinhood Chain (chainId 4663) — Clawnch-facing tool port tests.
 *
 * Covers:
 * - contract registry: RHC chain metadata, token addresses, explorer/trade links
 * - robinhood-api: endpoint URLs, auth headers, payloads, error + wrong-chain guards
 * - clawnch_launch: ticket path (sign → confirm), deposit path (dry run), Base-only params
 * - clawnch_fees: RHC check / claim / claim_all over the claim API
 * - clawnch_info: RHC token_info, list_tokens, portfolio, vault_claim rejection
 *
 * All network access is mocked: global fetch for Clawnch API calls and the
 * Robinhood Chain public client / transaction sender via module mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Module mocks ─────────────────────────────────────────────────────────

const rhMocks = vi.hoisted(() => ({
  getRhPublicClient: vi.fn(),
  sendRhTransaction: vi.fn(),
}));

vi.mock('../extensions/crypto/src/lib/robinhood-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extensions/crypto/src/lib/robinhood-api.js')>();
  return {
    ...actual,
    getRhPublicClient: rhMocks.getRhPublicClient,
    sendRhTransaction: rhMocks.sendRhTransaction,
  };
});

import {
  ROBINHOOD,
  TOKENS,
  CLAWNCH_CHAINS,
  resolveClawnchChainKey,
  getClawnchChainMeta,
  explorerTxUrl,
  explorerAddressUrl,
  tradeUrl,
} from '../extensions/crypto/src/lib/contract-registry.js';
import {
  RH_CHAIN_ID,
  RH_LAUNCH_ROUTER,
  RH_BAGS_FACTORY,
  RH_CLAWNCH_TOKEN,
  RH_DEPOSIT_MIN_WEI,
  RobinhoodChainError,
  rhNotSupported,
  isRhNotSupportedError,
  rhTradeUrl,
  rhExplorerTokenUrl,
  rhExplorerTxUrl,
  rhApiRequest,
  requestRhLaunchTicket,
  confirmRhLaunch,
  submitRhDepositLaunch,
  getRhLaunches,
  readRhClaim,
  requestRhClaimTx,
  assertRhUnsignedTx,
  rhApiBaseUrl,
} from '../extensions/crypto/src/lib/robinhood-api.js';
import { createClawnchLaunchTool } from '../extensions/crypto/src/tools/clawnch-launch.js';
import { createClawnchFeesTool } from '../extensions/crypto/src/tools/clawnch-fees.js';
import { createClawnchInfoTool } from '../extensions/crypto/src/tools/clawnch-info.js';

// ─── Test fixtures ────────────────────────────────────────────────────────

const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ROUTER = '0xdd4e350684d19Cd9FcD414a284837A358d4B535B';
const TOKEN = '0x1111111111111111111111111111111111111111';
const FEE_SHARE = '0x2222222222222222222222222222222222222222';
const TX_HASH = '0x' + 'a'.repeat(64);

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function redirectResponse(location: string, status = 307) {
  return {
    ok: false,
    status,
    headers: new Headers({ location }),
    text: async () => 'Redirecting...',
    json: async () => ({}),
  } as unknown as Response;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let fetchCalls: FetchCall[] = [];
let fetchQueue: Array<(url: string, init?: RequestInit) => Response> = [];

function queueResponse(res: Response) {
  fetchQueue.push(() => res);
}

function queueDynamic(fn: (url: string, init?: RequestInit) => Response) {
  fetchQueue.push(fn);
}

function installFetchMock() {
  fetchCalls = [];
  fetchQueue = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    fetchCalls.push({ url, init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`Unexpected fetch call in test: ${url}`);
    return next(url, init);
  }));
}

/** Minimal Robinhood Chain public client stand-in. */
function makePublicClient(overrides: Record<string, unknown> = {}) {
  return {
    getBalance: vi.fn(async () => 1_000_000_000_000_000_000n), // 1 ETH
    readContract: vi.fn(async () => 20_000_000_000_000_000n),  // 0.02 ETH default
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    ...overrides,
  };
}

async function connectWallet() {
  const { initWalletService } = await import('../extensions/crypto/src/services/walletconnect-service.js');
  await initWalletService({ privateKey: TEST_PK, network: 'mainnet' });
}

async function disconnectWallet() {
  const svc = await import('../extensions/crypto/src/services/walletconnect-service.js');
  if (typeof (svc as any).disconnectWallet === 'function') {
    try { await (svc as any).disconnectWallet(); } catch { /* ignore */ }
  }
}

// ─── Contract registry ────────────────────────────────────────────────────

describe('contract registry — Robinhood Chain is a first-class chain', () => {
  it('exposes RHC chain metadata (4663, RPC, Blockscout)', () => {
    expect(ROBINHOOD.chainId).toBe(4663);
    expect(ROBINHOOD.testnetChainId).toBe(46630);
    expect(ROBINHOOD.name).toBe('Robinhood Chain');
    expect(ROBINHOOD.rpcUrl).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(ROBINHOOD.explorerUrl).toBe('https://robinhoodchain.blockscout.com');
    expect(ROBINHOOD.tradeUrlBase).toBe('https://bags.fm/token/');
  });

  it('pins the deployed launch router + Bags factory addresses', () => {
    expect(ROBINHOOD.launchRouter).toBe('0xdd4e350684d19Cd9FcD414a284837A358d4B535B');
    expect(ROBINHOOD.bagsFactory).toBe('0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37');
    expect(RH_LAUNCH_ROUTER).toBe('0xdd4e350684d19Cd9FcD414a284837A358d4B535B');
    expect(RH_BAGS_FACTORY).toBe('0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37');
  });

  it('registers the RHC $CLAWNCH + WETH token addresses', () => {
    expect(TOKENS.robinhood.CLAWNCH).toBe('0x6a50F139F3eD4C9c7bDa0D067c5Ed09De1EEBbeA');
    expect(RH_CLAWNCH_TOKEN).toBe('0x6a50F139F3eD4C9c7bDa0D067c5Ed09De1EEBbeA');
    expect(TOKENS.robinhood.WETH).toBe(ROBINHOOD.weth);
    // Base stays untouched
    expect(TOKENS.base.CLAWNCH).toBe('0xa1F72459dfA10BAD200Ac160eCd78C6b77a747be');
  });

  it('resolves chain names and IDs to Clawnch chain keys', () => {
    expect(resolveClawnchChainKey('robinhood')).toBe('robinhood');
    expect(resolveClawnchChainKey('Robinhood Chain')).toBe('robinhood');
    expect(resolveClawnchChainKey('4663')).toBe('robinhood');
    expect(resolveClawnchChainKey('base')).toBe('base');
    expect(resolveClawnchChainKey('8453')).toBe('base');
    // Unknown chains must not silently resolve to Base
    expect(resolveClawnchChainKey('solana')).toBeUndefined();
    expect(resolveClawnchChainKey('')).toBeUndefined();
    expect(resolveClawnchChainKey(undefined)).toBeUndefined();
  });

  it('builds chain-aware explorer and trade links', () => {
    expect(explorerTxUrl('robinhood', TX_HASH)).toBe(`https://robinhoodchain.blockscout.com/tx/${TX_HASH}`);
    expect(explorerAddressUrl('robinhood', TOKEN)).toBe(`https://robinhoodchain.blockscout.com/address/${TOKEN}`);
    expect(tradeUrl('robinhood', TOKEN)).toBe(`https://bags.fm/token/${TOKEN}`);

    expect(explorerTxUrl('base', TX_HASH)).toBe(`https://basescan.org/tx/${TX_HASH}`);
    expect(tradeUrl('base', TOKEN)).toBe(`https://clawn.ch/token/${TOKEN}`);

    // Unknown chain → no link at all (never a Base link)
    expect(tradeUrl('solana', TOKEN)).toBeUndefined();
    expect(explorerTxUrl('solana', TX_HASH)).toBeUndefined();
  });

  it('marks only Robinhood Chain as launch-router backed', () => {
    expect(CLAWNCH_CHAINS.robinhood.usesLaunchRouter).toBe(true);
    expect(CLAWNCH_CHAINS.robinhood.id).toBe(4663);
    expect(CLAWNCH_CHAINS.base.usesLaunchRouter).toBe(false);
    expect(getClawnchChainMeta(4663)?.name).toBe('Robinhood Chain');
  });

  it('exposes the RHC claim/deposit constants', () => {
    expect(RH_CHAIN_ID).toBe(4663);
    expect(RH_DEPOSIT_MIN_WEI).toBe(20_000_000_000_000_000n);
    expect(rhTradeUrl(TOKEN)).toBe(`https://bags.fm/token/${TOKEN}`);
    expect(rhExplorerTokenUrl(TOKEN)).toBe(`https://robinhoodchain.blockscout.com/token/${TOKEN}`);
    expect(rhExplorerTxUrl(TX_HASH)).toBe(`https://robinhoodchain.blockscout.com/tx/${TX_HASH}`);
  });
});

// ─── robinhood-api client ─────────────────────────────────────────────────

describe('robinhood-api — errors', () => {
  it('rhNotSupported throws a clear Robinhood Chain error', () => {
    try {
      rhNotSupported('vault_percentage', 'No vault primitive on Bags.');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RobinhoodChainError);
      expect((err as Error).message).toContain('not supported on Robinhood Chain');
      expect((err as Error).message).toContain('vault_percentage');
      expect((err as Error).message).toContain('No vault primitive on Bags.');
      expect(isRhNotSupportedError(err)).toBe(true);
    }
  });

  it('assertRhUnsignedTx rejects transactions prepared for another chain', () => {
    expect(() => assertRhUnsignedTx({ to: ROUTER, data: '0x', value: '0x0', chainId: 8453 }))
      .toThrow(/expected 4663.*Robinhood Chain/s);
    expect(() => assertRhUnsignedTx({ to: ROUTER, data: '0x', value: '0x0', chainId: 4663 }))
      .not.toThrow();
  });

  it('uses clawn.ch as the default API base and honors CLAWNCHER_API_URL', () => {
    const prev = process.env.CLAWNCHER_API_URL;
    delete process.env.CLAWNCHER_API_URL;
    expect(rhApiBaseUrl()).toBe('https://clawn.ch');
    process.env.CLAWNCHER_API_URL = 'https://staging.clawn.ch/';
    expect(rhApiBaseUrl()).toBe('https://staging.clawn.ch');
    if (prev === undefined) delete process.env.CLAWNCHER_API_URL; else process.env.CLAWNCHER_API_URL = prev;
  });
});

describe('robinhood-api — HTTP', () => {
  beforeEach(() => installFetchMock());
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the ticket request with Bearer auth and the launch body', async () => {
    queueResponse(jsonResponse({
      ok: true,
      data: { to: ROUTER, data: '0xdeadbeef', value: '0x470de4df820000', chainId: 4663 },
      ticket: { agent: TEST_WALLET, feeRecipient: TEST_WALLET, paramsHash: '0x00', nonce: '7', deadline: '1700000000', signature: '0xsig' },
      meta: { chain: 'robinhood', depositAddress: TEST_WALLET, creationFeeWei: '20000000000000000', ttlSeconds: 600 },
    }));

    const res = await requestRhLaunchTicket({
      apiKey: 'agent-key',
      agentWallet: TEST_WALLET,
      name: 'Robin Token',
      symbol: 'ROBIN',
      description: 'desc',
      image: 'https://img',
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('https://clawn.ch/api/robinhood/ticket');
    expect(fetchCalls[0]!.init?.method).toBe('POST');
    expect((fetchCalls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer agent-key');
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({
      agentWallet: TEST_WALLET,
      name: 'Robin Token',
      symbol: 'ROBIN',
      description: 'desc',
      image: 'https://img',
    });
    expect(res.data.chainId).toBe(4663);
    expect(res.ticket.nonce).toBe('7');
  });

  it('rejects a ticket whose transaction targets a different chain', async () => {
    queueResponse(jsonResponse({
      ok: true,
      data: { to: ROUTER, data: '0x', value: '0x0', chainId: 8453 },
      ticket: {},
      meta: {},
    }));

    await expect(requestRhLaunchTicket({
      apiKey: 'k', agentWallet: TEST_WALLET, name: 'N', symbol: 'S',
    })).rejects.toThrow(/chainId 8453, expected 4663/);
  });

  it('maps API failures onto RobinhoodChainError with the server code', async () => {
    queueResponse(jsonResponse({
      ok: false,
      error: 'A registered agent API key is required.',
      code: 'unauthorized',
    }, 401));

    await expect(getRhLaunches({ limit: 1 })).rejects.toMatchObject({
      name: 'RobinhoodChainError',
      code: 'unauthorized',
      httpStatus: 401,
    });
  });

  it('preserves the Authorization header when clawn.ch redirects to www', async () => {
    queueResponse(redirectResponse('https://www.clawn.ch/api/robinhood/launch'));
    queueResponse(jsonResponse({ ok: true, launch: { token: TOKEN, agent: TEST_WALLET, mode: 'ticket', txHash: TX_HASH } }));

    const res = await confirmRhLaunch({ apiKey: 'agent-key', txHash: TX_HASH });

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]!.url).toBe('https://www.clawn.ch/api/robinhood/launch');
    expect((fetchCalls[1]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer agent-key');
    expect(res.launch?.token).toBe(TOKEN);
  });

  it('POSTs confirm and deposit launch payloads with the right modes', async () => {
    queueResponse(jsonResponse({ ok: true, launch: { token: TOKEN, agent: TEST_WALLET, mode: 'ticket', txHash: TX_HASH } }));
    await confirmRhLaunch({ apiKey: 'k', txHash: TX_HASH });
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({ mode: 'confirm', txHash: TX_HASH });

    fetchCalls = []; fetchQueue = [];
    queueResponse(jsonResponse({ ok: true, launch: { token: TOKEN, agent: TEST_WALLET, mode: 'deposit', txHash: TX_HASH } }));
    await submitRhDepositLaunch({
      apiKey: 'k', depositTxHash: TX_HASH, agentWallet: TEST_WALLET, name: 'N', symbol: 'SYM',
    });
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({
      mode: 'deposit', depositTxHash: TX_HASH, agentWallet: TEST_WALLET, name: 'N', symbol: 'SYM',
    });
  });

  it('reads the public launch feed with an agent filter', async () => {
    queueResponse(jsonResponse({
      ok: true,
      chain: 'robinhood',
      launches: [{ token: TOKEN, agent: TEST_WALLET, mode: 'ticket', txHash: TX_HASH }],
      pagination: { limit: 50, offset: 0, total: 1, hasMore: false },
    }));

    const feed = await getRhLaunches({ agent: TEST_WALLET, limit: 50 });

    expect(fetchCalls[0]!.url).toBe(`https://clawn.ch/api/robinhood/launches?agent=${TEST_WALLET}&limit=50`);
    expect((fetchCalls[0]!.init?.method ?? 'GET')).toBe('GET');
    expect((fetchCalls[0]!.init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(feed.launches).toHaveLength(1);
    expect(feed.pagination.total).toBe(1);
  });

  it('reads claim state (GET) and requests a claim transaction (POST)', async () => {
    queueResponse(jsonResponse({
      ok: true, chainId: 4663, token: TOKEN, address: TEST_WALLET,
      feeShare: FEE_SHARE, isClaimer: true, bps: 10000, claimableWei: '1000000000000000',
      claim: { to: FEE_SHARE, data: '0xclaim', value: '0x0', chainId: 4663 },
    }));

    const read = await readRhClaim({ token: TOKEN, address: TEST_WALLET });
    expect(fetchCalls[0]!.url).toBe(`https://clawn.ch/api/robinhood/claim?token=${TOKEN}&address=${TEST_WALLET}`);
    expect(read.isClaimer).toBe(true);
    expect(read.bps).toBe(10000);
    expect(read.claimableWei).toBe('1000000000000000');

    fetchCalls = []; fetchQueue = [];
    queueResponse(jsonResponse({
      ok: true, ready: true, claimableWei: '1000000000000000', claimableEth: '0.001000',
      claim: { to: FEE_SHARE, data: '0xclaim', value: '0x0', chainId: 4663 },
      meta: { agent: TEST_WALLET, bps: 10000 },
    }));

    const claim = await requestRhClaimTx({ apiKey: 'k', token: TOKEN });
    expect(fetchCalls[0]!.url).toBe('https://clawn.ch/api/robinhood/claim');
    expect(fetchCalls[0]!.init?.method).toBe('POST');
    expect((fetchCalls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({ token: TOKEN });
    expect(claim.ready).toBe(true);
    expect(claim.claim?.to).toBe(FEE_SHARE);
  });

  it('reports "not ready" without a transaction and never fakes a claim', async () => {
    queueResponse(jsonResponse({
      ok: true, ready: false, claimableWei: '0', claim: null,
      note: 'Nothing claimable right now.',
    }));

    const claim = await requestRhClaimTx({ apiKey: 'k', token: TOKEN });
    expect(claim.ready).toBe(false);
    expect(claim.claim).toBeNull();
  });

  it('throws when the API claims a balance but returns no transaction', async () => {
    queueResponse(jsonResponse({ ok: true, ready: true, claimableWei: '1000', claim: null }));

    await expect(requestRhClaimTx({ apiKey: 'k', token: TOKEN }))
      .rejects.toThrow(/no transaction to sign/);
  });

  it('surfaces non-JSON responses as transport errors', async () => {
    queueDynamic(() => ({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html>Gateway</html>',
      json: async () => ({}),
    } as unknown as Response));

    await expect(rhApiRequest('/api/robinhood/launches')).rejects.toMatchObject({ code: 'transport' });
  });

  it('blocks non-allowlisted hosts', async () => {
    await expect(rhApiRequest('/api/robinhood/launches', { apiBaseUrl: 'https://evil.example.com' }))
      .rejects.toThrow(/not in the endpoint allowlist|Robinhood Chain API request failed/);
  });
});

// ─── clawnch_launch ───────────────────────────────────────────────────────

describe('clawnch_launch — Robinhood Chain', () => {
  const launchTool = createClawnchLaunchTool();

  beforeEach(() => {
    installFetchMock();
    rhMocks.getRhPublicClient.mockReset();
    rhMocks.sendRhTransaction.mockReset();
    rhMocks.getRhPublicClient.mockResolvedValue(makePublicClient());
    rhMocks.sendRhTransaction.mockResolvedValue(TX_HASH);
    delete process.env.LAUNCH_CHAIN;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.CLAWNCHER_API_KEY;
  });

  it('advertises the chain + mode parameters', () => {
    const props = (launchTool.parameters as any).properties;
    expect(props.chain.enum).toEqual(['base', 'robinhood']);
    expect(props.mode.enum).toEqual(['ticket', 'deposit']);
    expect(props.deposit_tx_hash).toBeDefined();
    expect(props.dry_run).toBeDefined();
  });

  it('requires a connected wallet before anything else', async () => {
    await disconnectWallet();
    const res: any = await launchTool.execute('t', { name: 'N', symbol: 'SYM', chain: 'robinhood' });
    expect(res.content[0]!.text).toContain('No wallet connected');
  });

  it('rejects unknown chains instead of falling back to Base', async () => {
    await connectWallet();
    const res: any = await launchTool.execute('t', { name: 'N', symbol: 'SYM', chain: 'solana' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Unknown chain');
  });

  it('rejects Base-only launch params on Robinhood Chain', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    for (const params of [
      { vault_percentage: 50 },
      { dev_buy_eth: '0.01' },
      { bypass_rate_limit: true },
    ]) {
      const res: any = await launchTool.execute('t', { name: 'N', symbol: 'SYM', chain: 'robinhood', ...params });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('not supported on Robinhood Chain');
    }
    // No API or chain calls were made
    expect(fetchCalls).toHaveLength(0);
  });

  it('errors clearly when the agent API key is missing', async () => {
    await connectWallet();
    const res: any = await launchTool.execute('t', { name: 'N', symbol: 'SYM', chain: 'robinhood' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/agent API key required/i);
  });

  it('runs the ticket path: issue ticket → send → confirm', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    queueResponse(jsonResponse({
      ok: true,
      data: { to: ROUTER, data: '0xlaunchcalldata', value: '0x470de4df820000', chainId: 4663 },
      ticket: { agent: TEST_WALLET, feeRecipient: TEST_WALLET, paramsHash: '0x00', nonce: '1', deadline: '1700000000', signature: '0xsig' },
      meta: { chain: 'robinhood', router: ROUTER, depositAddress: TEST_WALLET, creationFeeWei: '20000000000000000', ttlSeconds: 600 },
    }));
    queueResponse(jsonResponse({
      ok: true,
      launch: { token: TOKEN, agent: TEST_WALLET, name: 'Robin Token', symbol: 'ROBIN', mode: 'ticket', txHash: TX_HASH, chainId: 4663 },
    }));

    const res: any = await launchTool.execute('t', {
      name: 'Robin Token', symbol: 'ROBIN', chain: 'robinhood', description: 'd',
    });

    expect(res.isError).toBeUndefined();
    const payload = res.details as any;
    expect(payload.status).toBe('success');
    expect(payload.chain).toBe('robinhood');
    expect(payload.chainId).toBe(4663);
    expect(payload.mode).toBe('ticket');
    expect(payload.txHash).toBe(TX_HASH);
    expect(payload.tokenAddress).toBe(TOKEN);
    expect(payload.tradeUrl).toBe(`https://bags.fm/token/${TOKEN}`);
    expect(payload.explorerUrl).toBe(`https://robinhoodchain.blockscout.com/address/${TOKEN}`);
    expect(payload.txUrl).toBe(`https://robinhoodchain.blockscout.com/tx/${TX_HASH}`);

    // The transaction handed to the signer is the ticket calldata, on 4663
    const sentTx = rhMocks.sendRhTransaction.mock.calls[0]![0];
    expect(sentTx.to).toBe(ROUTER);
    expect(sentTx.data).toBe('0xlaunchcalldata');
    expect(sentTx.chainId).toBe(4663);

    // API: ticket first, then the confirm call
    expect(fetchCalls[0]!.url).toBe('https://clawn.ch/api/robinhood/ticket');
    expect(fetchCalls[1]!.url).toBe('https://clawn.ch/api/robinhood/launch');
    expect(JSON.parse(String(fetchCalls[1]!.init?.body))).toEqual({ mode: 'confirm', txHash: TX_HASH });
  });

  it('does not send anything on dry_run', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    queueResponse(jsonResponse({
      ok: true,
      data: { to: ROUTER, data: '0xlaunchcalldata', value: '0x470de4df820000', chainId: 4663 },
      ticket: { agent: TEST_WALLET, feeRecipient: TEST_WALLET, paramsHash: '0x00', nonce: '1', deadline: '1700000000', signature: '0xsig' },
      meta: { creationFeeWei: '20000000000000000' },
    }));

    const res: any = await launchTool.execute('t', {
      name: 'Robin Token', symbol: 'ROBIN', chain: 'robinhood', dry_run: true,
    });

    expect((res.details as any).status).toBe('dry_run');
    expect(rhMocks.sendRhTransaction).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
  });

  it('reports a reverted launch transaction instead of confirming it', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    rhMocks.getRhPublicClient.mockResolvedValue(
      makePublicClient({ waitForTransactionReceipt: vi.fn(async () => ({ status: 'reverted' })) }),
    );
    queueResponse(jsonResponse({
      ok: true,
      data: { to: ROUTER, data: '0xlaunchcalldata', value: '0x470de4df820000', chainId: 4663 },
      ticket: { agent: TEST_WALLET, feeRecipient: TEST_WALLET, paramsHash: '0x00', nonce: '1', deadline: '1700000000', signature: '0xsig' },
      meta: { creationFeeWei: '20000000000000000' },
    }));

    const res: any = await launchTool.execute('t', { name: 'Robin Token', symbol: 'ROBIN', chain: 'robinhood' });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('reverted');
    // Only the ticket call happened — no confirm call for a failed tx
    expect(fetchCalls).toHaveLength(1);
  });

  it('returns deposit instructions on deposit dry_run', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    rhMocks.getRhPublicClient.mockResolvedValue(makePublicClient({
      readContract: vi.fn(async ({ functionName }: any) => functionName === 'DEPOSIT_ADDRESS'
        ? '0x3333333333333333333333333333333333333333'
        : 20_000_000_000_000_000n),
    }));

    const res: any = await launchTool.execute('t', {
      name: 'Robin Token', symbol: 'ROBIN', chain: 'robinhood', mode: 'deposit', dry_run: true,
    });

    const payload = res.details as any;
    expect(payload.status).toBe('dry_run');
    expect(payload.depositAddress).toBe('0x3333333333333333333333333333333333333333');
    expect(payload.requiredEth).toBe('0.02');
    expect(payload.next).toContain('deposit_tx_hash');
    expect(rhMocks.sendRhTransaction).not.toHaveBeenCalled();
  });

  it('deposits ETH and submits the deposit launch when no hash is supplied', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    rhMocks.getRhPublicClient.mockResolvedValue(makePublicClient({
      readContract: vi.fn(async ({ functionName }: any) => functionName === 'DEPOSIT_ADDRESS'
        ? '0x3333333333333333333333333333333333333333'
        : 20_000_000_000_000_000n),
    }));
    queueResponse(jsonResponse({
      ok: true,
      launch: { token: TOKEN, agent: TEST_WALLET, mode: 'deposit', txHash: TX_HASH, routerTxHash: '0x' + 'b'.repeat(64) },
    }));

    const res: any = await launchTool.execute('t', {
      name: 'Robin Token', symbol: 'ROBIN', chain: 'robinhood', mode: 'deposit',
    });

    const payload = res.details as any;
    expect(payload.status).toBe('success');
    expect(payload.mode).toBe('deposit');
    expect(payload.tokenAddress).toBe(TOKEN);
    expect(payload.tradeUrl).toBe(`https://bags.fm/token/${TOKEN}`);

    // Deposit tx: 0.02 ETH to the deposit address on chain 4663
    const sentTx = rhMocks.sendRhTransaction.mock.calls[0]![0];
    expect(sentTx.to).toBe('0x3333333333333333333333333333333333333333');
    expect(sentTx.value).toBe('0x470de4df820000');
    expect(sentTx.chainId).toBe(4663);

    const body = JSON.parse(String(fetchCalls[0]!.init?.body));
    expect(body.mode).toBe('deposit');
    expect(body.depositTxHash).toBe(TX_HASH);
    expect(body.agentWallet).toBe(TEST_WALLET);
  });

  it('confirms a pre-existing deposit hash without sending ETH', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    queueResponse(jsonResponse({
      ok: true,
      launch: { token: TOKEN, agent: TEST_WALLET, mode: 'deposit', txHash: TX_HASH },
    }));

    const res: any = await launchTool.execute('t', {
      name: 'Robin Token', symbol: 'ROBIN', chain: 'robinhood', mode: 'deposit',
      deposit_tx_hash: '0x' + 'c'.repeat(64),
    });

    expect((res.details as any).status).toBe('success');
    expect(rhMocks.sendRhTransaction).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetchCalls[0]!.init?.body));
    expect(body.depositTxHash).toBe('0x' + 'c'.repeat(64));
  });

  it('blocks the launch when the RHC balance cannot cover the creation fee', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    rhMocks.getRhPublicClient.mockResolvedValue(makePublicClient({
      getBalance: vi.fn(async () => 1_000_000_000_000n), // 0.000001 ETH
    }));
    queueResponse(jsonResponse({
      ok: true,
      data: { to: ROUTER, data: '0xlaunchcalldata', value: '0x470de4df820000', chainId: 4663 },
      ticket: { agent: TEST_WALLET, feeRecipient: TEST_WALLET, paramsHash: '0x00', nonce: '1', deadline: '1700000000', signature: '0xsig' },
      meta: { creationFeeWei: '20000000000000000' },
    }));

    const res: any = await launchTool.execute('t', { name: 'Robin Token', symbol: 'ROBIN', chain: 'robinhood' });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Insufficient ETH on Robinhood Chain');
    expect(rhMocks.sendRhTransaction).not.toHaveBeenCalled();
  });

  it('defaults to the Base path when no chain is given (Base behavior preserved)', async () => {
    await connectWallet();
    // No API key set → the Base path fails on the key, proving it is not the RHC path
    const res: any = await launchTool.execute('t', { name: 'N', symbol: 'SYM' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('https://clawn.ch/agents');
    expect(fetchCalls).toHaveLength(0);
  });

  it('rejects Robinhood-only options when no chain is given (no silent ignoring)', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    for (const params of [{ mode: 'deposit' }, { deposit_tx_hash: '0x' + 'd'.repeat(64) }, { dry_run: true }]) {
      const res: any = await launchTool.execute('t', { name: 'N', symbol: 'SYM', ...params });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('is a Robinhood Chain launch option');
    }
    expect(fetchCalls).toHaveLength(0);
  });

  it('honors LAUNCH_CHAIN=robinhood as the default chain', async () => {
    await connectWallet();
    process.env.LAUNCH_CHAIN = 'robinhood';
    const res: any = await launchTool.execute('t', {
      name: 'N', symbol: 'SYM', vault_percentage: 10,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not supported on Robinhood Chain');
    delete process.env.LAUNCH_CHAIN;
  });
});

// ─── clawnch_fees ─────────────────────────────────────────────────────────

describe('clawnch_fees — Robinhood Chain', () => {
  const feesTool = createClawnchFeesTool();

  beforeEach(() => {
    installFetchMock();
    rhMocks.getRhPublicClient.mockReset();
    rhMocks.sendRhTransaction.mockReset();
    rhMocks.getRhPublicClient.mockResolvedValue(makePublicClient());
    rhMocks.sendRhTransaction.mockResolvedValue(TX_HASH);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLAWNCHER_API_KEY;
  });

  it('requires a connected wallet', async () => {
    await disconnectWallet();
    const res: any = await feesTool.execute('t', { action: 'check', chain: 'robinhood' });
    expect(res.content[0]!.text).toContain('No wallet connected');
  });

  it('checks claimable fees for every launch of the agent', async () => {
    await connectWallet();

    // 1) launches feed
    queueResponse(jsonResponse({
      ok: true,
      launches: [
        { token: TOKEN, agent: TEST_WALLET, mode: 'ticket', txHash: TX_HASH },
        { token: '0x4444444444444444444444444444444444444444', agent: TEST_WALLET, mode: 'deposit', txHash: TX_HASH },
      ],
      pagination: { limit: 200, offset: 0, total: 2, hasMore: false },
    }));
    // 2) claim read per token
    queueResponse(jsonResponse({
      ok: true, feeShare: FEE_SHARE, isClaimer: true, bps: 10000, claimableWei: '1000000000000000',
      claim: { to: FEE_SHARE, data: '0xclaim', value: '0x0', chainId: 4663 },
    }));
    queueResponse(jsonResponse({
      ok: true, feeShare: FEE_SHARE, isClaimer: true, bps: 10000, claimableWei: '0', claim: null,
    }));

    const res: any = await feesTool.execute('t', { action: 'check', chain: 'robinhood' });

    const payload = res.details as any;
    expect(payload.chain).toBe('robinhood');
    expect(payload.chainId).toBe(4663);
    expect(payload.tokenCount).toBe(2);
    expect(payload.claimableCount).toBe(1);
    expect(payload.totalClaimableWei).toBe('1000000000000000');
    expect(payload.tokens[0].tradeUrl).toBe(`https://bags.fm/token/${TOKEN}`);
    expect(payload.tokens[0].explorerUrl).toBe(`https://robinhoodchain.blockscout.com/token/${TOKEN}`);

    expect(fetchCalls[0]!.url).toContain(`/api/robinhood/launches?agent=${TEST_WALLET}`);
    expect(fetchCalls[1]!.url).toContain('/api/robinhood/claim?token=');
  });

  it('checks a single token when one is passed', async () => {
    await connectWallet();
    queueResponse(jsonResponse({
      ok: true, feeShare: FEE_SHARE, isClaimer: false, bps: 0, claimableWei: '0', claim: null,
    }));

    const res: any = await feesTool.execute('t', { action: 'check', chain: 'robinhood', token: TOKEN });

    expect((res.details as any).tokenCount).toBe(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain(`token=${TOKEN}`);
  });

  it('claims a token: request unsigned tx → sign → report explorer link', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    queueResponse(jsonResponse({
      ok: true, ready: true, claimableWei: '5000000000000000', claimableEth: '0.005000',
      claim: { to: FEE_SHARE, data: '0xclaim', value: '0x0', chainId: 4663 },
      meta: { agent: TEST_WALLET, bps: 10000 },
    }));

    const res: any = await feesTool.execute('t', { action: 'claim', chain: 'robinhood', token: TOKEN });

    const payload = res.details as any;
    expect(payload.status).toBe('success');
    expect(payload.txHash).toBe(TX_HASH);
    expect(payload.claimableEth).toBe('0.005000');
    expect(payload.feeShare).toBe(FEE_SHARE);
    expect(payload.txUrl).toBe(`https://robinhoodchain.blockscout.com/tx/${TX_HASH}`);

    const sentTx = rhMocks.sendRhTransaction.mock.calls[0]![0];
    expect(sentTx.to).toBe(FEE_SHARE);
    expect(sentTx.chainId).toBe(4663);
    expect(fetchCalls[0]!.url).toBe('https://clawn.ch/api/robinhood/claim');
    expect((fetchCalls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer test-agent-key');
  });

  it('does not send a transaction when nothing is claimable', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    queueResponse(jsonResponse({
      ok: true, ready: false, claimableWei: '0', claim: null,
      note: 'Nothing claimable right now.',
    }));

    const res: any = await feesTool.execute('t', { action: 'claim', chain: 'robinhood', token: TOKEN });

    expect((res.details as any).status).toBe('nothing_to_claim');
    expect(rhMocks.sendRhTransaction).not.toHaveBeenCalled();
  });

  it('claim_all walks the launch feed and claims each funded token', async () => {
    await connectWallet();
    process.env.CLAWNCHER_API_KEY = 'test-agent-key';

    queueResponse(jsonResponse({
      ok: true,
      launches: [{ token: TOKEN, agent: TEST_WALLET, mode: 'ticket', txHash: TX_HASH }],
      pagination: { limit: 200, offset: 0, total: 1, hasMore: false },
    }));
    queueResponse(jsonResponse({
      ok: true, feeShare: FEE_SHARE, isClaimer: true, bps: 10000, claimableWei: '2000000000000000',
      claim: { to: FEE_SHARE, data: '0xclaim', value: '0x0', chainId: 4663 },
    }));
    queueResponse(jsonResponse({
      ok: true, ready: true, claimableWei: '2000000000000000', claimableEth: '0.002000',
      claim: { to: FEE_SHARE, data: '0xclaim', value: '0x0', chainId: 4663 },
      meta: { agent: TEST_WALLET, bps: 10000 },
    }));

    const res: any = await feesTool.execute('t', { action: 'claim_all', chain: 'robinhood' });

    const payload = res.details as any;
    expect(payload.status).toBe('complete');
    expect(payload.tokensProcessed).toBe(1);
    expect(payload.successCount).toBe(1);
    expect(payload.failureCount).toBe(0);
    expect(rhMocks.sendRhTransaction).toHaveBeenCalledTimes(1);
  });

  it('reports nothing_to_claim when the agent has no launches', async () => {
    await connectWallet();
    queueResponse(jsonResponse({ ok: true, launches: [], pagination: { limit: 200, offset: 0, total: 0, hasMore: false } }));

    const res: any = await feesTool.execute('t', { action: 'claim_all', chain: 'robinhood' });

    expect((res.details as any).message).toContain('No Robinhood Chain launches found');
    expect(rhMocks.sendRhTransaction).not.toHaveBeenCalled();
  });

  it('surfaces API failures without touching Base', async () => {
    await connectWallet();
    queueResponse(jsonResponse({ ok: false, error: 'Claim lookup failed', code: 'claim_error' }, 500));

    const res: any = await feesTool.execute('t', { action: 'check', chain: 'robinhood', token: TOKEN });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Robinhood Chain fee claim failed');
    expect(rhMocks.sendRhTransaction).not.toHaveBeenCalled();
  });

  it('keeps Base as the default chain for fee actions', async () => {
    await connectWallet();
    const res: any = await feesTool.execute('t', { action: 'claim' });
    // Base path requires a token param before anything else
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/token/i);
    expect(rhMocks.sendRhTransaction).not.toHaveBeenCalled();
  });
});

// ─── clawnch_info ─────────────────────────────────────────────────────────

describe('clawnch_info — Robinhood Chain', () => {
  const infoTool = createClawnchInfoTool();

  beforeEach(() => {
    installFetchMock();
    rhMocks.getRhPublicClient.mockReset();
    rhMocks.getRhPublicClient.mockResolvedValue(makePublicClient({
      readContract: vi.fn(async ({ functionName }: any) => {
        switch (functionName) {
          case 'name': return 'Robin Token';
          case 'symbol': return 'ROBIN';
          case 'decimals': return 18;
          case 'totalSupply': return 1_000_000n * 10n ** 18n;
          case 'balanceOf': return 5n * 10n ** 18n;
          case 'feeShareForToken': return FEE_SHARE;
          case 'creationFee': return 20_000_000_000_000_000n;
          default: return undefined;
        }
      }),
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('reads RHC token info with Blockscout + bags.fm links', async () => {
    queueResponse(jsonResponse({
      ok: true,
      launches: [{
        token: TOKEN, agent: TEST_WALLET, name: 'Robin Token', symbol: 'ROBIN', mode: 'ticket',
        txHash: TX_HASH, launchedAt: '2026-09-01T00:00:00.000Z',
        tradeUrl: `https://bags.fm/token/${TOKEN}`,
        explorerUrl: `https://robinhoodchain.blockscout.com/token/${TOKEN}`,
      }],
      pagination: { limit: 200, offset: 0, total: 1, hasMore: false },
    }));

    const res: any = await infoTool.execute('t', { action: 'token_info', chain: 'robinhood', token: TOKEN });

    const payload = res.details as any;
    expect(payload.chain).toBe('robinhood');
    expect(payload.chainId).toBe(4663);
    expect(payload.name).toBe('Robin Token');
    expect(payload.symbol).toBe('ROBIN');
    expect(payload.decimals).toBe(18);
    expect(payload.isClawnchToken).toBe(true);
    expect(payload.launchMode).toBe('ticket');
    expect(payload.feeShare).toBe(FEE_SHARE);
    expect(payload.tradeUrl).toBe(`https://bags.fm/token/${TOKEN}`);
    expect(payload.explorerUrl).toBe(`https://robinhoodchain.blockscout.com/token/${TOKEN}`);
    expect(payload.explorerAddressUrl).toBe(`https://robinhoodchain.blockscout.com/address/${TOKEN}`);
    expect(payload.bagsCreationFeeEth).toBe('0.02');
  });

  it('rejects a malformed token address before any read', async () => {
    const res: any = await infoTool.execute('t', { action: 'token_info', chain: 'robinhood', token: 'not-an-address' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('0x address');
  });

  it('raises a clear not-supported error for vault_claim on RHC', async () => {
    queueResponse(jsonResponse({ ok: true }));
    const res: any = await infoTool.execute('t', { action: 'vault_claim', chain: 'robinhood', token: TOKEN });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not supported on Robinhood Chain');
    expect(res.content[0]!.text).toContain('vault_claim');
    // Never touched the Base vault reader or the launch feed
    expect(fetchCalls).toHaveLength(0);
    expect(rhMocks.getRhPublicClient).not.toHaveBeenCalled();
  });

  it('lists RHC launches with trade + explorer links', async () => {
    queueResponse(jsonResponse({
      ok: true,
      launches: [{
        token: TOKEN, agent: TEST_WALLET, name: 'Robin Token', symbol: 'ROBIN', mode: 'deposit',
        txHash: TX_HASH, launchedAt: '2026-09-01T00:00:00.000Z',
        tradeUrl: `https://bags.fm/token/${TOKEN}`,
        explorerUrl: `https://robinhoodchain.blockscout.com/token/${TOKEN}`,
        txUrl: `https://robinhoodchain.blockscout.com/tx/${TX_HASH}`,
      }],
      pagination: { limit: 20, offset: 0, total: 1, hasMore: false },
    }));

    const res: any = await infoTool.execute('t', { action: 'list_tokens', chain: 'robinhood', page: 1, page_size: 20 });

    const payload = res.details as any;
    expect(payload.chain).toBe('robinhood');
    expect(payload.total).toBe(1);
    expect(payload.tokens[0].address).toBe(TOKEN);
    expect(payload.tokens[0].tradeUrl).toBe(`https://bags.fm/token/${TOKEN}`);
    expect(payload.tokens[0].explorerUrl).toBe(`https://robinhoodchain.blockscout.com/token/${TOKEN}`);
    expect(payload.tokens[0].txUrl).toBe(`https://robinhoodchain.blockscout.com/tx/${TX_HASH}`);
    expect(payload.tokens[0].priceUsd).toBeNull();
    expect(fetchCalls[0]!.url).toContain('/api/robinhood/launches');
  });

  it('builds an RHC portfolio from launches + on-chain balances', async () => {
    queueResponse(jsonResponse({
      ok: true,
      launches: [{ token: TOKEN, agent: TEST_WALLET, name: 'Robin Token', symbol: 'ROBIN', mode: 'ticket', txHash: TX_HASH }],
      pagination: { limit: 200, offset: 0, total: 1, hasMore: false },
    }));

    const res: any = await infoTool.execute('t', { action: 'portfolio', chain: 'robinhood', address: TEST_WALLET });

    const payload = res.details as any;
    expect(payload.chain).toBe('robinhood');
    expect(payload.ethBalance).toBe('1');
    expect(payload.launchCount).toBe(1);
    expect(payload.tokens[0].balance).toBe('5');
    expect(payload.tokens[0].tradeUrl).toBe(`https://bags.fm/token/${TOKEN}`);
  });

  it('reports RHC launch totals for platform_stats', async () => {
    queueResponse(jsonResponse({
      ok: true, launches: [{ token: TOKEN, agent: TEST_WALLET, mode: 'ticket', txHash: TX_HASH }],
      pagination: { limit: 1, offset: 0, total: 42, hasMore: true },
    }));
    queueResponse(jsonResponse({
      ok: true, launches: [], pagination: { limit: 5, offset: 0, total: 42, hasMore: true },
    }));

    const res: any = await infoTool.execute('t', { action: 'platform_stats', chain: 'robinhood' });

    const payload = res.details as any;
    expect(payload.chain).toBe('robinhood');
    expect(payload.totalAgenticLaunches).toBe(42);
    expect(payload.router).toBe(ROUTER);
  });
});