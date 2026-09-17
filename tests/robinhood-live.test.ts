/**
 * Robinhood Chain — LIVE read-only verification (opt-in).
 *
 * Hits the real Robinhood Chain RPC + the public Clawnch API endpoints used by
 * the RHC tools. No transactions, no writes, no API key required.
 *
 * Run explicitly:
 *   RH_LIVE=1 npx vitest run tests/robinhood-live.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  ROBINHOOD,
  TOKENS,
  explorerTxUrl,
  tradeUrl,
} from '../extensions/crypto/src/lib/contract-registry.js';
import {
  RH_CHAIN_ID,
  RH_DEPOSIT_MIN_WEI,
  RH_LAUNCH_ROUTER,
  RH_BAGS_FACTORY,
  getRhPublicClient,
  readRhDepositAddress,
  readRhBagsCreationFee,
  readRhTokenInfo,
  getRhLaunches,
  readRhClaim,
} from '../extensions/crypto/src/lib/robinhood-api.js';
import { createClawnchInfoTool } from '../extensions/crypto/src/tools/clawnch-info.js';

const LIVE = process.env.RH_LIVE === '1';
const describeLive = LIVE ? describe : describe.skip;

describeLive('Robinhood Chain live (read-only)', () => {
  it('RPC reports chainId 4663', async () => {
    const client = await getRhPublicClient();
    const chainId = await client.getChainId();
    console.log('[live] RHC chainId:', chainId);
    expect(chainId).toBe(4663);
  });

  it('router exposes its Bags factory + deposit address on-chain', async () => {
    const client = await getRhPublicClient();
    const code = await client.getBytecode({ address: RH_LAUNCH_ROUTER });
    expect(code && code !== '0x').toBe(true);

    const factory = await client.readContract({
      address: RH_LAUNCH_ROUTER,
      abi: [{ type: 'function', name: 'BAGS_FACTORY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
      functionName: 'BAGS_FACTORY',
    });
    const depositAddress = await readRhDepositAddress(client);
    const creationFee = await readRhBagsCreationFee(client);

    console.log('[live] router BAGS_FACTORY:', factory);
    console.log('[live] router DEPOSIT_ADDRESS:', depositAddress);
    console.log('[live] Bags creationFee (wei):', creationFee.toString());

    expect(String(factory).toLowerCase()).toBe(RH_BAGS_FACTORY.toLowerCase());
    expect(depositAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The live Bags creation fee is currently 0; the 0.02 ETH floor is enforced
    // by the API (DEPOSIT_MIN_WEI) and mirrored by RH_DEPOSIT_MIN_WEI client-side.
    expect(creationFee).toBeGreaterThanOrEqual(0n);
    expect(creationFee > RH_DEPOSIT_MIN_WEI ? creationFee : RH_DEPOSIT_MIN_WEI).toBe(RH_DEPOSIT_MIN_WEI);
  });

  it('reads the RHC $CLAWNCH token from chain', async () => {
    const info = await readRhTokenInfo(TOKENS.robinhood.CLAWNCH);
    console.log('[live] RHC $CLAWNCH:', JSON.stringify(info));
    expect(info.name).toBeTruthy();
    expect(info.symbol).toBeTruthy();
    expect(info.decimals).toBe(18);
  });

  it('serves the public launch feed with bags.fm + Blockscout links', async () => {
    const feed = await getRhLaunches({ limit: 5 });
    console.log('[live] RHC launch feed total:', feed.pagination.total);
    expect(Array.isArray(feed.launches)).toBe(true);
    for (const launch of feed.launches) {
      expect(launch.tradeUrl ?? tradeUrl('robinhood', launch.token)).toContain('bags.fm/token/');
      expect(launch.txUrl ?? explorerTxUrl('robinhood', launch.txHash)).toContain('robinhoodchain.blockscout.com');
    }
  });

  it('answers the claim read endpoint for a non-Bags token with a clear error', async () => {
    const res = await readRhClaim({ token: TOKENS.robinhood.CLAWNCH, address: ROBINHOOD.launchRouter })
      .then(v => ({ ok: true as const, v }))
      .catch(e => ({ ok: false as const, v: e as Error }));
    console.log('[live] claim read:', res.ok ? JSON.stringify(res.v) : res.v.message);

    // $CLAWNCH on RHC is not a Bags token → the API answers 404 no_fee_share and
    // the client surfaces it as a coded RobinhoodChainError (never a zero balance).
    if (!res.ok) {
      expect(res.v.message).toContain('No fee share found');
      expect((res.v as any).code).toBe('no_fee_share');
    } else {
      expect(res.v.token.toLowerCase()).toBe(TOKENS.robinhood.CLAWNCH.toLowerCase());
    }
  });

  it('clawnch_info rejects vault_claim on robinhood with the not-supported error', async () => {
    const tool = createClawnchInfoTool();
    const res: any = await tool.execute('live', { action: 'vault_claim', chain: 'robinhood', token: TOKENS.robinhood.CLAWNCH });
    console.log('[live] vault_claim on RHC:', res.content[0].text);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not supported on Robinhood Chain');
  });

  it('clawnch_info lists live RHC tokens with chain-native links', async () => {
    const tool = createClawnchInfoTool();
    const res: any = await tool.execute('live', { action: 'list_tokens', chain: 'robinhood', page: 1, page_size: 5 });
    console.log('[live] list_tokens(RHC) total:', res.details?.total);
    expect(res.isError).toBeUndefined();
    expect(res.details.chain).toBe('robinhood');
    expect(res.details.chainId).toBe(RH_CHAIN_ID);
  });
});