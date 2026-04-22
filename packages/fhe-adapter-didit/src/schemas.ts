/**
 * Zod schemas for the Didit HTTP surface we consume.
 *
 * Every 2xx body returned by Didit passes through one of these
 * schemas before any helper in `@crivacy-fhe/adapter-didit` acts on it. A failing
 * parse becomes a `DiditError('invalid_response', …)` upstream, so
 * these schemas define the exact wire shape we depend on:
 *
 *   * **`CreateSessionResponseSchema`** — shape of
 *     `POST /v3/session/`. Required fields are `session_id`,
 *     `session_token`, `session_url`, `workflow_id`, `vendor_data`,
 *     and `status`. Unknown fields pass through — Didit adds new
 *     optional fields between versions.
 *
 *   * **`DecisionResponseSchema`** — shape of
 *     `GET /v3/session/{id}/decision/`. The response is a deeply
 *     nested record with KYC, liveness, face-match, and address
 *     sections; every nested block is optional because the two
 *     workflows (KYC vs PoA) populate different subsets.
 *
 *   * **`WebhookBodySchema`** — shape of webhook POST bodies. Same
 *     fields as the decision response but wrapped with `timestamp`
 *     and `webhook_type` signatures-related fields.
 *
 *   * **`DiditApiErrorSchema`** — Didit's structured error body for
 *     4xx + 5xx responses. Used by `http.mapHttpError` to prefer the
 *     narrower `DiditErrorCode` over the generic `http_error`.
 *
 * All schemas use `.passthrough()` so unknown fields ride along to
 * downstream consumers without breaking the parse. The strict
 * validation lives on the handful of fields we actually read.
 */

import { z } from 'zod';

import {
  isDiditOutOfScopeWebhookType,
  isDiditUserEntityWebhookType,
} from './types';

/* ---------- Structured error ---------- */

/**
 * Didit's structured error body. The exact shape varies across
 * endpoint versions — we capture the fields most commonly present
 * and keep everything else passthrough so a version bump doesn't
 * break the parse.
 */
export const DiditApiErrorSchema = z
  .object({
    detail: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
    status: z.string().optional(),
    request_id: z.string().optional(),
  })
  .passthrough();

export type DiditApiError = z.infer<typeof DiditApiErrorSchema>;

/* ---------- Session create response ---------- */

/**
 * `POST /v3/session/` response. `session_id` is opaque; Didit has
 * used both UUID v4 and random 32-char hex in past versions so we
 * pin length bounds but not a specific alphabet.
 *
 * v3 API returns the hosted flow URL as `url` (renamed from earlier
 * `session_url`). Accept both keys via a transform so older mocks
 * and any Didit-side rollback continue to parse.
 */
export const CreateSessionResponseSchema = z
  .object({
    session_id: z.string().min(8).max(256),
    session_token: z.string().min(8).max(4096),
    url: z.string().url().max(2048).optional(),
    session_url: z.string().url().max(2048).optional(),
    workflow_id: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        'workflow_id must be a lowercase UUID',
      ),
    vendor_data: z.string().min(1).max(512),
    status: z.string().min(1).max(64),
  })
  .passthrough()
  .refine(
    (data) => typeof data.url === 'string' || typeof data.session_url === 'string',
    { message: 'response missing hosted flow URL (expected `url` or `session_url`)' },
  );

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

/* ---------- Decision payload — nested blocks ---------- */

/**
 * Warning entry — surfaced by every per-feature block (id_verifications,
 * liveness_checks, face_matches, poa_verifications, ip_analyses) inside
 * a `warnings[]` array. Carries the decline / risk signal as a stable
 * machine-readable `risk` code that downstream `decline-reason.ts`
 * priority-ranks to derive a human `failure_reason`.
 *
 * Reference codes (non-exhaustive — Didit ships new codes between
 * versions, so the schema does NOT enum-lock `risk`):
 *   - `DUPLICATED_FACE` — face_search 1:N hit on an existing approved
 *     session (the `additional_data.duplicated_session_id` points at
 *     the matched session). Highest-priority decline reason.
 *   - `POSSIBLE_DUPLICATED_USER` — id_verification matched a previous
 *     approved user by document. Lower-priority signal than
 *     DUPLICATED_FACE.
 *   - `DUPLICATED_IP_ADDRESS` — same client IP used in another
 *     `vendor_data` session. Information-level (not by itself a
 *     decline reason).
 *   - `LOW_QUALITY_*`, `SPOOFING_*`, document-specific risks etc.
 */
