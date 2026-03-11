# Commands Reference

87 slash commands. All commands are tappable in Telegram (no typing needed). On other channels, type them as usual.

---

## Core

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/wallet` | Wallet status, balance, chain |
| `/portfolio` | Token holdings and wallet info |
| `/balance` | ETH balance and wallet address |
| `/chain` | Current chain info |
| `/tx` | Transaction history |
| `/policy` | Spending auto-approval rules |
| `/setup` | Show configured vs unconfigured tools |
| `/doctor` | Run diagnostics (wallet, RPC, API keys, channels, security) |

## Wallet Connection

| Command | Description |
|---------|-------------|
| `/connect` | Connect mobile wallet via WalletConnect |
| `/connect_metamask` | Connect MetaMask |
| `/connect_rainbow` | Connect Rainbow |
| `/connect_coinbase` | Connect Coinbase Wallet |
| `/connect_trust` | Connect Trust Wallet |
| `/connect_zerion` | Connect Zerion |
| `/connect_uniswap` | Connect Uniswap Wallet |
| `/connect_rabby` | Connect Rabby |
| `/connect_other` | Connect other WalletConnect wallet |
| `/connect_bankr` | Connect Bankr custodial wallet |
| `/disconnect` | Disconnect the current wallet |

## Wallet Management

| Command | Description |
|---------|-------------|
| `/create_wallet` | Generate a new encrypted wallet |
| `/import_wallet` | Import wallet from seed phrase |
| `/recover` | Restore wallet from seed phrase |
| `/export_wallet` | Display wallet mnemonic (requires password) |
| `/wallet_backup` | Export encrypted backup file |

## Safety & Signing

| Command | Description |
|---------|-------------|
| `/mode` | Show current safety/signing mode |
| `/safemode` | Agent confirms before acting (default) |
| `/dangermode` | Agent acts immediately |
| `/readonly` | Read-only mode (no on-chain writes) |
| `/walletsign` | Transactions require phone approval (default) |
| `/autosign` | Auto-sign with private key |

## LLM & Provider

| Command | Description |
|---------|-------------|
| `/llm` | View or switch LLM model (e.g. `/llm sonnet`) |
| `/llm_opus`, `/llm_sonnet`, `/llm_haiku` | Claude model shortcuts |
| `/llm_gpt`, `/llm_codex`, `/llm_gpt_mini`, `/llm_gpt_nano` | GPT model shortcuts |
| `/llm_gemini`, `/llm_gemini_flash` | Gemini model shortcuts |
| `/llm_kimi`, `/llm_qwen` | Kimi K2.5 / Qwen3 Coder |
| `/provider` | View current LLM provider |
| `/provider_anthropic` | Switch to Anthropic API |
| `/provider_bankr` | Switch to Bankr Gateway |
| `/provider_openrouter` | Switch to OpenRouter |
| `/provider_openai` | Switch to OpenAI |
| `/llmcredits` | Bankr LLM credit balance |
| `/llmcost` | Bankr LLM cost tracking |
| `/topup` | Top up LLM credits |
| `/autotopup` | Configure automatic LLM credit top-up |

## Persona & Onboarding

| Command | Description |
|---------|-------------|
| `/professional` | Communication style: business-like |
| `/degen` | Communication style: CT native |
| `/chill` | Communication style: casual |
| `/technical` | Communication style: data-heavy |
| `/mentor` | Communication style: educational |
| `/skip` | Skip onboarding |
| `/all` | Select all capabilities during onboarding |
| `/cap_wallet`, `/cap_prices`, ... | Select individual capabilities (10 total) |

## Plans & Automations

| Command | Description |
|---------|-------------|
| `/plans` | List scheduled plans |
| `/plans_active` | Active plans only |
| `/plans_cancel` | Cancel a plan |
| `/plans_clear` | Cancel all active plans |
| `/automations` | Bankr automation status |

## Forum Topics

Telegram threaded mode — bind topics to personas, safety modes, and tool sets.

| Command | Description |
|---------|-------------|
| `/topics` | List forum topics and their bindings |
| `/topics_setup` | Set up suggested topic structure |
| `/topic_bind` | Bind a topic to a persona/mode (e.g. `/topic_bind 42 trading`) |
| `/topic_unbind` | Remove a topic binding |

## Self-Improvement

| Command | Description |
|---------|-------------|
| `/evolve` | Enable self-improvement mode |
| `/stable` | Disable self-improvement |
| `/evolution` | Show self-improvement mode and stats |

## Infrastructure

| Command | Description |
|---------|-------------|
| `/molten` | Molten agent profile |
| `/flykeys` | Manage Fly.io secrets |
| `/flystatus` | Machine status |
| `/flyrestart` | Restart bot |
| `/factoryreset` | Wipe all data and start over |
