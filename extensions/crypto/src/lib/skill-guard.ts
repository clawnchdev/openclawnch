/**
 * Skill Security Guard — static analysis for agent-created skills.
 *
 * Scans SKILL.md content for dangerous patterns before allowing the agent
 * to persist it. Inspired by Hermes Agent's skills_guard.py (~100 regex
 * patterns covering exfiltration, prompt injection, destructive commands,
 * persistence mechanisms, obfuscation, and supply chain attacks).
 *
 * We adapt this for a crypto DeFi context: the agent should be able to
 * write instructional markdown about trading strategies, but NOT be able
 * to embed code that exfiltrates keys, modifies system prompts, or
 * escalates its own permissions.
 *
 * Three trust levels:
 *   builtin  — static skills shipped with OpenClawnch (always allowed)
 *   learned  — skills the agent created from experience (scanned)
 *   imported — skills from external sources (strictest scanning)
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface SkillScanResult {
  safe: boolean;
  findings: SkillFinding[];
  trustLevel: 'builtin' | 'learned' | 'imported';
}

export interface SkillFinding {
  severity: 'critical' | 'high' | 'medium' | 'info';
  category: string;
  pattern: string;
  match: string;
  line: number;
  description: string;
}

// ─── Pattern Categories ──────────────────────────────────────────────────

interface ScanPattern {
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'info';
  regex: RegExp;
  description: string;
}

const SCAN_PATTERNS: ScanPattern[] = [
  // ── Prompt Injection ───────────────────────────────────────────────
  {
    category: 'prompt_injection',
    severity: 'critical',
    regex: /ignore\s+(all\s+)?previous\s+instructions/gi,
    description: 'Attempts to override system prompt instructions',
  },
  {
    category: 'prompt_injection',
    severity: 'critical',
    regex: /you\s+are\s+now\s+(a|an|the)\s+/gi,
    description: 'Attempts to redefine agent identity',
  },
  {
    category: 'prompt_injection',
    severity: 'critical',
    regex: /forget\s+(everything|all|your)\s+(you|instructions|rules)/gi,
    description: 'Attempts to clear agent context',
  },
  {
    category: 'prompt_injection',
    severity: 'critical',
    regex: /\bsystem\s*:\s*you\s+(must|should|will|are)\b/gi,
    description: 'Fake system message injection',
  },
  {
    category: 'prompt_injection',
    severity: 'high',
    regex: /<\/?system[-_]?(message|prompt|instruction|override)>/gi,
    description: 'XML-style system prompt injection tags',
  },
  {
    category: 'prompt_injection',
    severity: 'high',
    regex: /\bdo\s+not\s+(tell|reveal|mention|show)\s+(the\s+)?user\b/gi,
    description: 'Attempts to hide information from user',
  },
  {
    category: 'prompt_injection',
    severity: 'high',
    regex: /\bact\s+as\s+if\s+(you|the)\s+(are|is|have)\b/gi,
    description: 'Social engineering via role assumption',
  },

  // ── Exfiltration ───────────────────────────────────────────────────
  {
    category: 'exfiltration',
    severity: 'critical',
    regex: /\bfetch\s*\(\s*['"`]https?:\/\//gi,
    description: 'Embedded fetch call to external URL',
  },
  {
    category: 'exfiltration',
    severity: 'critical',
    regex: /\b(curl|wget|nc|ncat|netcat)\s+/gi,
    description: 'Network exfiltration command',
  },
  {
    category: 'exfiltration',
    severity: 'critical',
    regex: /process\.env\.(PRIVATE_KEY|BANKR_API_KEY|CLAWNCHER_PRIVATE_KEY)/gi,
    description: 'Direct secret access in skill content',
  },
  {
    category: 'exfiltration',
    severity: 'high',
    regex: /\bwebhook\.site\b|\brequestbin\b|\bpipedream\.net\b/gi,
    description: 'Known data exfiltration endpoints',
  },
  {
    category: 'exfiltration',
    severity: 'high',
    regex: /\bsend\s+(the|your|all)\s+(private|secret|api)\s*(key|token)/gi,
    description: 'Instruction to exfiltrate credentials',
  },

  // ── Destructive Operations ─────────────────────────────────────────
  {
    category: 'destructive',
    severity: 'critical',
    regex: /\brm\s+-rf\s+[\/~]/gi,
    description: 'Recursive file deletion command',
  },
  {
    category: 'destructive',
    severity: 'critical',
    regex: /\b(chmod|chown)\s+.*\s+(\/|~)/gi,
    description: 'File permission modification on system paths',
  },
  {
    category: 'destructive',
    severity: 'high',
    regex: /\b(drop|truncate|delete\s+from)\s+\w+/gi,
    description: 'Database destructive operation',
  },

  // ── Privilege Escalation ───────────────────────────────────────────
  {
    category: 'privilege_escalation',
    severity: 'critical',
    regex: /\bsudo\s+/gi,
    description: 'Privilege escalation via sudo',
  },
  {
    category: 'privilege_escalation',
    severity: 'critical',
    regex: /\bALLOW_PRIVATE_KEY_MODE\s*=\s*true/gi,
    description: 'Attempts to enable private key mode',
  },
  {
    category: 'privilege_escalation',
    severity: 'high',
    regex: /\b(danger\s*mode|disable\s+safety|skip\s+confirmation)/gi,
    description: 'Attempts to weaken safety controls',
  },
  {
    category: 'privilege_escalation',
    severity: 'high',
    regex: /\bOPENCLAWNCH_ALLOWLIST_MODE\s*=\s*(off|warn)/gi,
    description: 'Attempts to weaken endpoint allowlist',
  },

  // ── Obfuscation ────────────────────────────────────────────────────
  {
    category: 'obfuscation',
    severity: 'high',
    regex: /\b(eval|Function)\s*\(/gi,
    description: 'Dynamic code evaluation',
  },
  {
    category: 'obfuscation',
    severity: 'high',
    regex: /\batob\s*\(|btoa\s*\(/gi,
    description: 'Base64 encoding/decoding (potential obfuscation)',
  },
  {
    category: 'obfuscation',
    severity: 'medium',
    regex: /\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){3,}/g,
    description: 'Hex-encoded string (potential obfuscation)',
  },
  {
    category: 'obfuscation',
    severity: 'high',
    regex: /[\u200B-\u200F\u202A-\u202E\uFEFF]/g,
    description: 'Invisible Unicode characters (zero-width, bidirectional overrides)',
  },

  // ── Crypto-Specific Dangers ────────────────────────────────────────
  {
    category: 'crypto_danger',
    severity: 'critical',
    regex: /\b(approve|setApprovalForAll)\s*\(\s*['"`]?0x/gi,
    description: 'Embedded token approval to hardcoded address',
  },
  {
    category: 'crypto_danger',
    severity: 'critical',
    regex: /\bmax\s*uint256\b|\btype\(uint256\)\.max\b|ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/gi,
    description: 'Unlimited token approval (max uint256)',
  },
  {
    category: 'crypto_danger',
    severity: 'high',
    regex: /\b(always|automatically)\s+(approve|swap|transfer|bridge|send)\b/gi,
    description: 'Instruction to bypass confirmation for financial operations',
  },
  {
    category: 'crypto_danger',
    severity: 'high',
    regex: /\bslippage\s*[=:]\s*(100|[5-9]\d)\s*%/gi,
    description: 'Extremely high slippage tolerance (50%+)',
  },
  {
    category: 'crypto_danger',
    severity: 'medium',
    regex: /\b(honeypot|rug\s*pull|drain|scam)\s+(token|contract|this)/gi,
    description: 'References to known scam patterns in instructions',
  },

  // ── Persistence / Backdoor ─────────────────────────────────────────
  {
    category: 'persistence',
    severity: 'critical',
    regex: /\bcrontab\b|\bcron\s+/gi,
    description: 'Cron job installation (persistence mechanism)',
  },
  {
    category: 'persistence',
    severity: 'critical',
    regex: /\b(systemd|launchd|\.plist|\.service)\b/gi,
    description: 'System service installation (persistence mechanism)',
  },
  {
    category: 'persistence',
    severity: 'high',
    regex: /\b(\.bashrc|\.zshrc|\.profile|\.bash_profile)\b/gi,
    description: 'Shell profile modification',
  },

  // ── Self-Modification ──────────────────────────────────────────────
  {
    category: 'self_modification',
    severity: 'critical',
    regex: /\bwriteFile(Sync)?\s*\(\s*['"`].*index\.ts/gi,
    description: 'Attempts to modify plugin entry point',
  },
  {
    category: 'self_modification',
    severity: 'critical',
    regex: /\bwriteFile(Sync)?\s*\(\s*['"`].*endpoint-allowlist/gi,
    description: 'Attempts to modify the endpoint allowlist',
  },
  {
    category: 'self_modification',
    severity: 'high',
    regex: /\bwriteFile(Sync)?\s*\(\s*['"`].*credential-vault/gi,
    description: 'Attempts to modify the credential vault',
  },
  {
    category: 'self_modification',
    severity: 'high',
    regex: /\brequire\s*\(\s*['"`]child_process/gi,
    description: 'Attempts to import child_process module',
  },

  // ── Supply Chain ───────────────────────────────────────────────────
  {
    category: 'supply_chain',
    severity: 'high',
    regex: /\bnpm\s+(install|i)\s+/gi,
    description: 'Package installation command in skill',
  },
  {
    category: 'supply_chain',
    severity: 'high',
    regex: /\bpip\s+install\b/gi,
    description: 'Python package installation in skill',
  },
];

// ─── Scanner ─────────────────────────────────────────────────────────────

/**
 * Scan skill content for security issues.
 *
 * @param content - The full skill markdown content
 * @param trustLevel - How much we trust the source
 * @returns Scan result with findings and safe/unsafe determination
 */
