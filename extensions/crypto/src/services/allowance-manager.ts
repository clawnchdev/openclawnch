/**
 * Token Allowance Manager — batch ERC-20 allowance checking and tracking.
 *
 * Provides:
 * - Batch allowance checks across multiple tokens and spenders
 * - Permit2 allowance aggregation
 * - Unlimited/excessive allowance detection
 * - Revocation recommendations
 * - Common spender identification (Uniswap Router, 0x Exchange Proxy, etc.)
 *
 * Security concern: ERC-20 approvals are a major attack vector — unlimited
 * approvals to compromised contracts can drain tokens. This service helps
 * users audit and manage their exposure.
 */

import { formatUnits } from 'viem';
import { getRpcManager } from './rpc-provider.js';

// Well-known token decimals (lowercase address → decimals)
const KNOWN_TOKEN_DECIMALS: Record<string, number> = {
  // Base
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6,  // USDC
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 6,  // USDT
  // Ethereum
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6,  // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 6,  // USDT
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 8,  // WBTC
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface AllowanceInfo {
  token: string;
  tokenAddress: string;
  spender: string;
  spenderName: string;
  spenderAddress: string;
  allowance: string;       // raw wei/units string
  allowanceHuman: string;  // human-readable with decimals
  isUnlimited: boolean;
  riskLevel: 'safe' | 'moderate' | 'high' | 'critical';
  chain: string;
  chainId: number;
}

export interface AllowanceReport {
  owner: string;
  chainId: number;
  chain: string;
  totalChecked: number;
  unlimited: number;
  highRisk: number;
  allowances: AllowanceInfo[];
  recommendations: string[];
  timestamp: number;
}

export interface AllowanceManagerConfig {
  /** Threshold (in human-readable units) above which an allowance is flagged. Default: 1e12 */
  unlimitedThreshold?: number;
}

// ── ERC-20 ABI (minimal) ────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
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
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── Known Spenders ──────────────────────────────────────────────────────────

/** Common spender contracts by chain. */
const KNOWN_SPENDERS: Record<number, Record<string, string>> = {
  8453: { // Base
    '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD': 'Uniswap Universal Router',
    '0x000000000022D473030F116dDEE9F6B43aC78BA3': 'Permit2',
    '0xDef1C0ded9bec7F1a1670819833240f027b25EfF': '0x Exchange Proxy',
    '0x1111111254EEB25477B68fb85Ed929f73A960582': '1inch Router v5',
    '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5': 'KyberSwap Router',
    '0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559': 'Odos Router',
  },
  1: { // Ethereum
    '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD': 'Uniswap Universal Router',
    '0x000000000022D473030F116dDEE9F6B43aC78BA3': 'Permit2',
    '0xDef1C0ded9bec7F1a1670819833240f027b25EfF': '0x Exchange Proxy',
    '0x1111111254EEB25477B68fb85Ed929f73A960582': '1inch Router v5',
    '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D': 'Uniswap V2 Router',
    '0xE592427A0AEce92De3Edee1F18E0157C05861564': 'Uniswap V3 Router',
    '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F': 'SushiSwap Router',
  },
  42161: { // Arbitrum
    '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD': 'Uniswap Universal Router',
    '0x000000000022D473030F116dDEE9F6B43aC78BA3': 'Permit2',
    '0xDef1C0ded9bec7F1a1670819833240f027b25EfF': '0x Exchange Proxy',
    '0x1111111254EEB25477B68fb85Ed929f73A960582': '1inch Router v5',
  },
  10: { // Optimism
    '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD': 'Uniswap Universal Router',
    '0x000000000022D473030F116dDEE9F6B43aC78BA3': 'Permit2',
    '0xDef1C0ded9bec7F1a1670819833240f027b25EfF': '0x Exchange Proxy',
  },
  137: { // Polygon
    '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD': 'Uniswap Universal Router',
    '0x000000000022D473030F116dDEE9F6B43aC78BA3': 'Permit2',
    '0xDef1C0ded9bec7F1a1670819833240f027b25EfF': '0x Exchange Proxy',
    '0x1111111254EEB25477B68fb85Ed929f73A960582': '1inch Router v5',
  },
};

// ── Well-Known Tokens ───────────────────────────────────────────────────────

const WELL_KNOWN_TOKENS: Record<number, Record<string, string>> = {
  8453: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    WETH: '0x4200000000000000000000000000000000000006',
    DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  },
  1: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  },
};

const CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon',
};

// ── Service ─────────────────────────────────────────────────────────────────

export class AllowanceManager {
  private config: Required<AllowanceManagerConfig>;

  constructor(config: AllowanceManagerConfig = {}) {
    this.config = {
      unlimitedThreshold: config.unlimitedThreshold ?? 1e12,
    };
  }

