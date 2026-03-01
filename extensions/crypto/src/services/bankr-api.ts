/**
 * Bankr Agent API Client — shared client for all Bankr Agent API calls.
 *
 * Every tool and service that talks to api.bankr.bot uses this module.
 * Handles authentication, error mapping, and job polling.
 *
 * Base URL: https://api.bankr.bot
 * Auth: X-API-Key header with bk_... key
 */

import type {
  BankrUserInfo,
  BankrBalancesResponse,
  BankrChainBalance,
  BankrTokenBalance,
  BankrRawBalancesResponse,
  BankrChain,
  BankrPromptResponse,
  BankrJobResult,
  BankrSignRequest,
  BankrSignResponse,
  BankrSubmitRequest,
  BankrSubmitResponse,
  BankrDeployRequest,
  BankrDeployResponse,
} from './bankr-types.js';

import {
  BankrAuthError,
  BankrAccessError,
  BankrReadOnlyError,
  BankrRateLimitError,
  BankrServerError,
} from './bankr-types.js';

// ─── Configuration ───────────────────────────────────────────────────────

const BANKR_API = 'https://api.bankr.bot';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

// ─── Thread ID Storage ──────────────────────────────────────────────────

const _threadIds = new Map<string, string>();

export function storeBankrThreadId(userId: string, threadId: string): void {
  _threadIds.set(userId, threadId);
}

export function getBankrThreadId(userId: string): string | undefined {
  return _threadIds.get(userId);
}

// ─── Key Management ─────────────────────────────────────────────────────

export function getBankrApiKey(): string | null {
  return process.env.BANKR_API_KEY ?? null;
}

export function hasBankrApi(): boolean {
  return !!getBankrApiKey();
}

