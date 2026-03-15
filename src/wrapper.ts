// test3
/**
 * OpenClawnch — programmatic API
 * 
 * Re-exports the crypto extension for use as a library.
 * The main entry point for `import { ... } from 'openclawnch'`.
 */

export { default as cryptoPlugin } from '../extensions/crypto/index.js';
export type { CryptoPluginConfig } from '../extensions/crypto/src/lib/types.js';

// Re-export SDK types that consumers commonly need
export type {
  SpendingPolicy,
  SessionState,
  TransactionRequest,
  TransactionContext,
  QueuedTransaction,
} from '@clawnch/sdk';
