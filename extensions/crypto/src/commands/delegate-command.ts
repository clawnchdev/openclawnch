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
import {
  prepareDelegation,
  signDelegation,
  storeDelegation,
  formatDelegationStatus,
  getDelegatedPolicies,
  formatSupportedChains,
} from '../services/delegation-service.js';
import { buildPolicyDisplay, renderPolicyDisplay } from '../services/policy-evaluator.js';
import { CHAIN_NAMES, SUPPORTED_CHAIN_IDS } from '../services/delegation-types.js';

export const delegateCommand = {
  name: 'delegate',
  description: 'On-chain delegation management: /delegate [create|revoke|status|chains] [name]',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx?: any) => {
    const args = (ctx?.args ?? '').trim();
    const userId = ctx?.senderId ?? ctx?.from ?? 'owner';

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

  // Check policy is active and confirmed
  if (!policy.confirmedAt) {
    return {
      text: `Policy **${policy.name}** has never been confirmed. Confirm the policy first before creating a delegation.`,
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

  const wasOnChain = policy.delegation.hash && policy.delegation.hash !== '0x'
    && (policy.delegation.status === 'signed' || policy.delegation.status === 'active');

  policy.delegation.status = 'revoked';
  policy.updatedAt = Date.now();
  store.savePolicy(policy);

  if (wasOnChain) {
    lines.push(`Delegation revoked locally.`);
    lines.push(`Chain: ${CHAIN_NAMES[policy.delegation.chainId] ?? policy.delegation.chainId}`);
    lines.push(`Hash: \`${policy.delegation.hash}\``);
    lines.push('');
    lines.push('To also revoke on-chain, the delegator must call `disableDelegation()` on the');
    lines.push('DelegationManager contract. This prevents any further on-chain redemption.');
  } else {
    lines.push('Delegation was unsigned (never submitted on-chain). Marked as revoked locally.');
  }

  return { text: lines.join('\n') };
}

// ─── Show Status ────────────────────────────────────────────────────────

function showStatus(userId: string) {
  const delegated = getDelegatedPolicies(userId);

  if (delegated.length === 0) {
    return { text: 'No delegations found. Use `/delegate create <name>` to compile a policy.' };
  }

  const lines: string[] = [];
  lines.push(`**Delegation Status (${delegated.length} delegation${delegated.length !== 1 ? 's' : ''})**`);
  lines.push('');

  for (const p of delegated) {
    lines.push(`**${p.name}** [Policy: ${p.status.toUpperCase()}]`);
    if (p.delegation) {
      lines.push(formatDelegationStatus(p.delegation));
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
