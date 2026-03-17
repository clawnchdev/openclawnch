/**
 * /delegator — Agent account lifecycle management.
 *
 * Subcommands:
 *   /delegator create    — deploy a HybridDeleGator smart account
 *   /delegator fund      — show the agent account address for funding
 *   /delegator status    — show balance, delegation status, account info
 *   /delegator recover   — restore agent key from backup
 *
 * The agent account is a HybridDeleGator smart account owned by the user.
 * The agent holds a delegate key for autonomous execution within policy limits.
 * User funds the account explicitly — blast radius is limited to deposited funds.
 */

import {
  storeAgentKey,
  saveMeta,
  loadMeta,
  loadAgentKey,
  hasAgentAccount,
  type AgentMeta,
} from '../services/agent-keystore.js';
import { getWalletState } from '../services/walletconnect-service.js';
import { CHAIN_NAMES } from '../services/delegation-types.js';
import type { Address } from 'viem';

export const agentAccountCommand = {
  name: 'delegator',
  description: 'Delegator smart account management: /delegator [create|fund|status|recover]',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx?: any) => {
    const args = (ctx?.args ?? '').trim().toLowerCase();
    const parts = args.split(/\s+/);
    const sub = parts[0] || '';

    switch (sub) {
      case 'create':
        return handleCreate(parts.slice(1).join(' '));
      case 'fund':
        return handleFund();
      case 'status':
        return handleStatus();
      case 'recover':
        return handleRecover(parts.slice(1).join(' '));
      default:
        return showOverview();
    }
  },
};

// ─── Overview ───────────────────────────────────────────────────────────

function showOverview() {
  const meta = loadMeta();
  const lines: string[] = [];

  if (!meta) {
    lines.push('**No agent account configured.**');
    lines.push('');
    lines.push('Create one with `/delegator create` — this deploys a smart account');
    lines.push('that the agent uses for autonomous on-chain execution.');
    lines.push('You fund it with a specific amount; only those funds are at risk.');
    lines.push('');
    lines.push('**Commands:**');
    lines.push('  `/delegator create` — deploy a new agent smart account');
    lines.push('  `/delegator recover <private-key>` — restore from a backup key');
  } else {
    lines.push('**Agent Account**');
    lines.push('');
    lines.push(`  Smart account: \`${meta.smartAccountAddress}\``);
    lines.push(`  Agent address: \`${meta.agentAddress}\``);
    lines.push(`  Owner: \`${meta.ownerAddress}\``);
    lines.push(`  Chain: ${CHAIN_NAMES[meta.chainId] ?? meta.chainId}`);
    lines.push(`  Key storage: ${meta.storageMethod}`);
    lines.push(`  Created: ${meta.createdAt}`);
    lines.push('');
    lines.push('**Commands:**');
    lines.push('  `/delegator fund` — show address to send funds to');
    lines.push('  `/delegator status` — balance and delegation details');
  }

  return { text: lines.join('\n') };
}

// ─── Create ─────────────────────────────────────────────────────────────