export const WarningBlockSchema = z
  .object({
    feature: z.string().min(1).max(64).nullable().optional(),
    risk: z.string().min(1).max(128),
    additional_data: z.record(z.string(), z.unknown()).nullable().optional(),
    log_type: z.enum(['information', 'warning', 'error']).nullable().optional(),
    short_description: z.string().max(512).nullable().optional(),
    long_description: z.string().max(2048).nullable().optional(),
    node_id: z.string().min(1).max(128).nullable().optional(),
  })
  .passthrough();

export type WarningBlock = z.infer<typeof WarningBlockSchema>;

/**
 * Match entry inside `id_verifications[].matches[]` (document-side
 * duplicate detection) and `liveness_checks[].matches[]` (face-search
 * 1:N duplicate detection). Same wire shape on both surfaces with one
 * difference: liveness matches expose `similarity_percentage` (0-100)
 * which document matches do not.
 *
 * `vendor_data` is the OUR-side identifier we attached when creating
 * the matched session — typically a JSON string carrying
 * `{customerId, type, crivacySessionId}`. The face-match logic in
 * Sprint 6 parses this to find the existing customer / firm binding.
 */
export const DiditMatchBlockSchema = z
  .object({
    session_id: z.string().min(8).max(256),
    session_number: z.number().int().nullable().optional(),
    vendor_data: z.string().max(512).nullable().optional(),
    verification_date: z.string().max(64).nullable().optional(),
    user_details: z
      .object({
        name: z.string().max(512).nullable().optional(),
        full_name: z.string().max(512).nullable().optional(),
        document_type: z.string().max(64).nullable().optional(),
        document_number: z.string().max(128).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    status: z.string().min(1).max(64).nullable().optional(),
    is_blocklisted: z.boolean().nullable().optional(),
    similarity_percentage: z.number().min(0).max(100).nullable().optional(),
    match_image_url: z.string().url().max(8192).nullable().optional(),
    front_image_url: z.string().url().max(8192).nullable().optional(),
    api_service: z.string().max(128).nullable().optional(),
    source: z.string().max(64).nullable().optional(),
  })
  .passthrough();

export type DiditMatchBlock = z.infer<typeof DiditMatchBlockSchema>;

/**
 * KYC workflow document block (per-document entry inside
 * `id_verifications[]`). All fields nullable because Didit omits
 * fields it could not extract from the document.
 *
 * Wire shape note: Didit V3 returns this nested under
 * `id_verifications: [...]` (one entry per ID side / capture). Our
 * mapping layer reads `id_verifications[0]` — the primary capture.
 *
 * `matches[]` and `warnings[]` are surfaced because the face-search
 * 1:N duplicate detection (POSSIBLE_DUPLICATED_USER) runs through
 * this block and flags duplicates against previously approved
 * sessions; without surfacing them we cannot tell why a session was
 * declined.
 */
export const KycDocumentBlockSchema = z
  .object({
    status: z.string().min(1).max(64).nullable().optional(),
    document_type: z.string().min(1).max(64).nullable().optional(),
    document_number: z.string().min(1).max(128).nullable().optional(),
    personal_number: z.string().min(1).max(128).nullable().optional(),
    issuing_country: z.string().min(2).max(8).nullable().optional(),
    issuing_state: z.string().min(1).max(64).nullable().optional(),
    issuing_state_name: z.string().min(1).max(128).nullable().optional(),
    first_name: z.string().min(1).max(256).nullable().optional(),
    last_name: z.string().min(1).max(256).nullable().optional(),
    full_name: z.string().min(1).max(512).nullable().optional(),
    date_of_birth: z.string().max(32).nullable().optional(),
    expiration_date: z.string().max(32).nullable().optional(),
    nationality: z.string().min(2).max(8).nullable().optional(),
    matches: z.array(DiditMatchBlockSchema).nullable().optional(),
    warnings: z.array(WarningBlockSchema).nullable().optional(),
    node_id: z.string().min(1).max(128).nullable().optional(),
  })
  .passthrough();

export type KycDocumentBlock = z.infer<typeof KycDocumentBlockSchema>;

/**
 * Liveness block (per-check entry inside `liveness_checks[]`).
 * `score` accepts integer or float — coerced to the nearest integer
 * in the mapping layer.
 *
 * Wire shape note: Didit V3 returns `liveness_checks[]` (plural
 * array of liveness check results). The legacy single-object
 * `liveness` field was removed; mapping layer reads
 * `liveness_checks[0]`. `passed` is intentionally absent in the
 * V3 wire format — `passed` is derived from
 * `status === 'Approved'` in `hydrateDecisionResponse`.
 *
 * `matches[]` is the face_search 1:N duplicate detection result
 * (per Didit docs face_search auto-runs during liveness). Each
 * match carries `similarity_percentage` 0-100 and the matched
 * session's `vendor_data`. `warnings[]` carries the corresponding
 * `DUPLICATED_FACE` risk code that triggers cascade logic.
 */
export const LivenessBlockSchema = z
  .object({
    status: z.string().min(1).max(64).nullable().optional(),
    score: z.number().min(0).max(100).nullable().optional(),
    method: z.string().min(1).max(64).nullable().optional(),
    face_quality: z.number().min(0).max(100).nullable().optional(),
    face_luminance: z.number().nullable().optional(),
    matches: z.array(DiditMatchBlockSchema).nullable().optional(),
    warnings: z.array(WarningBlockSchema).nullable().optional(),
    node_id: z.string().min(1).max(128).nullable().optional(),
  })
  .passthrough();

export type LivenessBlock = z.infer<typeof LivenessBlockSchema>;

/**
 * Face match block (per-comparison entry inside `face_matches[]`).
 * Wire shape: V3 returns `face_matches[]` (plural). `passed`
 * derived from `status === 'Approved'` like liveness above.
 *
 * Distinct from the duplicate-detection face_search 1:N: this is
 * the 1:1 selfie-vs-ID-photo comparison. No `matches[]` here —
 * 1:1 produces a single (score, status) pair. `warnings[]` carries
 * 1:1-specific failure reasons (low quality, mismatch).
 */
export const FaceMatchBlockSchema = z
  .object({
    status: z.string().min(1).max(64).nullable().optional(),
    score: z.number().min(0).max(100).nullable().optional(),
    warnings: z.array(WarningBlockSchema).nullable().optional(),
    node_id: z.string().min(1).max(128).nullable().optional(),
  })
  .passthrough();

export type FaceMatchBlock = z.infer<typeof FaceMatchBlockSchema>;

/**
 * Address / proof-of-address block (per-verification entry inside
 * `poa_verifications[]`). `addressVerified` derived from
 * `status === 'Approved'`.
 */
export const AddressBlockSchema = z
  .object({
    status: z.string().min(1).max(64).nullable().optional(),
    document_type: z.string().min(1).max(64).nullable().optional(),
    country: z.string().min(2).max(8).nullable().optional(),
    address: z.string().min(1).max(1024).nullable().optional(),
    warnings: z.array(WarningBlockSchema).nullable().optional(),
    node_id: z.string().min(1).max(128).nullable().optional(),
  })
  .passthrough();

export type AddressBlock = z.infer<typeof AddressBlockSchema>;

/**
 * IP analysis block (per-capture entry inside top-level
 * `ip_analyses[]`). Carries device fingerprint + geolocation +
 * VPN/data-center signals. Sprint 6's IP abuse gate hashes
 * `ip_address` to populate `ip_abuse_signals`; `device_fingerprint`
 * is a future second-axis signal for repeat-evader detection.
 *
 * `warnings[]` includes `DUPLICATED_IP_ADDRESS` (information-level)
 * which contributes to repeat-evader scoring but is not a decline
 * reason on its own.
 */
export const IpAnalysisBlockSchema = z
  .object({
    status: z.string().min(1).max(64).nullable().optional(),
    ip_address: z.string().max(128).nullable().optional(),
    ip_country: z.string().max(128).nullable().optional(),
    ip_country_code: z.string().max(8).nullable().optional(),
    ip_state: z.string().max(128).nullable().optional(),
    ip_city: z.string().max(128).nullable().optional(),
    device_brand: z.string().max(128).nullable().optional(),
    device_model: z.string().max(128).nullable().optional(),
    browser_family: z.string().max(128).nullable().optional(),
    os_family: z.string().max(128).nullable().optional(),
    platform: z.string().max(64).nullable().optional(),
    device_fingerprint: z.string().max(256).nullable().optional(),
    is_vpn_or_tor: z.boolean().nullable().optional(),
    is_data_center: z.boolean().nullable().optional(),
    time_zone: z.string().max(128).nullable().optional(),
    warnings: z.array(WarningBlockSchema).nullable().optional(),
    node_id: z.string().min(1).max(128).nullable().optional(),
  })
  .passthrough();

export type IpAnalysisBlock = z.infer<typeof IpAnalysisBlockSchema>;

/* ---------- Decision response ---------- */

/**
 * `GET /v3/session/{id}/decision/` response. All KYC blocks are
 * optional; we enforce presence at the mapping layer based on
 * workflow type. `status` is the union of Didit's four terminal
 * + in-progress states.
 */
export const DecisionResponseSchema = z
  .object({
    session_id: z.string().min(8).max(256),
    session_number: z.number().int().optional(),
    workflow_id: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        'workflow_id must be a lowercase UUID',
      ),
    vendor_data: z.string().min(1).max(512),
    // `status` is intentionally NOT enum-locked. Same reasoning as
    // `WebhookBodySchema.status` (see comment there): Didit ships new
    // values as the product evolves (`Resubmitted`, `Kyc Expired`,
    // and the recently-observed `Expired` for sessions whose
    // workflow id is no longer recognized after the operator rotates
    // workflow IDs). Strict-enum validation at the GET decision
    // boundary turned the SSE pull-fallback into a silent stall —
    // every poll cycle threw `invalid_response`, the row stayed
    // `pending` forever, and the desktop UI never advanced. The
    // mapping layer in `customer-kyc.ts::pullAndApplyDiditDecision`
    // is the authoritative arbiter and routes unknown values to a
    // single recoverable branch.
    status: z.string().min(1).max(64),
    // `created_at` is OPTIONAL. Empirically Didit's `GET /v3/session/
    // {id}/decision/` response does NOT include a top-level
    // `created_at` field (verified 2026-05-07 against a real
    // session). The original schema required it and the parse failed
    // before the status branch could even read the value, blocking
    // the entire pull-fallback. We do not actually use `created_at`
    // anywhere in the mapping layer — `kyc_session_row.created_at`
    // is our own column. Keeping the field in the schema (optional)
    // documents that we tolerate it, while not requiring its
    // presence.
    created_at: z.string().min(1).max(64).optional(),
    human_score: z.number().min(0).max(100).nullable().optional(),
    // V3 wire format: per-feature results live in plural-named arrays
    // (`id_verifications` / `liveness_checks` / `face_matches` /
    // `poa_verifications`). Each array contains one entry per
    // capture / comparison; the mapping layer reads `[0]` (the
    // primary capture) for downstream flag derivation.
    id_verifications: z.array(KycDocumentBlockSchema).nullable().optional(),
    liveness_checks: z.array(LivenessBlockSchema).nullable().optional(),
    face_matches: z.array(FaceMatchBlockSchema).nullable().optional(),
    poa_verifications: z.array(AddressBlockSchema).nullable().optional(),
    ip_analyses: z.array(IpAnalysisBlockSchema).nullable().optional(),
    // Legacy V2-shape singular fields. Kept on the schema (optional)
    // so an unexpected mix-and-match payload from Didit during a
    // migration window doesn't break parsing — but the mapping layer
    // ignores them in favour of the V3 plural arrays above.
    kyc: KycDocumentBlockSchema.nullable().optional(),
    liveness: LivenessBlockSchema.nullable().optional(),
    face_match: FaceMatchBlockSchema.nullable().optional(),
    address: AddressBlockSchema.nullable().optional(),
  })
  .passthrough();

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

/* ---------- Webhook body ---------- */

/**
 * Webhook POST body. Covers ALL Didit V3 webhook event types, not just
 * verification-session events. The shape varies by `webhook_type`:
 *
 *   * `status.updated` / `data.updated` — session-level events. Carry
 *     `session_id` + `workflow_id` + per-feature `decision` data. These
 *     are the events the original handler was built around.
 *
 *   * `user.status.updated` — user-entity status change. Body shape per
 *     `Didit docs: api-references/management-api_users_update-status.md:33`:
 *     "Emits a `user.status.updated` webhook with `previous_status`,
 *     `status`, and `reason`." Plus envelope (`event_id, webhook_type,
 *     timestamp, vendor_user_id, vendor_data`). NO `session_id`.
 *
 *   * `user.data.updated` — user-entity data change (incl. **delete**).
 *     Per `management-api_users_update.md:30` + `users_delete.md:32`:
 *     fires with `changed_fields[]` + `changes{previous,current}`. When
 *     a user is deleted, this event fires with `deleted_at` set (likely
 *     in `changes.current.deleted_at`, possibly top-level — handler
 *     reads both paths defensively). NO `session_id`.
 *
 *   * `business.*`, `transaction.*`, `activity.created` — out of scope
 *     for this handler today; they parse but the handler short-circuits
 *     to a 200-ack with an audit log entry.
 *
 * `timestamp` is an ISO 8601 string in the body. Header `X-Timestamp`
 * is a Unix seconds integer. Both are validated by `webhook.ts`.
 *
 * Schema design: base fields are all OPTIONAL at the type level so the
 * union of all event shapes parses cleanly under one schema. A `refine`
 * at the bottom enforces "session-level events MUST carry session_id +
 * workflow_id" — this keeps the original session-event contract strict
 * while letting `user.*` / `business.*` / `transaction.*` / `activity.*`
 * events through without those fields.
 */
export const WebhookBodySchema = z
  .object({
    // Session-level fields — required for `status.updated` /
    // `data.updated` (enforced via refine below), absent for
    // `user.*` / `business.*` / `transaction.*` / `activity.*`.
    session_id: z.string().min(8).max(256).optional(),
    workflow_id: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        'workflow_id must be a lowercase UUID',
      )
      .optional(),
    // Always present (per Didit V3 docs — every event ties back to a
    // vendor-controlled identifier).
    vendor_data: z.string().min(1).max(512),
    // `status` is intentionally NOT locked to a fixed enum here. Didit
    // ships new values as the product evolves AND uses two distinct
    // status enums in different contexts (verification statuses
    // `Approved/Declined/In Review/...` vs user-entity statuses
    // `ACTIVE/FLAGGED/BLOCKED`). The webhook dispatch must accept
    // either; the handler is the authoritative arbiter and routes
    // unknown values to a single audit-and-acknowledge branch. Enum-
    // locking here turned the webhook dispatch into a silent outage
    // until a human noticed (BUG witnessed before — see DC1 closure).
    status: z.string().min(1).max(64).optional(),
    // Didit emits `timestamp` as either a Unix-seconds integer
    // (e.g. test webhooks: `1778220331`) or an ISO-8601 string
    // (e.g. session webhooks: `"2026-05-08T06:30:31Z"`). Union both
    // — the consumer (`assertBodyTimestampMatchesHeader`) already
    // handles either form. Locking to one type turned a recoverable
    // payload into a 400 outage on every test webhook.
    timestamp: z.union([z.string().min(1).max(64), z.number().int().positive()]).optional(),
    webhook_type: z.string().min(1).max(64).optional(),
    human_score: z.number().min(0).max(100).nullable().optional(),
    // ---- User-entity event fields (`user.status.updated` / `user.data.updated`) ----
    // `vendor_user_id` is Didit's stable internal UUID for the user;
    // distinct from `vendor_data` (which is OUR identifier). Present
    // on every user.* event per docs.
    vendor_user_id: z.string().min(8).max(256).optional(),
    // `user.status.updated` payload field — value before the change.
    // Same enum looseness reasoning as `status` above.
    previous_status: z.string().min(1).max(64).nullable().optional(),
    // Free-form operator-supplied note from the dashboard or
    // update-status PATCH body. Persisted to audit log.
    reason: z.string().max(2048).nullable().optional(),
    // `user.data.updated` payload — array of field names that
    // changed. Delete sets this to e.g. `["deleted_at"]`.
    changed_fields: z.array(z.string().min(1).max(128)).nullable().optional(),
    // `user.data.updated` payload — `{previous, current}` pair. Both
    // sub-objects are arbitrary JSON (whatever fields changed). Use
    // `passthrough` so we don't drop extra keys when reading.
    changes: z
      .object({
        previous: z.record(z.string(), z.unknown()).nullable().optional(),
        current: z.record(z.string(), z.unknown()).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    // Top-level `deleted_at` field — Didit docs imply this MAY be
    // top-level (`management-api_users_delete.md:32` says "with
    // deleted_at set" without specifying the path). Handler reads
    // both top-level AND `changes.current.deleted_at` to be safe.
    deleted_at: z.string().min(1).max(64).nullable().optional(),
    // V3 wire format: per-feature results live in plural-named arrays
    // — same shape as `DecisionResponseSchema`. Older `kyc` /
    // `liveness` / `face_match` / `address` singular fields are kept
    // as a no-op safety net during any migration window but the
    // mapping layer reads the plural arrays.
    id_verifications: z.array(KycDocumentBlockSchema).nullable().optional(),
    liveness_checks: z.array(LivenessBlockSchema).nullable().optional(),
    face_matches: z.array(FaceMatchBlockSchema).nullable().optional(),
    poa_verifications: z.array(AddressBlockSchema).nullable().optional(),
    ip_analyses: z.array(IpAnalysisBlockSchema).nullable().optional(),
    kyc: KycDocumentBlockSchema.nullable().optional(),
    liveness: LivenessBlockSchema.nullable().optional(),
    face_match: FaceMatchBlockSchema.nullable().optional(),
    address: AddressBlockSchema.nullable().optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    // Session-level events MUST carry session_id + workflow_id. The
    // original handler relied on these being present; relaxing them
    // unconditionally would let a malformed `status.updated` body
    // sneak past validation and crash inside the handler.
    //
    // Treat anything that is NOT a known non-session event prefix as
    // session-level — the handler's routing uses the same rule, and
    // an unknown future Didit event type will fail loudly at this
    // layer rather than silently parsing and crashing downstream.
    const wt = body.webhook_type;
    const isUserEvent = isDiditUserEntityWebhookType(wt);
    const isOutOfScopeEvent = isDiditOutOfScopeWebhookType(wt);
    const isSessionEvent = !isUserEvent && !isOutOfScopeEvent;
    if (isSessionEvent) {
      if (body.session_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['session_id'],
          message: 'session_id is required for session-level webhooks',
        });
      }
      if (body.workflow_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workflow_id'],
          message: 'workflow_id is required for session-level webhooks',
        });
      }
      if (body.status === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'status is required for session-level webhooks',
        });
      }
    }
    // User-entity events MUST carry vendor_user_id (Didit's stable
    // internal id for the user). vendor_data is already required at
    // the top of the schema, so we don't repeat that check here.
    if (isUserEvent && body.vendor_user_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vendor_user_id'],
        message: 'vendor_user_id is required for user.* webhooks',
      });
    }
  });

export type WebhookBody = z.infer<typeof WebhookBodySchema>;
