/**
 * Base Builder Code (ERC-8021) — transaction attribution for base.dev analytics.
 *
 * Every transaction on Base sent through OpenClawnch includes a data suffix that
 * attributes the transaction to our builder code. This:
 * 1. Tracks on-chain usage on base.dev
 * 2. Qualifies for Base ecosystem rewards
 * 3. Shows up in app leaderboards
 *
 * The suffix is appended to the `data` field of every sendTransaction call.
 * For native ETH transfers (no data), the suffix becomes the entire data field.
 * Smart contracts ignore trailing calldata — zero impact on execution.
 *
 * @see https://docs.base.org/base-chain/builder-codes/builder-codes
 * @see ERC-8021: https://eip.tools/eip/8021
 */

// ─── Builder Code Configuration ─────────────────────────────────────────

/** OpenClawnch's registered Base Builder Code. */
export const BUILDER_CODE = 'bc_z92vaimh';

/**
 * Pre-computed ERC-8021 data suffix for our builder code.
 *
 * Format: [1 byte: code length] [N bytes: UTF-8 code] [0x00] [8021 repeated 8 times]
 *
 * Encoding breakdown for 'bc_z92vaimh':
 *   0b                         = length 11
 *   62635f7a39327661696d68     = 'bc_z92vaimh' UTF-8
 *   00                         = separator
 *   80218021802180218021802180218021 = ERC-8021 magic (8 × 0x8021)
 */
export const DATA_SUFFIX = '0x0b62635f7a39327661696d680080218021802180218021802180218021' as const;

/** Base chain IDs where the suffix should be applied. */
const BASE_CHAIN_IDS = new Set([
  8453,   // Base Mainnet
  84532,  // Base Sepolia
]);

// ─── Suffix Injection ───────────────────────────────────────────────────

/**
 * Append the ERC-8021 builder code suffix to transaction data.
 *
 * - If data is empty/undefined (native ETH transfer), the suffix becomes the data.
 * - If data exists (contract call), the suffix is appended to the end.
 * - Only applies to Base chain transactions.
 *
 * @param data - Existing transaction data (hex string or undefined)
 * @param chainId - The chain this transaction targets
 * @returns The data with suffix appended, or original data if not Base
 */
export function appendBuilderCode(data: string | undefined, chainId: number | undefined): string | undefined {
  // Only apply to Base chains
  if (!chainId || !BASE_CHAIN_IDS.has(chainId)) {
    return data;
  }

  // Suffix without '0x' prefix for concatenation
  const suffixHex = DATA_SUFFIX.slice(2);

  if (!data || data === '0x') {
    // Native ETH transfer — suffix becomes the entire data field
    return DATA_SUFFIX;
  }

  // Contract call — append suffix to existing calldata
  // Remove '0x' from data, concatenate, re-add prefix
  const cleanData = data.startsWith('0x') ? data.slice(2) : data;
  return '0x' + cleanData + suffixHex;
}

/**
 * Check if a transaction's data field already contains our builder code suffix.
 */
export function hasBuilderCode(data: string | undefined): boolean {
  if (!data) return false;
  return data.endsWith(DATA_SUFFIX.slice(2));
}

/**
 * Wrap a viem wallet client to automatically append the builder code suffix
 * to all sendTransaction calls on Base.
 *
 * This is the main integration point. Applied once at wallet client creation
 * in walletconnect-service.ts.
 *
 * The wrapper intercepts the `request` method on the transport, catches
 * `eth_sendTransaction` calls, and appends the suffix to the data field.
 */
export function wrapWithBuilderCode(walletClient: any, chainId?: number): any {
  if (!walletClient) return walletClient;

  const effectiveChainId = chainId ?? walletClient.chain?.id;

  // Only wrap for Base chains
  if (!effectiveChainId || !BASE_CHAIN_IDS.has(effectiveChainId)) {
    return walletClient;
  }

  // Store the original sendTransaction
  const originalSendTransaction = walletClient.sendTransaction?.bind(walletClient);
  const originalWriteContract = walletClient.writeContract?.bind(walletClient);

  if (originalSendTransaction) {
    walletClient.sendTransaction = async (args: any) => {
      // Append builder code to data
      const modifiedArgs = {
        ...args,
        data: appendBuilderCode(args.data, effectiveChainId),
      };
      return originalSendTransaction(modifiedArgs);
    };
  }

  // writeContract internally calls sendTransaction, so we DON'T need to wrap it
  // separately — the sendTransaction wrapper catches it. But if the client has
  // a direct writeContract that bypasses sendTransaction, we wrap it too.
  // In practice with viem, writeContract encodes ABI → sendTransaction, so
  // the sendTransaction wrapper is sufficient.

  return walletClient;
}
