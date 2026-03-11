/**
 * Shared utility for resolving ERC-20 token decimals.
 *
 * Used by defi-swap (3 call sites), the plan executor balance resolver,
 * safety-service, and allowance-manager.
 *
 * Strategy:
 * 1. ETH/WETH → 18 (no RPC needed)
 * 2. Well-known stablecoins (USDC, USDT) → 6
 * 3. On-chain `decimals()` call via publicClient
 * 4. Fallback to 18 if all else fails
 */

/** Well-known token addresses on Base (lowercase for comparison). */
const WELL_KNOWN_DECIMALS: Record<string, number> = {
  // USDC on Base
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6,
  // USDT on Base
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 6,
  // USDC on Ethereum
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6,
  // USDT on Ethereum
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 6,
  // USDC on Polygon
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 6,
  // USDC.e on Polygon
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 6,
};

/** Sentinel addresses that represent native ETH (not an ERC-20). */
const ETH_ADDRESSES = new Set([
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // common sentinel
  '0x4200000000000000000000000000000000000006', // WETH on Base / OP
]);

/**
 * Resolve the decimal count for a token address.
 *
 * @param tokenAddress - The ERC-20 contract address (0x...) or ETH sentinel.
 * @param publicClient - A viem PublicClient (or compatible) for on-chain reads.
 *                        Pass `null` to skip on-chain resolution.
 * @returns The token's decimal count (defaults to 18 if unknown).
 */
export async function resolveTokenDecimals(
  tokenAddress: string,
  publicClient: { readContract: (args: any) => Promise<unknown> } | null,
): Promise<number> {
  const lower = tokenAddress.toLowerCase();

  // 1. Native ETH / WETH
  if (ETH_ADDRESSES.has(lower)) {
    return 18;
  }

  // 2. Well-known stablecoins
  const known = WELL_KNOWN_DECIMALS[lower];
  if (known !== undefined) {
    return known;
  }

  // 3. On-chain read
  if (publicClient) {
    try {
      const dec = await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: [{
          name: 'decimals',
          type: 'function',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ name: '', type: 'uint8' }],
        }] as const,
        functionName: 'decimals',
      });
      return Number(dec);
    } catch {
      // Contract might not implement decimals() — fall through
    }
  }

  // 4. Fallback
  return 18;
}

/**
 * Check if a token address represents native ETH (including WETH).
 */
export function isNativeEth(tokenAddress: string): boolean {
  return ETH_ADDRESSES.has(tokenAddress.toLowerCase());
}
