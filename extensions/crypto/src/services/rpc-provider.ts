/**
 * Multi-RPC Provider — fault-tolerant RPC access with automatic failover.
 *
 * Supports multiple RPC providers per chain, with:
 * - Priority-ordered provider list
 * - Automatic failover on error or timeout (>2s)
 * - Rate limit detection (429) with exponential backoff
 * - Circuit breaker (5 failures in 60s → skip provider for 5 min)
 * - User-configurable via plugin config
 */

import { createPublicClient, http, type PublicClient, type Chain } from 'viem';
import { base, mainnet, arbitrum, optimism, polygon } from 'viem/chains';

// ── Types ───────────────────────────────────────────────────────────────────

export interface RpcProviderConfig {
  url: string;
  name: string;
  priority: number; // lower = higher priority
  apiKeyEnv?: string; // env var name for API key (appended to URL)
}

interface ProviderHealth {
  failures: number;
  lastFailure: number;
  circuitOpenUntil: number; // timestamp — skip until this time
  backoffMs: number;
  lastRateLimited: number;
}

export interface RpcManagerConfig {
  /** Provider overrides per chain ID. Key is chain ID number as string. */
  providers?: Record<string, RpcProviderConfig[]>;
  /** Global timeout for RPC calls in ms. Default 3000. */
  timeoutMs?: number;
  /** Max consecutive failures before circuit opens. Default 5. */
  circuitThreshold?: number;
  /** How long circuit stays open in ms. Default 300_000 (5 min). */
  circuitResetMs?: number;
  /** Enable MEV protection via private transaction RPCs (Flashbots, MEV Blocker).
   *  When true, write transactions on supported chains route through private mempools.
   *  Default: true. */
  mevProtection?: boolean;
}

// ── Default Providers ───────────────────────────────────────────────────────

const DEFAULT_PROVIDERS: Record<number, RpcProviderConfig[]> = {
  // Base (8453)
  [8453]: [
    { url: 'https://base-mainnet.g.alchemy.com/v2/', name: 'Alchemy', priority: 1, apiKeyEnv: 'ALCHEMY_API_KEY' },
    { url: 'https://base.llamarpc.com', name: 'LlamaNodes', priority: 2 },
    { url: 'https://mainnet.base.org', name: 'Base Public', priority: 3 },
    { url: 'https://base.drpc.org', name: 'dRPC', priority: 4 },
    { url: 'https://base.meowrpc.com', name: 'MeowRPC', priority: 5 },
    { url: 'https://1rpc.io/base', name: '1RPC', priority: 6 },
  ],
  // Ethereum (1)
  [1]: [
    { url: 'https://eth-mainnet.g.alchemy.com/v2/', name: 'Alchemy', priority: 1, apiKeyEnv: 'ALCHEMY_API_KEY' },
    { url: 'https://eth.llamarpc.com', name: 'LlamaNodes', priority: 2 },
    { url: 'https://ethereum.publicnode.com', name: 'PublicNode', priority: 3 },
    { url: 'https://eth.drpc.org', name: 'dRPC', priority: 4 },
    { url: 'https://1rpc.io/eth', name: '1RPC', priority: 5 },
    { url: 'https://rpc.ankr.com/eth', name: 'Ankr', priority: 6 },
  ],
  // Arbitrum (42161)
  [42161]: [
    { url: 'https://arb-mainnet.g.alchemy.com/v2/', name: 'Alchemy', priority: 1, apiKeyEnv: 'ALCHEMY_API_KEY' },
    { url: 'https://arbitrum.llamarpc.com', name: 'LlamaNodes', priority: 2 },
    { url: 'https://arb1.arbitrum.io/rpc', name: 'Arbitrum Public', priority: 3 },
    { url: 'https://arbitrum.drpc.org', name: 'dRPC', priority: 4 },
    { url: 'https://1rpc.io/arb', name: '1RPC', priority: 5 },
  ],
  // Optimism (10)
  [10]: [
    { url: 'https://opt-mainnet.g.alchemy.com/v2/', name: 'Alchemy', priority: 1, apiKeyEnv: 'ALCHEMY_API_KEY' },
    { url: 'https://optimism.llamarpc.com', name: 'LlamaNodes', priority: 2 },
    { url: 'https://mainnet.optimism.io', name: 'OP Public', priority: 3 },
    { url: 'https://optimism.drpc.org', name: 'dRPC', priority: 4 },
    { url: 'https://1rpc.io/op', name: '1RPC', priority: 5 },
  ],
  // Polygon (137)
  [137]: [
    { url: 'https://polygon-mainnet.g.alchemy.com/v2/', name: 'Alchemy', priority: 1, apiKeyEnv: 'ALCHEMY_API_KEY' },
    { url: 'https://polygon.llamarpc.com', name: 'LlamaNodes', priority: 2 },
    { url: 'https://polygon-rpc.com', name: 'Polygon Public', priority: 3 },
    { url: 'https://polygon.drpc.org', name: 'dRPC', priority: 4 },
    { url: 'https://1rpc.io/matic', name: '1RPC', priority: 5 },
  ],
};

