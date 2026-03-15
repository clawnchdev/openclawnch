/**
 * ERC-20 Delegation Tests — Base Sepolia
 *
 * Separated from delegation-testnet.test.ts to avoid public RPC rate
 * limiting when running many write txs in a single test file.
 *
 * Run independently:
 *   kc-load pnpm vitest run tests/delegation-testnet-erc20.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  encodePacked,
  type Address,
  type Hex,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount, nonceManager } from 'viem/accounts';

const BASE_SEPOLIA_CHAIN_ID = 84532;
const TESTNET_PK = process.env.DELEGATION_TESTNET_PK as `0x${string}` | undefined;
const describeWrite = TESTNET_PK ? describe : describe.skip;

const CONTRACTS = {
  DelegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3' as Address,
  ERC20TransferAmountEnforcer: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc' as Address,
  TestSmartAccount: '0xA88bEFC44411018232A30644cC48b11eB5876DC0' as Address,
  TestToken: '0xD88066C2e84B549E5c7e58bef0B05b7f7cE72a7c' as Address,
};

const DELEGATION_MANAGER_ABI = [
  {
    name: 'redeemDelegations',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: '_permissionContexts', type: 'bytes[]' as const },
      { name: '_modes', type: 'bytes32[]' as const },
      { name: '_executionCallData', type: 'bytes[]' as const },
    ],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    name: 'balanceOf' as const,
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'account', type: 'address' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
] as const;

const EXECUTE_MODE_DEFAULT = ('0x' + '0'.repeat(64)) as Hex;

const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

async function readWithRetry<T>(fn: () => Promise<T>, retries = 4, delayMs = 1500): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await fn();
      if (result !== false && result !== undefined) return result;
    } catch { /* retry */ }
    if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return fn();
}

function makeDelegation(overrides?: Partial<{
  delegate: Address; delegator: Address; authority: Hex;
  caveats: { enforcer: Address; terms: Hex; args: Hex }[];
  salt: bigint; signature: Hex;
}>) {
  return {
    delegate: overrides?.delegate ?? ('0x' + '1'.repeat(40)) as Address,
    delegator: overrides?.delegator ?? ('0x' + '2'.repeat(40)) as Address,
    authority: overrides?.authority ?? ('0x' + 'f'.repeat(64)) as Hex,
    caveats: overrides?.caveats ?? [],
    salt: overrides?.salt ?? 1n,
    signature: overrides?.signature ?? ('0x' + 'ab'.repeat(65)) as Hex,
  };
}

// Shared permissionContext encoder (avoids repeating the massive type literal)
function encodePermCtx(signed: ReturnType<typeof makeDelegation> & { signature: Hex }) {
  return encodeAbiParameters(
    [{
      type: 'tuple[]',
      components: [
        { name: 'delegate', type: 'address' },
        { name: 'delegator', type: 'address' },
        { name: 'authority', type: 'bytes32' },
        {
          name: 'caveats', type: 'tuple[]',
          components: [
            { name: 'enforcer', type: 'address' },
            { name: 'terms', type: 'bytes' },
            { name: 'args', type: 'bytes' },
          ],
        },
        { name: 'salt', type: 'uint256' },
        { name: 'signature', type: 'bytes' },
      ],
    }],
    [[{
      delegate: signed.delegate,
      delegator: signed.delegator,
      authority: signed.authority,
      caveats: signed.caveats,
      salt: signed.salt,
      signature: signed.signature,
    }]],
  );
}

function erc20TransferCalldata(to: Address, amount: bigint): Hex {
  const selector = '0xa9059cbb';
  const toParam = to.slice(2).toLowerCase().padStart(64, '0');
  const amountParam = amount.toString(16).padStart(64, '0');
  return `${selector}${toParam}${amountParam}` as Hex;
}

