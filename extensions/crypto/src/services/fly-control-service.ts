/**
 * Fly Control Service — Manages the Fly.io deployment from within the bot.
 *
 * Uses the Fly Machines REST API (https://api.machines.dev) to:
 * - List/set/delete app-level secrets
 * - Get machine status
 * - Restart the machine
 *
 * Auth: FLY_API_TOKEN env var (set as a Fly secret itself).
 * App name: FLY_APP_NAME env var (or auto-detected from FLY_APP_NAME on Fly).
 *
 * SECURITY: All callers must be authenticated (requireAuth on commands).
 * Secret values are write-only — Fly's API never returns plaintext values.
 */

// ─── Configuration ───────────────────────────────────────────────────────

const FLY_API_BASE = 'https://api.machines.dev/v1';

function getFlyToken(): string | null {
  return process.env.FLY_API_TOKEN ?? null;
}

function getFlyAppName(): string | null {
  // FLY_APP_NAME is auto-set by Fly in the machine environment
  return process.env.FLY_APP_NAME ?? null;
}

export function isFlyControlAvailable(): boolean {
  return !!(getFlyToken() && getFlyAppName());
}

// ─── Error Types ─────────────────────────────────────────────────────────

export class FlyControlError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'FlyControlError';
  }
}

export class FlyNotConfiguredError extends FlyControlError {
  constructor() {
    super(
      'Fly control not configured. Set FLY_API_TOKEN as a Fly secret:\n' +
      '  fly secrets set FLY_API_TOKEN="$(fly tokens create deploy -a <your-app>)" -a <your-app>'
    );
  }
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────

function requireConfig(): { token: string; appName: string } {
  const token = getFlyToken();
  const appName = getFlyAppName();
  if (!token) throw new FlyNotConfiguredError();
  if (!appName) throw new FlyControlError('FLY_APP_NAME not set. Are you running on Fly.io?');
  return { token, appName };
}

async function flyRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const { token, appName } = requireConfig();
  const url = `${FLY_API_BASE}/apps/${appName}${path}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // H10: Add request timeout to prevent hanging
  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });

  if (res.ok) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  const errBody = await res.text().catch(() => '');

  if (res.status === 401) {
    throw new FlyControlError(
      'Fly API auth failed. Your FLY_API_TOKEN may be expired.\n' +
      'Generate a new one: fly tokens create deploy -a <your-app>'
    );
  }

  if (res.status === 404) {
    throw new FlyControlError(`Not found: ${path}`);
  }

  throw new FlyControlError(
    `Fly API error ${res.status}: ${errBody || 'Unknown error'}`,
    res.status,
  );
}

// ─── Secrets ─────────────────────────────────────────────────────────────

export interface FlySecret {
  name: string;
  digest: string;
  createdAt: string;
  version?: number;
}

/** List all secrets (names + digests only, never plaintext values). */
export async function listSecrets(): Promise<FlySecret[]> {
  const data = await flyRequest('GET', '/secrets');
  // API returns array of secret objects
  return (Array.isArray(data) ? data : data?.secrets ?? []).map((s: any) => ({
    name: s.name ?? s.Name,
    digest: s.digest ?? s.Digest ?? '',
    createdAt: s.created_at ?? s.CreatedAt ?? '',
    version: s.version ?? s.Version,
  }));
}

/**
 * Set one or more secrets. Values are encrypted by Fly and never returned.
 * Returns the new secrets version number — pass this to redeployMachine()
 * so the machine picks up the staged secrets.
 */
export async function setSecrets(
  secrets: Record<string, string>,
): Promise<number | undefined> {
  // Bulk update endpoint: POST /apps/{app}/secrets
  // Body: { values: { KEY: "value", KEY_TO_DELETE: null } }
  const result = await flyRequest('POST', '/secrets', { values: secrets });
  // The API returns the new version in the response
  return result?.version ?? result?.Version ?? undefined;
}

/** Delete a single secret. */
export async function deleteSecret(name: string): Promise<void> {
  await flyRequest('DELETE', `/secrets/${name}`);
}

// ─── Machines ────────────────────────────────────────────────────────────

export interface FlyMachineStatus {
  id: string;
  name: string;
  state: string;
  region: string;
  instanceId: string;
  privateIp: string;
  createdAt: string;
  updatedAt: string;
  imageRef: string;
  cpuKind: string;
  cpus: number;
  memoryMb: number;
}

/** List machines for this app. */
export async function listMachines(): Promise<FlyMachineStatus[]> {
  const data = await flyRequest('GET', '/machines');
  const machines = Array.isArray(data) ? data : [];
  return machines.map((m: any) => ({
    id: m.id,
    name: m.name ?? '',
    state: m.state ?? 'unknown',
    region: m.region ?? '',
    instanceId: m.instance_id ?? '',
    privateIp: m.private_ip ?? '',
    createdAt: m.created_at ?? '',
    updatedAt: m.updated_at ?? '',
    imageRef: m.config?.image ?? m.image_ref?.repository ?? '',
    cpuKind: m.config?.guest?.cpu_kind ?? '',
    cpus: m.config?.guest?.cpus ?? 0,
    memoryMb: m.config?.guest?.memory_mb ?? 0,
  }));
}

/** Restart a specific machine (simple restart, does NOT pick up new secrets). */
export async function restartMachine(machineId: string): Promise<void> {
  await flyRequest('POST', `/machines/${machineId}/restart?timeout=30s`);
}

/**
 * Update a machine in-place (GET config → POST it back) with min_secrets_version.
 *
 * The Fly Machines API stages secrets on set but does NOT deploy them until
 * a machine update includes `min_secrets_version` matching the staged version.
 * This is what `fly secrets deploy` does under the hood.
 *
 * If no secretsVersion is passed, we first query the secrets list to get the
 * latest version automatically.
 */
export async function redeployMachine(
  machineId: string,
  secretsVersion?: number,
): Promise<void> {
  // GET the full machine object
  const machine = await flyRequest('GET', `/machines/${machineId}`);
  const config = machine?.config;
  if (!config) {
    throw new FlyControlError(`Machine ${machineId} has no config`);
  }

  // If no version supplied, query the current max secrets version
  let minSecretsVersion = secretsVersion;
  if (minSecretsVersion === undefined) {
    const secrets = await listSecrets();
    // Use the highest version number across all secrets
    for (const s of secrets) {
      if (s.version !== undefined && (minSecretsVersion === undefined || s.version > minSecretsVersion)) {
        minSecretsVersion = s.version;
      }
    }
  }

  // POST the config back WITH min_secrets_version so Fly deploys staged secrets
  const body: Record<string, unknown> = { config };
  if (minSecretsVersion !== undefined) {
    body.min_secrets_version = minSecretsVersion;
  }
  await flyRequest('POST', `/machines/${machineId}`, body);
}

/**
 * Redeploy all running machines (picks up staged secrets).
 * Uses update with min_secrets_version (not restart) to ensure new secrets are deployed.
 *
 * @param secretsVersion - If provided, passed to redeployMachine. Otherwise auto-detected.
 */
export async function restartAllMachines(secretsVersion?: number): Promise<string[]> {
  const machines = await listMachines();
  const running = machines.filter(m => m.state === 'started');
  const redeployed: string[] = [];

  // Query secrets version once for all machines (if not provided)
  let version = secretsVersion;
  if (version === undefined) {
    const secrets = await listSecrets();
    for (const s of secrets) {
      if (s.version !== undefined && (version === undefined || s.version > version)) {
        version = s.version;
      }
    }
  }

  for (const m of running) {
    try {
      await redeployMachine(m.id, version);
      redeployed.push(m.id);
    } catch (err) {
      // Fallback: try simple restart if update fails
      try {
        await restartMachine(m.id);
        redeployed.push(m.id);
      } catch (err2) {
        console.error(`Failed to redeploy/restart machine ${m.id}: ${err2}`);
      }
    }
  }

  return redeployed;
}

// ─── Provider Switching ──────────────────────────────────────────────────
// High-level helper: switch LLM provider by updating the secret and
// restarting. The entrypoint.sh picks up OPENCLAWNCH_LLM_PROVIDER on boot.

export type LlmProvider = 'anthropic' | 'bankr' | 'openrouter' | 'openai';

const VALID_PROVIDERS: LlmProvider[] = ['anthropic', 'bankr', 'openrouter', 'openai'];

export function isValidProvider(p: string): p is LlmProvider {
  return VALID_PROVIDERS.includes(p as LlmProvider);
}

/**
 * Set the LLM provider secret (without restarting).
 * Returns the new secrets version — pass to scheduleRestart() so the
 * machine update includes min_secrets_version and actually deploys it.
 */
export async function setProvider(provider: LlmProvider): Promise<number | undefined> {
  if (!isValidProvider(provider)) {
    throw new FlyControlError(`Invalid provider: ${provider}. Valid: ${VALID_PROVIDERS.join(', ')}`);
  }

  return await setSecrets({ OPENCLAWNCH_LLM_PROVIDER: provider });
}

/**
 * Schedule a restart after a delay (default 2s).
 * This gives the command response time to be delivered before the process dies.
 * Fire-and-forget — errors are logged but don't propagate.
 *
 * @param delayMs - Delay before restart (default 2000ms)
 * @param secretsVersion - If provided, ensures the machine update includes
 *   min_secrets_version so staged secrets are deployed (not just staged).
 */
export function scheduleRestart(delayMs = 2000, secretsVersion?: number): void {
  setTimeout(async () => {
    try {
      await restartAllMachines(secretsVersion);
    } catch (err) {
      console.error('[fly-control] Scheduled restart failed:', err);
    }
  }, delayMs);
}

// ─── Convenience: Current Provider ───────────────────────────────────────

export function getCurrentProvider(): LlmProvider {
  const p = process.env.OPENCLAWNCH_LLM_PROVIDER;
  if (p && isValidProvider(p)) return p;
  return 'anthropic';
}
