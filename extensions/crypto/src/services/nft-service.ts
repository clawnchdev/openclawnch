/**
 * NFT Service — Reservoir API client for NFT operations.
 *
 * Supports:
 *   - Collection floor prices and metadata
 *   - Token viewing and metadata resolution
 *   - Portfolio listing (user's NFTs)
 *   - Buy/list/offer execution via Reservoir order flow
 *   - Transfer via standard ERC-721 safeTransferFrom
 *
 * Uses Reservoir API (covers OpenSea, Blur, LooksRare marketplaces).
 * Requires RESERVOIR_API_KEY env var (free tier: 4 req/sec).
 */

import { getCredentialVault } from './credential-vault.js';
import { guardedFetch } from './endpoint-allowlist.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface NftToken {
  contract: string;
  tokenId: string;
  name: string | null;
  description: string | null;
  image: string | null;
  collection: string | null;
  owner: string | null;
  lastSalePrice: string | null;
  rarity: number | null;
  attributes: Array<{ key: string; value: string }>;
  chain: string;
}

export interface NftCollection {
  id: string;
  name: string;
  image: string | null;
  floorPrice: string | null;
  floorPriceCurrency: string;
  volume24h: string | null;
  totalSupply: number | null;
  ownerCount: number | null;
  chain: string;
}

export interface NftPortfolioItem {
  contract: string;
  tokenId: string;
  name: string | null;
  image: string | null;
  collection: string | null;
  floorPrice: string | null;
  lastSalePrice: string | null;
  acquiredAt: string | null;
}

export interface NftBuyResult {
  status: string;
  orderId: string | null;
  txData: { to: string; data: string; value: string } | null;
  price: string | null;
  marketplace: string | null;
}

export interface NftListResult {
  status: string;
  orderId: string | null;
  steps: any[];
}

// ── Chain Configuration ─────────────────────────────────────────────────────

const CHAIN_API_BASE: Record<number, string> = {
  1: 'https://api.reservoir.tools',
  8453: 'https://api-base.reservoir.tools',
  42161: 'https://api-arbitrum.reservoir.tools',
  10: 'https://api-optimism.reservoir.tools',
  137: 'https://api-polygon.reservoir.tools',
};

const CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon',
};

// ── ERC-721 Minimal ABI ─────────────────────────────────────────────────────

