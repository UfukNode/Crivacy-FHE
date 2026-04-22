/**
 * Branded types + shared domain shapes for the Didit client.
 *
 * Wrapping bare strings in `Brand<T, B>` gives us nominal typing for
 * ids that look the same at runtime but carry different meanings —
 * e.g. a `DiditSessionId` must never flow into a `DiditWorkflowId`
 * slot, and the compiler enforces that without a runtime guard.
 * Consumers construct branded values through the validated parsers
 * exported from the matching module (`session.ts`, `webhook.ts`),
 * never via `as`. The one exception is `asDiditSessionIdUnchecked`,
 * reserved for places that already validated the string through a
 * different code path (e.g. DB rows that were validated at insert
 * time and are now re-read).
 *
 * The module also declares the union of status strings Didit can
 * emit, the internal verification outcome our workflow reaches from
 * a decision, the shape of the KYC and PoA decision payload fields
 * we actually consume, and the `DiditVerificationFlags` struct the
 * credential builder consumes via `@/lib/verification`.
 */

/* ---------- Brand plumbing ---------- */

declare const DiditBrandSymbol: unique symbol;

/**
 * Nominal wrapper around a runtime primitive (usually `string`).
 * `B` is a string literal picked by the owning module.
 */
export type Brand<T, B extends string> = T & { readonly [DiditBrandSymbol]: B };

/* ---------- Identifiers ---------- */

/** Didit session identifier returned by `POST /v3/session/`. */
export type DiditSessionId = Brand<string, 'DiditSessionId'>;

/**
 * Didit workflow identifier. Our deployment configures two: a KYC
 * workflow (ID + liveness + face match) and an Address workflow
 * (Proof of Address). Both are stored in `DiditConfig`.
 */
export type DiditWorkflowId = Brand<string, 'DiditWorkflowId'>;

/**
 * Internal user reference we pass as `vendor_data` when creating a
 * session. Didit echoes this verbatim in the webhook + decision
 * response, so we rehydrate our own row without leaking any PII into
 * the upstream call. Validated at `session.createSession` entry.
 */
export type DiditVendorData = Brand<string, 'DiditVendorData'>;

/* ---------- Status + workflow enums ---------- */

/**
 * Single source of truth for the literal status strings Didit emits
 * in the decision response and the webhook body. Multi-word values
 * (`In Progress`, `In Review`, `Not Started`, `Kyc Expired`) include
 * whitespace exactly as Didit emits them — the mapping layer
 * compares strings verbatim.
 *
 * Source: Didit docs: 27_verification-statuses.md
 *
 * **Use named keys (e.g. `DIDIT_STATUS.IN_PROGRESS`) everywhere the
 * value is referenced** — handler maps, switch cases, test fixtures.
 * The duplicated literal strings that used to live in three files
 * (didit-webhook statusMap, mapping.ts STATUS_TO_OUTCOME,
 * customer-kyc.ts mapDiditStatusToInternal) violated the project's
 * single-source-of-truth rule and would silently drift if Didit ever
 * changed e.g. `"Kyc Expired"` to `"KYC Expired"`.
 *
 * The const itself is informational rather than a parse-time gate:
 * the decision response schema (`DecisionResponseSchema`) and the
 * webhook body schema (`WebhookBodySchema`) both accept any
 * `string.min(1).max(64)` for `status`. Reasoning: Didit ships new
 * status values as the product evolves (recently `Resubmitted` +
 * `Kyc Expired`), and a strict enum at the parse layer turns each
 * such delivery into a hard error until the enum is bumped —
 * converting a recoverable payload into an outage. The handlers
 * carry the authoritative mapping; unknown values fall into a single
 * audit-and-acknowledge branch.
 */
export const DIDIT_STATUS = Object.freeze({
  NOT_STARTED: 'Not Started',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  RESUBMITTED: 'Resubmitted',
  APPROVED: 'Approved',
  DECLINED: 'Declined',
  EXPIRED: 'Expired',
  ABANDONED: 'Abandoned',
  KYC_EXPIRED: 'Kyc Expired',
} as const);

