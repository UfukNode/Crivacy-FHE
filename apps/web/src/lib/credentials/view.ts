/**
 * Canonical credential view + format adapters.
 *
 * Single source of truth for the "credential snapshot" that flows out
 * to firms. Every wire format — OAuth userinfo claims, REST GET, all
 * `credential.*` webhook event payloads, and the post-mint
 * `kyc.session.approved` event — derives from {@link CredentialView}
 * via the adapters in this module. Inline payload literals living in
 * worker / handler files are forbidden after Sprint 5; CI sweep
 * verifies no caller bypasses the view.
 *
 * ## Why
 *
 * Pre-Sprint-5 we had five-plus copies of "what fields describe a
 * credential" scattered across:
 *
 *   1. `lib/oauth/claims.ts` — OIDC snake_case (`crivacy_*`).
 *   2. `server/jobs/credential-pipeline-worker.ts` — `credential.created`
 *      / `credential.verified` / `credential.upgraded` payloads.
 *   3. `server/handlers/didit-webhook.ts` — B2B `kyc.session.approved`
 *      / `.rejected` payloads (and the `kyc.session.kyc_expired`
 *      handler).
 *   4. `server/handlers/credentials.ts` — REST GET detail + summary.
 *   5. `lib/fraud/ban.ts` — `credential.revoked` payload.
 *   6. `server/jobs/credential-expire-worker.ts` — `credential.expired`
 *      payload.
 *
 * Each carried a different subset of fields, so a B2B firm receiving
 * `kyc.session.approved` saw `{sessionId, userRef, level, workflow,
 * approvedAt}` — five fields, no blob, no proof hash, no contract id —
 * while a customer-flow firm receiving `credential.created` saw eight
 * fields including the contract id but still no blob; meanwhile OAuth
 * userinfo callers got the blob inline. Same verification event,
 * three wildly different payloads.
 *
 * Now: one view, three format adapters, one decision per format.
 *
 * ## Naming convention
 *
 * Two output naming styles, both sector-standard, never mixed:
 *
 *   * **OIDC** ({@link toOauthClaims}) — snake_case with `crivacy_*`
 *     prefix on non-standard claims. Mandated by RFC 6749 / OpenID
 *     Connect; firm-side OIDC libraries assume this shape.
 *   * **REST + webhook** ({@link toWebhookPayload},
 *     {@link toRestDetail}, {@link toRestSummary}) — camelCase, no
 *     prefix. Matches every other Crivacy REST/webhook surface.
 *
 * The view itself uses neutral camelCase field names; adapters
 * translate to whichever convention the consumer expects.
 *
 * @module
 */

import type { OauthScopeId } from '@/lib/oauth/scopes-catalog';
import type { KycCredentialMeta } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Canonical view
// ---------------------------------------------------------------------------

/**
 * The single source-of-truth shape of a Crivacy credential. Every wire
 * format adapter in this module reads from this; no field appears
 * outside that isn't here.
 *
 * Field choice rationale:
 *   * Names are neutral camelCase (no `chain*` prefix). The adapter
 *     that emits to a given wire format renames as needed
 *     (`network` → `chainNetwork` for legacy webhook fields,
 *     `credential_network` for OIDC, `network` for REST).
 *   * `disclosureBlob` is the raw bytes (`Uint8Array | null`); each
 *     adapter that needs to ship it on the wire base64url-encodes at
 *     the seam.
 *   * Lifecycle fields (`revokedAt`, `revokedReason`, `expiredAt`,
 *     `confirmedAt`) are present here so a single adapter call
 *     captures the credential's full state at the moment of the
 *     emit; callers append event-specific extras
 *     (`reason` / `verifiedAt` / `previousLevel`) at their site.
 */
export interface CredentialView {
  readonly id: string;
  readonly firmId: string;
  readonly userRef: string;
  readonly contractId: string | null;
  readonly level: 'basic' | 'enhanced';
  readonly status: 'pending' | 'active' | 'revoked' | 'expired' | 'superseded';
  readonly identityVerified: boolean;
  readonly livenessVerified: boolean;
  readonly addressVerified: boolean;
  readonly humanScore: number;
  readonly proofHash: string;
  readonly validator: 'didit' | 'chain' | 'zk';
  readonly network: string;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly confirmedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly expiredAt: Date | null;
  readonly disclosureBlob: Uint8Array | null;
  readonly operatorParty: string;
  readonly userParty: string;
  readonly templateId: string;
  readonly updatedAt: Date;
}

