/**
 * Staking Service — liquid staking protocol integrations.
 *
 * Supports:
 *   - Lido (stETH / wstETH) on Ethereum mainnet
 *   - Coinbase (cbETH) on Ethereum mainnet
 *   - Rocket Pool (rETH) on Ethereum mainnet
 *
 * Uses same ABI-call pattern as lending-service.ts. All protocols
 * are simple contract calls — no external SDK dependencies.
 *
 * APY data fetched from DeFiLlama yields API.
 */

import { formatUnits, parseEther } from 'viem';
import { getRpcManager } from './rpc-provider.js';
import { guardedFetch } from './endpoint-allowlist.js';

// ── Contract Addresses (Ethereum Mainnet) ───────────────────────────────────

const CONTRACTS = {
  lido: {
    stETH: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84' as const,
    wstETH: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as const,
  },
  rocketPool: {
    rETH: '0xae78736Cd615f374D3085123A210448E74Fc6393' as const,
    depositPool: '0xDD3f50F8A6CafbE9b31a427582963f465E745AF8' as const,
  },
  cbETH: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49BBf' as const,
} as const;

// Base bridged addresses (for position checking)
const BASE_TOKENS = {
  wstETH: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452' as const,
  cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' as const,
  rETH: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c' as const,
};

// ── Minimal ABIs ────────────────────────────────────────────────────────────