export type DiditDecisionStatus = (typeof DIDIT_STATUS)[keyof typeof DIDIT_STATUS];

export const DIDIT_DECISION_STATUSES: readonly DiditDecisionStatus[] = Object.freeze(
  Object.values(DIDIT_STATUS),
);

/**
 * Our internal verification outcome. One of these is written to the
 * `kyc_sessions.status` enum after a decision is reduced by
 * `mapping.reduceDecision`:
 *
 *   * `passed`          — Didit returned `Approved`
 *   * `failed`          — Didit returned `Declined`
 *   * `manual_review`   — Didit returned `In Review`
 *   * `pending`         — Didit returned `In Progress` or no decision yet
 */
export type InternalVerificationOutcome = 'passed' | 'failed' | 'manual_review' | 'pending';

export const INTERNAL_VERIFICATION_OUTCOMES: readonly InternalVerificationOutcome[] = Object.freeze(
  ['passed', 'failed', 'manual_review', 'pending'],
);

/**
 * Which Didit workflow a session was created under. Populated by
 * `session.workflowIdToType()` + `mapping.detectWorkflowType()`.
 *
 *   * `kyc`      — document + liveness + face match workflow
 *   * `address`  — proof of address workflow
 */
export type DiditWorkflowType = 'kyc' | 'address';

export const DIDIT_WORKFLOW_TYPES: readonly DiditWorkflowType[] = Object.freeze(['kyc', 'address']);

/* ---------- Webhook event-type categorization ---------- */

/**
 * The two `webhook_type` values that fire on **user-entity** lifecycle
 * changes (delete, ACTIVE/FLAGGED/BLOCKED status flip, profile metadata
 * update) — independent of any specific verification session.
 *
 * Source: `Didit docs: 26_webhooks.md` +
 * `api-references/management-api_users_*.md`.
 *
 * Single source of truth for the literal pair. Without this, the same
 * `(wt === 'user.status.updated' || wt === 'user.data.updated')` check
 * lived in three places (handler routing, schema superRefine, test
 * harness type alias) and would silently drift if Didit added a third
 * user-entity event variant. Use {@link isDiditUserEntityWebhookType}
 * for the predicate; import the type alias for static type pinning.
 */
export const DIDIT_USER_ENTITY_WEBHOOK_TYPES = Object.freeze([
  'user.status.updated',
  'user.data.updated',
] as const);

export type DiditUserEntityWebhookType = (typeof DIDIT_USER_ENTITY_WEBHOOK_TYPES)[number];

