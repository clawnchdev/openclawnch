/**
 * Block Explorer Tool — Etherscan/Basescan API integrations.
 *
 * Provides on-chain data lookup via Etherscan-compatible APIs:
 * Etherscan (Ethereum mainnet) and Basescan (Base). Requires
 * ETHERSCAN_API_KEY and/or BASESCAN_API_KEY environment variables.
 *
 * Actions:
 *   tx_lookup       — Get transaction details by hash
 *   contract_source — Fetch verified contract source code and ABI
 *   gas_tracker     — Current gas prices (fast/standard/slow)
 *   token_holders   — Top token holders and holder count
 *   internal_txs    — Internal transactions for an address or tx
 *
 * Supports both Ethereum and Base chains.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';

const ACTIONS = ['tx_lookup', 'contract_source', 'gas_tracker', 'token_holders', 'internal_txs'] as const;
const CHAINS = ['base', 'ethereum'] as const;

interface ExplorerConfig {
  apiUrl: string;
  apiKey: string;
  name: string;
  chainId: number;
}

function getExplorerConfig(chain: string): ExplorerConfig {
  switch (chain.toLowerCase()) {
    case 'ethereum':
    case 'eth':
    case 'mainnet': {
      const apiKey = process.env.ETHERSCAN_API_KEY;
      if (!apiKey) throw new Error('ETHERSCAN_API_KEY environment variable is required for Ethereum lookups.');
      return { apiUrl: 'https://api.etherscan.io/api', apiKey, name: 'Etherscan', chainId: 1 };
    }
    case 'base':
    default: {
      const apiKey = process.env.BASESCAN_API_KEY;
      if (!apiKey) throw new Error('BASESCAN_API_KEY environment variable is required for Base lookups.');
      return { apiUrl: 'https://api.basescan.org/api', apiKey, name: 'Basescan', chainId: 8453 };
    }
  }
}

async function explorerFetch(config: ExplorerConfig, params: Record<string, string>): Promise<any> {
  const url = new URL(config.apiUrl);
  url.searchParams.set('apikey', config.apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`${config.name} API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();

  // Etherscan returns status "0" for errors
  if (data.status === '0' && data.message !== 'No transactions found' && data.message !== 'No records found') {
    throw new Error(`${config.name}: ${data.result || data.message}`);
  }

  return data;
}

const BlockExplorerSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'tx_lookup: transaction details by hash. ' +
      'contract_source: verified contract source/ABI. ' +
      'gas_tracker: current gas prices. ' +
      'token_holders: top holders of a token. ' +
      'internal_txs: internal (trace) transactions.',
  }),
  chain: Type.Optional(stringEnum(CHAINS, {
    description: 'Chain: "base" (default) or "ethereum".',
  })),
  tx_hash: Type.Optional(Type.String({
    description: 'Transaction hash (0x...). Required for tx_lookup.',
  })),
  address: Type.Optional(Type.String({
    description: 'Contract or wallet address (0x...). Required for contract_source, token_holders, internal_txs.',
  })),
  token: Type.Optional(Type.String({
    description: 'Token contract address (0x...). Required for token_holders.',
  })),
  page: Type.Optional(Type.Number({
    description: 'Page number for paginated results. Default: 1.',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Results per page. Default: 25, max: 100.',
  })),
});

export function createBlockExplorerTool() {
  return {
    name: 'block_explorer',
    label: 'Block Explorer',
    ownerOnly: false,
    description:
      'Query Etherscan/Basescan APIs for on-chain data. Look up transactions, ' +
      'contract source code, gas prices, token holders, and internal transactions.',
    parameters: BlockExplorerSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'tx_lookup':
          return handleTxLookup(params);
        case 'contract_source':
          return handleContractSource(params);
        case 'gas_tracker':
          return handleGasTracker(params);
        case 'token_holders':
          return handleTokenHolders(params);
        case 'internal_txs':
          return handleInternalTxs(params);
        default:
          return errorResult(`Unknown action: ${action}. Use: ${ACTIONS.join(', ')}`);
      }
    },
  };
}

// ─── Action Handlers ──────────────────────────────────────────────────────

async function handleTxLookup(params: Record<string, unknown>) {
  const txHash = readStringParam(params, 'tx_hash') ?? readStringParam(params, 'txHash');
  if (!txHash) return errorResult('tx_hash is required for tx_lookup.');

  const chain = readStringParam(params, 'chain') ?? 'base';

  try {
    const config = getExplorerConfig(chain);

    // Get transaction details
    const txData = await explorerFetch(config, {
      module: 'proxy',
      action: 'eth_getTransactionByHash',
      txhash: txHash,
    });

    const tx = txData.result;
    if (!tx) return errorResult(`Transaction not found: ${txHash}`);

    // Get receipt for status and gas used
    const receiptData = await explorerFetch(config, {
      module: 'proxy',
      action: 'eth_getTransactionReceipt',
      txhash: txHash,
    });

    const receipt = receiptData.result;

    const gasPrice = tx.gasPrice ? parseInt(tx.gasPrice, 16) : 0;
    const gasUsed = receipt?.gasUsed ? parseInt(receipt.gasUsed, 16) : 0;
    const gasCostWei = BigInt(gasPrice) * BigInt(gasUsed);

    return jsonResult({
      chain,
      explorer: config.name,
      txHash,
      status: receipt?.status === '0x1' ? 'success' : receipt?.status === '0x0' ? 'reverted' : 'pending',
      blockNumber: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
      from: tx.from,
      to: tx.to,
      value: tx.value ? (parseInt(tx.value, 16) / 1e18).toString() + ' ETH' : '0',
      gasPrice: gasPrice > 0 ? (gasPrice / 1e9).toFixed(2) + ' gwei' : null,
      gasUsed: gasUsed > 0 ? gasUsed : null,
      gasCostEth: gasCostWei > 0n ? (Number(gasCostWei) / 1e18).toFixed(6) : null,
      nonce: tx.nonce ? parseInt(tx.nonce, 16) : null,
      input: tx.input?.length > 10 ? `${tx.input.slice(0, 10)}... (${(tx.input.length - 2) / 2} bytes)` : tx.input,
      logs: receipt?.logs?.length ?? 0,
    });
  } catch (err) {
    return errorResult(`TX lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleContractSource(params: Record<string, unknown>) {
  const address = readStringParam(params, 'address', { required: true })!;
  const chain = readStringParam(params, 'chain') ?? 'base';

  try {
    const config = getExplorerConfig(chain);

    const data = await explorerFetch(config, {
      module: 'contract',
      action: 'getsourcecode',
      address,
    });

    const result = data.result?.[0];
    if (!result) return errorResult(`No contract found at ${address}`);

    const isVerified = result.SourceCode && result.SourceCode !== '';

    return jsonResult({
      chain,
      explorer: config.name,
      address,
      isVerified,
      contractName: result.ContractName || null,
      compilerVersion: result.CompilerVersion || null,
      optimizationUsed: result.OptimizationUsed === '1',
      runs: result.Runs ? parseInt(result.Runs) : null,
      evmVersion: result.EVMVersion || null,
      licenseType: result.LicenseType || null,
      proxy: result.Proxy === '1',
      implementation: result.Implementation || null,
      // Truncate source if very long
      sourceCode: result.SourceCode
        ? result.SourceCode.length > 5000
          ? result.SourceCode.slice(0, 5000) + `\n... (${result.SourceCode.length} chars total, truncated)`
          : result.SourceCode
        : null,
      abi: result.ABI && result.ABI !== 'Contract source code not verified'
        ? JSON.parse(result.ABI)
        : null,
    });
  } catch (err) {
    return errorResult(`Contract source failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleGasTracker(params: Record<string, unknown>) {
  const chain = readStringParam(params, 'chain') ?? 'base';

  try {
    const config = getExplorerConfig(chain);

    const data = await explorerFetch(config, {
      module: 'gastracker',
      action: 'gasoracle',
    });

    const result = data.result;
    if (!result) return errorResult('Gas tracker data unavailable.');

    return jsonResult({
      chain,
      explorer: config.name,
      gasPrice: {
        fast: result.FastGasPrice ? parseFloat(result.FastGasPrice) : null,
        standard: result.ProposeGasPrice ? parseFloat(result.ProposeGasPrice) : null,
        slow: result.SafeGasPrice ? parseFloat(result.SafeGasPrice) : null,
        unit: 'gwei',
      },
      baseFee: result.suggestBaseFee ? parseFloat(result.suggestBaseFee) : null,
      gasUsedRatio: result.gasUsedRatio || null,
      lastBlock: result.LastBlock || null,
      // Estimate costs for common operations
      estimates: {
        ethTransfer: {
          fast: result.FastGasPrice ? (parseFloat(result.FastGasPrice) * 21000 / 1e9).toFixed(6) + ' ETH' : null,
          standard: result.ProposeGasPrice ? (parseFloat(result.ProposeGasPrice) * 21000 / 1e9).toFixed(6) + ' ETH' : null,
        },
        erc20Transfer: {
          fast: result.FastGasPrice ? (parseFloat(result.FastGasPrice) * 65000 / 1e9).toFixed(6) + ' ETH' : null,
          standard: result.ProposeGasPrice ? (parseFloat(result.ProposeGasPrice) * 65000 / 1e9).toFixed(6) + ' ETH' : null,
        },
        swap: {
          fast: result.FastGasPrice ? (parseFloat(result.FastGasPrice) * 200000 / 1e9).toFixed(6) + ' ETH' : null,
          standard: result.ProposeGasPrice ? (parseFloat(result.ProposeGasPrice) * 200000 / 1e9).toFixed(6) + ' ETH' : null,
        },
      },
    });
  } catch (err) {
    return errorResult(`Gas tracker failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleTokenHolders(params: Record<string, unknown>) {
  const token = readStringParam(params, 'token') ?? readStringParam(params, 'address');
  if (!token) return errorResult('token (or address) is required for token_holders.');

  const chain = readStringParam(params, 'chain') ?? 'base';
  const page = readNumberParam(params, 'page') ?? 1;
  const limit = Math.min(readNumberParam(params, 'limit') ?? 25, 100);

  try {
    const config = getExplorerConfig(chain);

    // Get token info
    const tokenInfo = await explorerFetch(config, {
      module: 'token',
      action: 'tokeninfo',
      contractaddress: token,
    });

    // Get top holders via token holder list
    const holdersData = await explorerFetch(config, {
      module: 'token',
      action: 'tokenholderlist',
      contractaddress: token,
      page: String(page),
      offset: String(limit),
    });

    const info = tokenInfo.result?.[0] ?? {};
    const holders = holdersData.result ?? [];

    // Calculate percentages if we have total supply
    const totalSupply = info.totalSupply ? BigInt(info.totalSupply) : null;
    const decimals = info.divisor ? parseInt(info.divisor) : 18;

    return jsonResult({
      chain,
      explorer: config.name,
      token,
      tokenName: info.tokenName || null,
      tokenSymbol: info.symbol || null,
      totalSupply: totalSupply !== null
        ? (Number(totalSupply) / Math.pow(10, decimals)).toString()
        : null,
      holdersCount: info.holdersCount || holders.length,
      page,
      limit,
      holders: holders.map((h: any) => {
        const balance = BigInt(h.TokenHolderQuantity || '0');
        const balanceFormatted = (Number(balance) / Math.pow(10, decimals)).toFixed(4);
        const percentage = totalSupply && totalSupply > 0n
          ? (Number(balance * 10000n / totalSupply) / 100).toFixed(2) + '%'
          : null;

        return {
          address: h.TokenHolderAddress,
          balance: balanceFormatted,
          percentage,
        };
      }),
    });
  } catch (err) {
    return errorResult(`Token holders failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleInternalTxs(params: Record<string, unknown>) {
  const address = readStringParam(params, 'address');
  const txHash = readStringParam(params, 'tx_hash') ?? readStringParam(params, 'txHash');
  const chain = readStringParam(params, 'chain') ?? 'base';
  const page = readNumberParam(params, 'page') ?? 1;
  const limit = Math.min(readNumberParam(params, 'limit') ?? 25, 100);

  if (!address && !txHash) {
    return errorResult('Either address or tx_hash is required for internal_txs.');
  }

  try {
    const config = getExplorerConfig(chain);

    let data: any;
    if (txHash) {
      // Internal txs for a specific transaction
      data = await explorerFetch(config, {
        module: 'account',
        action: 'txlistinternal',
        txhash: txHash,
      });
    } else {
      // Internal txs for an address
      data = await explorerFetch(config, {
        module: 'account',
        action: 'txlistinternal',
        address: address!,
        startblock: '0',
        endblock: '99999999',
        page: String(page),
        offset: String(limit),
        sort: 'desc',
      });
    }

    const txs = data.result ?? [];

    return jsonResult({
      chain,
      explorer: config.name,
      query: txHash ? { txHash } : { address },
      count: txs.length,
      page: txHash ? undefined : page,
      transactions: txs.map((tx: any) => ({
        blockNumber: tx.blockNumber,
        timestamp: tx.timeStamp ? new Date(parseInt(tx.timeStamp) * 1000).toISOString() : null,
        from: tx.from,
        to: tx.to,
        value: tx.value ? (parseInt(tx.value) / 1e18).toFixed(6) + ' ETH' : '0',
        type: tx.type || 'call',
        gas: tx.gas,
        gasUsed: tx.gasUsed,
        isError: tx.isError === '1',
        errCode: tx.errCode || null,
        traceId: tx.traceId || null,
      })),
    });
  } catch (err) {
    return errorResult(`Internal txs failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