const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  10: optimism,
  137: polygon,
};

const CHAIN_NAME_TO_ID: Record<string, number> = {
  ethereum: 1, eth: 1, mainnet: 1,
  base: 8453,
  arbitrum: 42161, arb: 42161,
  optimism: 10, op: 10,
  polygon: 137, matic: 137,
};

// ── MEV Protection RPCs ─────────────────────────────────────────────────────
// Private transaction RPCs that submit to block builders directly, bypassing
// the public mempool. Protects against sandwich attacks and frontrunning.

export interface MevRpcConfig {
  url: string;
  name: string;
  /** Which chain IDs this MEV RPC supports */
  chains: number[];
}

const MEV_PROTECTION_RPCS: MevRpcConfig[] = [
  {
    url: 'https://rpc.flashbots.net',
    name: 'Flashbots Protect',
    chains: [1], // Ethereum mainnet only
  },
  {
    url: 'https://rpc.mevblocker.io',
    name: 'MEV Blocker',
    chains: [1], // Ethereum mainnet only
  },
  {
    url: 'https://rpc.flashbots.net/fast',
    name: 'Flashbots Fast',
    chains: [1], // Ethereum mainnet, faster inclusion
  },
  {
    url: 'https://base.flashbots.net',
    name: 'Flashbots Base',
    chains: [8453], // Base
  },
];

// ── Circuit Breaker State ───────────────────────────────────────────────────

const healthMap = new Map<string, ProviderHealth>();

function getHealth(key: string): ProviderHealth {
  let h = healthMap.get(key);
  if (!h) {
    h = { failures: 0, lastFailure: 0, circuitOpenUntil: 0, backoffMs: 0, lastRateLimited: 0 };
    healthMap.set(key, h);
  }
  return h;
}

function recordFailure(key: string, isRateLimit: boolean, config: { circuitThreshold: number; circuitResetMs: number }): void {
  const h = getHealth(key);
  h.failures++;
  h.lastFailure = Date.now();

  if (isRateLimit) {
    h.lastRateLimited = Date.now();
    h.backoffMs = Math.min((h.backoffMs || 1000) * 2, 60_000);
  }

  if (h.failures >= config.circuitThreshold) {
    h.circuitOpenUntil = Date.now() + config.circuitResetMs;
  }
}

function recordSuccess(key: string): void {
  const h = getHealth(key);
  h.failures = 0;
  h.backoffMs = 0;
  h.circuitOpenUntil = 0;
}

function isAvailable(key: string): boolean {
  const h = healthMap.get(key);
  if (!h) return true;
  if (h.circuitOpenUntil > Date.now()) return false;
  if (h.lastRateLimited > 0 && Date.now() - h.lastRateLimited < h.backoffMs) return false;
  return true;
}

// ── RPC Manager ─────────────────────────────────────────────────────────────

export class RpcManager {
  private config: Required<RpcManagerConfig>;
  private clientCache = new Map<string, PublicClient>();

  constructor(userConfig: RpcManagerConfig = {}) {
    this.config = {
      providers: userConfig.providers ?? {},
      timeoutMs: userConfig.timeoutMs ?? 3000,
      circuitThreshold: userConfig.circuitThreshold ?? 5,
      circuitResetMs: userConfig.circuitResetMs ?? 300_000,
      mevProtection: userConfig.mevProtection ?? true,
    };
  }

  /** Resolve a chain name or ID to a numeric chain ID. */
  resolveChainId(chainInput: string | number): number {
    if (typeof chainInput === 'number') return chainInput;
    const num = parseInt(chainInput, 10);
    if (!isNaN(num)) return num;
    return CHAIN_NAME_TO_ID[chainInput.toLowerCase()] ?? 8453; // default Base
  }

  /** Get the ordered list of providers for a chain, filtered by health. */
  getProviders(chainId: number): RpcProviderConfig[] {
    // User overrides take precedence
    const userProviders = this.config.providers[String(chainId)];
    const defaults = DEFAULT_PROVIDERS[chainId] ?? [];
    const providers = userProviders ?? defaults;

    return providers
      .filter((p) => {
        // Skip providers that need an API key we don't have
        if (p.apiKeyEnv && !process.env[p.apiKeyEnv]) return false;
        // Skip circuit-broken providers
        const key = `${chainId}:${p.name}`;
        return isAvailable(key);
      })
      .sort((a, b) => a.priority - b.priority);
  }

  /** Build the full RPC URL for a provider (append API key if needed). */
  buildUrl(provider: RpcProviderConfig): string {
    if (provider.apiKeyEnv) {
      const key = process.env[provider.apiKeyEnv];
      if (key) return `${provider.url}${key}`;
    }
    return provider.url;
  }

