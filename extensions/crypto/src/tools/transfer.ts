/**
 * Transfer Tool — Send ETH or ERC-20 tokens to a recipient address.
 *
 * The most fundamental wallet operation. Uses viem directly for ETH transfers,
 * and the erc20Abi for ERC-20 transfers. Reads token metadata (decimals, symbol)
 * via ClawnchSwapper. All transactions go through ClawnchConnect for approval.
 *
 * Safety: pre-flight balance check via safety-service.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam, readNumberParam } from '../lib/tool-helpers.js';
import {
  getWalletState,
  requireWalletClient,
  requirePublicClient,
} from '../services/walletconnect-service.js';
import { checkBalance } from '../services/safety-service.js';

const ACTIONS = ['send', 'estimate'] as const;

const TransferSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: 'send: execute the transfer. estimate: check balance and estimate gas without sending.',
  }),
  to: Type.String({
    description: 'Recipient address (0x...)',
  }),
  amount: Type.String({
    description: 'Amount to send in human-readable units (e.g. "0.1" for 0.1 ETH, "100" for 100 USDC)',
  }),
  token: Type.Optional(Type.String({
    description: 'ERC-20 token contract address (0x...). Omit for native ETH transfer.',
  })),
});

export function createTransferTool() {
  return {
    name: 'transfer',
    label: 'Transfer',
    ownerOnly: false,
    description:
      'Send ETH or ERC-20 tokens to a recipient address. ' +
      'Use action "estimate" to preview gas costs and check balance, ' +
      'or "send" to execute. All transactions go through ClawnchConnect for approval.',
    parameters: TransferSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      const state = getWalletState();
      if (!state.connected) {
        return errorResult('No wallet connected. Use clawnchconnect tool to connect first.');
      }

      switch (action) {
        case 'send':
          return handleSend(params);
        case 'estimate':
          return handleEstimate(params);
        default:
          return errorResult(`Unknown action: ${action}. Use: send, estimate`);
      }
    },
  };
}

// ─── Well-known tokens on Base ────────────────────────────────────────────

const BASE_TOKENS: Record<string, { address: string; decimals: number; symbol: string }> = {
  USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' },
  USDT: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6, symbol: 'USDT' },
  DAI: { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, symbol: 'DAI' },
  WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, symbol: 'WETH' },
  CLAWNCH: { address: '0xa1F72459dfA10BAD200Ac160eCd78C6b77a747be', decimals: 18, symbol: 'CLAWNCH' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────

async function getTokenInfo(tokenAddress: string): Promise<{ decimals: number; symbol: string }> {
  // Check well-known tokens first
  for (const info of Object.values(BASE_TOKENS)) {
    if (info.address.toLowerCase() === tokenAddress.toLowerCase()) {
      return { decimals: info.decimals, symbol: info.symbol };
    }
  }

  // Read from chain via ClawnchSwapper
  try {
    const { ClawnchSwapper } = await import('@clawnch/clawncher-sdk');
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    const swapper = new ClawnchSwapper({
      wallet: wallet as any,
      publicClient: publicClient as any,
      network: 'mainnet',
    });

    const [decimals, symbol] = await Promise.all([
      swapper.getDecimals(tokenAddress as `0x${string}`),
      swapper.getSymbol(tokenAddress as `0x${string}`),
    ]);

    return { decimals, symbol };
  } catch {
    // Fallback: assume 18 decimals
    return { decimals: 18, symbol: 'UNKNOWN' };
  }
}

function parseTokenAmount(amount: string, decimals: number): bigint {
  // Handle decimal amounts properly
  const parts = amount.split('.');
  const whole = parts[0] ?? '0';
  let fraction = parts[1] ?? '';

  // Pad or truncate fraction to match decimals
  if (fraction.length > decimals) {
    fraction = fraction.slice(0, decimals);
  } else {
    fraction = fraction.padEnd(decimals, '0');
  }

  return BigInt(whole + fraction);
}

// ─── Action Handlers ──────────────────────────────────────────────────────

async function handleEstimate(params: Record<string, unknown>) {
  const to = readStringParam(params, 'to', { required: true })!;
  const amount = readStringParam(params, 'amount', { required: true })!;
  const tokenAddr = readStringParam(params, 'token');
  const isErc20 = !!tokenAddr;

  try {
    const publicClient = requirePublicClient();
    const state = getWalletState();
    const { formatEther, formatUnits, erc20Abi } = await import('viem');

    // Get ETH balance
    const ethBalance = await publicClient.getBalance({ address: state.address! });
    const ethBalanceFormatted = formatEther(ethBalance);

    const result: Record<string, unknown> = {
      to,
      amount,
      type: isErc20 ? 'ERC-20' : 'ETH',
      ethBalance: ethBalanceFormatted,
    };

    if (isErc20) {
      const info = await getTokenInfo(tokenAddr!);
      result.token = { address: tokenAddr, symbol: info.symbol, decimals: info.decimals };

      // Check ERC-20 balance
      try {
        const tokenBalance = await publicClient.readContract({
          address: tokenAddr as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [state.address!],
        }) as bigint;

        const tokenBalanceFormatted = formatUnits(tokenBalance, info.decimals);
        result.tokenBalance = tokenBalanceFormatted;

        const amountWei = parseTokenAmount(amount, info.decimals);
        if (amountWei > tokenBalance) {
          result.sufficientTokenBalance = false;
          result.shortfall = formatUnits(amountWei - tokenBalance, info.decimals);
        } else {
          result.sufficientTokenBalance = true;
        }
      } catch (err) {
        result.tokenBalanceError = err instanceof Error ? err.message : String(err);
      }

      // Check ETH for gas
      const safety = await checkBalance({ requiredEth: 0 });
      result.sufficientGas = safety.safe;
      if (!safety.safe) result.gasWarning = safety.blockers.join('; ');
    } else {
      // Native ETH transfer
      const amountEth = parseFloat(amount);
      const safety = await checkBalance({ requiredEth: amountEth });
      result.sufficientBalance = safety.safe;
      if (!safety.safe) result.balanceWarning = safety.blockers.join('; ');
      if (safety.warnings.length > 0) result.warnings = safety.warnings;
    }

    // Estimate gas
    try {
      if (isErc20) {
        const amountWei = parseTokenAmount(amount, (result.token as any).decimals);
        const gas = await publicClient.estimateGas({
          account: state.address!,
          to: tokenAddr as `0x${string}`,
          data: encodeFunctionData_transfer(to as `0x${string}`, amountWei),
        });
        result.estimatedGas = gas.toString();
      } else {
        const { parseEther } = await import('viem');
        const gas = await publicClient.estimateGas({
          account: state.address!,
          to: to as `0x${string}`,
          value: parseEther(amount),
        });
        result.estimatedGas = gas.toString();
      }
    } catch (err) {
      result.gasEstimateError = err instanceof Error ? err.message : String(err);
    }

    return jsonResult(result);
  } catch (err) {
    return errorResult(`Estimate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleSend(params: Record<string, unknown>) {
  const to = readStringParam(params, 'to', { required: true })!;
  const amount = readStringParam(params, 'amount', { required: true })!;
  const tokenAddr = readStringParam(params, 'token');
  const isErc20 = !!tokenAddr;

  try {
    const wallet = requireWalletClient();
    const publicClient = requirePublicClient();

    if (isErc20) {
      // ─── ERC-20 Transfer ─────────────────────────────────────────
      const info = await getTokenInfo(tokenAddr!);
      const amountWei = parseTokenAmount(amount, info.decimals);

      // Pre-flight: check token balance
      const { erc20Abi, formatUnits } = await import('viem');
      const state = getWalletState();
      const tokenBalance = await publicClient.readContract({
        address: tokenAddr as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [state.address!],
      }) as bigint;

      if (amountWei > tokenBalance) {
        return errorResult(
          `Insufficient ${info.symbol} balance. ` +
          `Have: ${formatUnits(tokenBalance, info.decimals)}, need: ${amount}`
        );
      }

      // Pre-flight: check ETH for gas
      const safety = await checkBalance({ requiredEth: 0 });
      if (!safety.safe) {
        return errorResult(`Insufficient gas: ${safety.blockers.join('; ')}`);
      }

      // Execute
      const txHash = await wallet.writeContract({
        address: tokenAddr as `0x${string}`,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to as `0x${string}`, amountWei],
      });

      // Wait for receipt
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === 'reverted') {
        return errorResult(`Transfer reverted. TX: ${txHash}`);
      }

      return jsonResult({
        status: 'success',
        type: 'ERC-20',
        token: { address: tokenAddr, symbol: info.symbol, decimals: info.decimals },
        to,
        amount,
        amountWei: amountWei.toString(),
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
      });
    } else {
      // ─── Native ETH Transfer ─────────────────────────────────────
      const amountEth = parseFloat(amount);
      const safety = await checkBalance({ requiredEth: amountEth });
      if (!safety.safe) {
        return errorResult(`Insufficient balance: ${safety.blockers.join('; ')}`);
      }

      const { parseEther } = await import('viem');
      const value = parseEther(amount);

      const txHash = await wallet.sendTransaction({
        to: to as `0x${string}`,
        value,
      });

      // Wait for receipt
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === 'reverted') {
        return errorResult(`Transfer reverted. TX: ${txHash}`);
      }

      return jsonResult({
        status: 'success',
        type: 'ETH',
        to,
        amount,
        amountWei: value.toString(),
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
      });
    }
  } catch (err) {
    return errorResult(`Transfer failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── ABI Encoding Helper ──────────────────────────────────────────────────

/**
 * Minimal ERC-20 transfer calldata encoder (avoids importing encodeFunctionData).
 * transfer(address,uint256) = 0xa9059cbb
 */
function encodeFunctionData_transfer(to: `0x${string}`, amount: bigint): `0x${string}` {
  const selector = '0xa9059cbb';
  const toParam = to.slice(2).toLowerCase().padStart(64, '0');
  const amountParam = amount.toString(16).padStart(64, '0');
  return `${selector}${toParam}${amountParam}` as `0x${string}`;
}
