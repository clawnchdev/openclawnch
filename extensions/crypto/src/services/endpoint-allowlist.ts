/**
 * Endpoint Allowlist — restrict outbound HTTP requests to approved hosts.
 *
 * Inspired by IronClaw's endpoint allowlisting pattern.
 * Prevents prompt injection attacks from tricking the agent into
 * exfiltrating data to attacker-controlled URLs.
 *
 * Usage:
 *   import { guardedFetch, isAllowedEndpoint } from './endpoint-allowlist.js';
 *
 *   // Use guardedFetch as a drop-in replacement for fetch()
 *   const resp = await guardedFetch('https://api.0x.org/swap/v1/quote?...');
 *
 *   // Or check manually before calling fetch
 *   if (!isAllowedEndpoint(url)) throw new Error('Blocked');
 */

// ─── Allowed Hosts ──────────────────────────────────────────────────────
// Organized by category. Every external HTTP call our tools make should
// hit one of these hosts. If a new integration is added, its hosts must
// be added here.

const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  // ── DEX Aggregators ──────────────────────────────────────────────────
  'api.0x.org',
  'api.1inch.dev',
  'apiv5.paraswap.io',
  'api.odos.xyz',
  'aggregator-api.kyberswap.com',
  'open-api.openocean.finance',

  // ── Price Feeds ──────────────────────────────────────────────────────
  'api.dexscreener.com',
  'api.coingecko.com',
  'pro-api.coingecko.com',
  'pro-api.coinmarketcap.com',
  'coins.llama.fi',
  'yields.llama.fi',
  'public-api.birdeye.so',

  // ── RPC Providers (accessed via viem, not raw fetch, but listed for completeness)
  'base-mainnet.g.alchemy.com',
  'eth-mainnet.g.alchemy.com',
  'arb-mainnet.g.alchemy.com',
  'opt-mainnet.g.alchemy.com',
  'polygon-mainnet.g.alchemy.com',
  'base.llamarpc.com',
  'eth.llamarpc.com',
  'arbitrum.llamarpc.com',
  'optimism.llamarpc.com',
  'polygon.llamarpc.com',
  'mainnet.base.org',
  'base.drpc.org',
  'base.meowrpc.com',
  '1rpc.io',
  'ethereum.publicnode.com',
  'eth.drpc.org',
  'rpc.ankr.com',
  'arb1.arbitrum.io',
  'arbitrum.drpc.org',
  'mainnet.optimism.io',
  'optimism.drpc.org',
  'polygon-rpc.com',
  'polygon.drpc.org',

  // ── Block Explorers ──────────────────────────────────────────────────
  'api.basescan.org',
  'api.etherscan.io',
  'api.arbiscan.io',
  'api-optimistic.etherscan.io',
  'api.polygonscan.com',

  // ── Bridge ───────────────────────────────────────────────────────────
  'li.quest',

  // ── Bankr Agent API ──────────────────────────────────────────────────
  'api.bankr.bot',
  'llm.bankr.bot',

  // ── Clawnch Platform ─────────────────────────────────────────────────
  'clawn.ch',
  'api.clawn.ch',

  // ── WalletConnect ────────────────────────────────────────────────────
  'relay.walletconnect.com',
  'relay.walletconnect.org',
  'explorer-api.walletconnect.com',

  // ── External Integrations ────────────────────────────────────────────
  'herdintelligence.com',
  'api.herdintelligence.com',
  'api.molten.gg',
  'api.wayfinder.ai',

  // ── NFT (Reservoir) ───────────────────────────────────────────────
  'api.reservoir.tools',
  'api-base.reservoir.tools',
  'api-arbitrum.reservoir.tools',
  'api-optimism.reservoir.tools',
  'api-polygon.reservoir.tools',

  // ── Governance ────────────────────────────────────────────────────────
  'hub.snapshot.org',
  'api.tally.xyz',

  // ── Farcaster (Neynar API) ──────────────────────────────────────────
  'api.neynar.com',

  // ── Safe Transaction Service ──────────────────────────────────────────
  'safe-transaction-mainnet.safe.global',
  'safe-transaction-base.safe.global',
  'safe-transaction-arbitrum.safe.global',
  'safe-transaction-optimism.safe.global',
  'safe-transaction-polygon.safe.global',

  // ── Airdrop Eligibility APIs ──────────────────────────────────────────
  'claims.eigenfoundation.org',
  'www.layerzero.foundation',

  // ── X/Twitter (ClawnX tool) ──────────────────────────────────────────
  'api.twitter.com',
  'api.x.com',

  // ── Telegram Bot API ─────────────────────────────────────────────────
  'api.telegram.org',

  // ── Fly.io deployment API ────────────────────────────────────────────
  'api.machines.dev',
  'api.fly.io',
]);

// Hosts that are allowed ONLY as exact matches (no subdomain matching).
// Prevents e.g. "evil.localhost" from being allowed.
const EXACT_ONLY_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
]);

// ── Additional user-configured hosts (loaded from env at startup) ──────
const _userHosts = new Set<string>();