export const ERC721_TRANSFER_ABI = [
  {
    name: 'safeTransferFrom',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    name: 'ownerOf',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── Service ─────────────────────────────────────────────────────────────────

export class NftService {
  private metadataCache = new Map<string, { data: NftToken; ts: number }>();
  private readonly CACHE_TTL = 300_000; // 5 minutes

  getApiKey(): string | null {
    return getCredentialVault().getSecret('nft.reservoir.apiKey', 'nft');
  }

  private getApiBase(chainId: number): string {
    return CHAIN_API_BASE[chainId] ?? CHAIN_API_BASE[8453]!;
  }

  private async reservoirFetch(
    chainId: number,
    path: string,
    params?: Record<string, string>,
    method = 'GET',
    body?: unknown,
  ): Promise<any> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'RESERVOIR_API_KEY not configured. Get a free key at https://reservoir.tools ' +
        'then set: /flykeys set RESERVOIR_API_KEY your_key',
      );
    }

    const base = this.getApiBase(chainId);
    const url = new URL(path, base);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'x-api-key': apiKey,
    };
    if (body) headers['Content-Type'] = 'application/json';

    const response = await guardedFetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Reservoir API ${response.status}: ${text || response.statusText}`);
    }

    return response.json();
  }

  // ── Token View ─────────────────────────────────────────────────────

  async getToken(contract: string, tokenId: string, chainId = 8453): Promise<NftToken> {
    const cacheKey = `${chainId}:${contract}:${tokenId}`;
    const cached = this.metadataCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) return cached.data;

    const data = await this.reservoirFetch(chainId, '/tokens/v7', {
      tokens: `${contract}:${tokenId}`,
      includeAttributes: 'true',
      includeLastSale: 'true',
    });

    const token = data.tokens?.[0]?.token;
    if (!token) throw new Error(`Token not found: ${contract}:${tokenId}`);

    const result: NftToken = {
      contract: token.contract,
      tokenId: token.tokenId,
      name: token.name ?? null,
      description: token.description ?? null,
      image: token.image ?? token.imageSmall ?? null,
      collection: token.collection?.name ?? null,
      owner: token.owner ?? data.tokens?.[0]?.ownership?.owner ?? null,
      lastSalePrice: data.tokens?.[0]?.market?.lastSale?.price?.amount?.native
        ? `${data.tokens[0].market.lastSale.price.amount.native} ETH`
        : null,
      rarity: token.rarityRank ?? null,
      attributes: (token.attributes ?? []).map((a: any) => ({
        key: a.key,
        value: a.value,
      })),
      chain: CHAIN_NAMES[chainId] ?? String(chainId),
    };

    this.metadataCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  // ── Collection Floor ───────────────────────────────────────────────

  async getCollectionFloor(collectionIdOrSlug: string, chainId = 8453): Promise<NftCollection> {
    // Try as collection ID (contract address) first, then as slug
    const params: Record<string, string> = collectionIdOrSlug.startsWith('0x')
      ? { id: collectionIdOrSlug }
      : { slug: collectionIdOrSlug };

    const data = await this.reservoirFetch(chainId, '/collections/v7', {
      ...params,
      includeOwnerCount: 'true',
    });

    const collection = data.collections?.[0];
    if (!collection) throw new Error(`Collection not found: ${collectionIdOrSlug}`);

    return {
      id: collection.id,
      name: collection.name ?? 'Unknown',
      image: collection.image ?? null,
      floorPrice: collection.floorAsk?.price?.amount?.native
        ? `${collection.floorAsk.price.amount.native}`
        : null,
      floorPriceCurrency: collection.floorAsk?.price?.currency?.symbol ?? 'ETH',
      volume24h: collection.volume?.['1day'] !== undefined
        ? `${collection.volume['1day']}`
        : null,
      totalSupply: collection.tokenCount ? parseInt(collection.tokenCount) : null,
      ownerCount: collection.ownerCount ? parseInt(collection.ownerCount) : null,
      chain: CHAIN_NAMES[chainId] ?? String(chainId),
    };
  }

  // ── Portfolio ──────────────────────────────────────────────────────

  async getPortfolio(
    ownerAddress: string,
    chainId = 8453,
    limit = 50,
  ): Promise<NftPortfolioItem[]> {
    const data = await this.reservoirFetch(chainId, '/users/tokens/v10', {
      users: ownerAddress,
      limit: String(Math.min(limit, 200)),
      includeLastSale: 'true',
      sortBy: 'acquiredAt',
      sortDirection: 'desc',
    });

    const tokens: any[] = data.tokens ?? [];

    return tokens.map((item: any) => ({
      contract: item.token?.contract ?? '',
      tokenId: item.token?.tokenId ?? '',
      name: item.token?.name ?? null,
      image: item.token?.image ?? item.token?.imageSmall ?? null,
      collection: item.token?.collection?.name ?? null,
      floorPrice: item.token?.collection?.floorAskPrice?.amount?.native
        ? `${item.token.collection.floorAskPrice.amount.native} ETH`
        : null,
      lastSalePrice: item.market?.lastSale?.price?.amount?.native
        ? `${item.market.lastSale.price.amount.native} ETH`
        : null,
      acquiredAt: item.ownership?.acquiredAt ?? null,
    }));
  }

  // ── Buy ────────────────────────────────────────────────────────────

  async getBuyOrder(
    contract: string,
    tokenId: string,
    takerAddress: string,
    chainId = 8453,
  ): Promise<NftBuyResult> {
    const data = await this.reservoirFetch(
      chainId,
      '/execute/buy/v7',
      {},
      'POST',
      {
        items: [{ token: `${contract}:${tokenId}`, quantity: 1 }],
        taker: takerAddress,
        skipBalanceCheck: false,
      },
    );

    const step = data.steps?.[0];
    const item = step?.items?.[0];

    return {
      status: item?.status ?? data.message ?? 'unknown',
      orderId: item?.orderId ?? null,
      txData: item?.data
        ? { to: item.data.to, data: item.data.data, value: item.data.value ?? '0' }
        : null,
      price: data.path?.[0]?.buyInQuote
        ? `${data.path[0].buyInQuote} ${data.path[0].buyInCurrency?.symbol ?? 'ETH'}`
        : null,
      marketplace: data.path?.[0]?.source ?? null,
    };
  }

  // ── List (Sell) ────────────────────────────────────────────────────

  async getListOrder(
    contract: string,
    tokenId: string,
    makerAddress: string,
    priceWei: string,
    chainId = 8453,
    expirationDays = 30,
  ): Promise<NftListResult> {
    const expiration = Math.floor(Date.now() / 1000) + expirationDays * 86400;

    const data = await this.reservoirFetch(
      chainId,
      '/execute/list/v5',
      {},
      'POST',
      {
        maker: makerAddress,
        token: `${contract}:${tokenId}`,
        weiPrice: priceWei,
        expirationTime: String(expiration),
        orderbook: 'reservoir',
      },
    );

    return {
      status: data.steps?.[0]?.items?.[0]?.status ?? 'pending',
      orderId: data.steps?.[0]?.items?.[0]?.orderId ?? null,
      steps: data.steps ?? [],
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: NftService | null = null;

export function getNftService(): NftService {
  if (!_instance) {
    _instance = new NftService();
  }
  return _instance;
}

export function resetNftService(): void {
  _instance = null;
}
