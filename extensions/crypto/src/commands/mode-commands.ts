/**
 * Mode commands — toggle safety and signing modes.
 *
 * /safemode    — Enable intent confirmation (default)
 * /dangermode  — Disable intent confirmation (agent acts immediately)
 * /walletsign  — Use WalletConnect for signing (default)
 * /autosign    — Use private key for auto-signing (requires CLAWNCHER_PRIVATE_KEY)
 * /mode        — Show current mode status
 */

import { getUserMode, setSafetyMode, setSigningMode, isReadonly } from '../services/mode-service.js';
import { getCredentialVault } from '../services/credential-vault.js';

function getSenderId(ctx: any): string {
  return ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'unknown';
}

export const safemodeCommand = {
  name: 'safemode',
  description: 'Enable intent confirmation — agent confirms before taking any action',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const mode = setSafetyMode(userId, 'safe');
    return {
      text: `Safe mode enabled.

The agent will confirm its intent before executing any action. You'll see a summary of what it plans to do and can approve or reject.

Current settings:
  Intent confirmation: ON
  Signing: ${mode.signingMode === 'wallet' ? 'WalletConnect (phone approval)' : 'Auto-sign (private key)'}`,
    };
  },
};

export const dangermodeCommand = {
  name: 'dangermode',
  description: 'Disable intent confirmation — agent acts immediately on your requests',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const mode = setSafetyMode(userId, 'danger');
    // M1: Warn strongly when both dangermode + autosign are active
    const isDualDanger = mode.signingMode === 'autosign';
    const signingNote = mode.signingMode === 'wallet'
      ? 'Transactions still require wallet approval on your phone.'
      : 'CRITICAL WARNING: With auto-sign enabled, transactions execute without ANY confirmation. ' +
        'A safety cap of 0.1 ETH per transaction applies in this mode. ' +
        'Consider using /walletsign for larger amounts.';
    return {
      text: `${isDualDanger ? '⚠️ MAXIMUM RISK MODE ⚠️\n\n' : ''}Danger mode enabled.

The agent will act immediately on your requests without confirming intent first.

${signingNote}

Current settings:
  Intent confirmation: OFF
  Signing: ${mode.signingMode === 'wallet' ? 'WalletConnect (phone approval)' : 'Auto-sign (private key)'}

Use /safemode to re-enable confirmations.`,
    };
  },
};

export const walletsignCommand = {
  name: 'walletsign',
  description: 'Use WalletConnect for transaction signing (phone approval required)',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const mode = setSigningMode(userId, 'wallet');
    return {
      text: `Wallet signing enabled.

All transactions will be sent to your phone wallet for approval. You always have the final say.

Current settings:
  Intent confirmation: ${mode.safetyMode === 'safe' ? 'ON' : 'OFF'}
  Signing: WalletConnect (phone approval)`,
    };
  },
};

export const autosignCommand = {
  name: 'autosign',
  description: 'Enable auto-signing with private key (no wallet approval needed)',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);

    // Check if private key is configured
    if (!getCredentialVault().getSecret('wallet.privateKey', 'mode-commands')) {
      return {
        text: `Auto-sign is not available.

A private key (CLAWNCHER_PRIVATE_KEY) must be configured at deploy time to enable auto-signing. This instance uses WalletConnect only.

To enable auto-sign, set the CLAWNCHER_PRIVATE_KEY environment variable:
  Fly.io: \`fly secrets set CLAWNCHER_PRIVATE_KEY="0x..." -a <your-app>\`
  Docker: add to your \`.env\` file

WARNING: Auto-sign means the agent can execute transactions without your approval. Only use with a dedicated hot wallet containing limited funds.`,
      };
    }

    const mode = setSigningMode(userId, 'autosign');
    return {
      text: `WARNING: Auto-sign enabled.

Transactions will be signed automatically using the configured private key. NO wallet approval will be requested.

Only use this with a dedicated hot wallet containing limited funds.

Current settings:
  Intent confirmation: ${mode.safetyMode === 'safe' ? 'ON' : 'OFF'}
  Signing: Auto-sign (private key)

Use /walletsign to switch back to phone approval.`,
    };
  },
};

export const readonlyCommand = {
  name: 'readonly',
  description: 'Enable read-only mode — no on-chain writes allowed (view portfolio, prices, analytics only)',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const mode = setSafetyMode(userId, 'readonly');
    return {
      text: `Read-only mode enabled.

All on-chain write operations are BLOCKED: swaps, transfers, token launches, approvals, bridging, etc.

You can still:
  - Check prices (/portfolio, defi_price)
  - View balances (defi_balance)
  - Run analytics (analytics, market_intel)
  - View cost basis and trade history

Use /safemode or /dangermode to re-enable write operations.

Current settings:
  Mode: READ-ONLY
  Signing: ${mode.signingMode === 'wallet' ? 'WalletConnect (phone approval)' : 'Auto-sign (private key)'}`,
    };
  },
};

export const modeCommand = {
  name: 'mode',
  description: 'Show current safety and signing mode',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const mode = getUserMode(userId);
    const hasPrivateKey = !!getCredentialVault().getSecret('wallet.privateKey', 'mode-commands');

    const safetyLabel = mode.safetyMode === 'readonly'
      ? 'READ-ONLY (/readonly)'
      : mode.safetyMode === 'safe'
        ? 'ON (/safemode)'
        : 'OFF (/dangermode)';

    return {
      text: `Current mode:

  Intent confirmation: ${safetyLabel}
  Signing: ${mode.signingMode === 'wallet' ? 'WalletConnect (/walletsign)' : 'Auto-sign (/autosign)'}
  Private key available: ${hasPrivateKey ? 'Yes' : 'No'}

Commands:
  /safemode    — Confirm before acting
  /dangermode  — Act immediately
  /readonly    — View only, no on-chain writes
  /walletsign  — Phone approval for transactions
  /autosign    — Auto-sign (requires private key)`,
    };
  },
};