export function scanSkillContent(
  content: string,
  trustLevel: 'builtin' | 'learned' | 'imported' = 'learned',
): SkillScanResult {
  // Builtin skills are always trusted
  if (trustLevel === 'builtin') {
    return { safe: true, findings: [], trustLevel };
  }

  const findings: SkillFinding[] = [];
  const lines = content.split('\n');

  for (const pattern of SCAN_PATTERNS) {
    pattern.regex.lastIndex = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] ?? '';
      let match: RegExpExecArray | null;
      pattern.regex.lastIndex = 0;

      while ((match = pattern.regex.exec(line)) !== null) {
        findings.push({
          severity: pattern.severity,
          category: pattern.category,
          pattern: pattern.regex.source.slice(0, 60),
          match: match[0].slice(0, 100),
          line: lineIdx + 1,
          description: pattern.description,
        });
      }
    }
  }

  // Determine if safe based on trust level and findings
  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasHigh = findings.some(f => f.severity === 'high');

  let safe: boolean;
  if (trustLevel === 'imported') {
    // Imported skills: any finding blocks
    safe = findings.length === 0;
  } else {
    // Learned skills: critical or high blocks
    safe = !hasCritical && !hasHigh;
  }

  return { safe, findings, trustLevel };
}

/**
 * Format scan findings as a human-readable report.
 */
