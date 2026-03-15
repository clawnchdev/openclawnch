/**
 * Delegation Types — EIP-7710/7715 on-chain delegation type system.
 *
 * Maps the openclawnch policy engine to the MetaMask Delegation Framework's
 * on-chain caveat enforcers. No external SDK dependency — uses viem directly
 * for ABI encoding and contract interaction.
 *
 * Contract addresses are from MetaMask Delegation Framework v1.3.0,
 * deployed deterministically across all major EVM chains.
 *
 * References:
 *   - EIP-7710: https://eips.ethereum.org/EIPS/eip-7710
 *   - EIP-7715: https://eips.ethereum.org/EIPS/eip-7715
 *   - MetaMask Delegation Framework: https://github.com/MetaMask/delegation-framework
 */

import type { Address, Hex } from 'viem';

// ─── Core Delegation Types (EIP-7710) ───────────────────────────────────

/**
 * A single caveat restricting a delegation.
 * Each caveat references an on-chain enforcer contract and ABI-encoded terms.
 */
export interface Caveat {
  /** Address of the caveat enforcer contract. */
  enforcer: Address;
  /** ABI-encoded terms the enforcer checks. Encoding varies by enforcer. */
  terms: Hex;
  /** Runtime arguments passed during redemption (usually '0x'). */
  args: Hex;
}

/**
 * An unsigned delegation — all fields except the signature.
 * The delegator must sign this to produce a valid Delegation.
 */
export interface UnsignedDelegation {
  /** Who receives the permission (the agent's address). */
  delegate: Address;
  /** Who grants the permission (the user's wallet). */
  delegator: Address;
  /**
   * Parent delegation hash for chained delegations.
   * 0x0...0 for root delegations (granted directly by the account owner).
   */
  authority: Hex;
  /** Restrictions on the delegation. */
  caveats: Caveat[];
  /** Random salt for uniqueness. */
  salt: bigint;
}

/**
 * A fully signed delegation ready for on-chain redemption.
 */
export interface SignedDelegation extends UnsignedDelegation {
  /** The delegator's EIP-712 signature over the delegation. */
  signature: Hex;
}

// ─── Delegation Metadata (stored alongside policies) ────────────────────

export type DelegationStatus = 'unsigned' | 'signed' | 'active' | 'revoked' | 'expired';

/**
 * Metadata stored in the policy's `delegation` field.
 * Links an off-chain policy to its on-chain delegation.
 */
export interface DelegationMetadata {
  /** Chain ID where the delegation is deployed. */
  chainId: number;
  /** Keccak256 hash of the delegation struct. */
  hash: Hex;
  /** DelegationManager contract address on this chain. */
  delegationManager: Address;
  /** Current lifecycle status. */
  status: DelegationStatus;
  /** The delegate address (agent). */
  delegate: Address;
  /** The delegator address (user). */
  delegator: Address;
  /** Salt used for uniqueness. */
  salt: string;
  /** ISO timestamp when the delegation was created. */
  createdAt: string;
  /** ISO timestamp when last status check was performed. */
  lastCheckedAt?: string;
  /** Caveats that couldn't be mapped (app-layer only). */
  unmappedRules?: string[];
}

// ─── Contract Addresses (MetaMask Delegation Framework v1.3.0) ──────────
//
// These are deployed at deterministic addresses via CREATE2 across all
// supported chains. Verified from the official deployments registry.

