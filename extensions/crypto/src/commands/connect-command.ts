/**
 * /connect commands — connect a mobile wallet via WalletConnect.
 *
 * Each wallet gets its own slash command so it's tappable in Telegram:
 *   /connect           — shows wallet menu
 *   /connect_metamask  — connect MetaMask
 *   /connect_rainbow   — connect Rainbow
 *   /connect_coinbase  — connect Coinbase Wallet
 *   /connect_trust     — connect Trust Wallet
 *   /connect_zerion    — connect Zerion
 *   /connect_uniswap   — connect Uniswap Wallet
 *   /connect_rabby     — connect Rabby (desktop, raw URI)
 *   /connect_other     — any wallet (raw URI)
 */

import {
  initWalletService,
  waitForWalletSession,
  getWalletState,
  isBankrMode,
  disconnectWallet,
} from '../services/walletconnect-service.js';
import { getBankrUserInfo, hasBankrApi } from '../services/bankr-api.js';
import { createChannelSender, extractChannelId, type ChannelId } from '../services/channel-sender.js';
import { getOnboardingFlow } from '../services/onboarding-flow.js';
import { getCredentialVault } from '../services/credential-vault.js';

// ── Wallet Deep Link Configuration ──────────────────────────────────────────

interface WalletOption {
  id: string;
  label: string;
  deepLink?: string; // undefined = desktop/raw URI
}

const WALLETS: WalletOption[] = [
  { id: 'metamask',  label: 'MetaMask',         deepLink: 'https://metamask.app.link/wc?uri=' },
  { id: 'rainbow',   label: 'Rainbow',          deepLink: 'https://rnbwapp.com/wc?uri=' },
  { id: 'coinbase',  label: 'Coinbase Wallet',  deepLink: 'https://go.cb-w.com/wc?uri=' },
  { id: 'trust',     label: 'Trust Wallet',     deepLink: 'https://link.trustwallet.com/wc?uri=' },
  { id: 'zerion',    label: 'Zerion',           deepLink: 'https://wallet.zerion.io/wc?uri=' },
  { id: 'uniswap',   label: 'Uniswap Wallet',  deepLink: 'https://uniswap.org/app/wc?uri=' },
  { id: 'rabby',     label: 'Rabby (desktop)' },
  { id: 'other',     label: 'Other wallet' },
];

/** Stored plugin API reference for sending messages after session establishes. */
let _api: any = null;
/** Guard against duplicate waitForWalletSession callbacks. */
let _pendingSessionWait = false;

export function setConnectCommandApi(api: any): void {
  _api = api;
}

// ── Shared Connect Logic ────────────────────────────────────────────────────

