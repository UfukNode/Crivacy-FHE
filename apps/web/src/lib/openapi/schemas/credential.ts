/**
 * KYC credential schemas.
 *
 * A credential is an on-chain attestation that a specific `userRef` passed
 * a given `level` of verification, stored in the `CrivacyKYC` contract on
 * Sepolia. Firms holding a key with `kyc:verify` scope, or the on-chain
 * pointer (`userAddress` + `kycContract`), can read the credential straight
 * from the contract with their own viem client without round-tripping
 * through Crivacy's API.
 */

import { DateTimeIso, SafeCount, UserRef } from '../common/primitives';
import { z } from '../registry';
import { CredentialStatus, KycLevel, NetworkName, ValidatorType } from './enums';
import { CredentialContractId, EvmAddress, FirmId } from './identifiers';

export const CredentialProofHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: 'Must be 64 hex chars (SHA-256).' })
  .openapi('CredentialProofHash', {
    description: 'SHA-256 of the underlying Didit decision payload, hex-encoded.',
    example: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  });
export type CredentialProofHash = z.infer<typeof CredentialProofHash>;

export const CredentialSummary = z
  .object({
    contractId: CredentialContractId,
    firmId: FirmId,
    userRef: UserRef,
    status: CredentialStatus,
    level: KycLevel,
    validUntil: DateTimeIso.nullable(),
    identityVerified: z.boolean(),
    livenessVerified: z.boolean(),
    addressVerified: z.boolean(),
    network: NetworkName,
    updatedAt: DateTimeIso,
  })
  .openapi('CredentialSummary', {
    description:
      'Compact credential view. Structurally identical to `CredentialSummary` in `@crivacy/shared-types`.',
  });
export type CredentialSummary = z.infer<typeof CredentialSummary>;

export const CredentialDetail = CredentialSummary.extend({
  proofHash: CredentialProofHash,
  validator: ValidatorType,
  operatorAddress: EvmAddress.openapi({
    description: 'The operator EVM address that wrote (and pays gas for) this credential.',
  }),
  userAddress: EvmAddress.openapi({
    description: "The subject's EVM address — the key of the credential in the `CrivacyKYC` contract.",
  }),
  kycContract: EvmAddress.openapi({
    description: 'The `CrivacyKYC` registry contract address on Sepolia.',
  }),
  humanScore: z.number().int().min(0).max(100).openapi({
    description:
      'Didit-derived human verification score (0–100). 100 is the top-confidence decision. Decrypted from the on-chain ciphertext handle for keys that hold access.',
    example: 96,
  }),
  issuedAt: DateTimeIso,
  revokedAt: DateTimeIso.nullable(),
  revocationReason: z.string().max(256).nullable(),
}).openapi('CredentialDetail', {
  description: 'Full credential, including the on-chain pointer and validator metadata.',
});
export type CredentialDetail = z.infer<typeof CredentialDetail>;

export const CredentialVerifyRequest = z
  .object({
    userAddress: EvmAddress.openapi({
      description: "The subject's EVM address — the credential key in the `CrivacyKYC` contract.",
    }),
    contract: EvmAddress.optional().openapi({
      description: 'The `CrivacyKYC` contract address. Defaults to the current deployment.',
    }),
    expectedUserRef: UserRef.optional().openapi({
      description: 'If present, the verify step fails unless the credential matches this userRef.',
    }),
    expectedLevel: KycLevel.optional().openapi({
      description: 'If present, the verify step fails unless the credential matches this level.',
    }),
    expectedNetwork: NetworkName.optional(),
  })
  .openapi('CredentialVerifyRequest', {
    description: 'Payload for `POST /api/v1/credentials/verify`.',
  });
export type CredentialVerifyRequest = z.infer<typeof CredentialVerifyRequest>;

export const CredentialVerifyResponse = z
  .object({
    valid: z.boolean(),
    reason: z.string().nullable().openapi({
      description:
        'Populated on `valid: false` with a short machine-friendly failure reason (e.g. `revoked`, `expired`, `userRef_mismatch`).',
    }),
    credential: CredentialSummary.nullable(),
    verifiedAt: DateTimeIso,
  })
  .openapi('CredentialVerifyResponse', {
    description: 'Result of `POST /api/v1/credentials/verify`.',
  });
export type CredentialVerifyResponse = z.infer<typeof CredentialVerifyResponse>;

export const CredentialHistoryEntry = z
  .object({
    at: DateTimeIso,
    action: z.enum(['created', 'verified', 'observer_added', 'revoked', 'expired', 'migrated']),
    actor: z.string().min(1).max(256).openapi({
      description:
        'Label describing the actor responsible for the event. `operator` for Crivacy-triggered actions, `chain` for chain-level expirations, a firm slug for firm-initiated revocations.',
    }),
    transactionId: z.string().min(1).max(256).nullable().openapi({
      description: 'Sepolia transaction hash backing the event, when available.',
    }),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('CredentialHistoryEntry', {
    description: 'Single entry in the credential audit history.',
  });
export type CredentialHistoryEntry = z.infer<typeof CredentialHistoryEntry>;

export const CredentialHistoryResponse = z
  .object({
    userRef: UserRef,
    entries: z.array(CredentialHistoryEntry),
    total: SafeCount.openapi({ description: 'Total number of entries in the full history.' }),
  })
  .openapi('CredentialHistoryResponse', {
    description: 'Response for `GET /api/v1/credentials/:userRef/history`.',
  });
export type CredentialHistoryResponse = z.infer<typeof CredentialHistoryResponse>;
