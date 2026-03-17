/**
 * /delegate — On-chain delegation management for policies (EIP-7710).
 *
 * Subcommands:
 *   /delegate                  — show delegation status for all policies
 *   /delegate create <name>    — compile policy to on-chain delegation
 *   /delegate revoke <name>    — revoke on-chain delegation
 *   /delegate status           — show all delegations with chain + hash
 *   /delegate chains           — list supported chains
 *
 * The delegation workflow:
 *   1. User creates a policy via natural language (policy engine)
 *   2. /delegate create <name> compiles the policy to caveats
 *   3. User reviews the compilation and signs (WalletConnect or private key)
 *   4. Signed delegation is stored and can be redeemed on-chain
 *
 * This command does NOT create policies — that's handled by the policy_manage
 * tool via natural language. This command bridges policies to on-chain enforcement.
 */

import { getPolicyStore } from '../services/policy-store.js';
import { isDelegationMode } from '../services/policy-types.js';
import {
  prepareDelegation,
  signDelegation,
  storeDelegation,
  revokeByPolicy,
  refreshDelegationStatus,
  canRedeem,
  formatDelegationStatus,
  getDelegatedPolicies,
  formatSupportedChains,
} from '../services/delegation-service.js';
import { getDelegationStore } from '../services/delegation-store.js';
import { buildPolicyDisplay, renderPolicyDisplay } from '../services/policy-evaluator.js';
import { CHAIN_NAMES, SUPPORTED_CHAIN_IDS } from '../services/delegation-types.js';

export const delegateCommand = {
  name: 'delegate',
  description: 'On-chain delegation management: /delegate [create|revoke|status|chains] [name]',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx?: any) => {
    // Gate: delegation features require delegation mode
    if (!isDelegationMode()) {
      return {
        text: [
          'On-chain delegation is not active. You are in **simple** mode —',
          'policies are enforced at the application layer only.',
          '',
          'To enable on-chain delegation: `/policymode delegation`',
        ].join('\n'),
      };
    }

    const args = (ctx?.args ?? '').trim();
    const { extractPolicyUserId } = await import('../services/policy-evaluator.js');
    let userId = extractPolicyUserId(ctx);
    if (userId === 'owner') {
      const store = getPolicyStore();
      if (store.listPolicies('owner').length === 0) {
        const found = store.findFirstUserWithPolicies();
        if (found) userId = found;
      }
    }

    // No args: show overview
    if (!args) {
      return showOverview(userId);
    }

    // Parse subcommand
    const parts = args.split(/\s+/);
    const sub = parts[0]!.toLowerCase();
    const rest = parts.slice(1).join(' ');

    switch (sub) {
      case 'create':
        return handleCreate(userId, rest, ctx);
      case 'revoke':
        return handleRevoke(userId, rest);
      case 'revoke-all':
        return handleRevokeAll(userId);
      case 'permissions':
        return handleRequestPermissions(userId, rest);
      case 'status':
        return showStatus(userId);
      case 'chains':
        return showChains();
      default:
        // Treat as policy name lookup
        return showDelegationForPolicy(userId, args);
    }
  },
};

// ─── Show Overview ──────────────────────────────────────────────────────