describeWrite('Base Sepolia — ERC-20 Delegation', () => {
  let account: ReturnType<typeof privateKeyToAccount>;
  let walletClient: any;

  beforeAll(() => {
    account = privateKeyToAccount(TESTNET_PK!, { nonceManager });
    walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });
  });

  it('TestToken is deployed and smart account holds tokens', async () => {
    const balance = await publicClient.readContract({
      address: CONTRACTS.TestToken, abi: ERC20_ABI,
      functionName: 'balanceOf', args: [CONTRACTS.TestSmartAccount],
    });
    expect(balance).toBeGreaterThan(0n);
    console.log(`Smart account TST balance: ${Number(balance) / 1e18}`);
  }, 15_000);

  it('redeemDelegations transfers ERC-20 from smart account to recipient', async () => {
    const { getDelegationDomain, DELEGATION_EIP712_TYPES } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );

    const transferAmount = 1_000_000_000_000_000_000n; // 1 TST
    const recipient = ('0x' + 'aaaa' + Date.now().toString(16).padStart(36, '0')) as Address;

    const delegation = makeDelegation({
      delegator: CONTRACTS.TestSmartAccount, delegate: account.address,
      salt: BigInt(Date.now()) + 400n,
    });

    const domain = getDelegationDomain(BASE_SEPOLIA_CHAIN_ID);
    const signature = await walletClient.signTypedData({
      domain, types: DELEGATION_EIP712_TYPES, primaryType: 'Delegation',
      message: { delegate: delegation.delegate, delegator: delegation.delegator,
        authority: delegation.authority, caveats: delegation.caveats, salt: delegation.salt },
    });

    const signed = { ...delegation, signature };
    const calldata = erc20TransferCalldata(recipient, transferAmount);
    const execData = encodePacked(['address', 'uint256', 'bytes'], [CONTRACTS.TestToken, 0n, calldata]);

    const balanceBefore = await publicClient.readContract({
      address: CONTRACTS.TestToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient],
    });

    const txHash = await walletClient.writeContract({
      address: CONTRACTS.DelegationManager, abi: DELEGATION_MANAGER_ABI,
      functionName: 'redeemDelegations',
      args: [[encodePermCtx(signed)], [EXECUTE_MODE_DEFAULT], [execData]],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    expect(receipt.status).toBe('success');

    const balanceAfter = await readWithRetry(() =>
      publicClient.readContract({ address: CONTRACTS.TestToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] })
        .then(b => (b as bigint) > (balanceBefore as bigint) ? b : false as any),
    );
    expect(balanceAfter).toBe((balanceBefore as bigint) + transferAmount);

    console.log(`ERC-20 redeemDelegations tx: ${txHash}`);
    console.log(`  Token: ${CONTRACTS.TestToken} (TST), Amount: ${Number(transferAmount) / 1e18} TST`);
  }, 90_000);

  it('redeemDelegations with ERC20TransferAmountEnforcer within limit succeeds', async () => {
    const { getDelegationDomain, DELEGATION_EIP712_TYPES } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );

    const amountLimit = 5_000_000_000_000_000_000n;
    const transferAmount = 1_000_000_000_000_000_000n;
    const recipient = ('0x' + 'bbbb' + Date.now().toString(16).padStart(36, '0')) as Address;

    const delegation = makeDelegation({
      delegator: CONTRACTS.TestSmartAccount, delegate: account.address,
      caveats: [{
        enforcer: CONTRACTS.ERC20TransferAmountEnforcer,
        terms: encodePacked(['address', 'uint256'], [CONTRACTS.TestToken, amountLimit]),
        args: '0x' as Hex,
      }],
      salt: BigInt(Date.now()) + 500n,
    });

    const domain = getDelegationDomain(BASE_SEPOLIA_CHAIN_ID);
    const signature = await walletClient.signTypedData({
      domain, types: DELEGATION_EIP712_TYPES, primaryType: 'Delegation',
      message: { delegate: delegation.delegate, delegator: delegation.delegator,
        authority: delegation.authority,
        caveats: delegation.caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })),
        salt: delegation.salt },
    });

    const signed = { ...delegation, signature };
    const calldata = erc20TransferCalldata(recipient, transferAmount);
    const execData = encodePacked(['address', 'uint256', 'bytes'], [CONTRACTS.TestToken, 0n, calldata]);

    const txHash = await walletClient.writeContract({
      address: CONTRACTS.DelegationManager, abi: DELEGATION_MANAGER_ABI,
      functionName: 'redeemDelegations',
      args: [[encodePermCtx(signed)], [EXECUTE_MODE_DEFAULT], [execData]],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    expect(receipt.status).toBe('success');

    const balance = await readWithRetry(() =>
      publicClient.readContract({ address: CONTRACTS.TestToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] })
        .then(b => (b as bigint) > 0n ? b : false as any),
    );
    expect(balance).toBe(transferAmount);

    console.log(`ERC-20 + ERC20TransferAmountEnforcer (within limit) tx: ${txHash}`);
  }, 60_000);

  it('redeemDelegations with ERC20TransferAmountEnforcer over limit reverts', async () => {
    const { getDelegationDomain, DELEGATION_EIP712_TYPES } = await import(
      '../extensions/crypto/src/services/delegation-types.js'
    );

    const amountLimit = 1_000_000_000_000_000_000n;
    const overAmount = 5_000_000_000_000_000_000n;
    const recipient = ('0x' + 'cccc' + Date.now().toString(16).padStart(36, '0')) as Address;

    const delegation = makeDelegation({
      delegator: CONTRACTS.TestSmartAccount, delegate: account.address,
      caveats: [{
        enforcer: CONTRACTS.ERC20TransferAmountEnforcer,
        terms: encodePacked(['address', 'uint256'], [CONTRACTS.TestToken, amountLimit]),
        args: '0x' as Hex,
      }],
      salt: BigInt(Date.now()) + 600n,
    });

    const domain = getDelegationDomain(BASE_SEPOLIA_CHAIN_ID);
    const signature = await walletClient.signTypedData({
      domain, types: DELEGATION_EIP712_TYPES, primaryType: 'Delegation',
      message: { delegate: delegation.delegate, delegator: delegation.delegator,
        authority: delegation.authority,
        caveats: delegation.caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })),
        salt: delegation.salt },
    });

    const signed = { ...delegation, signature };
    const calldata = erc20TransferCalldata(recipient, overAmount);
    const execData = encodePacked(['address', 'uint256', 'bytes'], [CONTRACTS.TestToken, 0n, calldata]);

    await expect(
      walletClient.writeContract({
        address: CONTRACTS.DelegationManager, abi: DELEGATION_MANAGER_ABI,
        functionName: 'redeemDelegations',
        args: [[encodePermCtx(signed)], [EXECUTE_MODE_DEFAULT], [execData]],
      }),
    ).rejects.toThrow();

    console.log('ERC-20 + ERC20TransferAmountEnforcer over-limit correctly reverted');
  }, 60_000);
});
