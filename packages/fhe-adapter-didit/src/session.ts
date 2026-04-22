/**
 * Session create + decision fetch for the Didit KYC API.
 *
 * This is the high-level write layer: pure functions that take a
 * `DiditConfig` + validated input and drive the HTTP transport to
 * produce a parsed, branded result. The two primary operations map
 * to the two Didit endpoints we consume:
 *
 *   * `createKycSession(config, vendorData, callbackUrl, fetch?)`
 *     → `POST /v3/session/` with `workflow_id = config.kycWorkflowId`
 *
 *   * `createAddressSession(config, vendorData, callbackUrl, fetch?)`
 *     → `POST /v3/session/` with `workflow_id = config.addressWorkflowId`
 *
 *   * `getDecision(config, sessionId, fetch?)`
 *     → `GET /v3/session/{id}/decision/` — retried on transient
 *       failures, parsed to the typed `DiditDecisionPayload`.
 *
 * Input validation lives here (not in `http.ts`) because the
 * transport layer is workflow-agnostic. Every call rejects empty
 * / malformed vendor data, rejects a non-http(s) callback URL, and
 * branded the returned session id so the caller cannot confuse a
 * string id with a session url.
 *
 * The Zod-parsed response is mapped to the branded `CreateSessionResult`
 * + `DiditDecisionPayload` shapes in `types.ts`. The raw wire field
 * names (`session_id`, `workflow_id`, `vendor_data`) are never
 * exposed beyond this module.
 */

import type { DiditConfig } from './config';
import { DiditError } from './errors';
import { type FetchLike, diditFetch } from './http';
import {
  type CreateSessionResponse,
  CreateSessionResponseSchema,
  type DecisionResponse,
  DecisionResponseSchema,
} from './schemas';
import {
  DIDIT_STATUS,
  type CreateSessionResult,
  type DiditDecisionPayload,
  type DiditIpAnalysisEntry,
  type DiditMatchEntry,
  type DiditSessionId,
  type DiditVendorData,
  type DiditWarningEntry,
  type DiditWorkflowId,
  type DiditWorkflowType,
  asDiditSessionIdUnchecked,
  asDiditVendorDataUnchecked,
  asDiditWorkflowIdUnchecked,
} from './types';
import { resolveDeclineReason } from './decline-reason';
import type {
  IpAnalysisBlock,
  KycDocumentBlock,
  LivenessBlock,
  WarningBlock,
} from './schemas';

/* ---------- Vendor data + callback validation ---------- */

/** Maximum length of the `vendor_data` string we send to Didit. */
export const MAX_VENDOR_DATA_LENGTH = 512;

/**
 * Validate + brand a vendor-data string. Throws
 * `DiditError('invalid_vendor_data', …)` on empty, oversized, or
 * non-printable-ASCII input. Printable ASCII is required so the
 * JSON body does not need any escape handling + so the string
 * round-trips through Didit's URL-encoded query params unchanged.
 */
export function validateVendorData(raw: string): DiditVendorData {
  if (typeof raw !== 'string') {
    throw new DiditError('invalid_vendor_data', 'vendor_data must be a string.');
  }
  if (raw.length === 0) {
    throw new DiditError('invalid_vendor_data', 'vendor_data must be non-empty.');
  }
  if (raw.length > MAX_VENDOR_DATA_LENGTH) {
    throw new DiditError(
      'invalid_vendor_data',
      `vendor_data exceeds ${MAX_VENDOR_DATA_LENGTH} chars (was ${raw.length}).`,
    );
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new DiditError(
        'invalid_vendor_data',
        `vendor_data contains a non-printable-ASCII character at index ${i}.`,
      );
    }
  }
  return asDiditVendorDataUnchecked(raw);
}

/**
 * Validate a callback URL. Throws
 * `DiditError('invalid_callback_url', …)` on empty input, malformed
 * URLs, or non-http(s) schemes. The Didit dispatcher will eventually
 * reject these too, but surfacing them before the HTTP call keeps
 * error handling local to the caller.
 */
export function validateCallbackUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DiditError('invalid_callback_url', 'callback_url must be a non-empty string.');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new DiditError('invalid_callback_url', `callback_url is malformed: ${raw}`, {
      cause: err,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DiditError(
      'invalid_callback_url',
      `callback_url must use http(s); got ${parsed.protocol}`,
    );
  }
  return raw;
}

