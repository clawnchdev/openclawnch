/**
 * Agent Pool — sub-agent definitions, CRUD, persistence, preset agents.
 *
 * Sub-agents are specialized LLM instances with custom system prompts and
 * restricted tool access. The main agent (the one the user talks to)
 * delegates tasks to sub-agents via the agent_delegate tool.
 *
 * Each sub-agent definition specifies:
 * - A system prompt (its "personality" and expertise)
 * - Which tools it can use (subset of built-in + user tools)
 * - Which model to use (defaults to haiku for cost efficiency)
 * - Budget and token limits per task
 *
 * Agent definitions persist to ~/.openclawnch/agents/ as JSON.
 *
 * Preset agents ship out-of-the-box and cannot be deleted (only disabled):
 * - strategist: DeFi strategy analysis and trade planning
 * - analyst: Market research, data analysis, report generation
 * - accountant: Tax, cost basis, portfolio accounting
 * - risk_manager: Transaction risk assessment and approval recommendations
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';

// ─── Types ──────────────────────────────────────────────────────────────

export interface SubAgentDef {
  /** Unique ID. Presets use 'preset_<name>'. */
  id: string;
  /** Agent name (snake_case, unique). */
  name: string;
  /** Human-readable label. */
  label: string;
  /** What this agent specializes in (shown to the main LLM). */
  description: string;
  /** System prompt sent to the sub-agent LLM. */
  systemPrompt: string;
  /** Which tools this agent can call. Empty = no tool access (reasoning only). */
  allowedTools: string[];
  /** Model shortcut or full ID. Default: 'haiku'. */
  model: string;
  /** Max output tokens per task. Default: 4096. */
  maxTokens: number;
  /** Temperature. Default: 0.3 (focused). */
  temperature: number;
  /** Max tool-use loop iterations per task. Default: 10. */
  maxToolCalls: number;
  /** Max time per task in ms. Default: 60000 (1 min). */
  timeoutMs: number;
  /** Whether this agent is currently enabled. */
  enabled: boolean;
  /** Whether this is a built-in preset (cannot be deleted). */
  isPreset: boolean;
  /** Who created this agent. 'system' for presets. */
  createdBy: string;
  /** Usage count. */
  usageCount: number;
  createdAt: number;
  updatedAt: number;

  // ── Sub-delegation identity (V7) ───────────────────────────────────
  // Ephemeral keypair for sub-delegation. Generated at agent creation,
  // NOT persisted to disk (regenerated on restart for security).
  // The address is used as the delegate in child delegations.

  /** Ephemeral wallet address for sub-delegation. */
  walletAddress?: Address;
  /** Ephemeral private key (hex). In-memory only, never serialized. */
  walletPrivateKey?: Hex;
  /** Parent delegation hash this agent's sub-delegation chains from. */
  parentDelegationHash?: Hex;
}

// ─── Preset Agents ──────────────────────────────────────────────────────

