/**
 * @crivacy/shared-types
 *
 * Cross-package TypeScript types that are safe to import from both the web app
 * (runtime) and server code. This package MUST remain runtime-free — no
 * runtime code, no side effects, no dependencies. Only `type` and `interface`
 * declarations plus branded nominal types.
 *
 * Zod schemas live in `apps/web/src/lib/openapi/` and are considered the
 * single source of truth for request/response validation (step 4 of PLAN.md
 * §20). Types in this package are derived from those schemas once they exist.
 * Until then the types here describe the stable public contracts that later
 * steps will implement against.
 */

// ---------- Branded identifiers ----------

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type FirmId = Brand<string, 'FirmId'>;
export type ApiKeyId = Brand<string, 'ApiKeyId'>;
export type ApiKeyPrefix = Brand<string, 'ApiKeyPrefix'>;
export type UserRef = Brand<string, 'UserRef'>;
export type KycSessionId = Brand<string, 'KycSessionId'>;
export type CredentialContractId = Brand<string, 'CredentialContractId'>;
export type WebhookEndpointId = Brand<string, 'WebhookEndpointId'>;
export type WebhookEventId = Brand<string, 'WebhookEventId'>;

// ---------- Enums (string literal unions) ----------

export type ApiKeyMode = 'live' | 'test';

export type ApiKeyScope =
  | 'kyc:create'
  | 'kyc:read'
  | 'kyc:verify'
  | 'webhooks:manage'
  | 'usage:read';

export type FirmTier = 'free' | 'starter' | 'pro' | 'enterprise';

// Crivacy.KYCCredential v0.0.3 collapsed the level vocabulary to
// `basic` (identity + liveness) and `enhanced` (+ proof of address).
// The intermediate `standard` tier was retired in the same release —
// it required address verification (which now lives in `enhanced`)
// but the v0.0.2 on-chain contract never accepted it, so it was a
// latent bug rather than an intentional tier.
export type KycLevel = 'basic' | 'enhanced';

export type KycStatus =
  | 'pending'
  | 'in_progress'
  | 'in_review'
  | 'identity_approved'
  | 'address_in_progress'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'resubmission_pending'
  | 'kyc_expired';

/**
 * `pending` covers the window between the database row being created and the
 * chain MainNet transaction being confirmed. Firms polling the credential
 * endpoint during that window see `pending`; they never see it after the TX
 * commits. All other states represent terminal on-chain facts.
 */
export type CredentialStatus = 'pending' | 'active' | 'revoked' | 'expired' | 'superseded';

export type WebhookEventType =
  | 'credential.created'
  | 'credential.verified'
  | 'credential.revoked'
  | 'credential.expired'
  | 'credential.updated'
  | 'credential.upgraded'
  | 'kyc.session.created'
  | 'kyc.session.approved'
  | 'kyc.session.rejected'
  // Non-default Didit lifecycle events. Firms subscribe so they can:
  //   - `kyc.session.in_review` — surface "compliance is reviewing"
  //     in their UI instead of polling stuck on `in_review`.
  //   - `kyc.session.resubmission_required` — show the redo prompt
  //     and resume CTA on their side.
  //   - `kyc.session.kyc_expired` — drop cached verified state and
  //     prompt the user to re-verify (paired with `credential.revoked`
  //     which is also fired by the revocation pipeline).
  | 'kyc.session.in_review'
  | 'kyc.session.resubmission_required'
  | 'kyc.session.kyc_expired';

export type WebhookDeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'dead_letter';

// ---------- Core entities (shapes used by API contracts) ----------

export interface FirmSummary {
  id: FirmId;
  name: string;
  slug: string;
  tier: FirmTier;
  contactEmail: string;
  createdAt: string; // ISO 8601
}

export interface ApiKeySummary {
  id: ApiKeyId;
  prefix: ApiKeyPrefix;
  name: string;
  mode: ApiKeyMode;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface RateLimitWindow {
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface QuotaWindow {
  period: 'month';
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
}

export interface KycSessionSummary {
  id: KycSessionId;
  firmId: FirmId;
  userRef: UserRef;
  status: KycStatus;
  level: KycLevel;
  createdAt: string;
  completedAt: string | null;
}

export interface CredentialSummary {
  contractId: CredentialContractId;
  firmId: FirmId;
  userRef: UserRef;
  status: CredentialStatus;
  level: KycLevel;
  validUntil: string | null;
  identityVerified: boolean;
  livenessVerified: boolean;
  addressVerified: boolean;
  network: 'mainnet' | 'devnet';
  updatedAt: string;
}

// ---------- Envelope types ----------

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export interface Paginated<T> {
  data: T[];
  pagination: {
    nextCursor: string | null;
    limit: number;
  };
}

export type ApiResponse<T> = T | ApiErrorBody;

// ---------- Fraud ----------

export type FraudReason =
  | 'fraud_document'
  | 'fraud_identity'
  | 'fraud_liveness'
  | 'fraud_combined'
  | 'manual_ban';

// ---------- Notifications ----------

/**
 * All valid notification event types. Security events
 * (`session.new_device`, `password.changed`) are always delivered
 * regardless of user preferences; the preference system only controls
 * the non-security types listed here.
 */
export type NotificationType =
  | 'kyc.status_changed'
  | 'kyc.step_completed'
  | 'credential.issued'
  | 'credential.revoked'
  | 'credential.upgraded'
  | 'ticket.reply'
  | 'ticket.status_changed'
  | 'ticket.assigned';

/** Customer KYC level as tracked by the customer portal. */
export type CustomerKycLevel =
  | 'kyc_0'
  | 'kyc_1'
  | 'kyc_2'
  | 'kyc_3'
  | 'kyc_4'
  | 'kyc_5';

export type CustomerStatus =
  | 'pending_verification'
  | 'active'
  | 'suspended'
  | 'locked'
  | 'banned';
