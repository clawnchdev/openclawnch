/**
 * /upgrade — Detect wallet account type and guide EOA→smart account migration.
 *
 * Usage:
 *   /upgrade         — detect account type and show status
 *   /upgrade detect  — force re-detection (bypass cache)
 *   /upgrade guide   — show migration guide for EOAs
 *
 * Account types:
 * - EOA: standard externally owned account (no code). Delegation enforcement
 *   is app-layer only. On-chain delegation requires a smart account.
 * - Smart Account: already has code (Safe, ERC-4337, etc.). Full delegation
 *   enforcement is available.
 * - EIP-7702: EOA with delegation designation. The account delegates to an
 *   implementation contract, getting smart account capabilities while keeping
 *   the same address. This is the recommended upgrade path.
 *
 * Non-breaking: EOA users continue using ClawnchConnect approval flow.
 * The command educates and guides but never auto-upgrades.
 */

import { getWalletState, detectAccountType, getWalletClient, type AccountTypeResult } from '../services/walletconnect-service.js';
import { isDelegationMode } from '../services/policy-types.js';
import { DELEGATION_CONTRACTS, CHAIN_NAMES } from '../services/delegation-types.js';
import type { Address } from 'viem';

// Known DeleGator implementation contracts per chain.
// These implement executeFromExecutor + isValidSignature for delegation.
const DELEGATOR_IMPL: Record<number, Address> = {
  84532: '0xA88bEFC44411018232A30644cC48b11eB5876DC0' as Address, // Base Sepolia — MinimalDelegator v2
};

/** Override via env var for custom implementations. */
function getDelegatorImpl(chainId: number): Address | null {
  const envImpl = process.env.DELEGATOR_IMPL_ADDRESS;
  if (envImpl?.startsWith('0x') && envImpl.length === 42) return envImpl as Address;
  return DELEGATOR_IMPL[chainId] ?? null;
}

export const upgradeCommand = {
  name: 'upgrade',
  description: 'Account type detection & smart account upgrade: /upgrade [detect|guide|7702]',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx?: any) => {
    const args = (ctx?.args ?? '').trim().toLowerCase();

    if (args === 'guide') {
      return showMigrationGuide();
    }
    if (args === '7702') {
      return handle7702Upgrade();
    }

    // Default and 'detect' both run detection
    const force = args === 'detect';
    return showAccountStatus(force);
  },
};

