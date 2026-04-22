/**
 * FHE (Zama FHEVM on Sepolia) runtime configuration — single source of
 * truth for the on-chain layer that replaced chain.
 *
 * Every value is required and read from env. Per the project's
 * no-hardcoded-fallback rule, a missing var THROWS at first use rather
 * than silently defaulting — a half-configured FHE layer must fail loud,
 * not mint credentials against the wrong contract or leak to a public RPC.
 *
 * @module
 */

import type { Address, Hex } from 'viem';

export interface FheConfig {
  /** Sepolia JSON-RPC endpoint the operator writes/reads through. */
  readonly rpcUrl: string;
  /** CrivacyKYC registry contract address. */
  readonly kycAddress: Address;
  /** CrivacyKycNFT soulbound-pass contract address. */
  readonly nftAddress: Address;
  /** Operator (Crivacy issuer / gatekeeper) private key. */
  readonly operatorPrivateKey: Hex;
  /** Zama relayer API key (server-side header auth). */
  readonly relayerApiKey: string;
  /** Human network label surfaced in the credential view (e.g. "sepolia"). */
  readonly networkLabel: string;
  /** EVM chain id (Sepolia = 11155111). */
  readonly chainId: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `[fhe] Missing required env var ${name}. The FHE on-chain layer cannot start ` +
        `without it — set it in the environment (no fallback by design).`,
    );
  }
  return value;
}

function requiredAddress(name: string): Address {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`[fhe] env var ${name} must be a 0x-prefixed 20-byte address, got "${value}".`);
  }
  return value as Address;
}

function requiredHexKey(name: string): Hex {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`[fhe] env var ${name} must be a 0x-prefixed 32-byte private key.`);
  }
  return value as Hex;
}

let cached: FheConfig | null = null;

/**
 * Resolve the FHE config from env once and memoize it. Throws on the
 * first missing/malformed var.
 */
export function getFheConfig(): FheConfig {
  if (cached !== null) return cached;
  cached = {
    rpcUrl: required('SEPOLIA_RPC_URL'),
    kycAddress: requiredAddress('FHE_KYC_ADDRESS'),
    nftAddress: requiredAddress('FHE_NFT_ADDRESS'),
    operatorPrivateKey: requiredHexKey('FHE_OPERATOR_PRIVATE_KEY'),
    // The relayer key is only needed for encrypt (createCredential) and
    // user-decrypt (verify endpoint) — NOT for plain chain reads/writes
    // (fetchCredential, grantAccess, revoke, NFT). Validated lazily in the
    // client's `getSdk()` so read-only paths (reconciler, verify) work without
    // it, and the app boots before a key is provisioned.
    relayerApiKey: process.env['FHE_RELAYER_API_KEY'] ?? '',
    networkLabel: required('FHE_NETWORK_LABEL'),
    chainId: Number.parseInt(required('FHE_CHAIN_ID'), 10),
  };
  return cached;
}

/** Test-only: reset the memoized config. */
export function __resetFheConfigForTests(): void {
  cached = null;
}