export function formatScanReport(result: SkillScanResult): string {
  if (result.safe && result.findings.length === 0) {
    return 'Skill scan: CLEAN — no issues found.';
  }

  const lines = [
    result.safe
      ? 'Skill scan: PASSED with informational findings.'
      : 'Skill scan: BLOCKED — security issues detected.',
    '',
  ];

  const grouped = new Map<string, SkillFinding[]>();
  for (const f of result.findings) {
    const key = `${f.severity}:${f.category}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(f);
  }

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, info: 3 };
  const sortedKeys = [...grouped.keys()].sort((a, b) => {
    const sevA = (a.split(':')[0] ?? '') as keyof typeof severityOrder;
    const sevB = (b.split(':')[0] ?? '') as keyof typeof severityOrder;
    return (severityOrder[sevA] ?? 4) - (severityOrder[sevB] ?? 4);
  });

  for (const key of sortedKeys) {
    const items = grouped.get(key)!;
    const [severity = '', category] = key.split(':');
    const icon = severity === 'critical' ? '[!!]' : severity === 'high' ? '[!]' : '[i]';
    lines.push(`${icon} [${severity.toUpperCase()}] ${category} (${items.length} finding${items.length > 1 ? 's' : ''}):`);
    for (const f of items.slice(0, 5)) {
      lines.push(`  Line ${f.line}: ${f.description}`);
      lines.push(`    Match: "${f.match}"`);
    }
    if (items.length > 5) {
      lines.push(`  ... and ${items.length - 5} more`);
    }
  }

  return lines.join('\n');
}

/**
 * Validate skill frontmatter structure.
 * Returns an array of validation errors (empty = valid).
 */
export function validateSkillFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (!frontmatter.name || typeof frontmatter.name !== 'string') {
    errors.push('Missing or invalid "name" field (required, must be a string)');
  } else if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(frontmatter.name as string)) {
    errors.push('Invalid "name" format — must be lowercase kebab-case (e.g., "my-skill")');
  }

  if (!frontmatter.description || typeof frontmatter.description !== 'string') {
    errors.push('Missing or invalid "description" field (required, must be a string)');
  }

  if (typeof frontmatter.name === 'string' && (frontmatter.name as string).length > 60) {
    errors.push('Skill name too long (max 60 characters)');
  }

  if (typeof frontmatter.description === 'string' && (frontmatter.description as string).length > 500) {
    errors.push('Skill description too long (max 500 characters)');
  }

  return errors;
}