/**
 * Validate + brand a workflow id. Accepts a bare UUID-shape string
 * and rejects anything that does not match the lowercase UUID form
 * Didit uses. Primary use: checking a workflow id pulled out of a
 * webhook body against the configured KYC / address ids.
 */
export function validateWorkflowId(raw: string): DiditWorkflowId {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DiditError('invalid_workflow_id', 'workflow_id must be a non-empty string.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
    throw new DiditError('invalid_workflow_id', `workflow_id is not a lowercase UUID: ${raw}`);
  }
  return asDiditWorkflowIdUnchecked(raw);
}

/**
 * Validate + brand a Didit session id. Shape pin only: Didit has
 * historically used both UUID and hex formats, so we accept any
 * printable-ASCII string in the configured length bounds.
 */
export function validateSessionId(raw: string): DiditSessionId {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DiditError('invalid_session_id', 'session_id must be a non-empty string.');
  }
  if (raw.length > 256) {
    throw new DiditError('invalid_session_id', `session_id exceeds 256 chars (was ${raw.length}).`);
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new DiditError(
        'invalid_session_id',
        `session_id contains a non-printable-ASCII character at index ${i}.`,
      );
    }
  }
  return asDiditSessionIdUnchecked(raw);
}

/* ---------- Workflow type detection ---------- */

/**
 * Map a workflow id string to the internal workflow type tag.
 * Returns `null` when the id matches neither configured workflow
 * — the caller decides whether to fail closed (recommended) or
 * fall through to a generic handler.
 */
export function workflowIdToType(
  config: DiditConfig,
  workflowId: string,
): DiditWorkflowType | null {
  if (workflowId === config.kycWorkflowId) {
    return 'kyc';
  }
  if (workflowId === config.addressWorkflowId) {
    return 'address';
  }
  return null;
}

/**
 * Same as `workflowIdToType` but throws `unknown_workflow` when
 * `failClosedOnUnknownWorkflow` is enabled (the production default).
 * Used by the webhook handler + decision poller to refuse any
 * session from a workflow we did not configure.
 */
export function resolveWorkflowType(config: DiditConfig, workflowId: string): DiditWorkflowType {
  const type = workflowIdToType(config, workflowId);
  if (type === null) {
    if (config.failClosedOnUnknownWorkflow) {
      throw new DiditError(
        'unknown_workflow',
        `Workflow id does not match KYC or Address: ${workflowId}`,
        { context: { workflowId } },
      );
    }
    return 'kyc';
  }
  return type;
}

/* ---------- Session create ---------- */

/**
 * Optional `expected_details` payload for cross-validation. Sprint 8
 * uses this on address sessions (with first/last name pulled from
 * the Didit User entity) so the PoA name fuzzy match has a reference
 * to compare the OCR'd bill name against. Without these fields
 * Didit's name match returns NULL and a roommate's bill could pass.
 *
 * The wire field is `expected_details` (snake_case, nested object);
 * the JS-side parameter uses camelCase. See Didit docs:
 * https://docs.didit.me/sessions-api/create-session — `expected_details`.
 */
export interface ExpectedDetailsInput {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly address?: string;
  readonly idCountry?: string;
  readonly poaCountry?: string;
}

/**
 * Wire shape of `expected_details` accepted by `POST /v3/session/`.
 * Snake-case to match Didit's wire format (camelCase is a JS-side
 * convention; the body MUST keep the snake-cased keys).
 */
interface ExpectedDetailsBody {
  first_name?: string;
  last_name?: string;
  address?: string;
  id_country?: string;
  poa_country?: string;
}

/**
 * Build the `expected_details` body fragment from the camelCase
 * input. Returns `undefined` when no fields are populated so the
 * fragment is omitted entirely (Didit accepts the absence — we just
 * skip the wire-level cross-validation).
 */
