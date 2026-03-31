/**
 * /report, /report_opt_in, /report_opt_out commands.
 *
 * /report <description>  — File a GitHub issue (requires opt-in)
 * /report_opt_in         — Enable issue reporting for this user
 * /report_opt_out        — Disable issue reporting
 *
 * The agent is instructed to proactively suggest /report when it detects
 * bugs, errors, or UX problems. The user must opt in first.
 */

import {
  isReportingEnabled,
  enableReporting,
  disableReporting,
  fileIssue,
  getReporterConfig,
} from '../services/issue-reporter.js';

export const reportCommand = {
  name: 'report',
  description: 'File a bug report or feature request as a GitHub issue. Usage: /report <title> | <description>',
  acceptsArgs: true,
  requireAuth: true,

  handler: async (ctx?: any) => {
    const userId = ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'owner';
    const rawArgs = (ctx?.args ?? '').trim();

    if (!rawArgs) {
      const enabled = isReportingEnabled(userId);
      const config = getReporterConfig(userId);
      return {
        text: [
          '**Issue Reporter**',
          '',
          `Status: ${enabled ? 'Enabled' : 'Disabled'}`,
          ...(config.issueCount > 0 ? [`Issues filed: ${config.issueCount}`] : []),
          '',
          'Usage:',
          '  `/report <title> | <description>` — File a bug or issue',
          '  `/report_opt_in` — Enable issue reporting',
          '  `/report_opt_out` — Disable issue reporting',
          '',
          enabled
            ? 'The agent will proactively suggest filing issues when it detects problems.'
            : 'Run `/report_opt_in` to enable. The agent will then suggest filing issues when it notices bugs or UX problems.',
        ].join('\n'),
      };
    }

    if (!isReportingEnabled(userId)) {
      return {
        text: 'Issue reporting is not enabled.\n\nRun `/report_opt_in` to enable. This is a one-time opt-in — the agent will then be able to file GitHub issues on your behalf when it detects problems.',
      };
    }

    // Parse: "title | description" or just "title"
    const pipeIdx = rawArgs.indexOf('|');
    let title: string;
    let body: string;
    let category: 'bug' | 'feature' | 'ux' | 'question' = 'bug';

    if (pipeIdx >= 0) {
      title = rawArgs.slice(0, pipeIdx).trim();
      body = rawArgs.slice(pipeIdx + 1).trim();
    } else {
      title = rawArgs;
      body = '';
    }

    if (!title) {
      return { text: 'Please provide a title. Usage: `/report <title> | <description>`' };
    }

    // Detect category from keywords
    const lower = (title + ' ' + body).toLowerCase();
    if (/\b(feature|request|add|support|wish|want|would be nice)\b/.test(lower)) {
      category = 'feature';
    } else if (/\b(confus|unclear|ux|ui|usability|hard to|difficult)\b/.test(lower)) {
      category = 'ux';
    } else if (/\b(question|how|why|what|when)\b/.test(lower)) {
      category = 'question';
    }

    const result = fileIssue({ title, body, category, userId });

    if ('error' in result) {
      return { text: `Failed to file issue: ${result.error}` };
    }

    return {
      text: `Issue filed: ${result.url}`,
    };
  },
};

export const reportOptInCommand = {
  name: 'report_opt_in',
  description: 'Enable GitHub issue reporting. The agent can then suggest filing issues when it detects problems.',
  acceptsArgs: false,
  requireAuth: true,

  handler: async (ctx?: any) => {
    const userId = ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'owner';

    if (isReportingEnabled(userId)) {
      return { text: 'Issue reporting is already enabled. Use `/report <title> | <description>` to file an issue.' };
    }

    enableReporting(userId);
    return {
      text: [
        'Issue reporting enabled.',
        '',
        'From now on, the agent will proactively suggest filing GitHub issues when it detects:',
        '  - Unexpected errors or tool failures',
        '  - Confusing UX or missing functionality',
        '  - Potential bugs in OpenClawnch',
        '',
        'You can file issues manually with `/report <title> | <description>`.',
        'To disable, use `/report_opt_out`.',
      ].join('\n'),
    };
  },
};

export const reportOptOutCommand = {
  name: 'report_opt_out',
  description: 'Disable GitHub issue reporting.',
  acceptsArgs: false,
  requireAuth: true,

  handler: async (ctx?: any) => {
    const userId = ctx?.senderId ?? ctx?.from ?? ctx?.metadata?.senderId ?? 'owner';

    if (!isReportingEnabled(userId)) {
      return { text: 'Issue reporting is already disabled.' };
    }

    disableReporting(userId);
    return { text: 'Issue reporting disabled. The agent will no longer suggest filing issues.' };
  },
};
