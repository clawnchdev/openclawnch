/**
 * /vault — Agent account lifecycle management.
 *
 * Subcommands:
 *   /vault create    — deploy a HybridDeleGator smart account
 *   /vault fund      — show the agent account address for funding
 *   /vault status    — show balance, delegation status, account info
 *   /vault recover   — restore agent key from backup
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
  name: 'vault',
  description: 'Agent vault (smart account) management: /vault [create|fund|status|recover]',
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
    lines.push('Create one with `/vault create` — this deploys a smart account');
    lines.push('that the agent uses for autonomous on-chain execution.');
    lines.push('You fund it with a specific amount; only those funds are at risk.');
    lines.push('');
    lines.push('**Commands:**');
    lines.push('  `/vault create` — deploy a new agent smart account');
    lines.push('  `/vault recover <private-key>` — restore from a backup key');
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
    lines.push('  `/vault fund` — show address to send funds to');
    lines.push('  `/vault status` — balance and delegation details');
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
    lines.push('Use `/vault status` to check it, or `/vault fund` to add funds.');
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

    lines.push(`Agent address: \`${agentAccount.address}\``);
    lines.push(`Owner (you): \`${wallet.address}\``);
    lines.push(`Chain: ${CHAIN_NAMES[chainId] ?? chainId}`);
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

    lines.push(`Smart account: \`${smartAccount.address}\``);
    lines.push('');

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

    lines.push(`Key stored via: **${storageMethod}**`);
    if (storageMethod === 'memory') {
      lines.push('**WARNING:** Key is only in memory. It will be lost on restart.');
      lines.push('Run `/vault create <passphrase>` with a passphrase to persist it.');
    }
    lines.push('');

    // 5. Show recovery key ONCE
    lines.push('---');
    lines.push('**RECOVERY KEY — SAVE THIS NOW. IT WILL NOT BE SHOWN AGAIN.**');
    lines.push('');
    lines.push(`\`${agentPrivateKey}\``);
    lines.push('');
    lines.push('If you lose access to this key and the keystore, you can still');
    lines.push('withdraw funds using your owner wallet directly on the smart account.');
    lines.push('But the agent will not be able to execute autonomously.');
    lines.push('---');
    lines.push('');
    lines.push('**Next step:** Fund the agent account:');
    lines.push(`Send ETH to \`${smartAccount.address}\``);
    lines.push('Then create a policy and delegation: `/delegate create <policy-name>`');
    lines.push('');
    lines.push('Note: if the gateway restarts after this operation (config reload),');
    lines.push('wait ~30 seconds and try `/vault status` to confirm everything is saved.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`**Creation failed:** ${msg.slice(0, 200)}`);
  }

  return { text: lines.join('\n') };
}

// ─── Fund ───────────────────────────────────────────────────────────────

function handleFund() {
  const meta = loadMeta();
  if (!meta) return { text: 'No agent account. Run `/vault create` first.' };

  const lines: string[] = [];
  lines.push('**Fund the Agent Account**');
  lines.push('');
  lines.push(`Send ETH or tokens to:`);
  lines.push(`\`${meta.smartAccountAddress}\``);
  lines.push('');
  lines.push(`Chain: ${CHAIN_NAMES[meta.chainId] ?? meta.chainId}`);
  lines.push('');
  lines.push('Only send what you want the agent to manage.');
  lines.push('You can withdraw at any time using your owner wallet.');

  return { text: lines.join('\n') };
}

// ─── Status ─────────────────────────────────────────────────────────────

async function handleStatus() {
  const meta = loadMeta();
  if (!meta) return { text: 'No agent account. Run `/vault create` first.' };

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

async function handleRecover(keyOrPassphrase: string) {
  if (!keyOrPassphrase) {
    return { text: 'Usage:\n  `/vault recover <private-key>` — restore from backup key\n  `/vault recover <passphrase>` — unlock encrypted keystore' };
  }

  const lines: string[] = [];

  // If it looks like a private key (0x + 64 hex chars)
  if (/^0x[0-9a-fA-F]{64}$/.test(keyOrPassphrase)) {
    try {
      const { privateKeyToAccount } = await import('viem/accounts');
      const account = privateKeyToAccount(keyOrPassphrase as `0x${string}`);

      const meta = loadMeta();
      if (meta && meta.agentAddress.toLowerCase() !== account.address.toLowerCase()) {
        lines.push(`**Warning:** This key derives address \`${account.address}\``);
        lines.push(`but the stored agent address is \`${meta.agentAddress}\`.`);
        lines.push('Proceeding will overwrite the stored agent key.');
        lines.push('');
      }

      const storageMethod = storeAgentKey(account.address, keyOrPassphrase);
      lines.push(`**Key recovered.** Stored via: ${storageMethod}`);
      lines.push(`Agent address: \`${account.address}\``);
    } catch {
      lines.push('**Invalid private key format.**');
    }
  } else {
    // Treat as passphrase for encrypted file
    const key = loadAgentKey(keyOrPassphrase);
    if (key) {
      lines.push('**Keystore unlocked successfully.**');
    } else {
      lines.push('**Failed to unlock keystore.** Wrong passphrase or no encrypted keystore found.');
    }
  }

  return { text: lines.join('\n') };
}
