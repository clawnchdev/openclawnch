/**
 * Browser Automation Tool — navigate, click, type, extract via PinchTab.
 *
 * Actions:
 *   navigate    — Navigate to a URL and extract page content
 *   click       — Click an element by CSS selector
 *   type        — Type text into an input field
 *   extract     — Extract structured data from current page
 *   screenshot  — Take a page screenshot (use sparingly)
 *   status      — Check if PinchTab is running
 *
 * Uses PinchTab HTTP API (Go binary, 12MB, stealth mode).
 * Token-efficient: ~800 tokens/page vs 10K+ for screenshots.
 *
 * Use cases: claim airdrops, interact with dApp UIs, scrape dashboards,
 * browse protocol docs, fill forms.
 */

import { Type } from '@sinclair/typebox';
import { stringEnum, jsonResult, errorResult, readStringParam } from '../lib/tool-helpers.js';
import { getBrowserService } from '../services/browser-service.js';

const ACTIONS = ['navigate', 'click', 'type', 'extract', 'screenshot', 'status'] as const;

const BrowserSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      'navigate: go to URL and extract content. click: click element. ' +
      'type: type into input. extract: get structured data. ' +
      'screenshot: take screenshot. status: check PinchTab.',
  }),
  url: Type.Optional(Type.String({
    description: 'URL to navigate to. Required for navigate action.',
  })),
  selector: Type.Optional(Type.String({
    description: 'CSS selector for click/type/extract/screenshot actions.',
  })),
  text: Type.Optional(Type.String({
    description: 'Text to type into input field. Required for type action.',
  })),
  wait_for: Type.Optional(Type.String({
    description: 'CSS selector to wait for after navigation (ensures page is loaded).',
  })),
  stealth: Type.Optional(Type.Boolean({
    description: 'Enable stealth mode to avoid bot detection. Default: true.',
  })),
  format: Type.Optional(Type.String({
    description: 'Extraction format: "text" (default), "json", "table".',
  })),
  press_enter: Type.Optional(Type.Boolean({
    description: 'Press Enter after typing. Default: false.',
  })),
  full_page: Type.Optional(Type.Boolean({
    description: 'Take full-page screenshot instead of viewport. Default: false.',
  })),
});

export function createBrowserTool() {
  return {
    name: 'browser',
    label: 'Browser',
    ownerOnly: true,
    description:
      'Browser automation via PinchTab. Navigate to URLs, click elements, type text, ' +
      'and extract structured content from web pages. Token-efficient (~800 tokens/page). ' +
      'Use for: claiming airdrops, interacting with dApp UIs, scraping dashboards. ' +
      'Requires PinchTab binary running locally.',
    parameters: BrowserSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, 'action', { required: true })!;

      switch (action) {
        case 'navigate':
          return handleNavigate(params);
        case 'click':
          return handleClick(params);
        case 'type':
          return handleType(params);
        case 'extract':
          return handleExtract(params);
        case 'screenshot':
          return handleScreenshot(params);
        case 'status':
          return handleStatus();
        default:
          return errorResult(`Unknown action: ${action}. Use: navigate, click, type, extract, screenshot, status`);
      }
    },
  };
}

// ── Action Handlers ─────────────────────────────────────────────────────

async function handleNavigate(params: Record<string, unknown>) {
  const url = readStringParam(params, 'url');
  if (!url) {
    return errorResult('url is required for navigate action.');
  }

  // Basic URL validation
  try {
    new URL(url);
  } catch {
    return errorResult(`Invalid URL: "${url}". Must be a fully-formed URL (e.g. https://app.aave.com).`);
  }

  try {
    const service = getBrowserService();
    const status = await service.getStatus();
    if (!status.running) {
      return errorResult(
        'PinchTab is not running. Start it with: pinchtab serve\n' +
        'Install from: https://pinchtab.com',
      );
    }

    const result = await service.navigate(url, {
      waitFor: readStringParam(params, 'wait_for') ?? undefined,
      stealth: params.stealth !== false,
    });

    return jsonResult({
      url: result.url,
      title: result.title,
      status: result.status,
      loadTimeMs: result.loadTimeMs,
      content: truncateContent(result.content, 4000),
      links: result.links.slice(0, 20).map(l => ({
        text: l.text.slice(0, 80),
        href: l.href,
      })),
      forms: result.forms.length > 0 ? result.forms : undefined,
      tip: result.links.length > 20
        ? `Showing 20 of ${result.links.length} links. Use extract with a selector for specific content.`
        : undefined,
    });
  } catch (err) {
    return errorResult(`Navigate failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleClick(params: Record<string, unknown>) {
  const selector = readStringParam(params, 'selector');
  if (!selector) {
    return errorResult('selector is required for click action (CSS selector, e.g. "button.submit", "#claim-btn").');
  }

  try {
    const service = getBrowserService();
    const result = await service.click(selector);

    return jsonResult({
      clicked: result.clicked,
      selector: result.selector,
      newUrl: result.newUrl,
      content: result.content ? truncateContent(result.content, 2000) : undefined,
    });
  } catch (err) {
    return errorResult(`Click failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleType(params: Record<string, unknown>) {
  const selector = readStringParam(params, 'selector');
  const text = readStringParam(params, 'text');
  if (!selector || !text) {
    return errorResult('Both selector and text are required for type action.');
  }

  try {
    const service = getBrowserService();
    const result = await service.type(selector, text, {
      pressEnter: params.press_enter === true,
    });

    return jsonResult({
      typed: result.typed,
      selector: result.selector,
      value: result.value,
    });
  } catch (err) {
    return errorResult(`Type failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleExtract(params: Record<string, unknown>) {
  try {
    const service = getBrowserService();
    const format = readStringParam(params, 'format');
    const result = await service.extract({
      selector: readStringParam(params, 'selector') ?? undefined,
      format: (format as 'text' | 'json' | 'table') ?? 'text',
    });

    return jsonResult({
      data: result.data,
      tokens: result.tokens,
    });
  } catch (err) {
    return errorResult(`Extract failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleScreenshot(params: Record<string, unknown>) {
  try {
    const service = getBrowserService();
    const result = await service.screenshot({
      fullPage: params.full_page === true,
      selector: readStringParam(params, 'selector') ?? undefined,
    });

    return jsonResult({
      width: result.width,
      height: result.height,
      sizeKb: Math.round((result.base64.length * 3) / 4 / 1024),
      note: 'Screenshot captured. Prefer extract action for token-efficient content retrieval.',
      // Don't include base64 in result — too large for LLM context.
      // In a real implementation, save to file and return path.
      saved: 'screenshot available via PinchTab UI',
    });
  } catch (err) {
    return errorResult(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleStatus() {
  try {
    const service = getBrowserService();
    const status = await service.getStatus();

    return jsonResult({
      running: status.running,
      url: status.url,
      version: status.version,
      currentPage: status.currentPage,
      note: status.running
        ? 'PinchTab is running and ready.'
        : 'PinchTab is not running. Start with: pinchtab serve\nInstall: https://pinchtab.com',
    });
  } catch (err) {
    return errorResult(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + `\n... [truncated, ${content.length - maxLength} more chars]`;
}
