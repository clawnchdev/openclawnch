/**
 * /doctor command — comprehensive diagnostic check for OpenClawnch.
 *
 * Inspired by ZeroClaw's `zeroclaw doctor` and `zeroclaw channel doctor`.
 * Checks: wallet connectivity, RPC health, API key validity, channel auth,
 * plan scheduler state, endpoint allowlist, and credential vault status.
 *
 * Zero-cost: bypasses the LLM entirely for instant results.
 */

import { getWalletState } from '../services/walletconnect-service.js';
import { getRpcManager } from '../services/rpc-provider.js';
import { getAllToolStatus } from '../services/tool-config-service.js';
import { getUserMode } from '../services/mode-service.js';
import { getCredentialVault } from '../services/credential-vault.js';
import { getAllowedHosts } from '../services/endpoint-allowlist.js';
import { getBudgetService } from '../services/budget-service.js';
import { getTxLedger } from '../services/tx-ledger.js';
import { getHeartbeatMonitor } from '../services/heartbeat-monitor.js';
import { getMarketCache } from '../services/market-cache.js';

function getSenderId(ctx: any): string {
  return ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'unknown';
}

interface DiagnosticResult {
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
}

async function runDiagnostics(userId: string): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  // ── 1. Wallet Connectivity ──────────────────────────────────────────
  try {
    const state = getWalletState();
    if (state.connected && state.address) {
      results.push({
        label: 'Wallet',
        status: 'ok',
        detail: `Connected (${state.mode}) — ${state.address.slice(0, 6)}...${state.address.slice(-4)}`,
      });
    } else {
      results.push({
        label: 'Wallet',
        status: 'warn',
        detail: 'Not connected. Use /connect to pair a wallet.',
      });
    }
  } catch (err) {
    results.push({
      label: 'Wallet',
      status: 'fail',
      detail: `Error checking wallet: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // ── 2. RPC Health ───────────────────────────────────────────────────
  try {
    const rpc = getRpcManager();
    const client = await rpc.getClient('base');
    const blockNumber = await client.getBlockNumber();
    results.push({
      label: 'RPC (Base)',
      status: 'ok',
      detail: `Connected — latest block #${blockNumber}`,
    });
  } catch (err) {
    results.push({
      label: 'RPC (Base)',
      status: 'fail',
      detail: `Cannot reach Base RPC: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // ── 3. RPC Provider Health Report ───────────────────────────────────
  try {
    const rpc = getRpcManager();
    const health = rpc.getHealthReport(8453);
    const available = health.filter(h => h.available).length;
    const total = health.length;
    const circuitOpen = health.filter(h => h.circuitOpen);

    if (circuitOpen.length > 0) {
      results.push({
        label: 'RPC Providers',
        status: 'warn',
        detail: `${available}/${total} available. Circuit open: ${circuitOpen.map(h => h.name).join(', ')}`,
      });
    } else {
      results.push({
        label: 'RPC Providers',
        status: 'ok',
        detail: `${available}/${total} providers available`,
      });
    }
  } catch {
    results.push({ label: 'RPC Providers', status: 'skip', detail: 'Could not check provider health' });
  }

  // ── 4. API Keys Status ──────────────────────────────────────────────
  try {
    const vault = getCredentialVault();
    const summary = vault.getConfigurationSummary();
    const critical = summary.filter(s => s.sensitive === 'critical');
    const high = summary.filter(s => s.sensitive === 'high');
    const configured = summary.filter(s => s.configured);

    const criticalMissing = critical.filter(s => !s.configured);
    if (criticalMissing.length > 0) {
      results.push({
        label: 'Critical Secrets',
        status: 'warn',
        detail: `Missing: ${criticalMissing.map(s => s.envVar).join(', ')}`,
      });
    } else {
      results.push({
        label: 'Critical Secrets',
        status: 'ok',
        detail: `All ${critical.length} critical secrets configured`,
      });
    }

    results.push({
      label: 'API Keys',
      status: configured.length > summary.length / 2 ? 'ok' : 'warn',
      detail: `${configured.length}/${summary.length} secrets configured (${high.filter(s => s.configured).length}/${high.length} high-priority)`,
    });
  } catch {
    results.push({ label: 'API Keys', status: 'skip', detail: 'Could not check credential vault' });
  }

  // ── 5. Tool Configuration ──────────────────────────────────────────
  try {
    const toolStatus = getAllToolStatus();
    const configured = toolStatus.filter(t => t.configured);
    const unconfigured = toolStatus.filter(t => !t.configured);

    results.push({
      label: 'Tools',
      status: unconfigured.length > 5 ? 'warn' : 'ok',
      detail: `${configured.length}/${toolStatus.length} tools ready` +
        (unconfigured.length > 0 ? `. Missing config: ${unconfigured.slice(0, 3).map(t => t.label).join(', ')}${unconfigured.length > 3 ? ` +${unconfigured.length - 3} more` : ''}` : ''),
    });
  } catch {
    results.push({ label: 'Tools', status: 'skip', detail: 'Could not check tool config' });
  }

  // ── 6. Safety Mode ─────────────────────────────────────────────────
  try {
    const mode = getUserMode(userId);
    const isDualDanger = mode.safetyMode === 'danger' && mode.signingMode === 'autosign';
    results.push({
      label: 'Safety Mode',
      status: isDualDanger ? 'warn' : 'ok',
      detail: `Safety: ${mode.safetyMode} | Signing: ${mode.signingMode}` +
        (isDualDanger ? ' — MAXIMUM RISK: danger + autosign active!' : ''),
    });
  } catch {
    results.push({ label: 'Safety Mode', status: 'skip', detail: 'Could not check mode' });
  }

  // ── 7. Endpoint Allowlist ──────────────────────────────────────────
  try {
    const mode = process.env.OPENCLAWNCH_ALLOWLIST_MODE ?? 'enforce';
    const hosts = getAllowedHosts();
    results.push({
      label: 'Endpoint Allowlist',
      status: mode === 'off' ? 'warn' : 'ok',
      detail: `Mode: ${mode} | ${hosts.length} hosts allowed` +
        (mode === 'off' ? ' — WARNING: allowlist disabled, all endpoints reachable' : ''),
    });
  } catch {
    results.push({ label: 'Endpoint Allowlist', status: 'skip', detail: 'Could not check allowlist' });
  }

  // ── 8. Budget Service ──────────────────────────────────────────────
  try {
    const budget = getBudgetService();
    const activeSession = budget.getActiveSession(userId);
    if (activeSession) {
      const check = budget.checkBudget(activeSession.id);
      results.push({
        label: 'Budget Tracker',
        status: check.ok ? 'ok' : 'warn',
        detail: `Active session: $${check.totalCostUsd.toFixed(2)} spent, $${check.remainingTotalUsd.toFixed(2)} remaining`,
      });
    } else {
      results.push({
        label: 'Budget Tracker',
        status: 'ok',
        detail: 'No active budget session',
      });
    }
  } catch {
    results.push({ label: 'Budget Tracker', status: 'skip', detail: 'Could not check budget service' });
  }

  // ── 9. Plan Scheduler ──────────────────────────────────────────────
  try {
    const { getScheduler } = await import('../services/plan-scheduler.js');
    const scheduler = getScheduler();
    const activeCount = scheduler.activeCount;
    results.push({
      label: 'Plan Scheduler',
      status: 'ok',
      detail: `Running — ${activeCount} active plan${activeCount !== 1 ? 's' : ''}`,
    });
  } catch {
    results.push({
      label: 'Plan Scheduler',
      status: 'warn',
      detail: 'Scheduler not initialized (may not have started yet)',
    });
  }

  // ── 10. Transaction Ledger ──────────────────────────────────────
  try {
    const ledger = getTxLedger();
    const stats = ledger.getStats();
    results.push({
      label: 'Transaction Ledger',
      status: 'ok',
      detail: `${stats.totalEvents} events recorded` +
        (stats.totalEvents > 0 ? ` (${Object.entries(stats.byType).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''),
    });
  } catch {
    results.push({ label: 'Transaction Ledger', status: 'skip', detail: 'Could not check ledger' });
  }

  // ── 11. Heartbeat Monitor ──────────────────────────────────────
  try {
    const heartbeat = getHeartbeatMonitor();
    const status = heartbeat.getStatus();
    results.push({
      label: 'Heartbeat Monitor',
      status: status.running ? 'ok' : (status.enabled ? 'warn' : 'ok'),
      detail: status.running
        ? `Running — ${status.trackedPositions} positions tracked, ${status.totalAlerts} alerts, interval: ${status.intervalMs / 1000}s`
        : status.enabled
          ? 'Enabled but not running (will start on gateway_start)'
          : 'Disabled (set OPENCLAWNCH_HEARTBEAT_ENABLED=true to enable)',
    });
  } catch {
    results.push({ label: 'Heartbeat Monitor', status: 'skip', detail: 'Could not check heartbeat' });
  }

  // ── 12. Market Cache ──────────────────────────────────────────
  try {
    const cache = getMarketCache();
    const stats = cache.getStats();
    results.push({
      label: 'Market Cache',
      status: 'ok',
      detail: `${stats.entries} entries, ${stats.hitRate}% hit rate (${stats.hits} hits, ${stats.misses} misses, ${stats.staleServes} stale serves)`,
    });
  } catch {
    results.push({ label: 'Market Cache', status: 'skip', detail: 'Could not check market cache' });
  }

  // ── 13. Channel Status ─────────────────────────────────────────────
  const channels = [
    { name: 'Telegram', envVar: 'TELEGRAM_BOT_TOKEN' },
    { name: 'Discord', envVar: 'DISCORD_TOKEN' },
    { name: 'Slack', envVar: 'SLACK_BOT_TOKEN' },
  ];

  for (const ch of channels) {
    const configured = !!process.env[ch.envVar];
    if (configured) {
      results.push({
        label: `Channel: ${ch.name}`,
        status: 'ok',
        detail: `${ch.envVar} configured`,
      });
    }
  }

  const anyChannel = channels.some(ch => !!process.env[ch.envVar]);
  if (!anyChannel) {
    results.push({
      label: 'Channels',
      status: 'warn',
      detail: 'No messaging channels configured. Set TELEGRAM_BOT_TOKEN, DISCORD_TOKEN, or SLACK_BOT_TOKEN.',
    });
  }

  return results;
}

const STATUS_ICONS: Record<string, string> = {
  ok: '[OK]',
  warn: '[!!]',
  fail: '[FAIL]',
  skip: '[--]',
};

export const doctorCommand = {
  name: 'doctor',
  description: 'Run diagnostics — check wallet, RPC, API keys, channels, security, and scheduler health',
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx: any) => {
    const userId = getSenderId(ctx);
    const results = await runDiagnostics(userId);

    const lines = ['**OpenClawnch Diagnostics**', ''];

    for (const r of results) {
      lines.push(`${STATUS_ICONS[r.status]} **${r.label}**: ${r.detail}`);
    }

    const okCount = results.filter(r => r.status === 'ok').length;
    const warnCount = results.filter(r => r.status === 'warn').length;
    const failCount = results.filter(r => r.status === 'fail').length;

    lines.push('');
    lines.push(`Summary: ${okCount} ok, ${warnCount} warnings, ${failCount} failures`);

    if (failCount > 0) {
      lines.push('', 'Fix failures above to ensure proper operation.');
    } else if (warnCount > 0) {
      lines.push('', 'Warnings are non-critical but should be reviewed.');
    } else {
      lines.push('', 'All checks passed.');
    }

    return { text: lines.join('\n') };
  },
};
