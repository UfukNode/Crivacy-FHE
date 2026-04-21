/**
 * On-chain credential verification helper (Zama FHEVM / Sepolia).
 *
 * After a successful OAuth flow finishes, the firm holds a set of
 * `CrivacyClaims`. When the `credential` scope was granted, those claims include
 * `fhe_kyc_user_address` (the subject's EVM address — the on-chain key of their
 * `CrivacyKYC` credential) and `fhe_kyc_contract` (the registry address).
 * `verifyDisclosure()` reads the credential's plaintext lifecycle straight from
 * the chain with the firm's own viem client — so the firm trusts the chain, not
 * Crivacy's claim set, for the credential's authenticity.
 *
 * What is trustless here (no decryption, no Crivacy API):
 *   * `status` / `isActive` / `validUntil` are public on-chain fields. The firm
 *     reads them directly and gates access on `isActive === true`.
 *   * `userRefHash` = keccak256 of the firm's user id bound at mint time; the
 *     firm confirms the binding by recomputing the hash.
 *
 * The sensitive fields (level, humanScore, the verification flags, the
 * eligibility verdict) stay encrypted as ciphertext handles. A firm that Crivacy
 * granted per-firm ACL access can decrypt the `eligible` handle with the Zama
 * SDK; everyone else sees only ciphertext.
 *
 * @module
 */

import { createPublicClient, http, type Address, type PublicClient } from 'viem';

import { CrivacyOauthError } from './errors';
import type { CrivacyClaims } from './types';

const CRIVACY_KYC_VERIFY_ABI = [
  {
    type: 'function',
    name: 'verify',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'userRefHash', type: 'bytes32' },
          { name: 'proofHash', type: 'bytes32' },
          { name: 'status', type: 'uint8' },
          { name: 'validator', type: 'uint8' },
          { name: 'validUntil', type: 'uint64' },
          { name: 'issuedAt', type: 'uint64' },
          { name: 'isActive', type: 'bool' },
          { name: 'level', type: 'bytes32' },
          { name: 'humanScore', type: 'bytes32' },
          { name: 'identityVerified', type: 'bytes32' },
          { name: 'livenessVerified', type: 'bytes32' },
          { name: 'addressVerified', type: 'bytes32' },
          { name: 'sanctioned', type: 'bytes32' },
          { name: 'eligible', type: 'bytes32' },
        ],
      },
    ],
  },
] as const;

const STATUS = ['none', 'active', 'revoked', 'expired'] as const;
const VALIDATOR = ['didit', 'chain', 'zk'] as const;

/**
 * The plaintext lifecycle of a credential read from chain, plus the encrypted
 * ciphertext handles for optional decryption by an ACL-granted firm.
 */
export interface FheCredentialView {
  readonly userRefHash: string;
  readonly proofHash: string;
  readonly status: (typeof STATUS)[number];
  readonly validator: (typeof VALIDATOR)[number];
  readonly validUntil: Date;
  readonly issuedAt: Date;
  readonly isActive: boolean;
  /** Encrypted handles — decrypt `eligible` with the Zama SDK if ACL-granted. */
  readonly handles: {
    readonly level: string;
    readonly humanScore: string;
    readonly identityVerified: string;
    readonly livenessVerified: string;
    readonly addressVerified: string;
    readonly sanctioned: string;
    readonly eligible: string;
  };
}

/**
 * Options accepted by {@link verifyDisclosure}.
 */
export interface VerifyDisclosureOptions {
  /** The firm's own viem public client, pointed at Sepolia. */
  readonly publicClient?: PublicClient | undefined;
  /** Or an RPC URL to build a client from when `publicClient` is omitted. */
  readonly rpcUrl?: string | undefined;
  /** Override the CrivacyKYC registry address (else read from claims). */
  readonly kycAddress?: Address | undefined;
}

/**
 * Verify the credential Crivacy delivered via OAuth userinfo by reading it from
 * the CrivacyKYC contract on Sepolia. Returns the plaintext {@link FheCredentialView}.
 *
 * Throws {@link CrivacyOauthError} with `code='disclosure_user_missing'` or
 * `'disclosure_contract_missing'` when the claims don't carry the on-chain
 * pointer (typically because `credential` was not in the consent scope, or the
 * user's credential is revoked).
 *
 * @example
 * ```ts
 * import { CrivacyClient, verifyDisclosure } from '@crivacy/js-sdk';
 * import { createPublicClient, http } from 'viem';
 * import { sepolia } from 'viem/chains';
 *
 * const claims = await crivacy.userinfo(accessToken);
 * const view = await verifyDisclosure(claims, {
 *   publicClient: createPublicClient({ chain: sepolia, transport: http() }),
 * });
 * if (!view.isActive) throw new Error('Credential not active on chain');
 * ```
 */
export async function verifyDisclosure(
  claims: CrivacyClaims,
  opts: VerifyDisclosureOptions = {},
): Promise<FheCredentialView> {
  const userAddress = claims.fhe_kyc_user_address;
  if (typeof userAddress !== 'string' || userAddress.length === 0) {
    throw new CrivacyOauthError(
      'disclosure_user_missing',
      'Userinfo response is missing `fhe_kyc_user_address`. Request the `credential` scope on authorize so Crivacy ships the on-chain credential pointer.',
    );
  }

  const kycAddress = (opts.kycAddress ?? claims.fhe_kyc_contract) as Address | undefined;
  if (typeof kycAddress !== 'string' || kycAddress.length === 0) {
    throw new CrivacyOauthError(
      'disclosure_contract_missing',
      'No CrivacyKYC contract address available. Pass `opts.kycAddress` or ensure `claims.fhe_kyc_contract` is present.',
    );
  }

  const client =
    opts.publicClient ?? createPublicClient({ transport: http(opts.rpcUrl) });

  const view = await client.readContract({
    address: kycAddress,
    abi: CRIVACY_KYC_VERIFY_ABI,
    functionName: 'verify',
    args: [userAddress as Address],
  });

  return {
    userRefHash: view.userRefHash,
    proofHash: view.proofHash,
    status: STATUS[view.status] ?? 'none',
    validator: VALIDATOR[view.validator] ?? 'didit',
    validUntil: new Date(Number(view.validUntil) * 1000),
    issuedAt: new Date(Number(view.issuedAt) * 1000),
    isActive: view.isActive,
    handles: {
      level: view.level,
      humanScore: view.humanScore,
      identityVerified: view.identityVerified,
      livenessVerified: view.livenessVerified,
      addressVerified: view.addressVerified,
      sanctioned: view.sanctioned,
      eligible: view.eligible,
    },
  };
}
