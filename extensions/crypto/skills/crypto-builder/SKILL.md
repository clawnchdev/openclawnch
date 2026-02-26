# Crypto Integration Builder

Build custom crypto tools, protocol adapters, and DeFi strategies that plug safely into OpenClawnch.

## When to Use

Use this skill when the user wants to:
- Build a custom tool that interacts with a DeFi protocol
- Create a price feed adapter for a new data source
- Write a strategy tool (DCA, rebalancing, yield farming)
- Add support for a new chain or DEX
- Build a webhook listener for on-chain events

## Architecture Rules

Every generated tool MUST follow these rules. Non-negotiable.

### 1. WalletConnect for All Writes

Any tool that sends a transaction must go through ClawnchConnect. The tool proposes; the user's phone wallet approves.

```typescript
// CORRECT — use ClawnchConnect
import { getWalletState, requireWalletClient } from '../services/walletconnect-service.js';

const wallet = requireWalletClient();
const txHash = await wallet.sendTransaction({
  to: contractAddress,
  data: encodedCalldata,
  value: 0n,
});

// WRONG — never import or use private keys
import { privateKeyToAccount } from 'viem/accounts'; // BANNED
```

### 2. Lazy SDK Imports

Never use top-level imports for SDK packages. They may not be installed.

```typescript
// CORRECT — dynamic import inside function
async function execute(params: Record<string, unknown>) {
  const { SomeClient } = await import('@some/sdk');
  const client = new SomeClient();
}

// WRONG — top-level import blocks tool loading
import { SomeClient } from '@some/sdk'; // fails if not installed
```

### 3. Pre-Flight Safety Checks

Every write operation must validate before execution:

```typescript
import { getSafetyService } from '../services/safety-service.js';

const safety = getSafetyService();
const check = await safety.preFlightCheck({
  operation: 'swap',
  tokenAddress,
  amount,
  walletAddress: state.address,
});

if (!check.safe) {
  return errorResult(`Pre-flight failed: ${check.reason}`);
}
```

### 4. Tool Shape

Every tool must match `AgentTool` from OpenClaw's plugin SDK:

```typescript
import { Type, type Static } from '@sinclair/typebox';
import { jsonResult, textResult, errorResult } from '../lib/tool-helpers.js';

const ToolParams = Type.Object({
  action: Type.String({ description: 'Action to perform' }),
  // ... other parameters
});

export function createMyTool() {
  return {
    name: 'my_tool',
    label: 'My Tool',
    description: 'One-line description of what this tool does',
    ownerOnly: true, // true for write ops, false for read-only
    parameters: ToolParams,

    async execute(
      toolCallId: string,
      params: Static<typeof ToolParams>,
    ) {
      try {
        const action = params.action;
        switch (action) {
          case 'read_something':
            return handleRead(params);
          case 'write_something':
            return handleWrite(params);
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(
          `My tool error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
```

### 5. Result Format

Always use the helper functions. They include the required `details` field.

```typescript
// Success with structured data
return jsonResult({ balance: '1.5', token: 'ETH' });

// Success with text
return textResult('Operation completed successfully.');

// Error
return errorResult('Insufficient balance for this operation.');
```

## Templates

### Read-Only Tool (e.g., query protocol TVL)

```typescript
import { Type, type Static } from '@sinclair/typebox';
import { jsonResult, errorResult } from '../lib/tool-helpers.js';

const Params = Type.Object({
  action: Type.String({ description: 'Action: tvl, apy, positions' }),
  protocol: Type.Optional(Type.String({ description: 'Protocol name' })),
  pool: Type.Optional(Type.String({ description: 'Pool address or ID' })),
});