// ── Allowlist mode (locked at startup to prevent env injection bypass) ──
let _allowlistMode: string = process.env.OPENCLAWNCH_ALLOWLIST_MODE ?? 'enforce';

function loadUserHosts(): void {
  const extra = process.env.OPENCLAWNCH_ALLOWED_HOSTS;
  if (extra) {
    for (const h of extra.split(',')) {
      const trimmed = h.trim().toLowerCase();
      if (trimmed) _userHosts.add(trimmed);
    }
  }
}

// Load once at module init
loadUserHosts();

// ─── Core Functions ──────────────────────────────────────────────────────

/**
 * Check if a URL targets an allowed host.
 * Returns true if the host is in the allowlist.
 */
export function isAllowedEndpoint(urlOrHost: string): boolean {
  try {
    let host: string;

    // Handle bare hostnames (no protocol)
    if (urlOrHost.includes('://')) {
      const parsed = new URL(urlOrHost);
      host = parsed.hostname.toLowerCase();
    } else {
      // Could be "host:port" or just "host"
      host = urlOrHost.split(':')[0]!.toLowerCase();
    }

    // Exact-only hosts (no subdomain matching)
    if (EXACT_ONLY_HOSTS.has(host)) return true;

    // Exact match against main allowlist
    if (ALLOWED_HOSTS.has(host) || _userHosts.has(host)) return true;

    // Subdomain match: if "api.example.com" is allowed, "v2.api.example.com" is too
    // Only applies to ALLOWED_HOSTS and _userHosts, NOT EXACT_ONLY_HOSTS
    for (const allowed of ALLOWED_HOSTS) {
      if (host.endsWith(`.${allowed}`)) return true;
    }
    for (const allowed of _userHosts) {
      if (host.endsWith(`.${allowed}`)) return true;
    }

    return false;
  } catch {
    return false; // Malformed URL → deny
  }
}

/**
 * A guarded fetch wrapper that blocks requests to non-allowlisted hosts.
 * Drop-in replacement for global `fetch()`.
 *
 * Security features:
 * - Blocks requests to non-allowlisted hosts
 * - Prevents redirect-based allowlist bypass (redirect: 'manual')
 * - Mode locked at startup (cannot be changed via env injection)
 */
export async function guardedFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (_allowlistMode === 'off') {
    return fetch(input, init);
  }

  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

  if (!isAllowedEndpoint(url)) {
    const msg = `[endpoint-allowlist] Blocked request to non-allowlisted host: ${url}`;

    if (_allowlistMode === 'warn') {
      console.warn(msg);
      return fetch(input, init);
    }

    throw new EndpointBlockedError(url);
  }

  // Force manual redirects to prevent redirect-based allowlist bypass:
  // An attacker who controls a redirect on an allowlisted host could redirect
  // to a non-allowlisted URL, exfiltrating data.
  const mergedInit: RequestInit = { ...init, redirect: 'manual' };
  const response = await fetch(input, mergedInit);

  // Handle redirects: check the target before following
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location) {
      // Resolve relative URLs against the original
      const resolvedUrl = new URL(location, url).toString();

      if (!isAllowedEndpoint(resolvedUrl)) {
        const msg = `[endpoint-allowlist] Blocked redirect to non-allowlisted host: ${resolvedUrl} (from ${url})`;
        if (_allowlistMode === 'warn') {
          console.warn(msg);
          return fetch(resolvedUrl, init);
        }
        throw new EndpointBlockedError(resolvedUrl);
      }

      // Redirect target is allowed — follow it
      return guardedFetch(resolvedUrl, init);
    }
  }

  return response;
}

/**
 * Add a host to the runtime allowlist (does not persist across restarts).
 * Useful for dynamically discovered endpoints (e.g., user-configured RPC URLs).
 */
export function addAllowedHost(host: string): void {
  _userHosts.add(host.toLowerCase());
}

/**
 * Get the full list of allowed hosts (for diagnostics).
 */
export function getAllowedHosts(): string[] {
  return [...ALLOWED_HOSTS, ...EXACT_ONLY_HOSTS, ..._userHosts].sort();
}

/**
 * Get the current allowlist mode.
 */
export function getAllowlistMode(): string {
  return _allowlistMode;
}

/**
 * Re-read the allowlist mode from the current env.
 * ONLY for use in tests — production code should never call this
 * (the mode is locked at startup to prevent runtime env injection).
 */
export function _resetAllowlistMode(): void {
  _allowlistMode = process.env.OPENCLAWNCH_ALLOWLIST_MODE ?? 'enforce';
}

// ─── Error Class ─────────────────────────────────────────────────────────

export class EndpointBlockedError extends Error {
  public readonly blockedUrl: string;

  constructor(url: string) {
    super(
      `Request blocked: "${url}" is not in the endpoint allowlist. ` +
      `If this is a legitimate endpoint, add it to OPENCLAWNCH_ALLOWED_HOSTS or the allowlist in endpoint-allowlist.ts.`
    );
    this.name = 'EndpointBlockedError';
    this.blockedUrl = url;
  }
}