export const DELEGATION_CONTRACTS = {
  /** Core delegation manager — handles creation, redemption, revocation. */
  DelegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3' as Address,

  // ── Caveat Enforcers ─────────────────────────────────────────────────

  /** Limits total ERC-20 transfer amount. Terms: (address token, uint256 amount) */
  ERC20TransferAmountEnforcer: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc' as Address,

  /** Limits ERC-20 transfers per time period. Terms: (address token, uint256 allowance, uint256 startTime, uint256 period) */
  ERC20PeriodTransferEnforcer: '0x474e3Ae7E169e940607cC624Da8A15Eb120139aB' as Address,

  /** Limits total number of calls. Terms: (uint256 count) */
  LimitedCallsEnforcer: '0x04658B29F6b82ed55274221a06Fc97D318E25416' as Address,

  /** Restricts which contract addresses can be called. Terms: (address[]) */
  AllowedTargetsEnforcer: '0x7F20f61b1f09b08D970938F6fa563634d65c4EeB' as Address,

  /** Restricts which function selectors can be called. Terms: (bytes4[]) */
  AllowedMethodsEnforcer: '0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5' as Address,

  /** Enforces time bounds on delegation. Terms: (uint128 executeAfter, uint128 executeBefore) */
  TimestampEnforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069' as Address,

  /** Limits total native token (ETH) transfer amount. Terms: (uint256 amount) */
  NativeTokenTransferAmountEnforcer: '0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320' as Address,

  /** Limits native token transfers per time period. Terms: (uint256 allowance, uint256 startTime, uint256 period) */
  NativeTokenPeriodTransferEnforcer: '0x9BC0FAf4Aca5AE429F4c06aEEaC517520CB16BD9' as Address,

  /** Limits msg.value to be <= encoded amount. Terms: (uint256 maxValue) */
  ValueLteEnforcer: '0x92Bf12322527cAA612fd31a0e810472BBB106A8F' as Address,

  /** Requires a specific nonce for single-use delegations. Terms: (uint256 nonce) */
  NonceEnforcer: '0xDE4f2FAC4B3D87A1d9953Ca5FC09FCa7F366254f' as Address,
} as const;

// ─── Supported Chains ───────────────────────────────────────────────────
//
// The delegation framework contracts are deployed on these chains.
// The addresses are the same on all chains (CREATE2 deterministic deployment).

export const SUPPORTED_CHAIN_IDS = new Set([
  1,        // Ethereum Mainnet
  8453,     // Base
  42161,    // Arbitrum One
  10,       // Optimism
  137,      // Polygon
  59144,    // Linea
  11155111, // Sepolia (testnet)
  84532,    // Base Sepolia (testnet)
]);

export const CHAIN_NAMES: Record<number, string> = {
  1:        'Ethereum',
  8453:     'Base',
  42161:    'Arbitrum',
  10:       'Optimism',
  137:      'Polygon',
  59144:    'Linea',
  11155111: 'Sepolia',
  84532:    'Base Sepolia',
};

// ─── EIP-712 Type Definitions ───────────────────────────────────────────
//
// Used for signing delegations. The delegator signs an EIP-712 typed
// message containing the delegation struct.

export const DELEGATION_EIP712_TYPES = {
  Delegation: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
    { name: 'args', type: 'bytes' },
  ],
} as const;

/**
 * Build the EIP-712 domain for a DelegationManager on a specific chain.
 */
export function getDelegationDomain(chainId: number) {
  return {
    name: 'DelegationManager',
    version: '1',
    chainId,
    verifyingContract: DELEGATION_CONTRACTS.DelegationManager,
  } as const;
}

// ─── Execution Modes (ERC-7579) ─────────────────────────────────────────
//
// DelegationManager.redeemDelegations uses ERC-7579 execution modes.
// Mode is a bytes32 encoding: callType (1 byte) + execType (1 byte) + unused (4) + modeSelector (4) + modePayload (22).
// For single calls with default execution: 0x00...00.

/**
 * Default single-call execution mode.
 * callType=0x00 (single), execType=0x00 (default), rest zeros.
 */
export const EXECUTE_MODE_DEFAULT = ('0x' + '0'.repeat(64)) as Hex;

/**
 * Encode a single execution as callData for redeemDelegations.
 * ERC-7579 single execution: abi.encodePacked(target, value, callData).
 * But DelegationManager expects: abi.encode(target, value, callData) as the
 * executionCallData parameter.
 */