/**
 * Session-only view for events that fire before a credential exists
 * (`kyc.session.created`) or for sessions that expire without ever
 * minting (`kyc.session.kyc_expired`). Distinct from
 * {@link CredentialView} because these moments genuinely have no
 * credential to project.
 */
export interface KycSessionView {
  readonly sessionId: string;
  readonly userRef: string;
  readonly workflow: 'identity' | 'address';
  readonly level: 'basic' | 'enhanced';
  readonly verificationUrl: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Row → view
// ---------------------------------------------------------------------------

/**
 * Project a `kyc_credentials_meta` row into the canonical view.
 *
 * The DB carries `identity_verified`/`liveness_verified`/`address_verified`
 * as integers (0/1) for byte-packed chain callers; this projection
 * normalises them to booleans so every consumer reads them the same way.
 * The `chainNetwork`/`chainContractId`/`chainTemplateId` columns
 * are renamed to `network`/`contractId`/`templateId` so the view stays
 * adapter-agnostic.
 */
export function fromKycCredentialMetaRow(row: KycCredentialMeta): CredentialView {
  return {
    id: row.id,
    firmId: row.firmId,
    userRef: row.userRef,
    contractId: row.chainContractId,
    level: row.level,
    status: row.status,
    identityVerified: row.identityVerified > 0,
    livenessVerified: row.livenessVerified > 0,
    addressVerified: row.addressVerified > 0,
    humanScore: row.humanScore,
    proofHash: row.proofHash,
    validator: row.validator,
    network: row.chainNetwork,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    confirmedAt: row.confirmedAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    expiredAt: row.expiredAt,
    disclosureBlob: row.disclosureBlobCache,
    operatorParty: row.operatorParty,
    userParty: row.userParty,
    templateId: row.chainTemplateId,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Adapter: OIDC userinfo / id_token claims
// ---------------------------------------------------------------------------

/**
 * Output shape for OIDC token surfaces. Non-standard claims are
 * `crivacy_*`-prefixed so they cannot collide with future OIDC
 * standard claims. Every field is optional because the adapter only
 * emits a key when the matching scope is in the consent — "absent"
 * and "null" mean different things on the wire to a strict OIDC
 * client.
 */
export interface OauthClaimSet {
  readonly sub?: string;
  readonly identity_verified?: boolean;
  readonly liveness_verified?: boolean;
  readonly address_verified?: boolean;
  readonly humanity_score?: number;
  readonly credential_proof_hash?: string;
  readonly credential_level?: 'basic' | 'enhanced';
  readonly credential_valid_until?: string;
  readonly credential_network?: string;
  readonly credential_contract_id?: string | null;
  readonly credential_credential_blob?: string;
  /** The subject's EVM address — on-chain key of their CrivacyKYC credential. */
  readonly fhe_kyc_user_address?: string;
  /** The CrivacyKYC registry contract address on Sepolia. */
  readonly fhe_kyc_contract?: string;
}

export interface OauthClaimInput {
  readonly userId: string;
  /** NULL when the user has no active credential. */
  readonly view: CredentialView | null;
  readonly scopes: readonly OauthScopeId[];
}

/**
 * Build the OIDC claim set for `id_token` + `/oauth/userinfo`.
 *
 * Wire-format invariants pinned by `tests/oauth/claims.test.ts`:
 *   * `sub` only when `openid` is in scope.
 *   * `identity_verified` + `liveness_verified` only when `kyc`.
 *   * `address_verified` only when `kyc:address`.
 *   * `humanity_score` only when `kyc:scores`.
 *   * `credential_proof_hash` / `_level` / `_valid_until` / `_network` /
 *     `_contract_id` only when `credential`.
 *   * `credential_credential_blob` only when `credential` AND the cached
 *     blob is present (callers fall back to REST when absent).
 *   * `credential_contract_id` is `null` (literal) when the row has no
 *     contract id yet, so firms can distinguish "still minting" from
 *     "no claim asked for".
 *
 * Empty scope set → empty claim set; defence in depth — the
 * authorize endpoint should reject empty scope upstream, but this
 * function never produces stray claims regardless.
 */
export function toOauthClaims(input: OauthClaimInput): OauthClaimSet {
  const out: Record<string, unknown> = {};
  const scopeSet = new Set<OauthScopeId>(input.scopes);

  if (scopeSet.has('openid')) {
    out['sub'] = input.userId;
  }

  if (input.view !== null) {
    if (scopeSet.has('kyc')) {
      out['identity_verified'] = input.view.identityVerified;
      out['liveness_verified'] = input.view.livenessVerified;
    }
    if (scopeSet.has('kyc:address')) {
      out['address_verified'] = input.view.addressVerified;
    }
    if (scopeSet.has('kyc:scores')) {
      out['humanity_score'] = input.view.humanScore;
    }
    if (scopeSet.has('credential')) {
      out['credential_proof_hash'] = input.view.proofHash;
      out['credential_level'] = input.view.level;
      out['credential_valid_until'] = input.view.validUntil.toISOString();
      out['credential_network'] = input.view.network;
      out['credential_contract_id'] = input.view.contractId;
      if (input.view.disclosureBlob !== null && input.view.disclosureBlob !== undefined) {
        out['credential_credential_blob'] = Buffer.from(
          input.view.disclosureBlob,
        ).toString('base64url');
      }
      // FHE pointers: the firm reads the credential straight from the
      // CrivacyKYC contract on Sepolia with these (see `@crivacy/js-sdk`
      // `verifyDisclosure`). `userParty` is the subject's EVM address.
      out['fhe_kyc_user_address'] = input.view.userParty;
      const fheContract = process.env['FHE_KYC_ADDRESS'];
      if (fheContract !== undefined && fheContract.length > 0) {
        out['fhe_kyc_contract'] = fheContract;
      }
    }
  }

  return out as OauthClaimSet;
}

// ---------------------------------------------------------------------------
// Adapter: REST + webhook payload (camelCase)
// ---------------------------------------------------------------------------

/**
 * camelCase wire shape used by both REST GET responses and webhook
 * event payloads. Includes the disclosure blob inline (base64url) when
 * present so a firm receiving the webhook can verify on-chain
 * immediately without a follow-up REST round-trip.
 *
 * Lifecycle event sites (`credential.revoked`, `credential.upgraded`,
 * etc.) take this output and spread their event-specific extras on
 * top — they do not redefine the credential snapshot.
 */
export interface CredentialWebhookPayload {
  readonly credentialId: string;
  readonly contractId: string | null;
  readonly userRef: string;
  readonly level: 'basic' | 'enhanced';
  readonly status: 'pending' | 'active' | 'revoked' | 'expired' | 'superseded';
  readonly identityVerified: boolean;
  readonly livenessVerified: boolean;
  readonly addressVerified: boolean;
  readonly humanScore: number;
  readonly proofHash: string;
  readonly validator: 'didit' | 'chain' | 'zk';
  readonly network: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly confirmedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly expiredAt: string | null;
  readonly disclosureBlob: string | null;
  readonly updatedAt: string;
}

export function toWebhookPayload(view: CredentialView): CredentialWebhookPayload {
  return {
    credentialId: view.id,
    contractId: view.contractId,
    userRef: view.userRef,
    level: view.level,
    status: view.status,
    identityVerified: view.identityVerified,
    livenessVerified: view.livenessVerified,
    addressVerified: view.addressVerified,
    humanScore: view.humanScore,
    proofHash: view.proofHash,
    validator: view.validator,
    network: view.network,
    validFrom: view.validFrom.toISOString(),
    validUntil: view.validUntil.toISOString(),
    confirmedAt: view.confirmedAt !== null ? view.confirmedAt.toISOString() : null,
    revokedAt: view.revokedAt !== null ? view.revokedAt.toISOString() : null,
    revokedReason: view.revokedReason,
    expiredAt: view.expiredAt !== null ? view.expiredAt.toISOString() : null,
    disclosureBlob:
      view.disclosureBlob !== null && view.disclosureBlob !== undefined
        ? Buffer.from(view.disclosureBlob).toString('base64url')
        : null,
    updatedAt: view.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Adapter: REST GET shapes (detail + summary)
// ---------------------------------------------------------------------------

/**
 * Map the internal validator enum to the API-surface PascalCase form.
 * Lives here (not duplicated in handlers) because the same mapping
 * applies to every REST surface.
 */
function mapValidatorToApi(validator: CredentialView['validator']): string {
  switch (validator) {
    case 'didit':
      return 'DiditValidator';
    case 'chain':
      return 'ChainValidator';
    case 'zk':
      return 'ZKValidator';
    default:
      return validator;
  }
}

/**
 * REST `GET /api/v1/credentials/:userRef` summary — used both as a
 * standalone response shape and as the `credential` field on
 * `/credentials/verify` responses. Matches the pre-Sprint-5
 * `credentialToSummary` shape byte-for-byte; renamed
 * `chainContractId`→`contractId`, `chainNetwork`→`network` were
 * already in the legacy shape.
 *
 * Disclosure blob is intentionally omitted from the summary — the
 * detail surface ships it; the summary is for list / digest contexts.
 */
export interface CredentialRestSummary {
  readonly contractId: string;
  readonly firmId: string;
  readonly userRef: string;
  readonly status: CredentialView['status'];
  readonly level: CredentialView['level'];
  readonly validUntil: string;
  readonly identityVerified: boolean;
  readonly livenessVerified: boolean;
  readonly addressVerified: boolean;
  readonly network: string;
  readonly updatedAt: string;
}

export function toRestSummary(view: CredentialView): CredentialRestSummary {
  return {
    contractId: view.contractId ?? '',
    firmId: view.firmId,
    userRef: view.userRef,
    status: view.status,
    level: view.level,
    validUntil: view.validUntil.toISOString(),
    identityVerified: view.identityVerified,
    livenessVerified: view.livenessVerified,
    addressVerified: view.addressVerified,
    network: view.network,
    updatedAt: view.updatedAt.toISOString(),
  };
}

/**
 * REST `GET /api/v1/credentials/:userRef` detail. Adds proof
 * material, validator metadata, the disclosure blob, and lifecycle
 * fields on top of the summary. Matches the pre-Sprint-5
 * `credentialToDetail` shape byte-for-byte.
 */
export interface CredentialRestDetail extends CredentialRestSummary {
  readonly proofHash: string;
  readonly validator: string;
  readonly operatorParty: string;
  readonly templateId: string;
  readonly humanScore: number;
  readonly issuedAt: string;
  readonly disclosureBlob: string;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
}

export function toRestDetail(view: CredentialView): CredentialRestDetail {
  return {
    ...toRestSummary(view),
    proofHash: view.proofHash,
    validator: mapValidatorToApi(view.validator),
    operatorParty: view.operatorParty,
    templateId: view.templateId,
    humanScore: view.humanScore,
    issuedAt: view.validFrom.toISOString(),
    disclosureBlob:
      view.disclosureBlob !== null && view.disclosureBlob !== undefined
        ? Buffer.from(view.disclosureBlob).toString('base64url')
        : '',
    revokedAt: view.revokedAt !== null ? view.revokedAt.toISOString() : null,
    revocationReason: view.revokedReason,
  };
}

// ---------------------------------------------------------------------------
// Adapter: KYC session events (no credential yet)
// ---------------------------------------------------------------------------

/**
 * camelCase webhook payload for session-only lifecycle events
 * (`kyc.session.created`, `kyc.session.kyc_expired`). Distinct from
 * {@link CredentialWebhookPayload} because at these moments no
 * credential exists yet — we only have the session row.
 */
export interface KycSessionWebhookPayload {
  readonly sessionId: string;
  readonly userRef: string;
  readonly workflow: 'identity' | 'address';
  readonly level: 'basic' | 'enhanced';
  readonly verificationUrl: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export function toSessionWebhookPayload(view: KycSessionView): KycSessionWebhookPayload {
  return {
    sessionId: view.sessionId,
    userRef: view.userRef,
    workflow: view.workflow,
    level: view.level,
    verificationUrl: view.verificationUrl,
    expiresAt: view.expiresAt !== null ? view.expiresAt.toISOString() : null,
    createdAt: view.createdAt.toISOString(),
  };
}