function showOverview(userId: string) {
  const store = getPolicyStore();
  const policies = store.listPolicies(userId);
  const delegated = policies.filter(p => p.delegation != null);

  const lines: string[] = [];
  lines.push('**On-Chain Delegations (EIP-7710)**');
  lines.push('');

  if (delegated.length === 0) {
    lines.push('No policies have been compiled to on-chain delegations yet.');
    lines.push('');
    if (policies.length > 0) {
      lines.push(`You have ${policies.length} polic${policies.length === 1 ? 'y' : 'ies'}. Use \`/delegate create <name>\` to compile one to an on-chain delegation.`);
    } else {
      lines.push('Create a policy first by describing what you want in plain English, then use `/delegate create <name>` to enforce it on-chain.');
    }
    lines.push('');
    lines.push('**Commands:**');
    lines.push('  `/delegate create <name>` — compile a policy to a delegation');
    lines.push('  `/delegate status` — show all delegations');
    lines.push('  `/delegate chains` — list supported chains');
    return { text: lines.join('\n') };
  }

  lines.push(`${delegated.length} of ${policies.length} polic${policies.length === 1 ? 'y has' : 'ies have'} on-chain delegations:`);
  lines.push('');

  for (const p of delegated) {
    lines.push(`**${p.name}** [${p.status.toUpperCase()}]`);
    if (p.delegation) {
      lines.push(formatDelegationStatus(p.delegation));
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('**Commands:**');
  lines.push('  `/delegate create <name>` — compile a policy to a delegation');
  lines.push('  `/delegate revoke <name>` — revoke an on-chain delegation');
  lines.push('  `/delegate revoke-all` — revoke ALL active delegations');
  lines.push('  `/delegate permissions <name>` — request MetaMask Advanced Permissions');
  lines.push('  `/delegate status` — detailed delegation status');
  lines.push('  `/delegate chains` — list supported chains');

  return { text: lines.join('\n') };
}

// ─── Create Delegation ──────────────────────────────────────────────────

async function handleCreate(userId: string, nameAndArgs: string, ctx?: any) {
  if (!nameAndArgs) {
    return { text: 'Usage: `/delegate create <policy-name> [--chain <chainId>]`' };
  }

  // Parse optional --chain flag
  const chainMatch = nameAndArgs.match(/--chain\s+(\d+)/);
  const chainId = chainMatch ? parseInt(chainMatch[1]!, 10) : 8453;
  const policyName = nameAndArgs.replace(/--chain\s+\d+/, '').trim();

  if (!policyName) {
    return { text: 'Usage: `/delegate create <policy-name> [--chain <chainId>]`' };
  }

  // Find the policy
  const store = getPolicyStore();
  let policy = store.getPolicyByName(userId, policyName);
  if (!policy) policy = store.getPolicy(userId, policyName);
  if (!policy) {
    return { text: `Policy "${policyName}" not found. Use \`/policies\` to list your policies.` };
  }

  // Check policy is active — accept if status is 'active' even without confirmedAt
  // (covers policies created via /policies create or via LLM tool)
  if (policy.status !== 'active') {
    return {
      text: `Policy **${policy.name}** is not active (status: ${policy.status}). Enable it first: /policies enable ${policy.name}`,
    };
  }

  // Check chain support
  if (!SUPPORTED_CHAIN_IDS.has(chainId)) {
    return {
      text: `Chain ${chainId} is not supported. Supported chains: ${formatSupportedChains()}`,
    };
  }

  // Compile the policy (fetches live ETH price, auto-detects wallet addresses)
  const result = await prepareDelegation({ policy, chainId });

  if ('error' in result) {
    return { text: `Compilation failed: ${result.error}` };
  }

  const lines: string[] = [];
  lines.push(`**Delegation Preview for "${policy.name}"**`);
  lines.push('');
  lines.push(result.summary);
  lines.push('');

  const unmappedNames = result.compilation.unmappedRules.map(u => u.rule.type);
  const delegation = result.compilation.delegation;

  // Check if wallet is available for signing
  const hasWallet = delegation.delegator !== ('0x' + '0'.repeat(40));

  if (!hasWallet) {
    lines.push('---');
    lines.push('**Next steps:**');
    lines.push('A connected wallet is needed to sign the delegation.');
    lines.push('1. Connect a wallet via `/connect` (WalletConnect) or set `CLAWNCHER_PRIVATE_KEY`');
    lines.push('2. Run `/delegate create ' + policy.name + '` again');
    lines.push('3. Review and sign the delegation');
    lines.push('');
    lines.push('The delegation will be signed by your wallet (delegator) and grant limited');
    lines.push('permissions to the agent (delegate) according to your policy rules.');

    // Store as unsigned so user can see status
    policy.delegation = {
      chainId,
      hash: '0x',
      delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
      status: 'unsigned',
      delegate: delegation.delegate,
      delegator: delegation.delegator,
      salt: delegation.salt.toString(),
      createdAt: new Date().toISOString(),
      unmappedRules: unmappedNames.length > 0 ? unmappedNames : undefined,
    };
    policy.updatedAt = Date.now();
    store.savePolicy(policy);
  } else {
    // Wallet available — attempt to sign
    lines.push('Signing delegation...');

    const signResult = await signDelegation(delegation, chainId);

    if ('error' in signResult) {
      lines.push(`Signing failed: ${signResult.error}`);
      lines.push('');
      lines.push('The delegation has been saved as unsigned. You can try again with `/delegate create ' + policy.name + '`.');

      // Store as unsigned
      policy.delegation = {
        chainId,
        hash: '0x',
        delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
        status: 'unsigned',
        delegate: delegation.delegate,
        delegator: delegation.delegator,
        salt: delegation.salt.toString(),
        createdAt: new Date().toISOString(),
        unmappedRules: unmappedNames.length > 0 ? unmappedNames : undefined,
      };
      policy.updatedAt = Date.now();
      store.savePolicy(policy);
    } else {
      // Signing succeeded — store with hash lookup
      const info = await storeDelegation(
        policy,
        userId,
        signResult.signed,
        chainId,
        unmappedNames,
      );

      lines.push('**Delegation signed and stored.**');
      lines.push('');
      lines.push(formatDelegationStatus(info));
    }
  }

  return { text: lines.join('\n') };
}

// ─── Revoke Delegation ──────────────────────────────────────────────────

async function handleRevoke(userId: string, name: string) {
  if (!name) {
    return { text: 'Usage: `/delegate revoke <policy-name>`' };
  }

  const store = getPolicyStore();
  let policy = store.getPolicyByName(userId, name);
  if (!policy) policy = store.getPolicy(userId, name);
  if (!policy) {
    return { text: `Policy "${name}" not found.` };
  }

  if (!policy.delegation) {
    return { text: `Policy **${policy.name}** has no on-chain delegation to revoke.` };
  }

  if (policy.delegation.status === 'revoked') {
    return { text: `Policy **${policy.name}** delegation is already revoked.` };
  }

  const lines: string[] = [];
  lines.push(`**Revoking delegation for "${policy.name}"**`);
  lines.push('');

  const result = await revokeByPolicy(policy, userId);

  if ('error' in result) {
    // On-chain revocation failed but local revocation succeeded
    lines.push(`On-chain revocation failed: ${result.error}`);
    lines.push('');
    lines.push('Delegation has been revoked locally. The on-chain delegation may still be');
    lines.push('redeemable. Connect the delegator wallet and try again to revoke on-chain.');
  } else if ('localOnly' in result) {
    // No full struct stored — could only revoke locally
    if (policy.delegation.hash && policy.delegation.hash !== '0x') {
      lines.push('Delegation revoked locally (full delegation struct not available for on-chain revocation).');
      lines.push(`Chain: ${CHAIN_NAMES[policy.delegation.chainId] ?? policy.delegation.chainId}`);
      lines.push(`Hash: \`${policy.delegation.hash}\``);
    } else {
      lines.push('Delegation was unsigned (never submitted on-chain). Marked as revoked locally.');
    }
  } else {
    // On-chain revocation succeeded
    lines.push('**Delegation revoked on-chain.**');
    lines.push(`Transaction: \`${result.txHash}\``);
    lines.push(`Chain: ${CHAIN_NAMES[policy.delegation.chainId] ?? policy.delegation.chainId}`);
    lines.push('');
    lines.push('The delegation can no longer be redeemed. On-chain enforcement disabled.');
  }

  return { text: lines.join('\n') };
}

// ─── Revoke All ─────────────────────────────────────────────────────────

async function handleRevokeAll(userId: string) {
  const delegated = getDelegatedPolicies(userId);
  const active = delegated.filter(p =>
    p.delegation && p.delegation.status !== 'revoked',
  );

  if (active.length === 0) {
    return { text: 'No active delegations to revoke.' };
  }

  const lines: string[] = [];
  lines.push(`**Revoking ${active.length} delegation(s)...**`);
  lines.push('');

  let succeeded = 0;
  let failed = 0;

  for (const policy of active) {
    try {
      const result = await revokeByPolicy(policy, userId);
      if ('error' in result) {
        lines.push(`- **${policy.name}**: failed — ${result.error}`);
        failed++;
      } else {
        const txInfo = 'txHash' in result ? ` (tx: ${result.txHash})` : ' (local only)';
        lines.push(`- **${policy.name}**: revoked${txInfo}`);
        succeeded++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`- **${policy.name}**: error — ${msg.slice(0, 100)}`);
      failed++;
    }
  }

  lines.push('');
  lines.push(`Done. ${succeeded} revoked, ${failed} failed.`);

  return { text: lines.join('\n') };
}

// ─── Request Advanced Permissions (MetaMask ERC-7715) ───────────────────

async function handleRequestPermissions(userId: string, policyName: string) {
  const lines: string[] = [];

  if (!policyName) {
    return { text: 'Usage: `/delegate permissions <policy-name>`\n\nRequests Advanced Permissions from MetaMask for the specified policy. The connected MetaMask wallet must be a smart account (EIP-7702).' };
  }

  const { getWalletState, getWalletClient } = await import('../services/walletconnect-service.js');
  const wallet = getWalletState();

  if (!wallet.connected || !wallet.address) {
    return { text: 'No wallet connected. Connect via WalletConnect first.' };
  }

  // Find the policy
  const policyStore = getPolicyStore();
  const policy = policyStore.getPolicyByName(userId, policyName) ?? policyStore.getPolicy(userId, policyName);
  if (!policy) {
    return { text: `Policy "${policyName}" not found. Use \`/policies\` to see available policies.` };
  }

  const chainId = wallet.chainId ?? 8453;
  const expiry = Math.floor(Date.now() / 1000) + 604800; // 1 week

  lines.push('**Requesting Advanced Permissions from MetaMask...**');
  lines.push('');
  lines.push(`Policy: ${policy.name}`);
  lines.push(`Chain: ${CHAIN_NAMES[chainId] ?? chainId}`);
  lines.push(`Expiry: ${new Date(expiry * 1000).toISOString()}`);
  lines.push('');

  try {
    const wc = getWalletClient();
    if (!wc) return { text: 'Wallet client not available.' };

    // Build permission requests from policy rules
    const { erc7715ProviderActions } = await import('@metamask/smart-accounts-kit/actions');
    const extendedClient = (wc as any).extend(erc7715ProviderActions());

    // For now, request a native token transfer permission based on policy rules
    // Future: map each rule type to its corresponding Advanced Permission type
    const permissionRequests: any[] = [];

    for (const rule of policy.rules) {
      if (rule.type === 'spending_limit' || rule.type === 'max_amount') {
        const maxUsd = 'maxAmountUsd' in rule ? rule.maxAmountUsd : 1000;
        // Approximate USD to ETH (rough conversion for permission request)
        const ethAmount = BigInt(Math.floor(maxUsd / 3000 * 1e18));
        permissionRequests.push({
          chainId,
          expiry,
          signer: { type: 'account', data: { address: wallet.address } },
          permission: {
            type: 'native-token-transfer',
            data: { maxAmount: ethAmount },
          },
          isAdjustmentAllowed: true,
        });
      }

      if (rule.type === 'erc20_limit') {
        const [whole = '0', frac = ''] = rule.maxAmount.split('.');
        const paddedFrac = (frac + '0'.repeat(rule.decimals)).slice(0, rule.decimals);
        const amount = BigInt(whole + paddedFrac);
        permissionRequests.push({
          chainId,
          expiry,
          signer: { type: 'account', data: { address: wallet.address } },
          permission: {
            type: 'erc20-token-periodic',
            data: {
              tokenAddress: rule.token,
              periodAmount: amount,
              periodDuration: 86400, // 1 day
              justification: `Policy: ${policy.name}`,
            },
          },
          isAdjustmentAllowed: true,
        });
      }
    }

    if (permissionRequests.length === 0) {
      lines.push('No policy rules could be mapped to Advanced Permissions.');
      lines.push('Supported rule types: `spending_limit`, `max_amount`, `erc20_limit`.');
      return { text: lines.join('\n') };
    }

    lines.push(`Requesting ${permissionRequests.length} permission(s)...`);
    lines.push('MetaMask will prompt for approval.');
    lines.push('');

    const granted = await extendedClient.requestExecutionPermissions(permissionRequests);

    // Store the granted permissions
    const { storeGrantedPermissions } = await import('../services/advanced-permissions.js');
    storeGrantedPermissions(policy.id, granted);

    // Update policy delegation info
    if (!policy.delegation) {
      policy.delegation = {
        chainId,
        hash: '0xadvanced-permissions',
        delegationManager: granted[0]?.signerMeta?.delegationManager ?? '',
        status: 'signed',
        delegate: wallet.address,
        delegator: wallet.address,
        salt: '0',
        createdAt: new Date().toISOString(),
      } as any;
      policyStore.savePolicy(policy);
    }

    lines.push(`**${granted.length} permission(s) granted.**`);
    lines.push('');
    lines.push('The agent can now execute actions within these permissions.');
    lines.push('Permissions expire in 1 week. Use `/delegate permissions` to renew.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('User rejected') || msg.includes('denied')) {
      lines.push('Permission request was rejected by the user.');
    } else if (msg.includes('not supported') || msg.includes('does not exist')) {
      lines.push('**MetaMask does not support Advanced Permissions on this wallet.**');
      lines.push('');
      lines.push('Requirements:');
      lines.push('- MetaMask Flask 13.5.0+ or MetaMask 13.9.0+');
      lines.push('- Account must be upgraded to a MetaMask Smart Account');
      lines.push('- Run `/upgrade detect` to check account type');
    } else {
      lines.push(`**Permission request failed:** ${msg.slice(0, 200)}`);
    }
  }

  return { text: lines.join('\n') };
}

// ─── Show Status ────────────────────────────────────────────────────────

async function showStatus(userId: string) {
  const delegated = getDelegatedPolicies(userId);

  if (delegated.length === 0) {
    return { text: 'No delegations found. Use `/delegate create <name>` to compile a policy.' };
  }

  const lines: string[] = [];
  lines.push(`**Delegation Status (${delegated.length} delegation${delegated.length !== 1 ? 's' : ''})**`);
  lines.push('');

  for (const p of delegated) {
    // Refresh on-chain status if we have a hash
    if (p.delegation?.hash && p.delegation.hash !== '0x' && p.delegation.status !== 'revoked') {
      try {
        await refreshDelegationStatus(p, userId);
      } catch { /* continue with cached status */ }
    }

    lines.push(`**${p.name}** [Policy: ${p.status.toUpperCase()}]`);
    if (p.delegation) {
      lines.push(formatDelegationStatus(p.delegation));

      // Show redemption readiness
      const redeemStatus = canRedeem(p.id);
      if (redeemStatus.ready) {
        lines.push('  Redemption: READY (full delegation stored)');
      } else {
        lines.push(`  Redemption: NOT AVAILABLE (${redeemStatus.reason})`);
      }

      // On-chain state (best-effort, non-blocking)
      try {
        const { checkDelegationsWithOnChain } = await import('../services/delegation-monitor.js');
        const report = await checkDelegationsWithOnChain(userId);
        const entry = report.health.find((h: any) => h.policyId === p.id);
        if (entry?.onChain) {
          const u = entry.onChain;
          const parts: string[] = [];
          if (u.nativeSpentWei !== null) parts.push(`ETH spent: ${Number(u.nativeSpentWei) / 1e18}`);
          if (u.callCount !== null) parts.push(`calls: ${u.callCount}`);
          if (u.driftDetected) parts.push(`DRIFT: ${u.driftDetails ?? 'local/on-chain mismatch'}`);
          if (parts.length > 0) {
            lines.push(`  On-chain: ${parts.join(', ')}`);
          }
        }
      } catch { /* best-effort — skip if monitor unavailable */ }
    }
    lines.push('');
  }

  return { text: lines.join('\n') };
}

// ─── Show Chains ────────────────────────────────────────────────────────

function showChains() {
  const lines: string[] = [];
  lines.push('**Supported Chains for EIP-7710 Delegations**');
  lines.push('');
  lines.push('The MetaMask Delegation Framework contracts are deployed at');
  lines.push('deterministic addresses on all of these chains:');
  lines.push('');

  for (const chainId of SUPPORTED_CHAIN_IDS) {
    const name = CHAIN_NAMES[chainId] ?? 'Unknown';
    const isTestnet = chainId > 100000;
    lines.push(`  ${name} (${chainId})${isTestnet ? ' [testnet]' : ''}`);
  }

  lines.push('');
  lines.push('Default: Base (8453)');
  lines.push('Use `--chain <id>` with `/delegate create` to target a specific chain.');

  return { text: lines.join('\n') };
}

// ─── Show Delegation For Policy ─────────────────────────────────────────

function showDelegationForPolicy(userId: string, nameOrId: string) {
  const store = getPolicyStore();
  let policy = store.getPolicyByName(userId, nameOrId);
  if (!policy) policy = store.getPolicy(userId, nameOrId);
  if (!policy) {
    return { text: `Policy "${nameOrId}" not found. Use \`/policies\` to list all.` };
  }

  const lines: string[] = [];
  const display = buildPolicyDisplay(policy, userId);
  lines.push(renderPolicyDisplay(display));
  lines.push('');

  if (policy.delegation) {
    lines.push('**On-chain delegation:**');
    lines.push(formatDelegationStatus(policy.delegation));
  } else {
    lines.push('No on-chain delegation. Use `/delegate create ' + policy.name + '` to create one.');
  }

  return { text: lines.join('\n') };
}