function requireBankrApiKey(): string {
  const key = getBankrApiKey();
  if (!key) {
    throw new BankrAuthError(
      'BANKR_API_KEY not set. Connect via /connect_bankr or set the env var.'
    );
  }
  return key;
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────

async function handleResponse(res: Response): Promise<any> {
  if (res.ok) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // Error handling by status code
  const body = await res.text().catch(() => '');

  switch (res.status) {
    case 401:
      throw new BankrAuthError();
    case 402:
      // 402 is LLM-specific but handle gracefully
      throw new BankrAuthError('LLM credits exhausted. Top up at bankr.bot/llm');
    case 403: {
      // Distinguish "not enabled" vs "read-only"
      const lower = body.toLowerCase();
      if (lower.includes('read-only') || lower.includes('readonly')) {
        throw new BankrReadOnlyError();
      }
      throw new BankrAccessError();
    }
    case 429: {
      let resetAt = Date.now() + 60_000;
      let limit = 0;
      let used = 0;
      try {
        const parsed = JSON.parse(body);
        resetAt = parsed.resetAt ?? resetAt;
        limit = parsed.limit ?? 0;
        used = parsed.used ?? 0;
      } catch {
        // Use defaults
      }
      throw new BankrRateLimitError(resetAt, limit, used);
    }
    default:
      if (res.status >= 500) {
        throw new BankrServerError(res.status, body || 'Bankr API server error');
      }
      throw new Error(`Bankr API error ${res.status}: ${body}`);
  }
}

export async function bankrGet(path: string): Promise<any> {
  const key = requireBankrApiKey();
  const res = await fetch(`${BANKR_API}${path}`, {
    method: 'GET',
    headers: {
      'X-API-Key': key,
      'Content-Type': 'application/json',
    },
  });
  return handleResponse(res);
}

export async function bankrPost(path: string, body: unknown): Promise<any> {
  const key = requireBankrApiKey();
  const res = await fetch(`${BANKR_API}${path}`, {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return handleResponse(res);
}

// ─── User Info ───────────────────────────────────────────────────────────

export async function getBankrUserInfo(): Promise<BankrUserInfo> {
  const raw = await bankrGet('/agent/me');
  // API returns the full response — extract the relevant fields
  return {
    wallets: raw.wallets ?? [],
    bankrClub: raw.bankrClub ?? false,
    socialAccounts: raw.socialAccounts ?? [],
    refCode: raw.refCode,
  };
}

// ─── Balances ────────────────────────────────────────────────────────────

export async function getBankrBalances(chains?: BankrChain[]): Promise<BankrBalancesResponse> {
  const params = chains?.length ? `?chains=${chains.join(',')}` : '';
  const raw: BankrRawBalancesResponse = await bankrGet(`/agent/balances${params}`);

  // Normalize the nested-object response into our flat array format
  const normalizedChains: BankrChainBalance[] = [];
  let grandTotal = 0;

  if (raw.balances) {
    for (const [chainName, chainData] of Object.entries(raw.balances)) {
      const tokens: BankrTokenBalance[] = (chainData.tokenBalances ?? []).map(entry => ({
        symbol: entry.token?.baseToken?.symbol ?? 'UNKNOWN',
        name: entry.token?.baseToken?.name ?? 'Unknown',
        address: entry.address ?? entry.token?.baseToken?.address ?? '',
        balance: entry.token?.balance ?? 0,
        balanceUsd: entry.token?.balanceUSD ?? 0,
        price: entry.token?.baseToken?.price ?? 0,
        decimals: entry.token?.baseToken?.decimals ?? 18,
      }));

      const totalUsd = parseFloat(chainData.total ?? '0');
      grandTotal += totalUsd;

      normalizedChains.push({
        chain: chainName,
        nativeBalance: chainData.nativeBalance ?? '0',
        nativeBalanceUsd: parseFloat(chainData.nativeUsd ?? '0'),
        tokens,
        totalUsd,
      });
    }
  }

  return { chains: normalizedChains, totalUsd: grandTotal };
}

// ─── Prompt + Job Polling ────────────────────────────────────────────────

export async function bankrPrompt(
  prompt: string,
  threadId?: string,
): Promise<BankrPromptResponse> {
  const body: Record<string, unknown> = { prompt };
  if (threadId) body.threadId = threadId;
  return bankrPost('/agent/prompt', body);
}

/**
 * Poll a Bankr job until it completes or fails.
 * Default: poll every 2s, timeout after 120s.
 */
export async function bankrPollJob(
  jobId: string,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
): Promise<BankrJobResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result: BankrJobResult = await bankrGet(`/agent/job/${jobId}`);

    if (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled') {
      return result;
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  // Timed out — try to cancel
  try {
    await bankrCancelJob(jobId);
  } catch {
    // Best-effort cancel
  }

  return {
    jobId,
    status: 'failed',
    error: `Job timed out after ${Math.round(timeoutMs / 1000)}s. The operation may still be processing on Bankr's side.`,
  };
}

/**
 * Submit a prompt and poll until completion. Convenience wrapper.
 */
export async function bankrPromptAndPoll(
  prompt: string,
  opts?: { threadId?: string; timeoutMs?: number },
): Promise<BankrJobResult> {
  const { jobId, threadId } = await bankrPrompt(prompt, opts?.threadId);
  // Store threadId for conversation continuity if a user context exists
  const result = await bankrPollJob(jobId, opts?.timeoutMs);
  // Attach threadId to result for callers that need it
  (result as any).threadId = threadId;
  return result;
}

export async function bankrCancelJob(jobId: string): Promise<void> {
  await bankrPost(`/agent/job/${jobId}/cancel`, {});
}

// ─── Sign ────────────────────────────────────────────────────────────────

export async function bankrSign(req: BankrSignRequest): Promise<BankrSignResponse> {
  return bankrPost('/agent/sign', req);
}

// ─── Submit Raw Transaction ──────────────────────────────────────────────

export async function bankrSubmit(req: BankrSubmitRequest): Promise<BankrSubmitResponse> {
  return bankrPost('/agent/submit', req);
}

// ─── Token Deploy ────────────────────────────────────────────────────────

export async function bankrDeployToken(opts: BankrDeployRequest): Promise<BankrDeployResponse> {
  return bankrPost('/token-launches/deploy', opts);
}
