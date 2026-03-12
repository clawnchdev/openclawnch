/**
 * RPC commands — view and configure RPC providers.
 *
 * /rpc — Show current RPC provider configuration and health per chain.
 */

import { getRpcManager } from '../services/rpc-provider.js';

const CHAIN_NAMES: Record<number, string> = {
  8453: 'Base',
  1: 'Ethereum',
  42161: 'Arbitrum',
  10: 'Optimism',
  137: 'Polygon',
};

export const rpcCommand = {
  name: 'rpc',
  description: 'Show RPC provider configuration, health, and active endpoints per chain',
  acceptsArgs: false,
  requireAuth: false,
  handler: async () => {
    const rpc = getRpcManager();
    const chains = rpc.getSupportedChains();
    const sections: string[] = [];

    for (const chainId of chains) {
      const name = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
      const providers = rpc.getProviders(chainId);
      const health = rpc.getHealthReport(chainId);

      if (providers.length === 0) {
        sections.push(`**${name}** (${chainId}): No available providers`);
        continue;
      }

      const top = providers[0]!;
      const topUrl = rpc.buildUrl(top);
      // Redact API keys / tokens from display
      const displayUrl = topUrl.replace(/[?&/][a-zA-Z0-9_\-]{20,}/g, '/***');

      const healthyCount = health.filter(h => h.available).length;
      const circuitOpen = health.filter(h => h.circuitOpen).length;

      let line = `**${name}** (${chainId}): ${top.name}`;
      line += `\n  URL: \`${displayUrl}\``;
      line += `\n  Providers: ${healthyCount}/${health.length} healthy`;
      if (circuitOpen > 0) {
        line += ` | ${circuitOpen} circuit-broken`;
      }
      if (providers.length > 1) {
        const fallbacks = providers.slice(1).map(p => p.name).join(', ');
        line += `\n  Fallback: ${fallbacks}`;
      }

      sections.push(line);
    }

    // Show custom/QuickNode env var status
    const envHints: string[] = [];
    if (process.env.RPC_URL) envHints.push('`RPC_URL` set (custom global)');
    if (process.env.QUICKNODE_ENDPOINT) envHints.push('`QUICKNODE_ENDPOINT` set');
    for (const [id, envName] of Object.entries({
      8453: 'RPC_URL_BASE', 1: 'RPC_URL_ETH', 42161: 'RPC_URL_ARB',
      10: 'RPC_URL_OP', 137: 'RPC_URL_POLYGON',
    })) {
      if (process.env[envName]) {
        const chain = CHAIN_NAMES[Number(id)] ?? id;
        envHints.push(`\`${envName}\` set (${chain})`);
      }
    }
    for (const [id, envName] of Object.entries({
      8453: 'QUICKNODE_ENDPOINT_BASE', 1: 'QUICKNODE_ENDPOINT_ETH',
      42161: 'QUICKNODE_ENDPOINT_ARB', 10: 'QUICKNODE_ENDPOINT_OP',
      137: 'QUICKNODE_ENDPOINT_POLYGON',
    })) {
      if (process.env[envName]) {
        const chain = CHAIN_NAMES[Number(id)] ?? id;
        envHints.push(`\`${envName}\` set (${chain})`);
      }
    }
    if (process.env.ALCHEMY_API_KEY) envHints.push('`ALCHEMY_API_KEY` set');

    const mev = rpc.isMevProtectionEnabled() ? 'ON' : 'OFF';

    let text = `**RPC Configuration**\n\n${sections.join('\n\n')}`;
    text += `\n\nMEV protection: ${mev}`;
    if (envHints.length > 0) {
      text += `\n\n**Configured env vars:**\n${envHints.map(h => `  ${h}`).join('\n')}`;
    }
    text += '\n\nSet `RPC_URL_BASE`, `QUICKNODE_ENDPOINT`, or `ALCHEMY_API_KEY` env vars to configure providers.';

    return { text };
  },
};