  /**
   * Check allowances for a wallet against known spenders.
   * Scans common tokens × common spenders on a given chain.
   */
   async auditAllowances(
     ownerAddress: string,
     chainId = 8453,
     tokenAddresses?: string[],
   ): Promise<AllowanceReport> {
     // Resolve tokens to check
     const tokens = tokenAddresses
       ? tokenAddresses.map((addr) => ({ symbol: '???', address: addr }))
       : Object.entries(WELL_KNOWN_TOKENS[chainId] ?? {}).map(([symbol, address]) => ({ symbol, address }));

     // Resolve spenders
     const spenders = KNOWN_SPENDERS[chainId] ?? {};
     const spenderEntries = Object.entries(spenders);

     if (tokens.length === 0 || spenderEntries.length === 0) {
       return {
         owner: ownerAddress,
         chainId,
         chain: CHAIN_NAMES[chainId] ?? String(chainId),
         totalChecked: 0,
         unlimited: 0,
         highRisk: 0,
         allowances: [],
         recommendations: ['No known tokens or spenders configured for this chain.'],
         timestamp: Date.now(),
       };
     }

     const rpcManager = getRpcManager();
     const client = await rpcManager.getClient(chainId);

    // Build batch of allowance checks
    const checks: Array<{ token: { symbol: string; address: string }; spenderAddr: string; spenderName: string }> = [];
    for (const token of tokens) {
      for (const [spenderAddr, spenderName] of spenderEntries) {
        checks.push({ token, spenderAddr, spenderName });
      }
    }

    // Execute all checks in parallel (batched)
    const results = await Promise.all(
      checks.map(async ({ token, spenderAddr, spenderName }): Promise<AllowanceInfo | null> => {
        try {
          const [allowance, decimals, symbol] = await Promise.all([
            client.readContract({
              address: token.address as `0x${string}`,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [ownerAddress as `0x${string}`, spenderAddr as `0x${string}`],
            }),
            token.symbol === '???'
              ? client.readContract({ address: token.address as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' })
              : Promise.resolve(KNOWN_TOKEN_DECIMALS[token.address.toLowerCase()] ?? 18),
            token.symbol === '???'
              ? client.readContract({ address: token.address as `0x${string}`, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '???')
              : Promise.resolve(token.symbol),
          ]);

          const raw = (allowance as bigint).toString();
          if (raw === '0') return null; // Skip zero allowances

          const dec = Number(decimals);
          // Use formatUnits to avoid Number(bigint) overflow for large allowances
          const humanStr = formatUnits(allowance as bigint, dec);
          const human = parseFloat(humanStr);
          const isUnlimited = human > this.config.unlimitedThreshold;
          const riskLevel = this.assessRisk(human, spenderName, isUnlimited);

          return {
            token: String(symbol),
            tokenAddress: token.address,
            spender: spenderName,
            spenderName,
            spenderAddress: spenderAddr,
            allowance: raw,
            allowanceHuman: isUnlimited ? 'unlimited' : human.toLocaleString(),
            isUnlimited,
            riskLevel,
            chain: CHAIN_NAMES[chainId] ?? String(chainId),
            chainId,
          };
        } catch {
          return null; // Skip tokens that fail (might not be ERC-20)
        }
      }),
    );

    const allowances = results.filter((r): r is AllowanceInfo => r !== null);
    const unlimited = allowances.filter((a) => a.isUnlimited).length;
    const highRisk = allowances.filter((a) => a.riskLevel === 'high' || a.riskLevel === 'critical').length;

    // Generate recommendations
    const recommendations: string[] = [];
    if (unlimited > 0) {
      recommendations.push(
        `${unlimited} unlimited approval${unlimited > 1 ? 's' : ''} found. Consider revoking unused ones with the permit2 tool.`,
      );
    }
    const unknownSpenders = allowances.filter((a) => a.spenderName === 'Unknown');
    if (unknownSpenders.length > 0) {
      recommendations.push(
        `${unknownSpenders.length} approval${unknownSpenders.length > 1 ? 's' : ''} to unrecognized contracts. Review and revoke if not needed.`,
      );
    }
    if (allowances.length === 0) {
      recommendations.push('No active approvals found — your wallet has minimal token approval exposure.');
    }

    return {
      owner: ownerAddress,
      chainId,
      chain: CHAIN_NAMES[chainId] ?? String(chainId),
      totalChecked: checks.length,
      unlimited,
      highRisk,
      allowances,
      recommendations,
      timestamp: Date.now(),
    };
  }

  /**
   * Check a single token's allowance for a specific spender.
   */
  async checkAllowance(
    ownerAddress: string,
    tokenAddress: string,
    spenderAddress: string,
    chainId = 8453,
  ): Promise<{ allowance: string; decimals: number; isUnlimited: boolean }> {
    const rpcManager = getRpcManager();
    const client = await rpcManager.getClient(chainId);

    const [allowance, decimals] = await Promise.all([
      client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [ownerAddress as `0x${string}`, spenderAddress as `0x${string}`],
      }),
      client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
    ]);

    const dec = Number(decimals);
    const humanStr = formatUnits(allowance as bigint, dec);
    const human = parseFloat(humanStr);

    return {
      allowance: (allowance as bigint).toString(),
      decimals: dec,
      isUnlimited: human > this.config.unlimitedThreshold,
    };
  }

  /**
   * Get known spender names for a chain.
   */
  getKnownSpenders(chainId = 8453): Record<string, string> {
    return { ...KNOWN_SPENDERS[chainId] };
  }

  /**
   * Resolve a spender address to a human-readable name.
   */
  resolveSpenderName(address: string, chainId = 8453): string {
    return KNOWN_SPENDERS[chainId]?.[address] ?? 'Unknown';
  }

  // ── Private ─────────────────────────────────────────────────────────

  private assessRisk(
    humanAmount: number,
    spenderName: string,
    isUnlimited: boolean,
  ): 'safe' | 'moderate' | 'high' | 'critical' {
    if (!isUnlimited && humanAmount < 1000) return 'safe';
    if (spenderName === 'Unknown') {
      return isUnlimited ? 'critical' : 'high';
    }
    if (isUnlimited) return 'moderate'; // unlimited to known protocol is moderate
    return 'safe';
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: AllowanceManager | null = null;

export function getAllowanceManager(config?: AllowanceManagerConfig): AllowanceManager {
  if (!_instance) {
    _instance = new AllowanceManager(config);
  }
  return _instance;
}

export function resetAllowanceManager(): void {
  _instance = null;
}
