/**
 * NFT Tool — view, transfer, buy, list, and manage NFTs.
 *
 * Actions:
 *   view             — View NFT metadata, image, attributes
 *   transfer         — Transfer an NFT to another address
 *   buy              — Buy an NFT listed on marketplaces
 *   list             — List an NFT for sale
 *   collection_floor — Get collection floor price and stats
 *   portfolio        — View all NFTs owned by an address
 *
 * Uses Reservoir API (covers OpenSea, Blur, LooksRare).
 * Requires RESERVOIR_API_KEY env var.
 */

import { Type } from '@sinclair/typebox';
import { parseEther } from 'viem';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { getNftService, ERC721_TRANSFER_ABI } from '../services/nft-service.js';
import { resolveAddressOrEns, isEnsName } from '../lib/ens-resolver.js';

const ACTIONS = ['view', 'transfer', 'buy', 'list', 'collection_floor', 'portfolio'] as const;

const NftSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'view: NFT metadata and attributes. transfer: send NFT to address. ' +
      'buy: purchase listed NFT. list: list NFT for sale. ' +
      'collection_floor: floor price and stats. portfolio: all owned NFTs.',
  }),
  contract: Type.Optional(Type.String({
    description: 'NFT contract address (0x...). Required for view, transfer, buy, list.',
  })),
  token_id: Type.Optional(Type.String({
    description: 'Token ID within the collection. Required for view, transfer, buy, list.',
  })),
  to: Type.Optional(Type.String({
    description: 'Recipient address or ENS name. Required for transfer.',
  })),
  price: Type.Optional(Type.String({
    description: 'Listing price in ETH (e.g. "0.5"). Required for list.',
  })),
  collection: Type.Optional(Type.String({
    description: 'Collection contract address or slug. Required for collection_floor.',
  })),
  chain: Type.Optional(Type.String({
    description: 'Chain: "base" (default), "ethereum", "arbitrum", "optimism", "polygon".',
  })),
  address: Type.Optional(Type.String({
    description: 'Wallet address for portfolio. Defaults to connected wallet.',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Max results for portfolio. Default: 50.',
  })),
});

export function createNftTool() {
  return {
    name: 'nft',
    label: 'NFT',
    ownerOnly: true,
    description:
      'View, transfer, buy, list, and manage NFTs. Supports collections on Base, Ethereum, ' +
      'Arbitrum, Optimism, and Polygon. Uses Reservoir API for marketplace data ' +
      '(covers OpenSea, Blur, LooksRare). Requires RESERVOIR_API_KEY.',
    parameters: NftSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'view':
          return handleView(params);
        case 'transfer':
          return handleTransfer(params);
        case 'buy':
          return handleBuy(params);
        case 'list':
          return handleList(params);
        case 'collection_floor':
          return handleCollectionFloor(params);
        case 'portfolio':
          return handlePortfolio(params);
        default:
          return errorResult(`Unknown action: ${action}. Use: view, transfer, buy, list, collection_floor, portfolio`);
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveChainId(chain?: string): number {
  if (!chain) return 8453;
  switch (chain.toLowerCase()) {
    case 'ethereum': case 'eth': case 'mainnet': return 1;
    case 'arbitrum': case 'arb': return 42161;
    case 'optimism': case 'op': return 10;
    case 'polygon': case 'matic': return 137;
    case 'base': default: return 8453;
  }
}

function chainName(chainId: number): string {
  const names: Record<number, string> = {
    1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon',
  };
  return names[chainId] ?? String(chainId);
}

/** Validate token ID is a non-negative integer string. */
function validateTokenId(tokenId: string): bigint {
  const trimmed = tokenId.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid token ID "${trimmed}". Must be a non-negative integer.`);
  }
  return BigInt(trimmed);
}

/** Validate and parse an ETH price string. */
function validatePrice(price: string): bigint {
  const trimmed = price.trim();
  if (!trimmed) throw new Error('Price cannot be empty.');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid price "${trimmed}". Must be a positive number (e.g. "0.5", "1.0").`);
  }
  const parsed = parseFloat(trimmed);
  if (parsed === 0) throw new Error('Price must be greater than zero.');
  return parseEther(trimmed);
}

