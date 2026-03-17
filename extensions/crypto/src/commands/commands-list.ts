/**
 * /commands_all — Full list of OpenClawnch commands.
 *
 * Shows every registered command grouped by category so users can
 * discover features that aren't in the Telegram slash dropdown
 * (limited to 100 commands by Telegram).
 */

export const commandsAllCommand = {
  name: 'commands_all',
  description: 'Show all OpenClawnch commands grouped by category',
  acceptsArgs: false,
  requireAuth: false,

  handler: async () => {
    const lines: string[] = [];

    lines.push('**All OpenClawnch Commands**');
    lines.push('');

    lines.push('**Delegation & Policies**');
    lines.push('  `/delegator` — manage agent smart account (create, fund, status, recover)');
    lines.push('  `/delegate` — on-chain delegation lifecycle (create, revoke, revoke-all, permissions, status, chains)');
    lines.push('  `/policies` — view/manage spending policies (overview, enable, disable, delete)');
    lines.push('  `/policymode` — switch between delegation (on-chain) and simple (app-layer) mode');
    lines.push('  `/upgrade` — account type detection + EIP-7702 smart account upgrade (detect, guide, 7702)');
    lines.push('  `/profile` — autonomy profiles (conservative, balanced, aggressive, custom)');
    lines.push('');

    lines.push('**Wallet & Connection**');
    lines.push('  `/wallet` — show address, chain, balance, account type');
    lines.push('  `/connect` — connect mobile wallet via WalletConnect');
    lines.push('  `/disconnect` — disconnect current wallet');
    lines.push('  `/connect_bankr` — connect Bankr custodial wallet');
    lines.push('  `/tx` — recent transaction history');
    lines.push('');

    lines.push('**Safety & Signing**');
    lines.push('  `/mode` — show current safety and signing mode');
    lines.push('  `/safemode` — require confirmation before on-chain actions');
    lines.push('  `/dangermode` — agent acts without confirmation');
    lines.push('  `/readonly` — no on-chain writes allowed');
    lines.push('  `/autosign` — auto-sign with private key (no wallet approvals)');
    lines.push('  `/walletsign` — require WalletConnect approval per tx');
    lines.push('  `/policy` — simple spending policies (e.g. "approve under 0.05 ETH")');
    lines.push('');

    lines.push('**DeFi Tools** (used via natural language)');
    lines.push('  transfer, defi_swap, bridge, defi_lend, defi_stake');
    lines.push('  liquidity, yield, nft, approvals, permit2, governance');
    lines.push('  These are invoked by asking the agent, e.g. "swap 1 ETH for USDC"');
    lines.push('');

    lines.push('**Platform**');
    lines.push('  `/agents` — manage sub-agents');
    lines.push('  `/skills` — list loaded skills');
    lines.push('  `/automations` — Bankr automations (limit orders, DCA)');
    lines.push('  `/molten` — Molten agent status');
    lines.push('');

    lines.push('**Session**');
    lines.push('  `/model` / `/llm` — show or switch LLM model');
    lines.push('  `/reset` — reset session');
    lines.push('  `/new` — start new session');
    lines.push('  `/compact` — compact session context');
    lines.push('  `/stop` — stop current run');
    lines.push('  `/usage` — cost summary');
    lines.push('');

    lines.push('---');
    lines.push('Not all commands appear in the Telegram dropdown (limited to 100).');
    lines.push('Type any command directly to use it.');

    return { text: lines.join('\n') };
  },
};