export function createProtocolInfoTool() {
  return {
    name: 'protocol_info',
    label: 'Protocol Info',
    description: 'Query DeFi protocol data: TVL, APY, positions',
    ownerOnly: false, // read-only = accessible to anyone
    parameters: Params,

    async execute(toolCallId: string, params: Static<typeof Params>) {
      try {
        switch (params.action) {
          case 'tvl': return handleTvl(params);
          case 'apy': return handleApy(params);
          case 'positions': return handlePositions(params);
          default: return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err) {
        return errorResult(`Protocol info error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

async function handleTvl(params: Record<string, unknown>) {
  const resp = await fetch('https://api.llama.fi/v2/protocols');
  const data = (await resp.json()) as any[];
  // ... process and return
  return jsonResult({ tvl: '1.2B', protocol: 'Aave' });
}
```

### Write Tool (e.g., deposit into vault)

```typescript
import { Type, type Static } from '@sinclair/typebox';
import { jsonResult, errorResult } from '../lib/tool-helpers.js';
import { getWalletState, requireWalletClient, requirePublicClient } from '../services/walletconnect-service.js';
import { getSafetyService } from '../services/safety-service.js';

const Params = Type.Object({
  action: Type.String({ description: 'Action: deposit, withdraw, claim, dry_run' }),
  vault: Type.Optional(Type.String({ description: 'Vault address' })),
  amount: Type.Optional(Type.String({ description: 'Amount in human-readable units' })),
  token: Type.Optional(Type.String({ description: 'Token symbol or address' })),
});

export function createVaultTool() {
  return {
    name: 'vault',
    label: 'Vault Manager',
    description: 'Deposit, withdraw, and claim from DeFi vaults',
    ownerOnly: true, // write operations
    parameters: Params,

    async execute(toolCallId: string, params: Static<typeof Params>) {
      try {
        switch (params.action) {
          case 'deposit': return handleDeposit(params);
          case 'withdraw': return handleWithdraw(params);
          case 'claim': return handleClaim(params);
          case 'dry_run': return handleDryRun(params);
          default: return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err) {
        return errorResult(`Vault error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

async function handleDeposit(params: Record<string, unknown>) {
  const state = getWalletState();
  if (!state.address) return errorResult('No wallet connected. Use /connect first.');

  const safety = getSafetyService();
  const check = await safety.preFlightCheck({
    operation: 'vault_deposit',
    amount: params.amount as string,
    walletAddress: state.address,
  });
  if (!check.safe) return errorResult(`Pre-flight failed: ${check.reason}`);

  const wallet = requireWalletClient();
  // ... encode calldata, send transaction via wallet
  // The wallet will prompt the user's phone for approval

  return jsonResult({
    status: 'pending_approval',
    message: 'Check your wallet app to approve the deposit.',
    vault: params.vault,
    amount: params.amount,
  });
}

async function handleDryRun(params: Record<string, unknown>) {
  // Simulate without executing — always safe
  return jsonResult({
    simulation: true,
    wouldDeposit: params.amount,
    estimatedGas: '0.001 ETH',
    estimatedApy: '4.2%',
  });
}
```

### Strategy Tool (e.g., DCA)

```typescript
import { Type, type Static } from '@sinclair/typebox';
import { jsonResult, errorResult } from '../lib/tool-helpers.js';

const Params = Type.Object({
  action: Type.String({ description: 'Action: create, list, cancel, status, dry_run' }),
  strategy: Type.Optional(Type.String({ description: 'Strategy type: dca, rebalance' })),
  token_buy: Type.Optional(Type.String({ description: 'Token to buy' })),
  token_sell: Type.Optional(Type.String({ description: 'Token to sell' })),
  amount_per_period: Type.Optional(Type.String({ description: 'Amount per DCA period' })),
  period: Type.Optional(Type.String({ description: 'Period: hourly, daily, weekly' })),
  max_slippage_bps: Type.Optional(Type.Number({ description: 'Max slippage in basis points (default 100 = 1%)' })),
});

export function createStrategyTool() {
  return {
    name: 'strategy',
    label: 'DeFi Strategy',
    description: 'Create and manage automated DeFi strategies (DCA, rebalancing)',
    ownerOnly: true,
    parameters: Params,

    async execute(toolCallId: string, params: Static<typeof Params>) {
      // Every strategy creation should include a dry_run by default
      // to show the user what would happen before committing
      try {
        switch (params.action) {
          case 'create': return handleCreate(params);
          case 'dry_run': return handleDryRun(params);
          case 'list': return handleList();
          case 'cancel': return handleCancel(params);
          default: return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err) {
        return errorResult(`Strategy error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
```

## Security Checklist

Before registering any custom tool, verify:

- [ ] No `privateKeyToAccount`, `mnemonicToAccount`, or similar imports
- [ ] No hardcoded contract addresses (use env vars or config)
- [ ] All write operations use `requireWalletClient()` (goes through ClawnchConnect)
- [ ] Slippage has a maximum bound (never >5% without explicit user override)
- [ ] Token approvals are bounded (never `type(uint256).max` without user consent)
- [ ] Pre-flight balance check before every transfer/swap/deposit
- [ ] Gas estimation before every write operation
- [ ] `dry_run` action available for simulation
- [ ] Error messages don't leak sensitive data (addresses OK, keys never)
- [ ] All SDK imports are lazy (`await import()`, not top-level)

## Registering Your Tool

Add to `extensions/crypto/index.ts`:

```typescript
import { createMyTool } from './src/tools/my-tool.js';

// In register():
api.registerTool(createMyTool());
```

Then rebuild:
```bash
pnpm build:ext
```

## Testing Pattern

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createMyTool } from '../extensions/crypto/src/tools/my-tool.js';

// Mock SDK at module level
vi.mock('@some/sdk', () => ({
  SomeClient: vi.fn().mockImplementation(() => ({
    getData: vi.fn().mockResolvedValue({ value: '42' }),
  })),
}));

describe('my_tool', () => {
  const tool = createMyTool();

  it('has correct shape', () => {
    expect(tool.name).toBe('my_tool');
    expect(tool.execute).toBeTypeOf('function');
    expect(tool.parameters).toBeDefined();
  });

  it('handles read action', async () => {
    const result = await tool.execute('test', { action: 'read_something' });
    expect(result.content).toBeDefined();
    expect(result.details).toBeDefined();
  });

  it('returns error when no wallet for write action', async () => {
    const result = await tool.execute('test', { action: 'write_something' });
    expect(result.content[0]!.text).toContain('wallet');
  });
});
```