const PRESETS: Omit<SubAgentDef, 'id' | 'usageCount' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'strategist',
    label: 'DeFi Strategist',
    description: 'Analyzes DeFi opportunities, compares protocols, and recommends trade strategies. Good at evaluating risk/reward tradeoffs.',
    systemPrompt:
      `You are a DeFi strategist sub-agent. Your job is to analyze decentralized finance opportunities and provide actionable trade strategies.\n\n` +
      `Guidelines:\n` +
      `- Always check current prices and balances before recommending trades\n` +
      `- Consider gas costs, slippage, and bridge fees in your analysis\n` +
      `- Quantify risk: estimate max drawdown, impermanent loss, or liquidation thresholds\n` +
      `- Compare at least 2 options when recommending strategies\n` +
      `- Be explicit about assumptions (timeframe, market conditions)\n` +
      `- Never recommend actions without explaining the reasoning\n` +
      `- Format output as structured analysis with clear sections`,
    allowedTools: ['defi_price', 'defi_balance', 'analytics', 'market_intel', 'cost_basis', 'yield', 'liquidity', 'block_explorer'],
    model: 'haiku',
    maxTokens: 4096,
    temperature: 0.3,
    maxToolCalls: 10,
    timeoutMs: 60_000,
    enabled: true,
    isPreset: true,
    createdBy: 'system',
  },
  {
    name: 'analyst',
    label: 'Market Analyst',
    description: 'Market research, token analysis, whale tracking, and data-driven insights. Produces structured reports.',
    systemPrompt:
      `You are a market analyst sub-agent. Your job is to research tokens, protocols, and market conditions, then produce concise analytical reports.\n\n` +
      `Guidelines:\n` +
      `- Start by gathering current data (prices, volumes, on-chain metrics)\n` +
      `- Look for patterns: whale movements, liquidity shifts, governance activity\n` +
      `- Compare with historical context when relevant\n` +
      `- Distinguish between facts (on-chain data) and interpretation (your analysis)\n` +
      `- Flag uncertainty explicitly: "data is limited", "this depends on..."\n` +
      `- Output structured reports with: Summary, Key Findings, Data Points, Risks`,
    allowedTools: ['defi_price', 'analytics', 'market_intel', 'block_explorer', 'herd_intelligence', 'watch_activity'],
    model: 'haiku',
    maxTokens: 4096,
    temperature: 0.2,
    maxToolCalls: 12,
    timeoutMs: 60_000,
    enabled: true,
    isPreset: true,
    createdBy: 'system',
  },
  {
    name: 'accountant',
    label: 'Crypto Accountant',
    description: 'Tax calculations, cost basis tracking, P&L reports, and multi-currency accounting across crypto and fiat.',
    systemPrompt:
      `You are a crypto accounting sub-agent. Your job is to calculate cost basis, track P&L, and produce accounting reports.\n\n` +
      `Guidelines:\n` +
      `- Use FIFO (First In, First Out) as the default cost basis method\n` +
      `- Track both realized and unrealized gains/losses\n` +
      `- Account for gas fees as part of the cost basis\n` +
      `- Handle multi-currency (crypto + fiat) positions\n` +
      `- Produce clear, auditable output with transaction references\n` +
      `- Flag any transactions with missing cost basis data\n` +
      `- Note: you provide calculations, not tax advice. Recommend a tax professional for filing.`,
    allowedTools: ['cost_basis', 'defi_balance', 'defi_price', 'analytics', 'fiat_payment'],
    model: 'haiku',
    maxTokens: 4096,
    temperature: 0.1,
    maxToolCalls: 8,
    timeoutMs: 60_000,
    enabled: true,
    isPreset: true,
    createdBy: 'system',
  },
  {
    name: 'risk_manager',
    label: 'Risk Manager',
    description: 'Evaluates transaction risk, checks approvals and allowances, assesses protocol safety, and recommends safeguards.',
    systemPrompt:
      `You are a risk management sub-agent. Your job is to evaluate the safety of proposed transactions and DeFi positions.\n\n` +
      `Guidelines:\n` +
      `- Check token approvals and unlimited allowances (flag revocation opportunities)\n` +
      `- Evaluate smart contract risk: is the protocol audited? TVL? Age?\n` +
      `- Assess concentration risk: what % of portfolio is in one position?\n` +
      `- Check for common scam signals: honeypot tokens, fake liquidity, rug pull patterns\n` +
      `- Recommend position sizing based on risk tolerance\n` +
      `- Output: Risk Level (Low/Medium/High/Critical), Findings, Recommendations\n` +
      `- When in doubt, recommend caution. Better to miss a trade than lose funds.`,
    allowedTools: ['approvals', 'defi_balance', 'defi_price', 'block_explorer', 'analytics', 'market_intel'],
    model: 'haiku',
    maxTokens: 2048,
    temperature: 0.1,
    maxToolCalls: 8,
    timeoutMs: 45_000,
    enabled: true,
    isPreset: true,
    createdBy: 'system',
  },
];

// ─── Ephemeral Keypair Generation ───────────────────────────────────────

/**
 * Generate an ephemeral keypair for sub-agent delegation.
 * Uses viem's generatePrivateKey + privateKeyToAccount.
 * These are in-memory only and NOT persisted to disk.
 */
async function generateEphemeralKeypair(): Promise<{ address: Address; privateKey: Hex }> {
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, privateKey };
}

// ─── Validation ─────────────────────────────────────────────────────────

function isValidAgentName(name: string): boolean {
  return /^[a-z][a-z0-9_]{2,30}$/.test(name);
}

const RESERVED_AGENT_NAMES = new Set(PRESETS.map(p => p.name));

// ─── Service ────────────────────────────────────────────────────────────

export class AgentPool {
  private agents = new Map<string, SubAgentDef>();
  private stateDir: string;

  constructor(opts?: { stateDir?: string }) {
    this.stateDir = opts?.stateDir ?? join(
      process.env.HOME ?? '', '.openclawnch', 'agents'
    );
    this.initPresets();
    this.loadState();
  }