async function showAccountStatus(force: boolean) {
  const wallet = getWalletState();

  if (!wallet.connected || !wallet.address) {
    return {
      text: [
        'No wallet connected.',
        '',
        'Connect a wallet first with `/connect` or set `CLAWNCHER_PRIVATE_KEY`.',
      ].join('\n'),
    };
  }

  const lines: string[] = [];
  lines.push('**Account Type Detection**');
  lines.push('');

  const result = await detectAccountType({ force });

  if (!result) {
    lines.push('Could not detect account type. Public client may not be available.');
    lines.push('');
    lines.push(`Address: \`${wallet.address}\``);
    lines.push(`Mode: ${wallet.mode}`);
    return { text: lines.join('\n') };
  }

  lines.push(`Address: \`${wallet.address}\``);
  lines.push(`Chain: ${CHAIN_NAMES[wallet.chainId ?? 0] ?? wallet.chainId ?? 'unknown'}`);
  lines.push(`Mode: ${wallet.mode}`);
  lines.push('');

  switch (result.accountType) {
    case 'eoa':
      lines.push('Type: **EOA** (Externally Owned Account)');
      lines.push('');
      lines.push('Your wallet is a standard EOA with no on-chain code.');
      if (isDelegationMode()) {
        lines.push('');
        lines.push('You are in delegation mode, but full on-chain enforcement requires');
        lines.push('a smart account. Your delegations are currently signed and the agent');
        lines.push('will attempt to redeem them, but caveat enforcers only work when the');
        lines.push('delegator account can execute calls through the DelegationManager.');
        lines.push('');
        lines.push('Options:');
        lines.push('1. **Upgrade to EIP-7702** — keep your address, gain smart account features');
        lines.push('   Run `/upgrade guide` for step-by-step instructions');
        lines.push('2. **Continue with app-layer enforcement** — policies are still enforced');
        lines.push('   by the agent before execution. Use `/policymode simple` to make this explicit.');
        lines.push('3. **Use a Smart Wallet** — connect a Safe, Coinbase Smart Wallet, or other');
        lines.push('   ERC-4337 account that already supports delegation.');
      } else {
        lines.push('');
        lines.push('In simple mode, app-layer policy enforcement works fine with an EOA.');
        lines.push('For on-chain enforcement, switch to delegation mode with `/policymode delegation`');
        lines.push('and consider upgrading: `/upgrade guide`');
      }
      break;

    case 'smart_account':
      lines.push('Type: **Smart Account** (on-chain code detected)');
      lines.push(`Has code: yes`);
      lines.push('');
      lines.push('Your wallet is already a smart account. Full on-chain delegation');
      lines.push('enforcement via EIP-7710 caveat enforcers is supported.');
      lines.push('');
      lines.push('The DelegationManager can execute calls through your account and');
      lines.push('all caveats (spending limits, allowed targets, time bounds) are');
      lines.push('enforced on-chain by the respective enforcer contracts.');
      if (!isDelegationMode()) {
        lines.push('');
        lines.push('You are in simple mode. Switch to delegation mode to take advantage');
        lines.push('of on-chain enforcement: `/policymode delegation`');
      } else {
        lines.push('');
        lines.push('Use `/delegate create <policy-name>` to compile and sign delegations.');
      }
      break;

    case 'eip7702':
      lines.push('Type: **EIP-7702** (delegation designation detected)');
      lines.push(`Has code: yes`);
      if (result.delegationDesignation) {
        lines.push(`Delegates to: \`${result.delegationDesignation}\``);
      }
      lines.push('');
      lines.push('Your EOA has an EIP-7702 delegation designation. It retains its');
      lines.push('original address but gains smart account capabilities through the');
      lines.push('designated implementation contract.');
      lines.push('');
      lines.push('Full on-chain delegation enforcement via EIP-7710 is supported.');
      lines.push('Caveat enforcers (spending limits, allowed targets, time bounds)');
      lines.push('are enforced on-chain by the DelegationManager.');
      if (!isDelegationMode()) {
        lines.push('');
        lines.push('Switch to delegation mode: `/policymode delegation`');
      } else {
        lines.push('');
        lines.push('Use `/delegate create <policy-name>` to compile and sign delegations.');
      }
      break;
  }

  if (force) {
    lines.push('');
    lines.push('(Cache refreshed — detection was re-run against the chain.)');
  }

  return { text: lines.join('\n') };
}