  /**
   * Get a viem PublicClient for the given chain.
   * Tries providers in priority order, failing over on errors.
   */
  async getClient(chainInput: string | number = 'base'): Promise<PublicClient> {
    const chainId = this.resolveChainId(chainInput);
    const providers = this.getProviders(chainId);

    if (providers.length === 0) {
      throw new Error(
        `No available RPC providers for chain ${chainId}. ` +
        `Set ALCHEMY_API_KEY or configure custom providers.`,
      );
    }

    // Try each provider in order
    let lastError: Error | null = null;

    for (const provider of providers) {
      const cacheKey = `${chainId}:${provider.name}`;

      // Return cached client if healthy
      const cached = this.clientCache.get(cacheKey);
      if (cached) return cached;

      try {
        const url = this.buildUrl(provider);
        const chain = CHAIN_MAP[chainId];

        const transport = http(url, { timeout: this.config.timeoutMs });
        const client = createPublicClient({
          chain,
          transport,
        });

        // Validate with a quick call
        await client.getBlockNumber();

        recordSuccess(cacheKey);
        this.clientCache.set(cacheKey, client as PublicClient);
        return client as PublicClient;
      } catch (err) {
        lastError = err as Error;
        // H9: Sanitize any API keys that may appear in error messages
        if (lastError.message) {
          lastError.message = lastError.message.replace(
            /[?&/][a-zA-Z0-9_\-]{20,}/g,
            '/[REDACTED]'
          );
        }
        const isRateLimit = lastError.message.includes('429') ||
          lastError.message.toLowerCase().includes('rate limit');

        recordFailure(cacheKey, isRateLimit, {
          circuitThreshold: this.config.circuitThreshold,
          circuitResetMs: this.config.circuitResetMs,
        });

        // Remove cached client on failure
        this.clientCache.delete(cacheKey);
      }
    }

    // H9: Sanitize API keys from error messages before exposing to LLM
    const sanitizedError = lastError?.message?.replace(
      /[?&/][a-zA-Z0-9_\-]{20,}/g,
      '/[REDACTED]'
    ) ?? 'Unknown error';
    throw new Error(
      `All RPC providers failed for chain ${chainId}. Last error: ${sanitizedError}`,
    );
  }

  /** Clear all cached clients (useful when switching chains). */
  clearCache(): void {
    this.clientCache.clear();
  }

  /** Get health status of all providers (for diagnostics). */
  getHealthReport(chainId: number): Array<{
    name: string;
    url: string;
    available: boolean;
    failures: number;
    circuitOpen: boolean;
  }> {
    const providers = DEFAULT_PROVIDERS[chainId] ?? [];
    return providers.map((p) => {
      const key = `${chainId}:${p.name}`;
      const h = healthMap.get(key);
      return {
        name: p.name,
        url: p.url,
        available: isAvailable(key),
        failures: h?.failures ?? 0,
        circuitOpen: (h?.circuitOpenUntil ?? 0) > Date.now(),
      };
    });
  }

  /** List supported chain IDs. */
  getSupportedChains(): number[] {
    return Object.keys(DEFAULT_PROVIDERS).map(Number);
  }

  // ── MEV Protection ──────────────────────────────────────────────────────

  /** Check if MEV protection is enabled. */
  isMevProtectionEnabled(): boolean {
    return this.config.mevProtection;
  }

  /**
   * Get MEV-protected RPC URLs for a chain.
   * Returns private transaction RPCs that bypass the public mempool.
   * Falls back to empty array if no MEV RPCs are available for the chain.
   */
  getMevRpcs(chainId: number): MevRpcConfig[] {
    if (!this.config.mevProtection) return [];
    return MEV_PROTECTION_RPCS.filter(r => r.chains.includes(chainId));
  }

  /**
   * Get a viem http transport configured for MEV-protected submission.
   * Uses Flashbots Protect (primary) with MEV Blocker as fallback.
   * Returns null if no MEV RPCs are available for the chain.
   */
  getMevTransport(chainId: number): ReturnType<typeof http> | null {
    const rpcs = this.getMevRpcs(chainId);
    if (rpcs.length === 0) return null;

    // Use first available MEV RPC, with health check filtering
    for (const rpc of rpcs) {
      const key = `mev:${chainId}:${rpc.name}`;
      if (isAvailable(key)) {
        return http(rpc.url, { timeout: this.config.timeoutMs });
      }
    }

    // All circuit-broken — return first anyway (circuit will reset eventually)
    return http(rpcs[0]!.url, { timeout: this.config.timeoutMs });
  }

  /**
   * Record a MEV RPC failure (for circuit breaker tracking).
   */
  recordMevFailure(chainId: number, rpcName: string, isRateLimit = false): void {
    const key = `mev:${chainId}:${rpcName}`;
    recordFailure(key, isRateLimit, {
      circuitThreshold: this.config.circuitThreshold,
      circuitResetMs: this.config.circuitResetMs,
    });
  }

  /**
   * Record a MEV RPC success.
   */
  recordMevSuccess(chainId: number, rpcName: string): void {
    recordSuccess(`mev:${chainId}:${rpcName}`);
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: RpcManager | null = null;

export function getRpcManager(config?: RpcManagerConfig): RpcManager {
  if (!_instance) {
    _instance = new RpcManager(config);
  }
  return _instance;
}

export function resetRpcManager(): void {
  _instance = null;
  healthMap.clear();
}