export interface ExecutionAction {
  /** Target contract address. */
  target: Address;
  /** Value in wei to send with the call. */
  value: bigint;
  /** Encoded function calldata (e.g., from encodeFunctionData). */
  callData: Hex;
}

// ─── Caveat Enforcer Mapping ────────────────────────────────────────────
//
// Maps PolicyRule types to their on-chain caveat enforcers.
// Each mapping specifies the enforcer address and how to encode the terms.
//
// Rules without a direct on-chain mapping are flagged as 'app_layer_only'.

export type CaveatMappingResult =
  | { type: 'mapped'; caveats: Caveat[] }
  | { type: 'app_layer_only'; reason: string };

/**
 * Well-known period durations in seconds, for on-chain period enforcers.
 */
export const PERIOD_SECONDS: Record<string, number> = {
  hourly:  3600,
  daily:   86400,
  weekly:  604800,
  monthly: 2592000,  // 30 days
};

// ─── DelegationManager ABI (minimal) ────────────────────────────────────
//
// Only the functions we need for delegation lifecycle management.

export const DELEGATION_MANAGER_ABI = [
  {
    name: 'redeemDelegations',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_permissionContexts', type: 'bytes[]' },
      { name: '_modes', type: 'bytes32[]' },
      { name: '_executionCallData', type: 'bytes[]' },
    ],
    outputs: [],
  },
  {
    name: 'disableDelegation',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: '_delegation',
        type: 'tuple',
        components: [
          { name: 'delegate', type: 'address' },
          { name: 'delegator', type: 'address' },
          { name: 'authority', type: 'bytes32' },
          {
            name: 'caveats',
            type: 'tuple[]',
            components: [
              { name: 'enforcer', type: 'address' },
              { name: 'terms', type: 'bytes' },
              { name: 'args', type: 'bytes' },
            ],
          },
          { name: 'salt', type: 'uint256' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: 'getDelegationHash',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      {
        name: '_delegation',
        type: 'tuple',
        components: [
          { name: 'delegate', type: 'address' },
          { name: 'delegator', type: 'address' },
          { name: 'authority', type: 'bytes32' },
          {
            name: 'caveats',
            type: 'tuple[]',
            components: [
              { name: 'enforcer', type: 'address' },
              { name: 'terms', type: 'bytes' },
              { name: 'args', type: 'bytes' },
            ],
          },
          { name: 'salt', type: 'uint256' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    name: 'disabledDelegations',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '_delegationHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// ─── Enforcer ABIs (for on-chain state reads) ──────────────────────────
//
// Period-based enforcers track cumulative spending on-chain via a
// `spentMap` mapping: (address delegationManager, bytes32 delegationHash) → SpentInfo.
// We read this to compare on-chain usage against local tracking.

/** ABI for NativeTokenPeriodTransferEnforcer.spentMap (read cumulative ETH usage). */
export const NATIVE_PERIOD_ENFORCER_ABI = [
  {
    name: 'spentMap',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: '_delegationManager', type: 'address' },
      { name: '_delegationHash', type: 'bytes32' },
    ],
    outputs: [
      { name: 'spent', type: 'uint256' },
      { name: 'lastUpdated', type: 'uint256' },
    ],
  },
] as const;

/** ABI for ERC20PeriodTransferEnforcer.spentMap (read cumulative ERC-20 usage). */
export const ERC20_PERIOD_ENFORCER_ABI = [
  {
    name: 'spentMap',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: '_delegationManager', type: 'address' },
      { name: '_delegationHash', type: 'bytes32' },
    ],
    outputs: [
      { name: 'spent', type: 'uint256' },
      { name: 'lastUpdated', type: 'uint256' },
    ],
  },
] as const;

/** ABI for LimitedCallsEnforcer.callCounts (read cumulative call count). */
export const LIMITED_CALLS_ENFORCER_ABI = [
  {
    name: 'callCounts',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: '_delegationManager', type: 'address' },
      { name: '_delegationHash', type: 'bytes32' },
    ],
    outputs: [
      { name: '', type: 'uint256' },
    ],
  },
] as const;
