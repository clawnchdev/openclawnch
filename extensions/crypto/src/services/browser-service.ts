/**
 * Browser Automation Service — PinchTab HTTP API client.
 *
 * PinchTab is a 12MB Go binary providing browser control via HTTP.
 * Token-efficient: extracts structured content (~800 tokens/page)
 * instead of screenshots. Stealth mode for bot detection bypass.
 *
 * HTTP API endpoints:
 *   POST /navigate     — Navigate to URL, return page content
 *   POST /click        — Click an element by selector
 *   POST /type         — Type text into an input field
 *   POST /extract      — Extract structured data from current page
 *   POST /screenshot   — Take a screenshot (fallback for visual inspection)
 *   GET  /status       — Check if PinchTab is running
 *
 * Default: http://localhost:9222 (configurable via PINCHTAB_URL env var)
 */

// PinchTab runs locally — all HTTP calls use bare fetch to localhost.
// guardedFetch is not needed (it's for external API allowlisting).

// ── Types ────────────────────────────────────────────────────────────────

export interface NavigateResult {
  url: string;
  title: string;
  content: string;         // Extracted text content (token-efficient)
  links: PageLink[];
  forms: PageForm[];
  status: number;
  loadTimeMs: number;
}

export interface PageLink {
  text: string;
  href: string;
  selector: string;
}

export interface PageForm {
  action: string;
  method: string;
  inputs: Array<{
    name: string;
    type: string;
    placeholder?: string;
    selector: string;
  }>;
}

export interface ClickResult {
  clicked: boolean;
  selector: string;
  newUrl?: string;
  content?: string;
}

export interface TypeResult {
  typed: boolean;
  selector: string;
  value: string;
}

export interface ExtractResult {
  data: Record<string, unknown>;
  tokens: number;
}

export interface BrowserStatus {
  running: boolean;
  url?: string;
  version?: string;
  currentPage?: string;
}

// ── Service ──────────────────────────────────────────────────────────────

export class BrowserService {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.PINCHTAB_URL ?? 'http://localhost:9222';
  }

  /**
   * Check if PinchTab is running and accessible.
   */
  async getStatus(): Promise<BrowserStatus> {
    try {
      const response = await fetch(`${this.baseUrl}/status`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        return { running: false };
      }

      const data: any = await response.json();
      return {
        running: true,
        url: this.baseUrl,
        version: data.version,
        currentPage: data.currentPage,
      };
    } catch {
      return { running: false };
    }
  }

  /**
   * Navigate to a URL and extract page content.
   */
  async navigate(url: string, options?: {
    waitFor?: string;     // CSS selector to wait for
    stealth?: boolean;    // Enable stealth mode
    timeout?: number;     // Navigation timeout in ms
  }): Promise<NavigateResult> {
    const response = await fetch(`${this.baseUrl}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        waitFor: options?.waitFor,
        stealth: options?.stealth ?? true,
        timeout: options?.timeout ?? 30_000,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`Navigate failed (${response.status}): ${text}`);
    }

    const data: any = await response.json();
    return {
      url: data.url ?? url,
      title: data.title ?? '',
      content: data.content ?? '',
      links: (data.links ?? []).map((l: any) => ({
        text: l.text ?? '',
        href: l.href ?? '',
        selector: l.selector ?? '',
      })),
      forms: (data.forms ?? []).map((f: any) => ({
        action: f.action ?? '',
        method: f.method ?? 'GET',
        inputs: (f.inputs ?? []).map((i: any) => ({
          name: i.name ?? '',
          type: i.type ?? 'text',
          placeholder: i.placeholder,
          selector: i.selector ?? '',
        })),
      })),
      status: data.status ?? 200,
      loadTimeMs: data.loadTimeMs ?? 0,
    };
  }

  /**
   * Click an element on the current page.
   */
  async click(selector: string, options?: {
    waitForNavigation?: boolean;
  }): Promise<ClickResult> {
    const response = await fetch(`${this.baseUrl}/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selector,
        waitForNavigation: options?.waitForNavigation ?? true,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`Click failed (${response.status}): ${text}`);
    }

    const data: any = await response.json();
    return {
      clicked: data.clicked ?? false,
      selector,
      newUrl: data.newUrl,
      content: data.content,
    };
  }

  /**
   * Type text into an input field.
   */
  async type(selector: string, text: string, options?: {
    clear?: boolean;       // Clear the field before typing
    pressEnter?: boolean;  // Press Enter after typing
  }): Promise<TypeResult> {
    const response = await fetch(`${this.baseUrl}/type`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selector,
        text,
        clear: options?.clear ?? true,
        pressEnter: options?.pressEnter ?? false,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`Type failed (${response.status}): ${text}`);
    }

    const data: any = await response.json();
    return {
      typed: data.typed ?? false,
      selector,
      value: data.value ?? text,
    };
  }

  /**
   * Extract structured data from the current page.
   * PinchTab uses smart extraction to keep token count low.
   */
  async extract(options?: {
    selector?: string;    // CSS selector to scope extraction
    format?: 'text' | 'json' | 'table';
  }): Promise<ExtractResult> {
    const response = await fetch(`${this.baseUrl}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selector: options?.selector,
        format: options?.format ?? 'text',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`Extract failed (${response.status}): ${text}`);
    }

    const data: any = await response.json();
    return {
      data: data.data ?? {},
      tokens: data.tokens ?? 0,
    };
  }

  /**
   * Take a screenshot of the current page.
   * Returns base64-encoded PNG. Use sparingly — not token-efficient.
   */
  async screenshot(options?: {
    fullPage?: boolean;
    selector?: string;
  }): Promise<{ base64: string; width: number; height: number }> {
    const response = await fetch(`${this.baseUrl}/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullPage: options?.fullPage ?? false,
        selector: options?.selector,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`Screenshot failed (${response.status}): ${text}`);
    }

    const data: any = await response.json();
    return {
      base64: data.base64 ?? '',
      width: data.width ?? 0,
      height: data.height ?? 0,
    };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let _instance: BrowserService | null = null;

export function getBrowserService(): BrowserService {
  if (!_instance) {
    _instance = new BrowserService();
  }
  return _instance;
}

export function resetBrowserService(): void {
  _instance = null;
}