  /** Create a new sub-agent. */
  create(params: {
    name: string;
    label: string;
    description: string;
    systemPrompt: string;
    createdBy: string;
    allowedTools?: string[];
    model?: string;
    maxTokens?: number;
    temperature?: number;
    maxToolCalls?: number;
    timeoutMs?: number;
  }): SubAgentDef {
    if (!isValidAgentName(params.name)) {
      throw new AgentPoolError(
        `Invalid agent name "${params.name}". Must be 3-30 chars, lowercase alphanumeric + underscores, starting with a letter.`
      );
    }
    if (this.getByName(params.name)) {
      throw new AgentPoolError(`An agent named "${params.name}" already exists.`);
    }
    if (params.systemPrompt.length < 20) {
      throw new AgentPoolError('System prompt must be at least 20 characters.');
    }

    const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const agent: SubAgentDef = {
      id,
      name: params.name,
      label: params.label,
      description: params.description,
      systemPrompt: params.systemPrompt,
      allowedTools: params.allowedTools ?? [],
      model: params.model ?? 'haiku',
      maxTokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.3,
      maxToolCalls: params.maxToolCalls ?? 10,
      timeoutMs: params.timeoutMs ?? 60_000,
      enabled: true,
      isPreset: false,
      createdBy: params.createdBy,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.agents.set(id, agent);
    this.saveState();
    return agent;
  }

  /** Update an existing agent. Cannot change name or isPreset. */
  update(id: string, updates: Partial<Pick<SubAgentDef,
    'label' | 'description' | 'systemPrompt' | 'allowedTools' | 'model' |
    'maxTokens' | 'temperature' | 'maxToolCalls' | 'timeoutMs' | 'enabled'
  >>): SubAgentDef | null {
    const agent = this.agents.get(id);
    if (!agent) return null;
    Object.assign(agent, updates, { updatedAt: Date.now() });
    this.saveState();
    return agent;
  }

  /** Delete an agent. Presets cannot be deleted (disable them instead). */
  delete(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (agent.isPreset) {
      throw new AgentPoolError(`Cannot delete preset agent "${agent.name}". Use disable instead.`);
    }
    this.agents.delete(id);
    this.saveState();
    return true;
  }

  get(id: string): SubAgentDef | null {
    return this.agents.get(id) ?? null;
  }

  getByName(name: string): SubAgentDef | null {
    for (const a of this.agents.values()) {
      if (a.name === name) return a;
    }
    return null;
  }

  list(opts?: { enabled?: boolean; isPreset?: boolean }): SubAgentDef[] {
    let all = Array.from(this.agents.values());
    if (opts?.enabled !== undefined) all = all.filter(a => a.enabled === opts.enabled);
    if (opts?.isPreset !== undefined) all = all.filter(a => a.isPreset === opts.isPreset);
    return all.sort((a, b) => {
      // Presets first, then by name
      if (a.isPreset !== b.isPreset) return a.isPreset ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  getEnabledAgents(): SubAgentDef[] {
    return this.list({ enabled: true });
  }

  recordUsage(id: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.usageCount += 1;
      agent.updatedAt = Date.now();
      this.saveState();
    }
  }

  /** Clear all agents (for testing). */
  clear(): void {
    this.agents.clear();
  }

  /**
   * Assign an ephemeral keypair to an agent for sub-delegation.
   * Generated in-memory, never persisted to disk.
   * Safe to call multiple times — skips if already assigned.
   */
  async assignEphemeralWallet(id: string): Promise<{ address: Address; privateKey: Hex } | null> {
    const agent = this.agents.get(id);
    if (!agent) return null;
    if (agent.walletAddress && agent.walletPrivateKey) {
      return { address: agent.walletAddress, privateKey: agent.walletPrivateKey };
    }

    const keypair = await generateEphemeralKeypair();
    agent.walletAddress = keypair.address;
    agent.walletPrivateKey = keypair.privateKey;
    agent.updatedAt = Date.now();
    // DO NOT saveState() — private keys must not be persisted
    return keypair;
  }

  /**
   * Get the ephemeral wallet for an agent (if assigned).
   */
  getWallet(id: string): { address: Address; privateKey: Hex } | null {
    const agent = this.agents.get(id);
    if (!agent?.walletAddress || !agent?.walletPrivateKey) return null;
    return { address: agent.walletAddress, privateKey: agent.walletPrivateKey };
  }

  // ── Presets ─────────────────────────────────────────────────────────

  private initPresets(): void {
    const now = Date.now();
    for (const preset of PRESETS) {
      const id = `preset_${preset.name}`;
      if (!this.agents.has(id)) {
        this.agents.set(id, {
          ...preset,
          id,
          usageCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private loadState(): void {
    try {
      const filePath = join(this.stateDir, 'agents.json');
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        for (const a of data) {
          // Loaded agents override presets (user may have disabled/modified them)
          this.agents.set(a.id, a);
        }
      }
    } catch { /* fresh start */ }
  }

  private saveState(): void {
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
      const filePath = join(this.stateDir, 'agents.json');
      // Strip ephemeral wallet keys — NEVER persist private keys to disk
      const serializable = Array.from(this.agents.values()).map(a => {
        const { walletPrivateKey, walletAddress, parentDelegationHash, ...rest } = a;
        return rest;
      });
      writeFileSync(filePath, JSON.stringify(serializable, null, 2), 'utf8');
    } catch { /* best effort */ }
  }
}

// ─── Error Class ────────────────────────────────────────────────────────

export class AgentPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentPoolError';
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: AgentPool | null = null;

export function getAgentPool(opts?: { stateDir?: string }): AgentPool {
  if (!instance) {
    instance = new AgentPool(opts);
  }
  return instance;
}

export function resetAgentPool(): void {
  instance?.clear();
  instance = null;
}
