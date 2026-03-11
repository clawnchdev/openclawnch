/**
 * ENS / On-chain Identity Resolution — shared utility for all tools.
 *
 * Resolves ENS names (*.eth), Basenames (*.base.eth), and plain addresses
 * into normalized 0x addresses. Used by every tool that accepts an address
 * parameter, so users can type "vitalik.eth" instead of the raw address.
 *
 * Uses viem's built-in ENS support:
 * - publicClient.getEnsAddress() — name → address
 * - publicClient.getEnsName() — address → name (reverse resolution)
 * - publicClient.getEnsAvatar() — address → avatar URL
 *
 * ENS resolution requires an Ethereum mainnet client (ENS registry lives on L1).
 * For Base, we also check the Base ENS resolver for *.base.eth names.
 */

import { type Address, isAddress, getAddress } from 'viem';

// ── L1 Client for ENS Resolution ────────────────────────────────────────────
// The ENS registry lives on Ethereum L1. Standard *.eth names must be resolved
// via an L1 client. Basenames (*.base.eth) resolve on Base via the L2 resolver.

/**
 * Get the appropriate public client for ENS resolution.
 * - *.base.eth → use the provided client (expected to be a Base client)
 * - *.eth → get an Ethereum L1 client via RpcManager
 * Falls back to the provided client if L1 is unavailable.
 */
async function getEnsClient(name: string, fallback: any): Promise<any> {
  // Basenames resolve on Base — use the provided client directly
  if (name.endsWith('.base.eth')) return fallback;

  // Standard *.eth names need an Ethereum L1 client
  try {
    const { getRpcManager } = await import('../services/rpc-provider.js');
    const rpcManager = getRpcManager();
    return await rpcManager.getClient(1); // Ethereum mainnet
  } catch {
    // L1 RPC unavailable — try the provided client anyway.
    // This will fail for Base clients resolving .eth names,
    // but at least gives a clear error message.
    return fallback;
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedAddress {
  /** Checksummed 0x address */
  address: Address;
  /** Original input (may be ENS name, address, etc.) */
  input: string;
  /** ENS name if resolved, or if reverse-resolved from address */
  ensName?: string;
  /** Whether the input was an ENS name that got resolved */
  wasEnsResolution: boolean;
}

export interface EnsProfile {
  address: Address;
  name: string | null;
  avatar: string | null;
}

// ── Cache ───────────────────────────────────────────────────────────────────
// ENS names change infrequently. Cache for 5 minutes to reduce RPC calls.

const ENS_CACHE = new Map<string, { address: Address; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(name: string): Address | null {
  const entry = ENS_CACHE.get(name.toLowerCase());
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    ENS_CACHE.delete(name.toLowerCase());
    return null;
  }
  return entry.address;
}

function setCache(name: string, address: Address): void {
  ENS_CACHE.set(name.toLowerCase(), { address, timestamp: Date.now() });
  // Prune cache if too large
  if (ENS_CACHE.size > 500) {
    const oldest = Array.from(ENS_CACHE.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, 100);
    for (const [key] of oldest) ENS_CACHE.delete(key);
  }
}

/** Clear the ENS cache (for testing). */
export function clearEnsCache(): void {
  ENS_CACHE.clear();
}

// ── Detection ───────────────────────────────────────────────────────────────

/** Check if a string looks like an ENS name (*.eth, *.base.eth, etc.) */
export function isEnsName(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim().toLowerCase();
  // Standard ENS: *.eth (resolved on Ethereum L1)
  // Basenames: *.base.eth (resolved on Base L2)
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.(eth|base\.eth)$/i.test(trimmed);
}

/** Check if input is a valid hex address OR an ENS name. */
export function isAddressOrEns(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  return isAddress(input) || isEnsName(input);
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve an address-or-ENS input to a checksummed 0x address.
 *
 * - If input is already a valid address, returns it checksummed.
 * - If input is an ENS name, resolves via the provided publicClient.
 * - Throws if resolution fails or input is invalid.
 *
 * @param input - Address string or ENS name (e.g., "vitalik.eth", "0x1234...")
 * @param publicClient - viem PublicClient (must be connected to Ethereum mainnet for ENS)
 */
export async function resolveAddressOrEns(
  input: string,
  publicClient: any, // Using any to avoid viem version conflicts
): Promise<ResolvedAddress> {
  const trimmed = input.trim();

  // Fast path: already a valid address
  if (isAddress(trimmed)) {
    return {
      address: getAddress(trimmed),
      input: trimmed,
      wasEnsResolution: false,
    };
  }

  // ENS resolution
  if (isEnsName(trimmed)) {
    // Check cache first
    const cached = getCached(trimmed);
    if (cached) {
      return {
        address: cached,
        input: trimmed,
        ensName: trimmed,
        wasEnsResolution: true,
      };
    }

    try {
      // Route to the correct client: L1 for *.eth, provided client for *.base.eth
      const ensClient = await getEnsClient(trimmed, publicClient);
      const address = await ensClient.getEnsAddress({ name: trimmed });
      if (!address) {
        throw new Error(`ENS name "${trimmed}" does not resolve to an address.`);
      }

      const checksummed = getAddress(address);
      setCache(trimmed, checksummed);

      return {
        address: checksummed,
        input: trimmed,
        ensName: trimmed,
        wasEnsResolution: true,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes('does not resolve')) {
        throw err; // Re-throw our own error
      }
      throw new Error(
        `Failed to resolve ENS name "${trimmed}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new Error(
    `Invalid address or ENS name: "${trimmed}". ` +
    `Expected a 0x address (42 chars) or an ENS name (e.g., name.eth).`,
  );
}

/**
 * Reverse-resolve an address to an ENS name (if one exists).
 * Returns null if no reverse record is set.
 */
export async function reverseResolveEns(
  address: Address,
  publicClient: any,
): Promise<string | null> {
  try {
    // Reverse resolution always uses L1 (ENS registry is on Ethereum mainnet)
    const ensClient = await getEnsClient('reverse.eth', publicClient);
    const name = await ensClient.getEnsName({ address });
    return name ?? null;
  } catch {
    return null;
  }
}

/**
 * Get a full ENS profile for an address (name + avatar).
 */
export async function getEnsProfile(
  address: Address,
  publicClient: any,
): Promise<EnsProfile> {
  const name = await reverseResolveEns(address, publicClient);
  let avatar: string | null = null;

  if (name) {
    try {
      const ensClient = await getEnsClient(name, publicClient);
      avatar = await ensClient.getEnsAvatar({ name });
    } catch {
      // Avatar resolution is best-effort
    }
  }

  return { address, name, avatar };
}

/**
 * Batch-resolve multiple address-or-ENS inputs.
 * Returns results in the same order as inputs.
 * Individual failures are returned as errors in the result array.
 */
export async function resolveMany(
  inputs: string[],
  publicClient: any,
): Promise<Array<ResolvedAddress | Error>> {
  return Promise.all(
    inputs.map(async (input) => {
      try {
        return await resolveAddressOrEns(input, publicClient);
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    }),
  );
}