async function doConnect(wallet: WalletOption, ctx: any): Promise<{ text: string }> {
  const state = getWalletState();
  if (state.connected && state.address) {
    return {
      text: `Wallet already connected: ${state.address.slice(0, 6)}...${state.address.slice(-4)} (chain ${state.chainId})\n\nUse the clawnchconnect tool with action "disconnect" to disconnect first.`,
    };
  }

  const projectId = getCredentialVault().getSecret('walletconnect.projectId', 'connect-command') ?? undefined;
  const privateKey = getCredentialVault().getSecret('wallet.privateKey', 'connect-command') ?? undefined;

  if (!projectId && !privateKey) {
    return {
      text: `WalletConnect is not configured.\n\nTo enable wallet connection, set the WALLETCONNECT_PROJECT_ID environment variable.\n\nOn Fly.io: \`fly secrets set WALLETCONNECT_PROJECT_ID="your-project-id" -a <your-app>\`\nOn Docker: add to your \`.env\` file or \`docker-compose.yml\`\n\nGet a project ID at https://cloud.reown.com`,
    };
  }

  try {
    const result = await initWalletService({
      privateKey,
      walletConnectProjectId: projectId,
      rpcUrl: process.env.CLAWNCHER_RPC_URL,
      network: (process.env.CLAWNCHER_NETWORK as 'mainnet' | 'sepolia') || 'mainnet',
      sessionPath: process.env.WALLETCONNECT_SESSION
        || `${process.env.HOME ?? ''}/.openclawnch/wc-session.json`,
    });

    if (result.mode === 'private_key') {
      return {
        text: `Connected via private key (headless mode).\nAddress: ${result.address}\n\nTransactions will be auto-signed.`,
      };
    }

    if (result.address && !result.pairingUri) {
      return {
        text: `Wallet already connected: ${result.address.slice(0, 6)}...${result.address.slice(-4)}\n\nSession restored from previous connection.`,
      };
    }

    if (result.pairingUri) {
      // Get the sender's chat ID and channel for the callback
      const chatId = ctx?.conversationId ?? ctx?.senderId ?? ctx?.from;
      const channel: ChannelId = extractChannelId(ctx) ?? 'telegram';

      // Start background session wait — when approved, send confirmation + advance onboarding
      // Guard: only one wait at a time to prevent duplicate callbacks
      const connectUserId = ctx?.senderId ?? ctx?.from ?? chatId;
      if (_pendingSessionWait) {
        // Already waiting — don't start another
      } else {
      _pendingSessionWait = true;
      waitForWalletSession(300_000)
        .then((session) => {
          console.log(`[/connect] Session established: ${session.address} (chain ${session.chainId})`);

          // Advance onboarding if user was on connect_wallet step
          if (connectUserId) {
            const flow = getOnboardingFlow(String(connectUserId));
            const onboardingMsg = flow.onWalletConnected(
              session.address,
              `chain ${session.chainId}`,
            );
            if (onboardingMsg && _api) {
              // Send the onboarding progression message instead of the generic confirmation
              const sender = createChannelSender(_api);
              sender.send(channel, String(chatId), onboardingMsg.text)
                .catch((err: any) => console.log(`[/connect] Failed to send onboarding msg: ${err}`));
              return; // Don't send the generic confirmation too
            }
          }

          // Generic confirmation (user not in onboarding)
          if (_api && chatId) {
            const sender = createChannelSender(_api);
            sender.send(channel, String(chatId), `Wallet connected!\n\nAddress: ${session.address.slice(0, 6)}...${session.address.slice(-4)}\nChain: ${session.chainId}\n\nYou're ready to trade. Try: "What's the price of ETH?" or "Show my balance"`)
              .catch((err: any) => console.log(`[/connect] Failed to send confirmation: ${err}`));
          }
        })
        .catch((err) => {
          console.log(`[/connect] Session wait failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => { _pendingSessionWait = false; });
      } // end else (_pendingSessionWait guard)

      const encodedUri = encodeURIComponent(result.pairingUri);

      // Desktop wallets get raw URI (no deep link available)
      if (!wallet.deepLink) {
        return {
          text: `Copy this code and paste it in your wallet's WalletConnect input:\n\n\`${result.pairingUri}\`\n\nExpires in 5 minutes.`,
        };
      }

      // Mobile wallets get a clean hyperlink
      const url = `${wallet.deepLink}${encodedUri}`;
      return {
        text: `[Connect ${wallet.label}](${url})\n\nTap the link above to open ${wallet.label} and approve the connection. Expires in 5 minutes.`,
      };
    }

    return {
      text: 'WalletConnect failed to generate a pairing link. The relay server may be down. Try again in a minute.',
    };
  } catch (err) {
    return {
      text: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Command Definitions ─────────────────────────────────────────────────────

/** /connect — shows wallet menu with tappable options */
export const connectCommand = {
  name: 'connect',
  description: 'Connect your mobile wallet via WalletConnect',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    const state = getWalletState();
    if (state.connected && state.address) {
      return {
        text: `Wallet already connected: ${state.address.slice(0, 6)}...${state.address.slice(-4)} (chain ${state.chainId})\n\nUse the clawnchconnect tool with action "disconnect" to disconnect first.`,
      };
    }

    const lines = ['Which wallet do you use?\n'];
    for (const w of WALLETS) {
      lines.push(`  /connect_${w.id}`);
    }
    lines.push('  /connect_bankr — Bankr (custodial, multi-chain)');
    lines.push('\nTap one to connect.');
    return { text: lines.join('\n') };
  },
};

/** Generate a /connect_<wallet> command */
function makeWalletCommand(wallet: WalletOption) {
  return {
    name: `connect_${wallet.id}`,
    description: `Connect ${wallet.label} via WalletConnect`,
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx: any) => doConnect(wallet, ctx),
  };
}

/** All individual wallet commands: /connect_metamask, /connect_rainbow, etc. */
export const walletConnectCommands = WALLETS.map(makeWalletCommand);

// ── /connect_bankr ──────────────────────────────────────────────────────────

export const connectBankrCommand = {
  name: 'connect_bankr',
  description: 'Connect Bankr custodial wallet (multi-chain)',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    // Already connected?
    const state = getWalletState();
    if (state.connected && state.mode === 'bankr') {
      return {
        text: [
          '**Already connected via Bankr**',
          '',
          `EVM: ${state.bankrEvmAddress ?? 'unknown'}`,
          state.bankrSolAddress ? `Solana: ${state.bankrSolAddress}` : null,
          state.bankrClub ? 'Bankr Club: Active' : null,
          '',
          'Use /connect to switch to a different wallet.',
        ].filter(Boolean).join('\n'),
      };
    }
    if (state.connected) {
      return {
        text: `Wallet already connected (${state.mode}): ${state.address?.slice(0, 6)}...${state.address?.slice(-4)}\n\nDisconnect first to switch to Bankr.`,
      };
    }

    // Check for API key
    const apiKey = getCredentialVault().getSecret('bankr.apiKey', 'connect-command');
    if (!apiKey) {
      return {
        text: [
          '**BANKR_API_KEY not set**',
          '',
          'To use Bankr as your wallet:',
          '1. Create an account at https://bankr.bot',
          '2. Get an API key with Agent API enabled: https://bankr.bot/api',
          '3. Set the environment variable:',
          '   Fly.io: `fly secrets set BANKR_API_KEY="bk_your_key" -a <your-app>`',
          '   Docker: add `BANKR_API_KEY=bk_your_key` to your `.env` file',
        ].join('\n'),
      };
    }

    try {
      const result = await initWalletService({ bankrApiKey: apiKey });

      if (result.mode !== 'bankr') {
        return {
          text: 'Failed to initialize Bankr wallet. Check your BANKR_API_KEY.',
        };
      }

      const newState = getWalletState();
      return {
        text: [
          '**Connected via Bankr** (custodial wallet)',
          '',
          `EVM: ${newState.bankrEvmAddress ?? result.address ?? 'unknown'}`,
          newState.bankrSolAddress ? `Solana: ${newState.bankrSolAddress}` : null,
          newState.bankrClub ? `Bankr Club: Active` : null,
          '',
          'Transactions execute server-side. No phone approval needed.',
          'Bankr\'s Sentinel security system screens all transactions.',
          '',
          'This is a custodial wallet — Bankr holds the keys.',
          'For self-custody, use /connect_metamask or another wallet.',
        ].filter(Boolean).join('\n'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Agent API not enabled') || msg.includes('403')) {
        return {
          text: [
            '**Agent API not enabled on this key**',
            '',
            'Your Bankr API key was recognized but doesn\'t have Agent API access.',
            '',
            '**Fix it:**',
            '1. Go to https://bankr.bot/api',
            '2. Find your API key',
            '3. Enable the "Agent API" toggle',
          ].join('\n'),
        };
      }
      return {
        text: `Bankr connection failed: ${msg}`,
      };
    }
  },
};

// ── /disconnect ─────────────────────────────────────────────────────────────

export const disconnectCommand = {
  name: 'disconnect',
  description: 'Disconnect the current wallet',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (_ctx: any) => {
    const state = getWalletState();
    if (!state.connected) {
      return { text: 'No wallet connected.' };
    }

    const addr = state.address ?? 'unknown';
    const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    const mode = state.mode ?? 'unknown';

    try {
      await disconnectWallet();
      return {
        text: `Disconnected wallet ${short} (${mode}).\n\nUse /connect to pair a new wallet.`,
      };
    } catch (err) {
      return {
        text: `Failed to disconnect: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
