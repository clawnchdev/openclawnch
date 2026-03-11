/**
 * Credential Vault — centralized secret access with leak scanning.
 *
 * Inspired by IronClaw's credential boundary injection pattern.
 * Instead of tools reading process.env directly, they request secrets
 * through this vault. The vault:
 * 1. Provides secrets on demand (single point of access)
 * 2. Tracks which tools accessed which secrets (audit log)
 * 3. Scans outbound strings for leaked credentials before they reach the LLM
 *
 * This does NOT encrypt secrets at rest (they're still in env vars / Fly secrets).
 * What it does is:
 * - Prevent accidental secret exposure in tool output
 * - Create an audit trail of secret access
 * - Provide a single place to rotate/revoke secrets
 * - Scan LLM-bound text for credential leaks
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface SecretAccess {
  key: string;
  tool: string;
  timestamp: number;
}

export interface LeakScanResult {
  clean: boolean;
  leaks: Array<{
    type: string;
    pattern: string;
    position: number;
  }>;
  redactedText: string;
}

// ─── Secret Registry ─────────────────────────────────────────────────────
// Maps logical secret names to env var names.
// Tools should use logical names, never raw env vars.

const SECRET_REGISTRY: Record<string, {
  envVar: string;
  description: string;
  sensitive: 'critical' | 'high' | 'medium';
}> = {
  // ── Critical: private keys and auth tokens that control funds ─────
  'wallet.privateKey': {
    envVar: 'CLAWNCHER_PRIVATE_KEY',
    description: 'Wallet private key for auto-signing',
    sensitive: 'critical',
  },
  'wallet.keychainMnemonic': {
    envVar: 'CLAWNCHER_WALLET_PASSWORD',
    description: 'Password for Keychain-encrypted wallet mnemonic',
    sensitive: 'critical',
  },
  'walletconnect.projectId': {
    envVar: 'WALLETCONNECT_PROJECT_ID',
    description: 'WalletConnect cloud project ID',
    sensitive: 'high',
  },
  'bankr.apiKey': {
    envVar: 'BANKR_API_KEY',
    description: 'Bankr Agent API key',
    sensitive: 'high',
  },

  // ── High: API keys for financial services ─────────────────────────
  'dex.0x.apiKey': {
    envVar: 'ZEROX_API_KEY',
    description: '0x DEX aggregator API key',
    sensitive: 'high',
  },
  'dex.1inch.apiKey': {
    envVar: 'ONEINCH_API_KEY',
    description: '1inch DEX aggregator API key',
    sensitive: 'high',
  },
  'bridge.lifi.apiKey': {
    envVar: 'LIFI_API_KEY',
    description: 'LI.FI bridge aggregator API key',
    sensitive: 'high',
  },

  // ── Medium: read-only API keys ────────────────────────────────────
  'rpc.alchemy.apiKey': {
    envVar: 'ALCHEMY_API_KEY',
    description: 'Alchemy RPC provider API key',
    sensitive: 'medium',
  },
  'price.coingecko.apiKey': {
    envVar: 'COINGECKO_API_KEY',
    description: 'CoinGecko price feed API key',
    sensitive: 'medium',
  },
  'price.cmc.apiKey': {
    envVar: 'CMC_API_KEY',
    description: 'CoinMarketCap price feed API key',
    sensitive: 'medium',
  },
  'price.birdeye.apiKey': {
    envVar: 'BIRDEYE_API_KEY',
    description: 'Birdeye price feed API key',
    sensitive: 'medium',
  },
  'explorer.basescan.apiKey': {
    envVar: 'BASESCAN_API_KEY',
    description: 'Basescan block explorer API key',
    sensitive: 'medium',
  },
  'explorer.etherscan.apiKey': {
    envVar: 'ETHERSCAN_API_KEY',
    description: 'Etherscan block explorer API key',
    sensitive: 'medium',
  },
  'intel.herd.accessToken': {
    envVar: 'HERD_ACCESS_TOKEN',
    description: 'Herd Intelligence access token',
    sensitive: 'medium',
  },
  'social.x.apiKey': {
    envVar: 'X_API_KEY',
    description: 'X/Twitter API key',
    sensitive: 'high',
  },
  'social.x.apiSecret': {
    envVar: 'X_API_SECRET',
    description: 'X/Twitter API secret',
    sensitive: 'high',
  },
  'social.x.accessToken': {
    envVar: 'X_ACCESS_TOKEN',
    description: 'X/Twitter access token',
    sensitive: 'high',
  },
  'social.x.accessTokenSecret': {
    envVar: 'X_ACCESS_TOKEN_SECRET',
    description: 'X/Twitter access token secret',
    sensitive: 'high',
  },
  'llm.anthropic.apiKey': {
    envVar: 'ANTHROPIC_API_KEY',
    description: 'Anthropic LLM API key',
    sensitive: 'high',
  },
  'llm.bankr.key': {
    envVar: 'BANKR_LLM_KEY',
    description: 'Bankr LLM gateway key',
    sensitive: 'high',
  },
  'llm.openrouter.apiKey': {
    envVar: 'OPENROUTER_API_KEY',
    description: 'OpenRouter LLM API key',
    sensitive: 'high',
  },
  'llm.openai.apiKey': {
    envVar: 'OPENAI_API_KEY',
    description: 'OpenAI LLM API key',
    sensitive: 'high',
  },
  'deploy.fly.apiToken': {
    envVar: 'FLY_API_TOKEN',
    description: 'Fly.io deployment API token',
    sensitive: 'high',
  },
  'bot.molten.apiKey': {
    envVar: 'MOLTEN_API_KEY',
    description: 'Molten agent matching API key',
    sensitive: 'medium',
  },
  'bot.wayfinder.apiKey': {
    envVar: 'WAYFINDER_API_KEY',
    description: 'Wayfinder routing API key',
    sensitive: 'medium',
  },
  'clawnch.apiKey': {
    envVar: 'CLAWNCH_API_KEY',
    description: 'Clawnch platform API key',
    sensitive: 'high',
  },
  'clawnch.launcherApiKey': {
    envVar: 'CLAWNCHER_API_KEY',
    description: 'Clawnch token launcher API key',
    sensitive: 'high',
  },
  'bot.hummingbot.username': {
    envVar: 'HUMMINGBOT_USERNAME',
    description: 'Hummingbot gateway username',
    sensitive: 'high',
  },
  'bot.hummingbot.password': {
    envVar: 'HUMMINGBOT_PASSWORD',
    description: 'Hummingbot gateway password',
    sensitive: 'critical',
  },
  'bot.telegram.botToken': {
    envVar: 'TELEGRAM_BOT_TOKEN',
    description: 'Telegram bot API token',
    sensitive: 'high',
  },
  'nft.reservoir.apiKey': {
    envVar: 'RESERVOIR_API_KEY',
    description: 'Reservoir NFT API key (free tier: 4 req/sec)',
    sensitive: 'medium',
  },
};

// ─── Credential Vault ────────────────────────────────────────────────────

class CredentialVault {
  private accessLog: SecretAccess[] = [];
  private readonly MAX_LOG_SIZE = 1000;

  /**
   * Get a secret value by its logical name.
   * Returns null if not configured.
   */
  getSecret(name: string, tool: string): string | null {
    const entry = SECRET_REGISTRY[name];
    if (!entry) return null;

    const value = process.env[entry.envVar] ?? null;

    // Log access (even if value is null — tracks attempts)
    this.logAccess(name, tool);

    return value;
  }

  /**
   * Check if a secret is configured (without revealing its value).
   */
  hasSecret(name: string): boolean {
    const entry = SECRET_REGISTRY[name];
    if (!entry) return false;
    return !!process.env[entry.envVar];
  }

  /**
   * Get the raw env var for a logical secret name.
   * Use this only when you need to pass the env var name (not value) to something.
   */
  getEnvVarName(name: string): string | null {
    return SECRET_REGISTRY[name]?.envVar ?? null;
  }

  /**
   * Scan text for credential leaks.
   * Returns a result with any detected leaks and a redacted version of the text.
   */
  scanForLeaks(text: string): LeakScanResult {
    const leaks: LeakScanResult['leaks'] = [];
    let redacted = text;

    // 1. Check for actual secret values appearing in text
    for (const [name, entry] of Object.entries(SECRET_REGISTRY)) {
      const value = process.env[entry.envVar];
      if (!value || value.length < 8) continue; // Skip short/missing values

      const idx = text.indexOf(value);
      if (idx !== -1) {
        leaks.push({
          type: `secret:${name}`,
          pattern: `${entry.envVar} value`,
          position: idx,
        });
        // Redact the value
        redacted = redacted.replaceAll(value, `[REDACTED:${entry.envVar}]`);
      }
    }

    // 2. Pattern-based detection (catches secrets not in our registry)
    //
    // IMPORTANT: The private_key pattern uses a "context-positive" approach:
    // In a crypto application, 64-hex-char strings are everywhere (tx hashes,
    // block hashes, ABI-encoded data, Merkle proofs, event topics, etc.).
    // Instead of matching all 64-hex strings and trying to exclude safe ones,
    // we only flag them when the surrounding context indicates a secret.
    const LEAK_PATTERNS: Array<{ type: string; regex: RegExp }> = [
      // Private keys: only match 64-hex strings near danger-context words.
      // The regex itself matches any 64-hex string; filtering is below.
      { type: 'private_key', regex: /\b(0x)?[0-9a-fA-F]{64}\b/g },
      // WalletConnect secrets
      { type: 'wc_secret', regex: /wc:[0-9a-f]{32}@/gi },
      // Generic API keys (long alphanumeric strings that look like keys)
      { type: 'api_key_pattern', regex: /\b(sk-|bk_|xai-|pk_|sk_live_|rk_live_)[a-zA-Z0-9_\-]{20,}\b/g },
      // BIP-39 mnemonic sequences: 12 or 24 consecutive lowercase words (3-8 chars each)
      // Heuristic: a sequence of 12+ short lowercase words is very likely a seed phrase
      // Case-insensitive to catch mixed-case mnemonics (e.g. "Abandon Ability ...")
      { type: 'bip39_mnemonic', regex: /\b([a-zA-Z]{3,8}\s+){11,}[a-zA-Z]{3,8}\b/gi },
    ];

    // Collect all pattern matches first, then apply redactions in reverse
    // order to preserve string offsets.
    const patternMatches: Array<{ type: string; matchStr: string; index: number }> = [];

    for (const { type, regex } of LEAK_PATTERNS) {
      let match: RegExpExecArray | null;
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        // Don't flag if already caught as a known secret value
        if (leaks.some(l => l.position === match!.index)) continue;

        // For private key pattern: apply strict false-positive filters.
        // A crypto app routinely outputs 64-hex strings (tx hashes, event
        // topics, ABI-encoded values) that are NOT secrets.
        if (type === 'private_key') {
          const hexPart = match[0].replace(/^0x/, '');

          // Filter 1: Low entropy — ABI-padded values like 0x000...001
          // Real private keys have high entropy (many distinct nibbles).
          const uniqueNibbles = new Set(hexPart.toLowerCase().split('')).size;
          if (uniqueNibbles < 8) continue;

          // Filter 2: ABI-encoded address (24 leading zeros + 40-char addr)
          if (/^0{24}[0-9a-fA-F]{40}$/.test(hexPart)) continue;

          // Filter 3: Context-positive — only flag if surrounding text
          // indicates this is actually a secret/key. Use a wide window
          // (80 chars each side) for context.
          const contextStart = Math.max(0, match.index - 80);
          const contextEnd = Math.min(text.length, match.index + match[0].length + 80);
          const surrounding = text.slice(contextStart, contextEnd);

          // Danger-context: words that suggest a secret is being disclosed
          const DANGER_CONTEXT = /\b(private\s*key|secret\s*key|priv\s*key|mnemonic|seed\s*phrase|signing\s*key|wallet\s*key|export\s*key|my\s*key|your\s*key)\b/i;
          // Safe-context: words that indicate a normal crypto data type
          const SAFE_CONTEXT = /\b(tx|transaction|hash|block|receipt|data|calldata|input|encoded|abi|selector|topics|event|log|proof|merkle|root|salt|create2|slot|storage|token[_\s]?id|nft|signature|sig\b|nonce|commitment|returndata|output|result|param|arg|swap|transfer|balance|0x[0-9a-fA-F]{40})\b/i;

          // Only flag if danger context is present AND safe context is absent
          if (!DANGER_CONTEXT.test(surrounding)) continue;
          if (SAFE_CONTEXT.test(surrounding)) continue;
        }

        patternMatches.push({
          type,
          matchStr: match[0],
          index: match.index,
        });
      }
    }

    // Sort by position descending so we can apply redactions from the end
    // of the string backward, preserving earlier offsets.
    patternMatches.sort((a, b) => b.index - a.index);

    for (const pm of patternMatches) {
      leaks.push({
        type: pm.type,
        pattern: pm.matchStr.slice(0, 20) + '...',
        position: pm.index,
      });
      redacted = redacted.slice(0, pm.index) + `[REDACTED:${pm.type}]` + redacted.slice(pm.index + pm.matchStr.length);
    }

    return {
      clean: leaks.length === 0,
      leaks,
      redactedText: redacted,
    };
  }

  /**
   * Get recent access log entries (for diagnostics).
   */
  getAccessLog(limit = 50): SecretAccess[] {
    return this.accessLog.slice(-limit);
  }

  /**
   * Get a summary of configured vs unconfigured secrets.
   */
  getConfigurationSummary(): Array<{
    name: string;
    envVar: string;
    description: string;
    configured: boolean;
    sensitive: string;
  }> {
    return Object.entries(SECRET_REGISTRY).map(([name, entry]) => ({
      name,
      envVar: entry.envVar,
      description: entry.description,
      configured: !!process.env[entry.envVar],
      sensitive: entry.sensitive,
    }));
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private logAccess(key: string, tool: string): void {
    this.accessLog.push({ key, tool, timestamp: Date.now() });
    // Trim log
    if (this.accessLog.length > this.MAX_LOG_SIZE) {
      this.accessLog = this.accessLog.slice(-this.MAX_LOG_SIZE / 2);
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _instance: CredentialVault | null = null;

export function getCredentialVault(): CredentialVault {
  if (!_instance) {
    _instance = new CredentialVault();
  }
  return _instance;
}

export function resetCredentialVault(): void {
  _instance = null;
}
