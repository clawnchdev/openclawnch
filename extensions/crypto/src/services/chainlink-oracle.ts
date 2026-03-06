/**
 * Chainlink Oracle Feed Service — on-chain price verification.
 *
 * Reads Chainlink price feed aggregator contracts to get decentralized,
 * tamper-resistant price data directly from the blockchain. Used as a
 * verification layer before large swaps to detect price manipulation.
 *
 * Supported feeds:
 * - ETH/USD, BTC/USD, LINK/USD, UNI/USD, AAVE/USD, etc.
 * - Available on Ethereum, Base, Arbitrum, Optimism, Polygon
 *
 * Architecture:
 * - Reads `latestRoundData()` from Chainlink AggregatorV3Interface
 * - Validates staleness (rejects if older than maxStalenessSeconds)
 * - Cross-references with DEX prices to detect discrepancies
 */

import { getRpcManager } from './rpc-provider.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ChainlinkPriceResult {
  pair: string;
  priceUsd: number;
  decimals: number;
  roundId: string;
  updatedAt: number;  // unix timestamp
  answeredInRound: string;
  staleness: number;  // seconds since last update
  isStale: boolean;
  chain: string;
  feedAddress: string;
}

export interface ChainlinkOracleConfig {
  /** Max staleness in seconds. Default: 3600 (1 hour). */
  maxStalenessSeconds?: number;
  /** Price divergence threshold in % to flag discrepancy. Default: 2. */
  divergenceThresholdPercent?: number;
}

// ── Chainlink AggregatorV3Interface ABI (minimal) ───────────────────────────

const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'description',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── Feed Registry ───────────────────────────────────────────────────────────

/**
 * Chainlink price feed addresses per chain.
 * Source: https://docs.chain.link/data-feeds/price-feeds/addresses
 */
const FEED_ADDRESSES: Record<number, Record<string, string>> = {
  // Ethereum Mainnet
  1: {
    'ETH/USD': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    'BTC/USD': '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    'LINK/USD': '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c',
    'UNI/USD': '0x553303d460EE0afB37EdFf9bE42922D8FF63220e',
    'AAVE/USD': '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9',
    'COMP/USD': '0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5',
    'MKR/USD': '0xec1D1B3b0443256cc3860e24a46F108e699484Aa',
    'SNX/USD': '0xDC3EA94CD0AC27d9A86C180091e7f78C683d3699',
    'CRV/USD': '0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f',
    'DAI/USD': '0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9',
    'USDC/USD': '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    'USDT/USD': '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D',
    'MATIC/USD': '0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676',
    'ARB/USD': '0x31697852a68433DbCc2Ff9bA924722580E9730ca',
    'OP/USD': '0x0D276FC14719f9292D5C1eA2198673d1f4269246',
    'LDO/USD': '0x4e844125952D32AcdF339BE976c98E22F6F318dB',
    'RPL/USD': '0x4E155eD98aFE9034b7A5962f6C84c86d869daA9d',
    'DOGE/USD': '0x2465CefD3b488BE410b941b1d4b2767088e2A028',
    'SHIB/USD': '0x8dD1CD88F43aF196ae478e91b9F5E4Ac69A97C61',
    'PEPE/USD': '0x02DE3B1C4534eb56879602Fa89d04E457a4c7f48',
  },
  // Base
  8453: {
    'ETH/USD': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    'BTC/USD': '0xCCADC697c55bbB68dc5bCdf8d3CBe83CdD4E071E',
    'LINK/USD': '0x17CAb8FE31cA45e0aBa8eCA8AEa4ad791d9e3b28',
    'USDC/USD': '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B',
    'DAI/USD': '0x591e79239a7d679378eC8c847e5038150364C78F',
    'CBETH/USD': '0xd7818272B9e248357d13057AAb0B417aF31E817d',
  },
  // Arbitrum
  42161: {
    'ETH/USD': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
    'BTC/USD': '0x6ce185860a4963106506C203335A2910413708e9',
    'LINK/USD': '0x86E53CF1B870786351Da77A57575e79CB55812CB',
    'ARB/USD': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
    'USDC/USD': '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
    'DAI/USD': '0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB',
    'UNI/USD': '0x9C917083fDb403ab5ADbEC26Ee294f6EcAda2720',
  },
  // Optimism
  10: {
    'ETH/USD': '0x13e3Ee699D1909E989722E753853AE30b17e08c5',
    'BTC/USD': '0xD702DD976Fb76Fffc2D3963D037dfDae5b04E593',
    'LINK/USD': '0xCc232dcFAAE6354cE191Bd574108c1aD03f86229',
    'OP/USD': '0x0D276FC14719f9292D5C1eA2198673d1f4269246',
    'USDC/USD': '0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3',
    'DAI/USD': '0x8dBa75e83DA73cc766A7e5a0ee71F656BAb470d6',
  },
  // Polygon
  137: {
    'ETH/USD': '0xF9680D99D6C9589e2a93a78A04A279e509205945',
    'BTC/USD': '0xc907E116054Ad103354f2D350FD2514433D57F6f',
    'LINK/USD': '0xd9FFdb71EbE7496cC440152d43986Aae0AB76665',
    'MATIC/USD': '0xAB594600376Ec9fD91F8e8dC0f7edF4aed3DA033',
    'USDC/USD': '0xfE4A8cc5b5B2366C1B58Bea3858e81843583ee2e',
    'DAI/USD': '0x4746DeC9e833A82EC7C2C1245845D6B60eBCD0E2',
    'AAVE/USD': '0x72484B12719E23115761D5DA1646945632979bB6',
  },
};

