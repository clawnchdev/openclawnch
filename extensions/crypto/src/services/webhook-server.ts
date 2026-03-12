/**
 * Webhook Server — inbound HTTP server for external event ingestion.
 *
 * Accepts webhooks from external services (GitHub, Stripe, monitoring, etc.)
 * and converts them into event bus events that can trigger plan workflows.
 *
 * Security:
 * - Disabled by default: only starts if OPENCLAWNCH_WEBHOOK_PORT is set
 * - Binds to localhost (127.0.0.1) by default — set OPENCLAWNCH_WEBHOOK_HOST=0.0.0.0 for external
 * - Per-route HMAC-SHA256 signature verification (secret per webhook)
 * - Rate limiting: per-IP and per-route
 * - Payload size cap: 64KB default
 * - No direct tool execution — only fires events on the event bus
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getWebhookRoutes, type WebhookRoute } from './webhook-routes.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface WebhookServerConfig {
  port: number;
  host: string;
  maxPayloadBytes: number;
  rateLimitPerMinute: number;
}

export interface WebhookEvent {
  type: 'webhook_received';
  route: string;
  source: string;
  payload: unknown;
  headers: Record<string, string>;
  receivedAt: number;
}

type WebhookEventHandler = (event: WebhookEvent) => void | Promise<void>;

// ─── Rate Limiter ───────────────────────────────────────────────────────

class RateLimiter {
  private hits = new Map<string, number[]>();
  private windowMs = 60_000;
  private maxPerWindow: number;

  constructor(maxPerMinute: number) {
    this.maxPerWindow = maxPerMinute;
  }

  check(key: string): boolean {
    const now = Date.now();
    const timestamps = this.hits.get(key) ?? [];
    const recent = timestamps.filter(t => now - t < this.windowMs);

    if (recent.length >= this.maxPerWindow) return false;

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Clean up expired entries. */
  prune(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.hits.entries()) {
      const recent = timestamps.filter(t => now - t < this.windowMs);
      if (recent.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, recent);
      }
    }
  }
}

// ─── HMAC Verification ──────────────────────────────────────────────────

function verifyHmac(payload: string, signature: string, secret: string): boolean {
  try {
    // Support common signature formats:
    // "sha256=abc123" (GitHub), "abc123" (raw), "v0=abc123" (Slack)
    let algo = 'sha256';
    let sig = signature;

    if (signature.startsWith('sha256=')) {
      sig = signature.slice(7);
    } else if (signature.startsWith('sha1=')) {
      algo = 'sha1';
      sig = signature.slice(5);
    } else if (signature.startsWith('v0=')) {
      sig = signature.slice(3);
    }

    const expected = createHmac(algo, secret).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');

    if (sigBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(sigBuf, expectedBuf);
  } catch {
    return false;
  }
}

// ─── Server ─────────────────────────────────────────────────────────────

export class WebhookServer {
  private server: Server | null = null;
  private config: WebhookServerConfig;
  private rateLimiter: RateLimiter;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  private handler: WebhookEventHandler | null = null;

  constructor(config?: Partial<WebhookServerConfig>) {
    this.config = {
      port: config?.port ?? parseInt(process.env.OPENCLAWNCH_WEBHOOK_PORT ?? '0', 10),
      host: config?.host ?? (process.env.OPENCLAWNCH_WEBHOOK_HOST ?? '127.0.0.1'),
      maxPayloadBytes: config?.maxPayloadBytes ?? 65_536, // 64KB
      rateLimitPerMinute: config?.rateLimitPerMinute ?? 60,
    };
    this.rateLimiter = new RateLimiter(this.config.rateLimitPerMinute);
  }

  /** Register the event handler for incoming webhooks. */
  onEvent(handler: WebhookEventHandler): void {
    this.handler = handler;
  }

  /** Start the server. Returns false if port is not configured. */
  async start(): Promise<boolean> {
    if (this.config.port <= 0) return false;
    if (this.server) return true; // already running

    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.listen(this.config.port, this.config.host, () => {
        // Prune rate limiter every 5 minutes
        this.pruneInterval = setInterval(() => this.rateLimiter.prune(), 300_000);
        resolve(true);
      });

      this.server.on('error', () => {
        resolve(false);
      });
    });
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  getConfig(): WebhookServerConfig {
    return { ...this.config };
  }

  // ── Request Handler ─────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only accept POST
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    // Rate limit by IP
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!this.rateLimiter.check(`ip:${ip}`)) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too Many Requests');
      return;
    }

    // Parse URL path — strip leading /webhook/ prefix if present
    const path = (req.url ?? '/').replace(/^\/webhook\/?/, '/').replace(/\/$/, '') || '/';

    // Rate limit by route
    if (!this.rateLimiter.check(`route:${path}`)) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too Many Requests');
      return;
    }

    // Look up route
    const routes = getWebhookRoutes();
    const route = routes.getByPath(path);
    if (!route || !route.enabled) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // Read body with size limit
    const body = await this.readBody(req);
    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('Payload Too Large');
      return;
    }

    // Verify HMAC signature
    if (route.secret) {
      const sigHeader =
        req.headers['x-hub-signature-256'] ??    // GitHub
        req.headers['x-hub-signature'] ??         // GitHub (SHA-1)
        req.headers['x-signature'] ??             // Generic
        req.headers['stripe-signature'] ??        // Stripe (handled differently but captured)
        req.headers['x-webhook-signature'] ??     // Common
        '';
      const signature = Array.isArray(sigHeader) ? sigHeader[0] ?? '' : sigHeader;

      if (!signature || !verifyHmac(body, signature, route.secret)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized: Invalid signature');
        return;
      }
    }

    // Parse payload
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = { raw: body };
    }

    // Build event
    const event: WebhookEvent = {
      type: 'webhook_received',
      route: route.name,
      source: route.source,
      payload,
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k, v as string])
      ),
      receivedAt: Date.now(),
    };

    // Record hit
    routes.recordHit(route.id);

    // Fire event
    if (this.handler) {
      try {
        await this.handler(event);
      } catch { /* handler errors don't affect HTTP response */ }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, route: route.name }));
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.config.maxPayloadBytes) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });

      req.on('error', () => {
        resolve(null);
      });
    });
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: WebhookServer | null = null;

export function getWebhookServer(config?: Partial<WebhookServerConfig>): WebhookServer {
  if (!instance) {
    instance = new WebhookServer(config);
  }
  return instance;
}

export function resetWebhookServer(): void {
  if (instance) {
    instance.stop().catch(() => {});
    instance = null;
  }
}