const LIDO_STETH_ABI = [
  {
    name: 'submit',
    inputs: [{ name: '_referral', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    name: 'balanceOf',
    inputs: [{ name: '_account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    name: 'approve',
    inputs: [
      { name: '_spender', type: 'address' },
      { name: '_amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    name: 'allowance',
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const WSTETH_ABI = [
  {
    name: 'wrap',
    inputs: [{ name: '_stETHAmount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    name: 'unwrap',
    inputs: [{ name: '_wstETHAmount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    name: 'balanceOf',
    inputs: [{ name: '_account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    name: 'stEthPerToken',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    name: 'tokensPerStEth',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const ROCKET_DEPOSIT_ABI = [
  {
    name: 'deposit',
    inputs: [],
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

const RETH_ABI = [
  {
    name: 'burn',
    inputs: [{ name: '_rethAmount', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    name: 'balanceOf',
    inputs: [{ name: '_account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    name: 'getExchangeRate',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── Types ───────────────────────────────────────────────────────────────────

export interface StakeResult {
  hash: string;
  protocol: string;
  action: string;
  asset: string;
  amount: string;
}

export interface StakingPosition {
  protocol: string;
  asset: string;
  balance: string;
  balanceEth: string;
  chain: string;
  apy?: string;
}

interface ApyData {
  protocol: string;
  symbol: string;
  apy: number;
  tvl: number;
  fetchedAt: number;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class StakingService {
  private apyCache: ApyData[] = [];
  private apyCacheTimestamp = 0;
  private readonly APY_CACHE_TTL = 600_000; // 10 minutes

  // ── Protocol Registry ──────────────────────────────────────────────

  getSupportedProtocols() {
    return [
      { id: 'lido', name: 'Lido', assets: ['stETH', 'wstETH'], chain: 'ethereum' },
      { id: 'rocket_pool', name: 'Rocket Pool', assets: ['rETH'], chain: 'ethereum' },
      { id: 'coinbase', name: 'Coinbase', assets: ['cbETH'], chain: 'ethereum' },
    ];
  }

  resolveProtocol(input: string): string | null {
    const lower = input.toLowerCase();
    if (lower === 'lido' || lower === 'steth' || lower === 'wsteth') return 'lido';
    if (lower === 'rocket_pool' || lower === 'rocketpool' || lower === 'reth') return 'rocket_pool';
    if (lower === 'coinbase' || lower === 'cbeth' || lower === 'cb') return 'coinbase';
    return null;
  }

  // ── Stake (ETH → LST) ─────────────────────────────────────────────

  async stakeEth(
    protocol: string,
    amount: bigint,
    userAddress: `0x${string}`,
    walletClient: any,
    publicClient: any,
  ): Promise<StakeResult> {
    switch (protocol) {
      case 'lido':
        return this.stakeLido(amount, userAddress, walletClient, publicClient);
      case 'rocket_pool':
        return this.stakeRocketPool(amount, walletClient, publicClient);
      case 'coinbase':
        throw new Error(
          'cbETH cannot be minted directly. Swap ETH for cbETH using defi_swap tool instead.',
        );
      default:
        throw new Error(`Unknown protocol: ${protocol}`);
    }
  }

  private async stakeLido(
    amount: bigint,
    _userAddress: `0x${string}`,
    walletClient: any,
    publicClient: any,
  ): Promise<StakeResult> {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.lido.stETH,
      abi: LIDO_STETH_ABI,
      functionName: 'submit',
      args: ['0x0000000000000000000000000000000000000000' as `0x${string}`],
      value: amount,
    });

    await publicClient.waitForTransactionReceipt({ hash });

    return {
      hash,
      protocol: 'lido',
      action: 'stake',
      asset: 'stETH',
      amount: formatUnits(amount, 18),
    };
  }

  private async stakeRocketPool(
    amount: bigint,
    walletClient: any,
    publicClient: any,
  ): Promise<StakeResult> {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.rocketPool.depositPool,
      abi: ROCKET_DEPOSIT_ABI,
      functionName: 'deposit',
      args: [],
      value: amount,
    });

    await publicClient.waitForTransactionReceipt({ hash });

    return {
      hash,
      protocol: 'rocket_pool',
      action: 'stake',
      asset: 'rETH',
      amount: formatUnits(amount, 18),
    };
  }

  // ── Unstake (LST → ETH) ───────────────────────────────────────────

  async unstake(
    protocol: string,
    amount: bigint,
    _userAddress: `0x${string}`,
    walletClient: any,
    publicClient: any,
  ): Promise<StakeResult> {
    switch (protocol) {
      case 'rocket_pool':
        return this.unstakeRocketPool(amount, walletClient, publicClient);
      case 'lido':
        throw new Error(
          'Lido unstaking uses a withdrawal queue (7+ days). ' +
          'For instant exit, swap stETH/wstETH for ETH using defi_swap tool.',
        );
      case 'coinbase':
        throw new Error(
          'cbETH cannot be redeemed directly. Swap cbETH for ETH using defi_swap tool.',
        );
      default:
        throw new Error(`Unknown protocol: ${protocol}`);
    }
  }

  private async unstakeRocketPool(
    amount: bigint,
    walletClient: any,
    publicClient: any,
  ): Promise<StakeResult> {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.rocketPool.rETH,
      abi: RETH_ABI,
      functionName: 'burn',
      args: [amount],
    });

    await publicClient.waitForTransactionReceipt({ hash });

    return {
      hash,
      protocol: 'rocket_pool',
      action: 'unstake',
      asset: 'rETH',
      amount: formatUnits(amount, 18),
    };
  }

  // ── Wrap / Unwrap (stETH ↔ wstETH) ────────────────────────────────

  async wrap(
    amount: bigint,
    userAddress: `0x${string}`,
    walletClient: any,
    publicClient: any,
  ): Promise<StakeResult> {
    // Check and approve stETH for wstETH contract
    await this.ensureStEthApproval(amount, userAddress, walletClient, publicClient);

    const hash = await walletClient.writeContract({
      address: CONTRACTS.lido.wstETH,
      abi: WSTETH_ABI,
      functionName: 'wrap',
      args: [amount],
    });

    await publicClient.waitForTransactionReceipt({ hash });

    return {
      hash,
      protocol: 'lido',
      action: 'wrap',
      asset: 'wstETH',
      amount: formatUnits(amount, 18),
    };
  }

  async unwrap(
    amount: bigint,
    _userAddress: `0x${string}`,
    walletClient: any,
    publicClient: any,
  ): Promise<StakeResult> {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.lido.wstETH,
      abi: WSTETH_ABI,
      functionName: 'unwrap',
      args: [amount],
    });

    await publicClient.waitForTransactionReceipt({ hash });

    return {
      hash,
      protocol: 'lido',
      action: 'unwrap',
      asset: 'stETH',
      amount: formatUnits(amount, 18),
    };
  }

  private async ensureStEthApproval(
    amount: bigint,
    userAddress: `0x${string}`,
    walletClient: any,
    publicClient: any,
  ): Promise<void> {
    const currentAllowance = await publicClient.readContract({
      address: CONTRACTS.lido.stETH,
      abi: LIDO_STETH_ABI,
      functionName: 'allowance',
      args: [userAddress, CONTRACTS.lido.wstETH],
    }) as bigint;

    if (currentAllowance < amount) {
      // Approve exact amount + 0.5% buffer (not unlimited) to limit exposure
      const approvalAmount = amount + (amount / 200n);
      const approveHash = await walletClient.writeContract({
        address: CONTRACTS.lido.stETH,
        abi: LIDO_STETH_ABI,
        functionName: 'approve',
        args: [CONTRACTS.lido.wstETH, approvalAmount],
      });

      // Wait for approval to confirm before proceeding (prevents race condition)
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
  }

  // ── Positions ──────────────────────────────────────────────────────

  async getPositions(
    userAddress: `0x${string}`,
    chainId: number,
    publicClient: any,
  ): Promise<StakingPosition[]> {
    const positions: StakingPosition[] = [];

    if (chainId === 1) {
      // Ethereum mainnet — check native LST balances + exchange rates
      const checks = [
        this.checkBalance(publicClient, CONTRACTS.lido.stETH, LIDO_STETH_ABI, userAddress, 'Lido', 'stETH'),
        this.checkBalance(publicClient, CONTRACTS.lido.wstETH, WSTETH_ABI, userAddress, 'Lido', 'wstETH'),
        this.checkBalance(publicClient, CONTRACTS.rocketPool.rETH, RETH_ABI, userAddress, 'Rocket Pool', 'rETH'),
        this.checkBalance(publicClient, CONTRACTS.cbETH, ERC20_BALANCE_ABI, userAddress, 'Coinbase', 'cbETH'),
      ];

      const results = await Promise.allSettled(checks);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          positions.push({ ...r.value, chain: 'ethereum' });
        }
      }

      // Fetch exchange rates for ETH equivalents
      await this.enrichWithExchangeRates(positions, publicClient, 1);
    } else if (chainId === 8453) {
      // Base — check bridged LST balances
      const checks = [
        this.checkBalance(publicClient, BASE_TOKENS.wstETH, ERC20_BALANCE_ABI, userAddress, 'Lido', 'wstETH'),
        this.checkBalance(publicClient, BASE_TOKENS.cbETH, ERC20_BALANCE_ABI, userAddress, 'Coinbase', 'cbETH'),
        this.checkBalance(publicClient, BASE_TOKENS.rETH, ERC20_BALANCE_ABI, userAddress, 'Rocket Pool', 'rETH'),
      ];

      const results = await Promise.allSettled(checks);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          positions.push({ ...r.value, chain: 'base' });
        }
      }
    }

    // Enrich with APY data
    await this.enrichWithApy(positions);

    return positions;
  }

  private async checkBalance(
    publicClient: any,
    tokenAddress: string,
    abi: readonly any[],
    userAddress: `0x${string}`,
    protocol: string,
    asset: string,
  ): Promise<Omit<StakingPosition, 'chain'> | null> {
    try {
      const balance = await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi,
        functionName: 'balanceOf',
        args: [userAddress],
      }) as bigint;

      if (balance === 0n) return null;

      return {
        protocol,
        asset,
        balance: formatUnits(balance, 18),
        balanceEth: formatUnits(balance, 18), // will be enriched with exchange rate
      };
    } catch {
      return null;
    }
  }

  private async enrichWithExchangeRates(
    positions: StakingPosition[],
    publicClient: any,
    chainId: number,
  ): Promise<void> {
    if (chainId !== 1) return;

    for (const pos of positions) {
      try {
        if (pos.asset === 'wstETH') {
          const stEthPerToken = await publicClient.readContract({
            address: CONTRACTS.lido.wstETH,
            abi: WSTETH_ABI,
            functionName: 'stEthPerToken',
          }) as bigint;
          const balanceWei = parseEther(pos.balance);
          const ethEquiv = (balanceWei * stEthPerToken) / BigInt(1e18);
          pos.balanceEth = formatUnits(ethEquiv, 18);
        } else if (pos.asset === 'rETH') {
          const exchangeRate = await publicClient.readContract({
            address: CONTRACTS.rocketPool.rETH,
            abi: RETH_ABI,
            functionName: 'getExchangeRate',
          }) as bigint;
          const balanceWei = parseEther(pos.balance);
          const ethEquiv = (balanceWei * exchangeRate) / BigInt(1e18);
          pos.balanceEth = formatUnits(ethEquiv, 18);
        }
        // stETH and cbETH are ~1:1 with ETH (pos.balanceEth already set)
      } catch {
        // Keep balanceEth as-is
      }
    }
  }

  // ── APY Fetching ───────────────────────────────────────────────────

  async getApys(): Promise<ApyData[]> {
    if (this.apyCache.length > 0 && Date.now() - this.apyCacheTimestamp < this.APY_CACHE_TTL) {
      return this.apyCache;
    }

    try {
      const response = await guardedFetch('https://yields.llama.fi/pools', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) return this.apyCache;

      const data: any = await response.json();
      const pools: any[] = data.data ?? [];

      // Filter for ETH staking pools on Ethereum
      const stakingPools = pools.filter((p: any) =>
        (p.project === 'lido' || p.project === 'rocket-pool' || p.project === 'coinbase-wrapped-staked-eth') &&
        p.chain === 'Ethereum' &&
        (p.symbol?.includes('ETH') || p.symbol?.includes('stETH')),
      );

      this.apyCache = stakingPools.map((p: any) => ({
        protocol: p.project,
        symbol: p.symbol,
        apy: p.apy ?? p.apyBase ?? 0,
        tvl: p.tvlUsd ?? 0,
        fetchedAt: Date.now(),
      }));
      this.apyCacheTimestamp = Date.now();

      return this.apyCache;
    } catch {
      return this.apyCache;
    }
  }

  private async enrichWithApy(positions: StakingPosition[]): Promise<void> {
    const apys = await this.getApys();

    for (const pos of positions) {
      const match = apys.find(a => {
        if (pos.protocol === 'Lido') return a.protocol === 'lido';
        if (pos.protocol === 'Rocket Pool') return a.protocol === 'rocket-pool';
        if (pos.protocol === 'Coinbase') return a.protocol === 'coinbase-wrapped-staked-eth';
        return false;
      });
      if (match) {
        pos.apy = `${match.apy.toFixed(2)}%`;
      }
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _instance: StakingService | null = null;

export function getStakingService(): StakingService {
  if (!_instance) {
    _instance = new StakingService();
  }
  return _instance;
}

export function resetStakingService(): void {
  _instance = null;
}