// ── Action Handlers ─────────────────────────────────────────────────────────

async function handleView(params: Record<string, unknown>) {
  const contract = readStringParam(params, 'contract', { required: true });
  const tokenId = readStringParam(params, 'token_id') ?? readStringParam(params, 'tokenId');
  if (!contract || !tokenId) {
    return errorResult('Both contract and token_id are required for view.');
  }

  const chainId = resolveChainId(readStringParam(params, 'chain'));

  try {
    const service = getNftService();
    const token = await service.getToken(contract, tokenId, chainId);

    return jsonResult({
      chain: token.chain,
      contract: token.contract,
      tokenId: token.tokenId,
      name: token.name,
      description: token.description,
      image: token.image,
      collection: token.collection,
      owner: token.owner,
      lastSale: token.lastSalePrice,
      rarityRank: token.rarity,
      attributes: token.attributes.length > 0 ? token.attributes : undefined,
    });
  } catch (err) {
    return errorResult(`NFT view failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleTransfer(params: Record<string, unknown>) {
  const contract = readStringParam(params, 'contract', { required: true });
  const tokenId = readStringParam(params, 'token_id') ?? readStringParam(params, 'tokenId');
  const toInput = readStringParam(params, 'to', { required: true });
  if (!contract || !tokenId || !toInput) {
    return errorResult('contract, token_id, and to are required for transfer.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  try {
    // Resolve ENS if needed
    let toAddress = toInput;
    if (isEnsName(toInput)) {
      const publicClient = requirePublicClient();
      const resolved = await resolveAddressOrEns(toInput, publicClient);
      toAddress = resolved.address;
    }

    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const hash = await wallet.writeContract({
      address: contract as `0x${string}`,
      abi: ERC721_TRANSFER_ABI,
      functionName: 'safeTransferFrom',
      args: [
        state.address as `0x${string}`,
        toAddress as `0x${string}`,
        validateTokenId(tokenId),
      ],
    });

    await publicClient.waitForTransactionReceipt({ hash });

    return jsonResult({
      status: 'success',
      action: 'transfer',
      contract,
      tokenId,
      from: state.address,
      to: toAddress,
      ensName: isEnsName(toInput) ? toInput : undefined,
      txHash: hash,
    });
  } catch (err) {
    return errorResult(`NFT transfer failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleBuy(params: Record<string, unknown>) {
  const contract = readStringParam(params, 'contract', { required: true });
  const tokenId = readStringParam(params, 'token_id') ?? readStringParam(params, 'tokenId');
  if (!contract || !tokenId) {
    return errorResult('Both contract and token_id are required for buy.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const chainId = resolveChainId(readStringParam(params, 'chain'));

  try {
    const service = getNftService();
    const buyOrder = await service.getBuyOrder(contract, tokenId, state.address, chainId);

    if (!buyOrder.txData) {
      return jsonResult({
        status: 'no_listing',
        contract,
        tokenId,
        message: buyOrder.status || 'No active listing found for this NFT.',
      });
    }

    // Execute the buy transaction
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();
    const hash = await wallet.sendTransaction({
      to: buyOrder.txData.to as `0x${string}`,
      data: buyOrder.txData.data as `0x${string}`,
      value: BigInt(buyOrder.txData.value || '0'),
    });

    await publicClient.waitForTransactionReceipt({ hash });

    return jsonResult({
      status: 'success',
      action: 'buy',
      contract,
      tokenId,
      price: buyOrder.price,
      marketplace: buyOrder.marketplace,
      txHash: hash,
      chain: chainName(chainId),
    });
  } catch (err) {
    return errorResult(`NFT buy failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleList(params: Record<string, unknown>) {
  const contract = readStringParam(params, 'contract', { required: true });
  const tokenId = readStringParam(params, 'token_id') ?? readStringParam(params, 'tokenId');
  const priceInput = readStringParam(params, 'price', { required: true });
  if (!contract || !tokenId || !priceInput) {
    return errorResult('contract, token_id, and price are required for list.');
  }

  const state = getWalletState();
  if (!state.connected || !state.address) {
    return errorResult('No wallet connected. Connect a wallet first.');
  }

  const chainId = resolveChainId(readStringParam(params, 'chain'));

  try {
    const priceWei = validatePrice(priceInput).toString();
    const service = getNftService();
    const listResult = await service.getListOrder(
      contract, tokenId, state.address, priceWei, chainId,
    );

    // If there are signing steps, the wallet needs to complete them
    const signingSteps = listResult.steps.filter((s: any) =>
      s.kind === 'signature' && s.items?.length > 0,
    );

    return jsonResult({
      status: listResult.status,
      action: 'list',
      contract,
      tokenId,
      priceEth: priceInput,
      orderId: listResult.orderId,
      chain: chainName(chainId),
      requiresSignature: signingSteps.length > 0,
      note: signingSteps.length > 0
        ? 'Listing requires wallet signature approval. The order will be posted to Reservoir/OpenSea.'
        : 'Listing submitted successfully.',
    });
  } catch (err) {
    return errorResult(`NFT list failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleCollectionFloor(params: Record<string, unknown>) {
  const collectionInput = readStringParam(params, 'collection')
    ?? readStringParam(params, 'contract');
  if (!collectionInput) {
    return errorResult('collection (contract address or slug) is required for collection_floor.');
  }

  const chainId = resolveChainId(readStringParam(params, 'chain'));

  try {
    const service = getNftService();
    const collection = await service.getCollectionFloor(collectionInput, chainId);

    return jsonResult({
      chain: collection.chain,
      collection: collection.name,
      contractId: collection.id,
      image: collection.image,
      floorPrice: collection.floorPrice
        ? `${collection.floorPrice} ${collection.floorPriceCurrency}`
        : 'no listings',
      volume24h: collection.volume24h
        ? `${collection.volume24h} ETH`
        : null,
      totalSupply: collection.totalSupply,
      ownerCount: collection.ownerCount,
    });
  } catch (err) {
    return errorResult(`Collection floor failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handlePortfolio(params: Record<string, unknown>) {
  const state = getWalletState();
  const addressInput = readStringParam(params, 'address') ?? state.address;
  if (!addressInput) {
    return errorResult('No wallet connected and no address provided.');
  }

  const chainId = resolveChainId(readStringParam(params, 'chain'));
  const limit = readNumberParam(params, 'limit') ?? 50;

  try {
    const service = getNftService();
    const items = await service.getPortfolio(addressInput, chainId, limit);

    if (items.length === 0) {
      return jsonResult({
        chain: chainName(chainId),
        address: addressInput,
        nfts: [],
        message: 'No NFTs found on this chain.',
      });
    }

    // Group by collection
    const byCollection: Record<string, typeof items> = {};
    for (const item of items) {
      const key = item.collection ?? item.contract;
      if (!byCollection[key]) byCollection[key] = [];
      byCollection[key].push(item);
    }

    return jsonResult({
      chain: chainName(chainId),
      address: addressInput,
      totalNfts: items.length,
      collections: Object.entries(byCollection).map(([name, nfts]) => ({
        collection: name,
        count: nfts.length,
        floorPrice: nfts[0]?.floorPrice,
        items: nfts.slice(0, 5).map(n => ({
          tokenId: n.tokenId,
          name: n.name,
          image: n.image,
        })),
      })),
    });
  } catch (err) {
    return errorResult(`Portfolio failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