export function isDiditUserEntityWebhookType(value: unknown): value is DiditUserEntityWebhookType {
  return (
    typeof value === 'string' &&
    (DIDIT_USER_ENTITY_WEBHOOK_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Webhook event prefixes / values we explicitly do **not** handle
 * today (B2B business onboarding, transaction monitoring, activity
 * feed). The `webhook` handler 200-acks these with an observability
 * log so Didit does not enter a retry storm; the schema's superRefine
 * exempts them from the session-id / workflow-id presence requirement
 * since their payloads do not carry those fields.
 *
 * Use {@link isDiditOutOfScopeWebhookType} — single source of truth
 * for the prefix list (previously duplicated across `didit-webhook.ts`
 * routing + `schemas.ts` superRefine).
 */
export function isDiditOutOfScopeWebhookType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return (
    value.startsWith('business.') ||
    value.startsWith('transaction.') ||
    value === 'activity.created'
  );
}

/* ---------- Decision payload (subset we consume) ---------- */

/**
 * Document-side fields we pull from a KYC decision. Didit's response
 * is much larger — `personalNumber` / `expirationDate` / `nationality`
 * are added in Sprint 6 because the cross-document duplicate detection
 * (and the customer-side audit trail) needs them. Other Didit fields
 * (image URLs, OCR raw text, NFC chip data) stay in the raw payload
 * and are accessible via `customer_kyc_sessions.didit_decision_payload`
 * for ops investigations.
 */
export interface DiditKycDocumentFields {
  readonly documentType: string | null;
  readonly documentNumber: string | null;
  readonly issuingCountry: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly dateOfBirth: string | null; // ISO 8601 date, `YYYY-MM-DD`
  // Sprint 6 additions — optional because the original (pre-Sprint-6)
  // contract did not emit these. Hydrate now projects them from the
  // raw Didit payload when present.
  readonly personalNumber?: string | null;
  readonly issuingState?: string | null;
  readonly fullName?: string | null;
  readonly expirationDate?: string | null; // ISO 8601 date, `YYYY-MM-DD`
  readonly nationality?: string | null;
}

/**
 * Liveness fields. Didit publishes a 0..100 confidence score; our
 * schema coerces anything Didit emits to this range or rejects.
 */
export interface DiditLivenessFields {
  readonly passed: boolean;
  readonly score: number; // 0..100 integer
}

/**
 * Face match fields. Score compares the document photo to the live
 * capture. Didit's own decision logic can still mark the session
 * `Declined` even when the score is high, which is why we keep both
 * the score and the boolean result.
 */
export interface DiditFaceMatchFields {
  readonly passed: boolean;
  readonly score: number; // 0..100 integer
}

/**
 * Address / proof-of-address fields. The Address workflow does not
 * produce document metadata; we record whether the address was
 * verified and stash the document type for audit.
 */
export interface DiditAddressFields {
  readonly addressVerified: boolean;
  readonly documentType: string | null;
  readonly country: string | null;
}

/**
 * One entry of the duplicate-detection (face_search 1:N) result.
 * Surfaced from either `liveness_checks[].matches[]` (face-side hit)
 * or `id_verifications[].matches[]` (document-side hit). The `source`
 * tag tells `face-match.ts` which surface contributed the entry —
 * face-side hits are higher-confidence than document-side ones.
 *
 * `vendorData` is the OUR-side identifier we attached when creating
 * the matched session — typically a JSON string carrying
 * `{customerId, type, crivacySessionId}`. `face-match.ts` parses this
 * to find the existing customer / firm binding and decide cascade vs
 * reuse.
 */
export interface DiditMatchEntry {
  readonly source: 'liveness' | 'id_verification';
  readonly sessionId: string;
  readonly vendorData: string | null;
  readonly verificationDate: string | null;
  readonly status: string | null; // matched session's status (Approved / Declined / etc.)
  readonly isBlocklisted: boolean | null;
  /** 0..100 — populated only on liveness-side matches. */
  readonly similarityPercentage: number | null;
}

/**
 * One warning surfaced by Didit. Aggregated flat across all per-feature
 * blocks (id_verifications, liveness_checks, face_matches,
 * poa_verifications, ip_analyses) and tagged with the originating
 * `feature` so `decline-reason.ts` can priority-rank without re-walking
 * the raw payload.
 *
 * `risk` matches a `DiditRiskCode` from `lib/didit/risk-codes.ts` for
 * known codes; unknown codes (Didit ships new ones between versions)
 * pass through untyped — handled as the generic "verification failed"
 * branch by the priority resolver.
 */
export interface DiditWarningEntry {
  readonly feature: string | null;
  readonly risk: string;
  readonly logType: 'information' | 'warning' | 'error' | null;
  readonly shortDescription: string | null;
  readonly nodeId: string | null;
}

/**
 * One IP analysis capture. Didit emits MULTIPLE entries when the
 * session was started on one device and finished on another (e.g.
 * QR-handoff to phone) — one per unique `device_fingerprint`.
 * `ipAddress` feeds the Sprint 6 IP abuse signal counter (hashed
 * via `lib/fraud/ip-abuse.ts`); `deviceFingerprint` is reserved for
 * a future second-axis repeat-evader signal.
 */
export interface DiditIpAnalysisEntry {
  readonly status: string | null;
  readonly ipAddress: string | null;
  readonly ipCountryCode: string | null;
  readonly platform: string | null;
  readonly browserFamily: string | null;
  readonly osFamily: string | null;
  readonly deviceFingerprint: string | null;
  readonly isVpnOrTor: boolean | null;
  readonly isDataCenter: boolean | null;
}

/**
 * Full decision payload we consume from either workflow. Most fields
 * are nullable because the two workflows populate different subsets.
 * `status` + `vendor_data` + `session_id` are always present.
 *
 * Sprint 6 extensions (additive — pre-Sprint-6 callers continue to
 * read `kyc` / `liveness` / `faceMatch` / `address` unchanged):
 *   - `faceSearchMatches[]` — duplicate detection results
 *   - `warnings[]` — flat aggregation of all per-block warnings
 *   - `ipAnalyses[]` — per-device IP captures
 *   - `failureReasonCode` / `failureReasonText` — derived from
 *     `warnings[]` via priority list in `decline-reason.ts`
 */
export interface DiditDecisionPayload {
  readonly sessionId: DiditSessionId;
  readonly workflowId: DiditWorkflowId;
  readonly workflowType: DiditWorkflowType;
  readonly status: DiditDecisionStatus;
  readonly vendorData: DiditVendorData;
  readonly humanScore: number | null;
  readonly kyc: DiditKycDocumentFields | null;
  readonly liveness: DiditLivenessFields | null;
  readonly faceMatch: DiditFaceMatchFields | null;
  readonly address: DiditAddressFields | null;
  readonly faceSearchMatches: readonly DiditMatchEntry[];
  readonly warnings: readonly DiditWarningEntry[];
  readonly ipAnalyses: readonly DiditIpAnalysisEntry[];
  readonly failureReasonCode: string | null;
  readonly failureReasonText: string | null;
  readonly createdAt: string; // ISO 8601 timestamp from Didit
}

/* ---------- Verification flags ---------- */

/**
 * The reduced verification flags a single session contributes to a
 * credential. Consumers merge flags across two sessions (KYC
 * + PoA) before calling `fhe.createCredential`.
 *
 * `humanScore` is the integer 0..100 used by the credential payload.
 * `outcome` mirrors `InternalVerificationOutcome` so consumers can
 * early-exit if a session is still pending.
 */
export interface DiditVerificationFlags {
  readonly workflowType: DiditWorkflowType;
  readonly outcome: InternalVerificationOutcome;
  readonly humanScore: number;
  readonly identityVerified: boolean;
  readonly livenessVerified: boolean;
  readonly addressVerified: boolean;
}

/* ---------- Session creation result ---------- */

/**
 * What `session.createSession` returns. `sessionUrl` is the hosted
 * flow the end user is redirected to (or embedded via the Didit SDK
 * iframe); `sessionToken` is passed to the SDK when embedding. Both
 * are opaque strings — we never parse them.
 */
export interface CreateSessionResult {
  readonly sessionId: DiditSessionId;
  readonly sessionUrl: string;
  readonly sessionToken: string;
  readonly workflowType: DiditWorkflowType;
  readonly workflowId: DiditWorkflowId;
  readonly vendorData: DiditVendorData;
}

/* ---------- Unchecked constructors ---------- */

/**
 * Cast a raw string into a `DiditSessionId` without validating it.
 * Only use from call sites that have already validated the string
 * through a different code path (DB row, schema parse, fixture).
 * The type system guarantees nothing about unchecked casts.
 */
export function asDiditSessionIdUnchecked(value: string): DiditSessionId {
  return value as DiditSessionId;
}

/**
 * Same as above for workflow ids. Used by `config.ts` to brand the
 * KYC + Address workflow ids after Zod validation.
 */
export function asDiditWorkflowIdUnchecked(value: string): DiditWorkflowId {
  return value as DiditWorkflowId;
}

/**
 * Same as above for vendor data. Used by tests + DB rehydration.
 */
export function asDiditVendorDataUnchecked(value: string): DiditVendorData {
  return value as DiditVendorData;
}
