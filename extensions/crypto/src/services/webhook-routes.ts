/**
 * Webhook Routes — registry that maps URL paths to event triggers.
 *
 * Each route defines:
 * - A URL path (e.g. "/github", "/stripe", "/monitor")
 * - A source label for display
 * - An optional HMAC secret for signature verification
 * - An optional plan name to trigger when the webhook fires
 * - Enable/disable lifecycle
 *
 * Routes persist to ~/.openclawnch/webhooks/routes.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────

export interface WebhookRoute {
  /** Unique ID. */
  id: string;
  /** Route name (alphanumeric + hyphens, unique). */
  name: string;
  /** URL path this route matches (e.g. "/github"). */
  path: string;
  /** Human-readable source label (e.g. "GitHub", "Stripe Payments"). */
  source: string;
  /** HMAC secret for signature verification. Empty = no verification (not recommended). */
  secret: string;
  /** Plan name to trigger when webhook fires. Empty = just emit event. */
  triggerPlan: string;
  /** Whether this route is active. */
  enabled: boolean;
  /** Who created this route. */
  createdBy: string;
  /** Number of times this webhook has been received. */
  hitCount: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Validation ─────────────────────────────────────────────────────────

function isValidRouteName(name: string): boolean {
  return /^[a-z][a-z0-9\-]{1,40}$/.test(name);
}

function isValidPath(path: string): boolean {
  return /^\/[a-z0-9\-_\/]{0,100}$/.test(path);
}

// ─── Service ────────────────────────────────────────────────────────────

export class WebhookRouteRegistry {
  private routes = new Map<string, WebhookRoute>();
  private stateDir: string;

  constructor(opts?: { stateDir?: string }) {
    this.stateDir = opts?.stateDir ?? join(
      process.env.HOME ?? '', '.openclawnch', 'webhooks'
    );
    this.loadState();
  }

  /** Create a new webhook route. */
  create(params: {
    name: string;
    path: string;
    source: string;
    secret?: string;
    triggerPlan?: string;
    createdBy: string;
  }): WebhookRoute {
    if (!isValidRouteName(params.name)) {
      throw new WebhookRouteError(
        `Invalid route name "${params.name}". Must be 2-40 chars, lowercase alphanumeric + hyphens.`
      );
    }
    if (!isValidPath(params.path)) {
      throw new WebhookRouteError(
        `Invalid path "${params.path}". Must start with / and contain only lowercase alphanumeric, hyphens, underscores.`
      );
    }
    if (this.getByName(params.name)) {
      throw new WebhookRouteError(`A route named "${params.name}" already exists.`);
    }
    if (this.getByPath(params.path)) {
      throw new WebhookRouteError(`A route with path "${params.path}" already exists.`);
    }

    const id = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const route: WebhookRoute = {
      id,
      name: params.name,
      path: params.path,
      source: params.source,
      secret: params.secret ?? '',
      triggerPlan: params.triggerPlan ?? '',
      enabled: true,
      createdBy: params.createdBy,
      hitCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.routes.set(id, route);
    this.saveState();
    return route;
  }

  update(id: string, updates: Partial<Pick<WebhookRoute,
    'source' | 'secret' | 'triggerPlan' | 'enabled'
  >>): WebhookRoute | null {
    const route = this.routes.get(id);
    if (!route) return null;
    Object.assign(route, updates, { updatedAt: Date.now() });
    this.saveState();
    return route;
  }

  delete(id: string): boolean {
    const existed = this.routes.delete(id);
    if (existed) this.saveState();
    return existed;
  }

  get(id: string): WebhookRoute | null {
    return this.routes.get(id) ?? null;
  }

  getByName(name: string): WebhookRoute | null {
    for (const r of this.routes.values()) {
      if (r.name === name) return r;
    }
    return null;
  }

  getByPath(path: string): WebhookRoute | null {
    for (const r of this.routes.values()) {
      if (r.path === path) return r;
    }
    return null;
  }

  list(opts?: { enabled?: boolean }): WebhookRoute[] {
    let all = Array.from(this.routes.values());
    if (opts?.enabled !== undefined) all = all.filter(r => r.enabled === opts.enabled);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  recordHit(id: string): void {
    const route = this.routes.get(id);
    if (route) {
      route.hitCount += 1;
      route.updatedAt = Date.now();
      this.saveState();
    }
  }

  clear(): void {
    this.routes.clear();
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private loadState(): void {
    try {
      const filePath = join(this.stateDir, 'routes.json');
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        for (const r of data) {
          this.routes.set(r.id, r);
        }
      }
    } catch { /* fresh start */ }
  }

  private saveState(): void {
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
      const filePath = join(this.stateDir, 'routes.json');
      writeFileSync(filePath, JSON.stringify(Array.from(this.routes.values()), null, 2), 'utf8');
    } catch { /* best effort */ }
  }
}

// ─── Error Class ────────────────────────────────────────────────────────

export class WebhookRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRouteError';
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: WebhookRouteRegistry | null = null;

export function getWebhookRoutes(opts?: { stateDir?: string }): WebhookRouteRegistry {
  if (!instance) {
    instance = new WebhookRouteRegistry(opts);
  }
  return instance;
}

export function resetWebhookRoutes(): void {
  instance?.clear();
  instance = null;
}
