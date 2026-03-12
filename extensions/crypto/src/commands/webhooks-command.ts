/**
 * Webhooks command — manage inbound webhook routes.
 *
 * /webhooks              — List all webhook routes and server status
 * /webhooks info <name>  — Show details for a route
 * /webhooks enable <name>  — Enable a route
 * /webhooks disable <name> — Disable a route
 * /webhooks delete <name>  — Delete a route
 */

import { getWebhookRoutes, type WebhookRoute } from '../services/webhook-routes.js';
import { getWebhookServer } from '../services/webhook-server.js';

function formatRouteSummary(route: WebhookRoute): string {
  const status = route.enabled ? 'enabled' : 'disabled';
  const secured = route.secret ? 'HMAC' : 'open';
  return `  **${route.name}** (${status}, ${secured}) — ${route.source}\n    Path: \`${route.path}\` | Hits: ${route.hitCount}${route.triggerPlan ? ` | Trigger: ${route.triggerPlan}` : ''}`;
}

export const webhooksCommand = {
  name: 'webhooks',
  description: 'Manage inbound webhook routes: list, info, enable, disable, delete',
  acceptsArgs: true,
  requireAuth: false,
  handler: async (ctx?: any) => {
    const rawArgs = (ctx?.args ?? '').trim();
    const parts = rawArgs.split(/\s+/);
    const subcommand = parts[0] || 'list';
    const arg = parts.slice(1).join(' ');

    const routes = getWebhookRoutes();

    switch (subcommand) {
      case 'list': {
        const server = getWebhookServer();
        const config = server.getConfig();
        const allRoutes = routes.list();

        const sections: string[] = [];

        // Server status
        if (server.isRunning()) {
          sections.push(`**Webhook Server:** Running on ${config.host}:${config.port}`);
        } else if (config.port > 0) {
          sections.push(`**Webhook Server:** Configured (port ${config.port}) but not started`);
        } else {
          sections.push(
            '**Webhook Server:** Not configured\n' +
            'Set `OPENCLAWNCH_WEBHOOK_PORT` to enable. Default host: `127.0.0.1` (set `OPENCLAWNCH_WEBHOOK_HOST=0.0.0.0` for external).'
          );
        }

        if (allRoutes.length === 0) {
          sections.push('\n**Routes:** None defined');
          sections.push('\nCreate webhook routes via the agent: "Create a webhook for GitHub push events"');
        } else {
          const enabled = allRoutes.filter(r => r.enabled);
          const disabled = allRoutes.filter(r => !r.enabled);

          sections.push(`\n**Routes** (${allRoutes.length} total, ${enabled.length} enabled)`);
          if (enabled.length > 0) {
            sections.push(`\n**Active:**\n${enabled.map(formatRouteSummary).join('\n')}`);
          }
          if (disabled.length > 0) {
            sections.push(`\n**Disabled:**\n${disabled.map(formatRouteSummary).join('\n')}`);
          }
        }

        sections.push('\nUse `/webhooks info <name>` for details.');
        return { text: sections.join('\n') };
      }

      case 'info': {
        if (!arg) return { text: 'Usage: `/webhooks info <route_name>`' };
        const route = routes.getByName(arg);
        if (!route) return { text: `No webhook route named "${arg}" found.` };

        const server = getWebhookServer();
        const config = server.getConfig();
        const baseUrl = server.isRunning()
          ? `http://${config.host}:${config.port}`
          : `http://localhost:${config.port || '???'}`;

        const lines = [
          `**${route.name}** — ${route.source}`,
          `  Status: ${route.enabled ? 'enabled' : 'disabled'}`,
          `  Path: \`${route.path}\``,
          `  Full URL: \`${baseUrl}/webhook${route.path}\``,
          `  Security: ${route.secret ? 'HMAC-SHA256 verified' : 'No signature verification (not recommended)'}`,
          `  Trigger plan: ${route.triggerPlan || 'none (event bus only)'}`,
          `  Hits: ${route.hitCount}`,
          `  Created by: ${route.createdBy}`,
          `  Created: ${new Date(route.createdAt).toLocaleDateString()}`,
        ];
        return { text: lines.join('\n') };
      }

      case 'enable': {
        if (!arg) return { text: 'Usage: `/webhooks enable <route_name>`' };
        const route = routes.getByName(arg);
        if (!route) return { text: `No webhook route named "${arg}" found.` };
        if (route.enabled) return { text: `Route "${arg}" is already enabled.` };
        routes.update(route.id, { enabled: true });
        return { text: `Webhook route "${arg}" has been enabled.` };
      }

      case 'disable': {
        if (!arg) return { text: 'Usage: `/webhooks disable <route_name>`' };
        const route = routes.getByName(arg);
        if (!route) return { text: `No webhook route named "${arg}" found.` };
        if (!route.enabled) return { text: `Route "${arg}" is already disabled.` };
        routes.update(route.id, { enabled: false });
        return { text: `Webhook route "${arg}" has been disabled.` };
      }

      case 'delete': {
        if (!arg) return { text: 'Usage: `/webhooks delete <route_name>`' };
        const route = routes.getByName(arg);
        if (!route) return { text: `No webhook route named "${arg}" found.` };
        routes.delete(route.id);
        return { text: `Webhook route "${arg}" has been permanently deleted.` };
      }

      default:
        return {
          text: `Unknown subcommand: "${subcommand}".\n\nAvailable: \`list\`, \`info <name>\`, \`enable <name>\`, \`disable <name>\`, \`delete <name>\``,
        };
    }
  },
};