async function handleCreate(passphrase: string) {
  const lines: string[] = [];

  if (hasAgentAccount()) {
    const meta = loadMeta()!;
    lines.push('**Agent account already exists.**');
    lines.push(`  Smart account: \`${meta.smartAccountAddress}\``);
    lines.push(`  Agent address: \`${meta.agentAddress}\``);
    lines.push('Use `/delegator status` to check it, or `/delegator fund` to add funds.');
    return { text: lines.join('\n') };
  }

  // Always require a passphrase — the key must be persisted encrypted
  if (!passphrase || passphrase.length < 8) {
    lines.push('**Passphrase required.**');
    lines.push('');
    lines.push('Usage: `/delegator create <passphrase>`');
    lines.push('');
    lines.push('The passphrase encrypts the agent private key on disk.');
    lines.push('Use at least 8 characters. You will need it to unlock the keystore after restarts.');
    return { text: lines.join('\n') };
  }

  const wallet = getWalletState();
  if (!wallet.connected || !wallet.address) {
    return { text: 'Connect a wallet first. The connected wallet becomes the owner of the agent account.' };
  }

  const chainId = wallet.chainId ?? 8453;

  lines.push('**Creating Agent Account...**');
  lines.push('');

  try {
    // 1. Generate agent keypair
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
    const agentPrivateKey = generatePrivateKey();
    const agentAccount = privateKeyToAccount(agentPrivateKey);

    lines.push(`Chain: ${CHAIN_NAMES[chainId] ?? chainId}`);
    lines.push(`Owner (you): \`${wallet.address}\``);
    lines.push('');

    // 2. Deploy HybridDeleGator via SDK
    const { toMetaMaskSmartAccount, Implementation, getSmartAccountsEnvironment } = await import('@metamask/smart-accounts-kit');
    const { createPublicClient, http } = await import('viem');
    const { baseSepolia, base } = await import('viem/chains');

    const chain = chainId === 84532 ? baseSepolia : base;
    const publicClient = createPublicClient({ chain, transport: http() });

    const smartAccount = await toMetaMaskSmartAccount({
      client: publicClient as any,
      implementation: Implementation.Hybrid,
      deployParams: [wallet.address as Address, [], [], []],
      deploySalt: `0x${Date.now().toString(16).padStart(64, '0')}`,
      signer: { account: agentAccount },
    });

    // 3. Store the key securely
    const storageMethod = storeAgentKey(agentAccount.address, agentPrivateKey, passphrase || undefined);

    // 4. Save metadata
    const meta: AgentMeta = {
      smartAccountAddress: smartAccount.address,
      agentAddress: agentAccount.address,
      ownerAddress: wallet.address,
      chainId,
      createdAt: new Date().toISOString(),
      storageMethod,
    };
    saveMeta(meta);

    // 5. Clear output with labeled addresses
    lines.push('**FUND THIS ADDRESS (smart account):**');
    lines.push(`\`${smartAccount.address}\``);
    lines.push('This is where the agent operates.');
    lines.push('Only funds here are used by the agent.');
    lines.push('');
    lines.push(`Agent signer: \`${agentAccount.address}\``);
    lines.push('(pays gas for delegation txs — needs small ETH amount)');
    lines.push('');
    lines.push(`Key stored: **${storageMethod}**`);
    lines.push('');

    // 6. Show recovery key ONCE
    lines.push('---');
    lines.push('**RECOVERY KEY — SAVE NOW**');
    lines.push('This recovers the agent signer.');
    lines.push('Your owner wallet recovers the');
    lines.push('smart account itself.');
    lines.push('');
    lines.push(`\`${agentPrivateKey}\``);
    lines.push('');
    lines.push('Will not be shown again.');
    lines.push('---');
    lines.push('');
    lines.push('**Next:** send ETH to the smart');
    lines.push('account address above, then:');
    lines.push('`/delegate create <policy-name>`');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`**Creation failed:** ${msg.slice(0, 200)}`);
  }

  return { text: lines.join('\n') };
}

// ─── Fund ───────────────────────────────────────────────────────────────

function handleFund() {
  const meta = loadMeta();
  if (!meta) return { text: 'No agent account. Run `/delegator create` first.' };

  const lines: string[] = [];
  lines.push('**Fund the Agent Account**');
  lines.push('');
  lines.push('Send ETH or tokens to the');
  lines.push('**smart account** (not the agent');
  lines.push('signer address):');
  lines.push('');
  lines.push(`\`${meta.smartAccountAddress}\``);
  lines.push('');
  lines.push(`Chain: ${CHAIN_NAMES[meta.chainId] ?? meta.chainId}`);
  lines.push('');
  lines.push('Only send what you want the');
  lines.push('agent to manage. Withdraw');
  lines.push('anytime via your owner wallet.');
  lines.push('');
  lines.push('The agent signer also needs a');
  lines.push('small amount of ETH for gas:');
  lines.push(`\`${meta.agentAddress}\``);

  return { text: lines.join('\n') };
}

// ─── Status ─────────────────────────────────────────────────────────────