// ── Chain Name Resolution ───────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon',
};

// ── Service ─────────────────────────────────────────────────────────────────

export class ChainlinkOracle {
  private config: Required<ChainlinkOracleConfig>;

  constructor(userConfig: ChainlinkOracleConfig = {}) {
    this.config = {
      maxStalenessSeconds: userConfig.maxStalenessSeconds ?? 3600,
      divergenceThresholdPercent: userConfig.divergenceThresholdPercent ?? 2,
    };
  }

  /**
   * Get a Chainlink price for a trading pair (e.g., "ETH/USD").
   * Reads directly from the on-chain aggregator contract.
   */
  async getPrice(pair: string, chainId = 8453): Promise<ChainlinkPriceResult> {
    const normalizedPair = pair.toUpperCase().replace(/\s/g, '');
    const feeds = FEED_ADDRESSES[chainId];
    if (!feeds) {
      throw new ChainlinkError(`Chainlink feeds not available for chain ${chainId}`);
    }

    const feedAddress = feeds[normalizedPair];
    if (!feedAddress) {
      const available = Object.keys(feeds).join(', ');
      throw new ChainlinkError(
        `No Chainlink feed for ${normalizedPair} on ${CHAIN_NAMES[chainId] ?? chainId}. Available: ${available}`,
      );
    }

    const rpcManager = getRpcManager();
    const client = await rpcManager.getClient(chainId);

    // Read decimals + latestRoundData in parallel
    const [decimals, roundData] = await Promise.all([
      client.readContract({
        address: feedAddress as `0x${string}`,
        abi: AGGREGATOR_V3_ABI,
        functionName: 'decimals',
      }),
      client.readContract({
        address: feedAddress as `0x${string}`,
        abi: AGGREGATOR_V3_ABI,
        functionName: 'latestRoundData',
      }),
    ]);

    const [roundId, answer, , updatedAt, answeredInRound] = roundData as [bigint, bigint, bigint, bigint, bigint];
    const dec = Number(decimals);
    const priceUsd = Number(answer) / 10 ** dec;
    const updatedAtSec = Number(updatedAt);
    const staleness = Math.floor(Date.now() / 1000) - updatedAtSec;

    return {
      pair: normalizedPair,
      priceUsd,
      decimals: dec,
      roundId: roundId.toString(),
      updatedAt: updatedAtSec,
      answeredInRound: answeredInRound.toString(),
      staleness,
      isStale: staleness > this.config.maxStalenessSeconds,
      chain: CHAIN_NAMES[chainId] ?? String(chainId),
      feedAddress,
    };
  }