function showMigrationGuide() {
  const lines: string[] = [];

  lines.push('**EOA to Smart Account — Migration Guide**');
  lines.push('');
  lines.push('To use on-chain delegation enforcement (EIP-7710), your wallet needs');
  lines.push('smart account capabilities. Here are your options:');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('**Option 1: EIP-7702 Upgrade (Recommended)**');
  lines.push('');
  lines.push('EIP-7702 lets your existing EOA delegate to a smart account implementation');
  lines.push('without changing your address. Your EOA gains smart account features');
  lines.push('(batched calls, delegation, session keys) while keeping all existing');
  lines.push('balances, approvals, and history.');
  lines.push('');
  lines.push('How it works:');
  lines.push('1. Sign an EIP-7702 authorization designating an implementation contract');
  lines.push('2. Submit a type-4 transaction that sets your account\'s code to `0xef0100` + implementation address');
  lines.push('3. Your EOA now executes calls through the implementation\'s logic');
  lines.push('4. Reversible: you can clear the designation to revert to a plain EOA');
  lines.push('');
  lines.push('Supported implementations:');
  lines.push('- **MetaMask Delegation Framework** — the implementation used by openclawnch');
  lines.push('  DelegationManager: `' + DELEGATION_CONTRACTS.DelegationManager + '`');
  lines.push('- **Coinbase Smart Wallet** — ERC-4337 + EIP-7702 compatible');
  lines.push('- **Safe{Core}** — modular smart account with EIP-7702 support (v1.5+)');
  lines.push('');
  lines.push('Requirements:');
  lines.push('- Wallet must support EIP-7702 signing (MetaMask 12.8+, Rabby, etc.)');
  lines.push('- Chain must support EIP-7702 (Ethereum mainnet post-Pectra, Base, etc.)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('**Option 2: Deploy a Smart Wallet**');
  lines.push('');
  lines.push('Create a new smart account and transfer assets to it:');
  lines.push('- **Safe** — multisig with delegation module (safe.global)');
  lines.push('- **Coinbase Smart Wallet** — ERC-4337 account (keys.coinbase.com)');
  lines.push('- **Kernel** — lightweight ERC-4337 account (zerodev.app)');
  lines.push('');
  lines.push('This gives you a new address. You\'ll need to transfer assets and');
  lines.push('re-approve contracts on the new address.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('**Option 3: Stay on EOA (App-Layer Only)**');
  lines.push('');
  lines.push('Continue using your EOA with app-layer policy enforcement:');
  lines.push('- Policies are evaluated by the agent before each action');
  lines.push('- ClawnchConnect prompts for wallet approval on each transaction');
  lines.push('- No on-chain enforcement, but still functional and safe');
  lines.push('- Use `/policymode simple` to make this explicit');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('Run `/upgrade` to check your current account type.');

  return { text: lines.join('\n') };
}

// ─── EIP-7702 Upgrade ───────────────────────────────────────────────────

async function handle7702Upgrade() {
  const wallet = getWalletState();
  const lines: string[] = [];

  if (!wallet.connected || !wallet.address) {
    return { text: 'No wallet connected. Connect with `/connect` or set `CLAWNCHER_PRIVATE_KEY` first.' };
  }

  if (wallet.mode !== 'private_key') {
    lines.push('**EIP-7702 Upgrade — Requires Private Key Mode**');
    lines.push('');
    lines.push('`signAuthorization` requires direct private key access.');
    lines.push('WalletConnect wallets must use their own 7702 UI (MetaMask 12.8+, Rabby).');
    lines.push('');
    lines.push('1. Switch to private key mode and run `/upgrade 7702` again');
    lines.push('2. Use your wallet\'s native EIP-7702 support');
    lines.push('3. Deploy a Smart Wallet — see `/upgrade guide`');
    return { text: lines.join('\n') };
  }

  const acctType = await detectAccountType({ force: true });
  if (acctType?.accountType === 'smart_account' || acctType?.accountType === 'eip7702') {
    lines.push('**Already a Smart Account**');
    lines.push(`Type: ${acctType.accountType}`);
    if (acctType.delegationDesignation) {
      lines.push(`Delegates to: \`${acctType.delegationDesignation}\``);
    }
    lines.push('No upgrade needed. Use `/delegate create <policy>` to start.');
    return { text: lines.join('\n') };
  }

  const chainId = wallet.chainId ?? 0;
  const impl = getDelegatorImpl(chainId);
  if (!impl) {
    lines.push('**No DeleGator implementation for this chain.**');
    lines.push(`Chain: ${CHAIN_NAMES[chainId] ?? chainId}`);
    lines.push('Set `DELEGATOR_IMPL_ADDRESS` env var or switch to Base Sepolia (84532).');
    return { text: lines.join('\n') };
  }

  lines.push('**EIP-7702 Upgrade**');
  lines.push('');
  lines.push(`Address: \`${wallet.address}\``);
  lines.push(`Chain: ${CHAIN_NAMES[chainId] ?? chainId}`);
  lines.push(`Implementation: \`${impl}\``);
  lines.push('');

  try {
    const wc = getWalletClient();
    if (!wc) return { text: 'Wallet client not available.' };

    lines.push('Signing EIP-7702 authorization...');
    const authorization = await (wc as any).signAuthorization({ contractAddress: impl });

    lines.push('Submitting type-4 transaction...');
    const txHash = await (wc as any).sendTransaction({
      to: wallet.address, value: 0n, authorizationList: [authorization],
    });
    lines.push(`Transaction: \`${txHash}\``);

    const updated = await detectAccountType({ force: true });
    lines.push('');
    if (updated?.accountType === 'eip7702') {
      lines.push('**Upgrade successful.**');
      lines.push(`Implementation: \`${updated.delegationDesignation ?? impl}\``);
      lines.push('Next: `/policymode delegation` then `/delegate create <policy>`');
    } else if (updated?.accountType === 'smart_account') {
      lines.push('**Upgrade successful.** Detected as smart account.');
    } else {
      lines.push('Transaction confirmed. Run `/upgrade detect` to verify.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not supported') || msg.includes('invalid type') || msg.includes('unknown type')) {
      lines.push(`**${CHAIN_NAMES[chainId] ?? 'This chain'} does not support EIP-7702.**`);
      lines.push('Requires the Pectra hard fork. See `/upgrade guide` for alternatives.');
    } else {
      lines.push(`**Upgrade failed:** ${msg.slice(0, 200)}`);
    }
  }

  return { text: lines.join('\n') };
}