async function handleStatus() {
  const meta = loadMeta();
  if (!meta) return { text: 'No agent account. Run `/delegator create` first.' };

  const lines: string[] = [];
  lines.push('**Agent Account Status**');
  lines.push('');
  lines.push(`  Smart account: \`${meta.smartAccountAddress}\``);
  lines.push(`  Agent address: \`${meta.agentAddress}\``);
  lines.push(`  Owner: \`${meta.ownerAddress}\``);
  lines.push(`  Chain: ${CHAIN_NAMES[meta.chainId] ?? meta.chainId}`);
  lines.push(`  Key storage: ${meta.storageMethod}`);
  lines.push('');

  // Check if key is accessible
  const key = loadAgentKey();
  lines.push(`  Key accessible: ${key ? 'yes' : 'no (may need passphrase)'}`);
  lines.push('');

  // Check on-chain balance
  try {
    const { createPublicClient, http, formatEther } = await import('viem');
    const { baseSepolia, base } = await import('viem/chains');
    const chain = meta.chainId === 84532 ? baseSepolia : base;
    const publicClient = createPublicClient({ chain, transport: http() });

    const balance = await publicClient.getBalance({ address: meta.smartAccountAddress as Address });
    lines.push(`  Balance: ${formatEther(balance)} ETH`);

    const code = await publicClient.getCode({ address: meta.smartAccountAddress as Address });
    const deployed = code && code.length > 2;
    lines.push(`  Deployed: ${deployed ? 'yes' : 'no (deploy on first tx)'}`);
  } catch {
    lines.push('  Balance: unable to check (RPC unavailable)');
  }

  return { text: lines.join('\n') };
}

// ─── Recover ────────────────────────────────────────────────────────────

async function handleRecover(argsStr: string) {
  if (!argsStr) {
    return { text: [
      'Usage:',
      '  /delegator recover <key> <passphrase>',
      '  /delegator recover <passphrase>',
      '',
      'First form: restore from backup key',
      '  (encrypts with passphrase)',
      'Second form: unlock encrypted keystore',
    ].join('\n') };
  }

  const lines: string[] = [];
  const parts = argsStr.trim().split(/\s+/);
  const first = parts[0] ?? '';
  const second = parts[1] ?? '';

  // Form 1: recover <private-key> <passphrase>
  if (/^0x[0-9a-fA-F]{64}$/.test(first)) {
    if (!second || second.length < 8) {
      return { text: 'Passphrase required (min 8 chars).\nUsage: /delegator recover <key> <passphrase>' };
    }

    try {
      const { privateKeyToAccount } = await import('viem/accounts');
      const account = privateKeyToAccount(first as `0x${string}`);

      // Store the key encrypted
      const storageMethod = storeAgentKey(account.address, first, second);
      lines.push(`Key stored: **${storageMethod}**`);
      lines.push(`Agent address: \`${account.address}\``);
      lines.push('');

      // Rebuild meta from the SDK if wallet is connected
      const wallet = getWalletState();
      if (wallet.connected && wallet.address) {
        try {
          const { toMetaMaskSmartAccount, Implementation } = await import('@metamask/smart-accounts-kit');
          const { createPublicClient, http } = await import('viem');
          const { baseSepolia, base } = await import('viem/chains');

          const chainId = wallet.chainId ?? 8453;
          const chain = chainId === 84532 ? baseSepolia : base;
          const publicClient = createPublicClient({ chain, transport: http() });

          const smartAccount = await toMetaMaskSmartAccount({
            client: publicClient as any,
            implementation: Implementation.Hybrid,
            deployParams: [wallet.address as Address, [], [], []],
            deploySalt: `0x${Date.now().toString(16).padStart(64, '0')}`,
            signer: { account },
          });

          const meta: AgentMeta = {
            smartAccountAddress: smartAccount.address,
            agentAddress: account.address,
            ownerAddress: wallet.address,
            chainId,
            createdAt: new Date().toISOString(),
            storageMethod,
          };
          saveMeta(meta);

          lines.push('Meta rebuilt from connected wallet.');
          lines.push(`Smart account: \`${smartAccount.address}\``);
          lines.push(`Owner: \`${wallet.address}\``);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lines.push(`Meta rebuild failed: ${msg.slice(0, 100)}`);
          lines.push('Key is stored but /delegator status won\'t work until meta is rebuilt.');
          lines.push('Connect your wallet and run /delegator recover again.');
        }
      } else {
        lines.push('No wallet connected — meta not rebuilt.');
        lines.push('Connect wallet, then run /delegator recover again to rebuild meta.');
      }
    } catch {
      lines.push('**Invalid private key format.**');
    }
    return { text: lines.join('\n') };
  }

  // Form 2: recover <passphrase> — unlock encrypted keystore
  const key = loadAgentKey(first);
  if (key) {
    lines.push('**Keystore unlocked.**');
    const meta = loadMeta();
    if (meta) {
      lines.push(`Smart account: \`${meta.smartAccountAddress}\``);
    }
  } else {
    lines.push('**Failed to unlock.** Wrong passphrase or no encrypted keystore.');
  }

  return { text: lines.join('\n') };
}
