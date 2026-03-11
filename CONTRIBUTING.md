# Contributing to OpenClawnch

## Development Setup

```bash
# Clone the repository
git clone https://github.com/clawnch/openclawnch.git
cd openclawnch

# Install dependencies
pnpm install

# Run type checking
pnpm typecheck

# Run tests
pnpm test

# Build
pnpm build
```

## Requirements

- Node.js >= 22.12.0
- pnpm 9+

## Project Structure

```
openclawnch/
  src/                    # Root wrapper package
  extensions/crypto/      # Crypto extension
    src/
      tools/              # Tool implementations
      services/           # Service layer (RPC, wallet, APIs)
      commands/            # Slash commands
      lib/                # Shared utilities
    skills/               # Skill docs (LLM instructions)
  tests/                  # Test suite (vitest)
  deploy/                 # Deployment configs
```

## Adding a New Tool

1. Create `extensions/crypto/src/tools/your-tool.ts` following the existing pattern
2. Export a `createYourTool()` factory function
3. Register in `extensions/crypto/index.ts` via `registerToolWithReadonlyGate()`
4. If the tool writes to chain, add its name to `WRITE_TOOL_NAMES`
5. Update test assertions for the new tool count
6. Run `pnpm typecheck && pnpm test`

## Adding a New Service

1. Create `extensions/crypto/src/services/your-service.ts`
2. Use the singleton pattern (`getInstance` / `resetInstance`)
3. Register any API keys in `credential-vault.ts`
4. Add API domains to `endpoint-allowlist.ts`

## Testing

All changes must pass the full test suite:

```bash
pnpm typecheck   # TypeScript type checking
pnpm test         # 900+ tests via vitest
```

Test files live in `tests/` and follow the naming pattern `*.test.ts`.

## Pull Requests

1. Fork the repo and create a feature branch
2. Make your changes
3. Ensure `pnpm typecheck && pnpm test` passes
4. Submit a PR with a clear description of changes
5. Wait for CI checks to pass

## Code Style

- TypeScript strict mode
- ESM imports (`.js` extensions required)
- snake_case for tool names and actions
- camelCase for TypeScript identifiers
- Minimal dependencies (prefer viem, node:crypto, existing packages)

## Security

- Never commit API keys, private keys, or secrets
- Use the credential vault for all secret access
- Add new API domains to the endpoint allowlist
- Report security issues privately (do not open public issues)