  /**
   * Get the Chainlink ETH/USD price on a specific chain.
   */
  async getEthPrice(chainId = 8453): Promise<ChainlinkPriceResult> {
    return this.getPrice('ETH/USD', chainId);
  }

  /**
   * Verify a DEX price against Chainlink oracle.
   * Returns a divergence report.
   */
  async verifyPrice(
    token: string,
    dexPriceUsd: number,
    chainId = 8453,
  ): Promise<{
    chainlinkPrice: number;
    dexPrice: number;
    divergencePercent: number;
    isAcceptable: boolean;
    warning?: string;
  }> {
    const pair = `${token.toUpperCase()}/USD`;
    try {
      const result = await this.getPrice(pair, chainId);

      if (result.isStale) {
        return {
          chainlinkPrice: result.priceUsd,
          dexPrice: dexPriceUsd,
          divergencePercent: 0,
          isAcceptable: true, // Can't reject based on stale oracle — fall through
          warning: `Chainlink ${pair} data is stale (${Math.round(result.staleness / 60)}m old). Skipping oracle verification.`,
        };
      }

      const divergence = Math.abs(result.priceUsd - dexPriceUsd) / result.priceUsd * 100;
      const isAcceptable = divergence < this.config.divergenceThresholdPercent;

      return {
        chainlinkPrice: result.priceUsd,
        dexPrice: dexPriceUsd,
        divergencePercent: Math.round(divergence * 100) / 100,
        isAcceptable,
        warning: isAcceptable
          ? undefined
          : `Price divergence ${divergence.toFixed(1)}% between DEX ($${dexPriceUsd.toFixed(4)}) and Chainlink ($${result.priceUsd.toFixed(4)}). Possible manipulation or stale DEX data.`,
      };
    } catch (err) {
      // If Chainlink feed doesn't exist for this token, skip verification
      if (err instanceof ChainlinkError) {
        return {
          chainlinkPrice: 0,
          dexPrice: dexPriceUsd,
          divergencePercent: 0,
          isAcceptable: true,
          warning: `No Chainlink feed for ${pair}. Oracle verification skipped.`,
        };
      }
      throw err;
    }
  }

  /**
   * Get all available feed pairs for a chain.
   */
  getAvailableFeeds(chainId = 8453): string[] {
    return Object.keys(FEED_ADDRESSES[chainId] ?? {});
  }

  /**
   * Get all supported chain IDs.
   */
  getSupportedChains(): number[] {
    return Object.keys(FEED_ADDRESSES).map(Number);
  }

  /**
   * Batch price lookup: get Chainlink prices for multiple pairs.
   */
  async getPrices(
    pairs: Array<{ pair: string; chainId?: number }>,
  ): Promise<ChainlinkPriceResult[]> {
    return Promise.all(
      pairs.map((p) =>
        this.getPrice(p.pair, p.chainId ?? 8453).catch((err): ChainlinkPriceResult => ({
          pair: p.pair,
          priceUsd: 0,
          decimals: 0,
          roundId: '0',
          updatedAt: 0,
          answeredInRound: '0',
          staleness: 0,
          isStale: true,
          chain: CHAIN_NAMES[p.chainId ?? 8453] ?? String(p.chainId ?? 8453),
          feedAddress: '',
        })),
      ),
    );
  }
}

// ── Error Class ─────────────────────────────────────────────────────────────

export class ChainlinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainlinkError';
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: ChainlinkOracle | null = null;

export function getChainlinkOracle(config?: ChainlinkOracleConfig): ChainlinkOracle {
  if (!_instance) {
    _instance = new ChainlinkOracle(config);
  }
  return _instance;
}

export function resetChainlinkOracle(): void {
  _instance = null;
}