function buildExpectedDetailsBody(
  input: ExpectedDetailsInput | undefined,
): ExpectedDetailsBody | undefined {
  if (input === undefined) return undefined;
  const out: ExpectedDetailsBody = {};
  if (input.firstName !== undefined && input.firstName.length > 0) {
    out.first_name = input.firstName;
  }
  if (input.lastName !== undefined && input.lastName.length > 0) {
    out.last_name = input.lastName;
  }
  if (input.address !== undefined && input.address.length > 0) {
    out.address = input.address;
  }
  if (input.idCountry !== undefined && input.idCountry.length > 0) {
    out.id_country = input.idCountry;
  }
  if (input.poaCountry !== undefined && input.poaCountry.length > 0) {
    out.poa_country = input.poaCountry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Low-level session create. Kept internal so the public
 * `createKycSession` / `createAddressSession` helpers can bind the
 * workflow id without leaking the wire-name to consumers.
 */
async function createSessionInternal(
  config: DiditConfig,
  workflowId: DiditWorkflowId,
  workflowType: DiditWorkflowType,
  vendorData: DiditVendorData,
  callbackUrl: string,
  expectedDetails?: ExpectedDetailsInput,
  fetchImpl?: FetchLike,
): Promise<CreateSessionResult> {
  const expected = buildExpectedDetailsBody(expectedDetails);
  const body = {
    workflow_id: workflowId,
    vendor_data: vendorData,
    callback: callbackUrl,
    callback_method: 'both',
    ...(expected !== undefined ? { expected_details: expected } : {}),
  };

  const raw = await diditFetch<CreateSessionResponse>(
    config,
    {
      method: 'POST',
      path: '/v3/session/',
      body,
      schema: CreateSessionResponseSchema,
      context: { workflowId, workflowType, vendorData },
    },
    fetchImpl,
  );

  const sessionId = validateSessionId(raw.session_id);
  const hostedUrl = raw.url ?? raw.session_url;
  if (typeof hostedUrl !== 'string' || hostedUrl.length === 0) {
    throw new DiditError(
      'invalid_response',
      'Didit session response missing hosted flow URL (`url` / `session_url`).',
      { context: { workflowId, workflowType } },
    );
  }
  return Object.freeze({
    sessionId,
    sessionUrl: hostedUrl,
    sessionToken: raw.session_token,
    workflowType,
    workflowId,
    vendorData,
  });
}

/**
 * Create a KYC session: ID document + liveness + face match. The
 * resulting `session_url` is the hosted flow the end user is
 * redirected to; the `session_token` is used by the Didit SDK to
 * embed the flow in an iframe instead of a redirect.
 *
 * `expectedDetails` is optional; KYC sessions don't currently use
 * it but the parameter is exposed for symmetry with the address
 * helper and to support future caller-driven cross-validation.
 */
export function createKycSession(
  config: DiditConfig,
  vendorData: DiditVendorData,
  callbackUrl: string,
  expectedDetails?: ExpectedDetailsInput,
  fetchImpl?: FetchLike,
): Promise<CreateSessionResult> {
  const callback = validateCallbackUrl(callbackUrl);
  return createSessionInternal(
    config,
    config.kycWorkflowId,
    'kyc',
    vendorData,
    callback,
    expectedDetails,
    fetchImpl,
  );
}

/**
 * Create an Address / proof-of-address session. Same shape as the
 * KYC create, different workflow id. Consumers typically call this
 * after a KYC session has been approved.
 *
 * Sprint 8: `expectedDetails.firstName + lastName` MUST be supplied
 * (in production callers) so Didit's PoA fuzzy name match has a
 * reference. Without them the bill name check returns NULL and a
 * roommate's utility bill would slip through. The handler layer
 * (`handleStartAddress`) pulls the values from
 * `getDiditUser(config, vendorData).fullName` and passes them
 * through. Keeping the parameter optional in the signature lets
 * tests + ad-hoc tooling create a session without the name anchor.
 */
export function createAddressSession(
  config: DiditConfig,
  vendorData: DiditVendorData,
  callbackUrl: string,
  expectedDetails?: ExpectedDetailsInput,
  fetchImpl?: FetchLike,
): Promise<CreateSessionResult> {
  const callback = validateCallbackUrl(callbackUrl);
  return createSessionInternal(
    config,
    config.addressWorkflowId,
    'address',
    vendorData,
    callback,
    expectedDetails,
    fetchImpl,
  );
}

/* ---------- Decision fetch ---------- */

/**
 * Hydrate a raw decision response into a typed, branded payload.
 * Exposed so the webhook handler can reuse the same mapping after
 * verifying the webhook body (rather than re-fetching from Didit).
 */
export function hydrateDecisionResponse(
  config: DiditConfig,
  raw: DecisionResponse,
): DiditDecisionPayload {
  const sessionId = validateSessionId(raw.session_id);
  const workflowId = validateWorkflowId(raw.workflow_id);
  const workflowType = resolveWorkflowType(config, workflowId);
  const vendorData = validateVendorData(raw.vendor_data);

  // V3 wire format: per-feature results live in plural-named arrays.
  // Pick the primary capture (`[0]`) — V3 may include multiple
  // entries per feature (e.g. front + back ID images, retry attempts)
  // but the first element is the authoritative one for downstream
  // flag derivation. Falls back to the legacy V2 singular field
  // (`raw.kyc` / `raw.liveness` / etc.) when the V3 array is absent
  // — keeps mocked test fixtures from earlier wire format working.
  //
  // The legacy `passed: boolean` field is gone in V3; `passed` is
  // derived from `status === 'Approved'`. This makes the `passed`
  // signal symmetric with the rest of the V3 status enum.
  const idDoc = raw.id_verifications?.[0] ?? raw.kyc ?? null;
  const liveness = raw.liveness_checks?.[0] ?? raw.liveness ?? null;
  const faceMatch = raw.face_matches?.[0] ?? raw.face_match ?? null;
  const address = raw.poa_verifications?.[0] ?? raw.address ?? null;

  // Sprint 6: aggregate cross-block surfaces. Walk every per-feature
  // capture (NOT just `[0]`) — Didit emits multiple captures per
  // feature when a session was started on one device and finished on
  // another, and `face_search` matches arrive on `liveness_checks[].
  // matches[]` rather than a top-level block. The aggregated
  // `faceSearchMatches` / `warnings` / `ipAnalyses` arrays feed the
  // Sprint 6 face-match cascade logic in `lib/fraud/face-match.ts`.
  const faceSearchMatches = collectFaceSearchMatches(raw);
  const warnings = collectWarnings(raw);
  const ipAnalyses = collectIpAnalyses(raw);
  const declineReason = resolveDeclineReason(warnings);

  return Object.freeze({
    sessionId,
    workflowId,
    workflowType,
    status: raw.status as DiditDecisionPayload['status'],
    vendorData,
    humanScore: raw.human_score ?? null,
    kyc:
      idDoc !== null
        ? Object.freeze({
            documentType: idDoc.document_type ?? null,
            documentNumber: idDoc.document_number ?? null,
            personalNumber: idDoc.personal_number ?? null,
            issuingCountry: idDoc.issuing_country ?? null,
            issuingState: idDoc.issuing_state ?? null,
            firstName: idDoc.first_name ?? null,
            lastName: idDoc.last_name ?? null,
            fullName: idDoc.full_name ?? null,
            dateOfBirth: idDoc.date_of_birth ?? null,
            expirationDate: idDoc.expiration_date ?? null,
            nationality: idDoc.nationality ?? null,
          })
        : null,
    liveness:
      liveness !== null
        ? Object.freeze({
            // V3 has `status` only; legacy V2 had `passed`. Honour
            // either: explicit `passed: true` OR `status === 'Approved'`.
            // Note: a per-block `Declined` here can be a face_search
            // duplicate cascade rather than a true liveness failure —
            // `warnings[]` carries the actual `risk` code; consumers
            // that need to differentiate read `failureReasonCode`.
            passed:
              ('passed' in liveness && liveness['passed'] === true) ||
              liveness.status === DIDIT_STATUS.APPROVED,
            score: typeof liveness.score === 'number' ? Math.round(liveness.score) : 0,
          })
        : null,
    faceMatch:
      faceMatch !== null
        ? Object.freeze({
            passed:
              ('passed' in faceMatch && faceMatch['passed'] === true) ||
              faceMatch.status === DIDIT_STATUS.APPROVED,
            score: typeof faceMatch.score === 'number' ? Math.round(faceMatch.score) : 0,
          })
        : null,
    address:
      address !== null
        ? Object.freeze({
            // V3 has `status`; legacy V2 had `address_verified: boolean`.
            addressVerified:
              ('address_verified' in address && address['address_verified'] === true) ||
              address.status === DIDIT_STATUS.APPROVED,
            documentType: address.document_type ?? null,
            // V3 PoA payload does NOT carry a top-level `country` —
            // the country lives at `poa_parsed_address.country` (ISO
            // 3166-1 alpha-2, e.g. `TR`). The legacy V2 schema had
            // `address.country` directly, so we honour it first when
            // a fixture / older webhook still ships that shape, then
            // fall back to the parsed-address path. `issuing_state`
            // (e.g. `TUR`) is a last-resort 3-letter alpha-3 fallback;
            // never the primary because alpha-3 vs alpha-2 mismatches
            // would silently break the proof-hash determinism. The
            // `findMissingAddressFields` strict guard requires this
            // field to be a non-empty string — without this fallback
            // the address-phase mint blew up silently mid-pipeline
            // (pg-boss ate the `invalid_proof_input` throw, the
            // worker retried forever, the `kyc_credentials_meta`
            // INSERT never landed, and the customer stayed at
            // `kyc_3` while Didit showed "Approved"). Live trauma:
            // 5 attempts × $0.20 = $1.00 burned on this exact bug
            // before we reached the credential-pipeline log.
            country:
              ('country' in address && typeof (address as { country?: unknown }).country === 'string'
                ? ((address as { country?: string }).country ?? null)
                : null) ??
              (address as { poa_parsed_address?: { country?: string | null } | null })
                .poa_parsed_address?.country ??
              null,
          })
        : null,
    faceSearchMatches: Object.freeze(faceSearchMatches),
    warnings: Object.freeze(warnings),
    ipAnalyses: Object.freeze(ipAnalyses),
    failureReasonCode: declineReason.code,
    failureReasonText: declineReason.text,
    // `created_at` is now optional in the wire schema (Didit's v3
    // GET decision endpoint omits it empirically — confirmed
    // 2026-05-07). Default to the empty string when absent so the
    // typed payload's `createdAt: string` contract holds; downstream
    // consumers that read this field already tolerate empty input.
    createdAt: raw.created_at ?? '',
  });
}

/* ---------- Sprint 6: cross-block aggregations ---------- */

/**
 * Gather face_search 1:N duplicate detection results from BOTH
 * surfaces Didit emits them on (`liveness_checks[].matches[]` for
 * face-side hits, `id_verifications[].matches[]` for document-side
 * hits). Tags each entry with the originating surface so
 * `face-match.ts` can weight face-side hits higher.
 *
 * Walks every capture in each plural array — a session that bounced
 * desktop → phone has multiple liveness captures, and the duplicate
 * detection result may live on any of them.
 */
function collectFaceSearchMatches(raw: DecisionResponse): DiditMatchEntry[] {
  const out: DiditMatchEntry[] = [];

  for (const capture of raw.liveness_checks ?? []) {
    if (!capture || !capture.matches) continue;
    for (const m of capture.matches) {
      out.push(toMatchEntry(m, 'liveness'));
    }
  }
  for (const capture of raw.id_verifications ?? []) {
    if (!capture || !capture.matches) continue;
    for (const m of capture.matches) {
      out.push(toMatchEntry(m, 'id_verification'));
    }
  }
  return out;
}

function toMatchEntry(
  raw: NonNullable<NonNullable<LivenessBlock['matches']>[number]>,
  source: 'liveness' | 'id_verification',
): DiditMatchEntry {
  return Object.freeze({
    source,
    sessionId: raw.session_id,
    vendorData: raw.vendor_data ?? null,
    verificationDate: raw.verification_date ?? null,
    status: raw.status ?? null,
    isBlocklisted: typeof raw.is_blocklisted === 'boolean' ? raw.is_blocklisted : null,
    similarityPercentage:
      typeof raw.similarity_percentage === 'number' ? raw.similarity_percentage : null,
  });
}

/**
 * Aggregate `warnings[]` flat across every per-feature block plus the
 * top-level `ip_analyses[]` array. Each entry is tagged with its
 * originating feature so the priority resolver in `decline-reason.ts`
 * can rank without re-walking the raw payload.
 *
 * Walks every capture (not just `[0]`) — the back-side of an ID and
 * the front-side often surface different warnings, and we want both.
 */
function collectWarnings(raw: DecisionResponse): DiditWarningEntry[] {
  const out: DiditWarningEntry[] = [];
  for (const capture of raw.id_verifications ?? []) {
    if (capture && capture.warnings) {
      for (const w of capture.warnings) out.push(toWarningEntry(w));
    }
  }
  for (const capture of raw.liveness_checks ?? []) {
    if (capture && capture.warnings) {
      for (const w of capture.warnings) out.push(toWarningEntry(w));
    }
  }
  for (const capture of raw.face_matches ?? []) {
    if (capture && capture.warnings) {
      for (const w of capture.warnings) out.push(toWarningEntry(w));
    }
  }
  for (const capture of raw.poa_verifications ?? []) {
    if (capture && capture.warnings) {
      for (const w of capture.warnings) out.push(toWarningEntry(w));
    }
  }
  for (const capture of raw.ip_analyses ?? []) {
    if (capture && capture.warnings) {
      for (const w of capture.warnings) out.push(toWarningEntry(w));
    }
  }
  return out;
}

function toWarningEntry(raw: WarningBlock): DiditWarningEntry {
  return Object.freeze({
    feature: raw.feature ?? null,
    risk: raw.risk,
    logType: raw.log_type ?? null,
    shortDescription: raw.short_description ?? null,
    nodeId: raw.node_id ?? null,
  });
}

/**
 * Project all IP analysis captures (Didit emits one per unique
 * `device_fingerprint` — typically 2 entries when the session was
 * QR-handed-off from desktop to phone).
 */
function collectIpAnalyses(raw: DecisionResponse): DiditIpAnalysisEntry[] {
  const captures = raw.ip_analyses ?? [];
  return captures.filter((c): c is IpAnalysisBlock => c !== null && c !== undefined).map((c) =>
    Object.freeze({
      status: c.status ?? null,
      ipAddress: c.ip_address ?? null,
      ipCountryCode: c.ip_country_code ?? null,
      platform: c.platform ?? null,
      browserFamily: c.browser_family ?? null,
      osFamily: c.os_family ?? null,
      deviceFingerprint: c.device_fingerprint ?? null,
      isVpnOrTor: typeof c.is_vpn_or_tor === 'boolean' ? c.is_vpn_or_tor : null,
      isDataCenter: typeof c.is_data_center === 'boolean' ? c.is_data_center : null,
    }),
  );
}

/**
 * Best-effort hydration of a verified webhook body into the decision
 * payload shape. The webhook body and `GET /v3/session/{id}/decision/`
 * response share the per-feature blocks (`liveness_checks` /
 * `id_verifications` / etc.) plus session-level fields, so we re-run
 * `DecisionResponseSchema` on the body and feed the parsed result into
 * `hydrateDecisionResponse`. Returns `null` when the parse fails — the
 * caller treats that as "decision data unavailable from this webhook
 * payload" and falls back to a `getDecision` round-trip OR skips face-
 * match evaluation entirely (since a body that doesn't carry decision
 * data carries no matches[] either).
 *
 * Used by `server/handlers/didit-webhook.ts` to evaluate the Sprint 6
 * face-match cascade WITHOUT paying the round-trip cost of refetching
 * the decision from Didit. The webhook's HMAC signature already
 * proves the body came from Didit; the schema re-parse here is a
 * shape sanity check, not a trust boundary.
 */
export function hydrateDecisionFromWebhookBody(
  config: DiditConfig,
  body: unknown,
): DiditDecisionPayload | null {
  const result = DecisionResponseSchema.safeParse(body);
  if (!result.success) return null;
  try {
    return hydrateDecisionResponse(config, result.data);
  } catch {
    // hydrateDecisionResponse throws on workflow_id / vendor_data /
    // session_id validation drift. Keep webhook handlers up-by-failing-
    // open: returning null lets the caller skip cascade evaluation
    // without 5xxing on Didit (and triggering retries against state
    // we already persisted).
    return null;
  }
}

/**
 * Fetch the decision for a session. Used by the verification worker
 * when a webhook is missed (reconcile path) or when polling status
 * for the dashboard view. Retried on transient failures — the GET
 * endpoint is idempotent.
 */
export async function getDecision(
  config: DiditConfig,
  sessionId: DiditSessionId,
  fetchImpl?: FetchLike,
): Promise<DiditDecisionPayload> {
  const validatedId = validateSessionId(sessionId);
  const path = `/v3/session/${encodeURIComponent(validatedId)}/decision/`;
  const raw = await diditFetch<DecisionResponse>(
    config,
    {
      method: 'GET',
      path,
      schema: DecisionResponseSchema,
      context: { sessionId: validatedId },
    },
    fetchImpl,
  );
  return hydrateDecisionResponse(config, raw);
}
