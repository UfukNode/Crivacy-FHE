/**
 * Shared test fixtures for the Didit-client suite.
 *
 * Mirrors the `tests/chain/fixtures.ts` pattern — a fake
 * `FetchLike` that pulls from a FIFO queue, a config builder that
 * overlays safe test defaults, and canonical constants for session
 * ids + workflow ids + webhook bodies. No real HTTP client is ever
 * instantiated; no environment variable is ever read at test time.
 */

import { createHmac } from 'node:crypto';

import { vi } from 'vitest';

import { canonicalJson } from '@crivacy-fhe/adapter-didit/canonical';
import type { DiditConfig, DiditEnv } from '@crivacy-fhe/adapter-didit/config';
import { loadDiditConfig } from '@crivacy-fhe/adapter-didit/config';
import type { FetchLike, FetchLikeResponse } from '@crivacy-fhe/adapter-didit/http';
import type { DiditDecisionPayload, DiditDecisionStatus } from '@crivacy-fhe/adapter-didit/types';
import {
  asDiditSessionIdUnchecked,
  asDiditVendorDataUnchecked,
  asDiditWorkflowIdUnchecked,
} from '@crivacy-fhe/adapter-didit/types';

/* ---------- Canonical constants ---------- */

/**
 * KYC workflow id — matches the MEMORY.md record exactly so tests
 * fail loudly if someone copies a stale value.
 */
export const FIXTURE_KYC_WORKFLOW_ID = '2ab9f298-699c-4b2c-9ce9-6246c17c6c25';

/**
 * Address / PoA workflow id — same source as the KYC one above.
 */
export const FIXTURE_ADDRESS_WORKFLOW_ID = '72b72ee3-85ad-46d2-8558-1d2ff48b1ffb';

/** Plausible session id — Didit has used UUID + random hex over time. */
export const FIXTURE_SESSION_ID = 'sess_01HYTEST00000000000000000';

/** Plausible vendor data — our internal user reference. */
export const FIXTURE_VENDOR_DATA = 'user_0123456789abcdef';

/** Test api key that passes the printable-ASCII shape check. */
export const FIXTURE_API_KEY = 'didit_test_key_AAAAAAAAAA';

/** Test webhook secret that passes the printable-ASCII shape check. */
export const FIXTURE_WEBHOOK_SECRET = 'didit_test_secret_BBBBBBBBBB';

/** Default callback URL for session creation. */
export const FIXTURE_CALLBACK_URL = 'https://app.test.crivacy.io/verification/callback';

/** Base URL for the fake Didit host. */
export const FIXTURE_BASE_URL = 'https://didit.test';

/**
 * Fixed deterministic clock — webhook freshness tests freeze time
 * to this value.
 */
export const FIXTURE_NOW = new Date('2026-04-11T18:00:00.000Z');

/** Unix-seconds equivalent of `FIXTURE_NOW`. */
export const FIXTURE_NOW_SECONDS = Math.floor(FIXTURE_NOW.getTime() / 1_000);

/** Deterministic clock returning `FIXTURE_NOW.getTime()` in ms. */
export function fixtureClock(): number {
  return FIXTURE_NOW.getTime();
}

/** Deterministic branded session id for quick references. */
export const FIXTURE_SESSION_ID_BRANDED = asDiditSessionIdUnchecked(FIXTURE_SESSION_ID);

/** Deterministic branded vendor data for quick references. */
export const FIXTURE_VENDOR_DATA_BRANDED = asDiditVendorDataUnchecked(FIXTURE_VENDOR_DATA);

/** Branded KYC workflow id. */
export const FIXTURE_KYC_WORKFLOW_BRANDED = asDiditWorkflowIdUnchecked(FIXTURE_KYC_WORKFLOW_ID);

/** Branded Address workflow id. */
export const FIXTURE_ADDRESS_WORKFLOW_BRANDED = asDiditWorkflowIdUnchecked(
  FIXTURE_ADDRESS_WORKFLOW_ID,
);

/* ---------- Config builder ---------- */

/**
 * Build a fresh `DiditConfig` with safe test defaults. Tests can
 * spread overrides via the env-record shape to change individual
 * fields without touching the real environment.
 */
export function buildTestConfig(overrides: Partial<DiditEnv> = {}): DiditConfig {
  const env: DiditEnv = {
    DIDIT_BASE_URL: FIXTURE_BASE_URL,
    DIDIT_API_KEY: FIXTURE_API_KEY,
    DIDIT_REQUEST_TIMEOUT_MS: '1000',
    DIDIT_MAX_RETRIES: '0',
    DIDIT_RETRY_BASE_DELAY_MS: '0',
    DIDIT_KYC_WORKFLOW_ID: FIXTURE_KYC_WORKFLOW_ID,
    DIDIT_ADDRESS_WORKFLOW_ID: FIXTURE_ADDRESS_WORKFLOW_ID,
    DIDIT_DEFAULT_CALLBACK_URL: FIXTURE_CALLBACK_URL,
    DIDIT_WEBHOOK_SECRET: FIXTURE_WEBHOOK_SECRET,
    DIDIT_WEBHOOK_DRIFT_SECONDS: '300',
    DIDIT_FAIL_CLOSED_ON_UNKNOWN_WORKFLOW: 'true',
    DIDIT_PROOF_HASH_STRICT: 'true',
    ...overrides,
  };
  return loadDiditConfig(env);
}

/* ---------- Fake fetch ---------- */

/**
 * Captured request — each call to the fake fetch pushes one of
 * these. Tests assert on the shape (method, path, parsed body).
 */
export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * Programmed response — either a body object + status, or an error
 * to throw. `status` defaults to 200.
 */
export type FakeResponse =
  | {
      readonly kind: 'json';
      readonly status?: number;
      readonly body: unknown;
    }
  | {
      readonly kind: 'text';
      readonly status?: number;
      readonly body: string;
    }
  | {
      readonly kind: 'throw';
      readonly error: Error;
    }
  | {
      readonly kind: 'empty';
      readonly status?: number;
    };

/** Handle returned by `buildFakeFetch`. */
export interface FakeFetchHandle {
  readonly fetch: FetchLike;
  readonly captured: CapturedRequest[];
  readonly enqueue: (response: FakeResponse) => void;
  readonly reset: () => void;
  readonly remaining: () => number;
}

/**
 * Build a `FetchLike` that pulls responses from a FIFO queue and
 * captures each request. Calls fail if no response is queued.
 * Respects `AbortSignal` so abort-on-timeout tests work.
 */
export function buildFakeFetch(): FakeFetchHandle {
  const captured: CapturedRequest[] = [];
  const queue: FakeResponse[] = [];

  const fetchImpl: FetchLike = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    captured.push({
      method: init.method,
      path: `${parsed.pathname}${parsed.search}`,
      url,
      headers: init.headers,
      body: parseBody(init.body),
    });

    if (init.signal?.aborted === true) {
      const err = new Error('fetch aborted');
      err.name = 'AbortError';
      throw err;
    }

    const response = queue.shift();
    if (response === undefined) {
      throw new Error(
        `fake fetch: no response queued for ${init.method} ${parsed.pathname}. Did you forget to enqueue one?`,
      );
    }

    if (response.kind === 'throw') {
      throw response.error;
    }

    return buildFakeResponse(response);
  });

  return {
    fetch: fetchImpl,
    captured,
    enqueue: (response) => {
      queue.push(response);
    },
    reset: () => {
      captured.length = 0;
      queue.length = 0;
    },
    remaining: () => queue.length,
  };
}

function parseBody(raw: string | undefined): unknown {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildFakeResponse(response: FakeResponse): FetchLikeResponse {
  if (response.kind === 'json') {
    const status = response.status ?? 200;
    const text = JSON.stringify(response.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
    };
  }
  if (response.kind === 'text') {
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(response.body),
    };
  }
  if (response.kind === 'empty') {
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(''),
    };
  }
  throw new Error('unreachable: buildFakeResponse called with throw');
}

/* ---------- Canned response bodies ---------- */

/**
 * Build a `POST /v3/session/` response body matching the
 * `CreateSessionResponseSchema` shape.
 */
export function buildCreateSessionResponseBody(
  overrides: {
    session_id?: string;
    session_token?: string;
    session_url?: string;
    workflow_id?: string;
    vendor_data?: string;
    status?: string;
  } = {},
): Record<string, unknown> {
  return {
    session_id: overrides.session_id ?? FIXTURE_SESSION_ID,
    session_token: overrides.session_token ?? 'token_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    session_url: overrides.session_url ?? `${FIXTURE_BASE_URL}/v3/session/${FIXTURE_SESSION_ID}`,
    workflow_id: overrides.workflow_id ?? FIXTURE_KYC_WORKFLOW_ID,
    vendor_data: overrides.vendor_data ?? FIXTURE_VENDOR_DATA,
    status: overrides.status ?? 'Not Started',
  };
}

/**
 * Build a `GET /v3/session/{id}/decision/` response body matching
 * the KYC-workflow `DecisionResponseSchema` happy path.
 */
export function buildKycDecisionBody(
  overrides: {
    session_id?: string;
    workflow_id?: string;
    vendor_data?: string;
    status?: DiditDecisionStatus;
    human_score?: number;
    document_type?: string;
    document_number?: string;
    issuing_country?: string;
    first_name?: string;
    last_name?: string;
    date_of_birth?: string;
    liveness_passed?: boolean;
    liveness_score?: number;
    face_match_passed?: boolean;
    face_match_score?: number;
    created_at?: string;
  } = {},
): Record<string, unknown> {
  return {
    session_id: overrides.session_id ?? FIXTURE_SESSION_ID,
    session_number: 42,
    workflow_id: overrides.workflow_id ?? FIXTURE_KYC_WORKFLOW_ID,
    vendor_data: overrides.vendor_data ?? FIXTURE_VENDOR_DATA,
    status: overrides.status ?? 'Approved',
    created_at: overrides.created_at ?? FIXTURE_NOW.toISOString(),
    human_score: overrides.human_score ?? 95,
    kyc: {
      document_type: overrides.document_type ?? 'PASSPORT',
      document_number: overrides.document_number ?? 'P123456789',
      issuing_country: overrides.issuing_country ?? 'TUR',
      first_name: overrides.first_name ?? 'Ada',
      last_name: overrides.last_name ?? 'Lovelace',
      date_of_birth: overrides.date_of_birth ?? '1815-12-10',
    },
    liveness: {
      passed: overrides.liveness_passed ?? true,
      status: 'live',
      score: overrides.liveness_score ?? 98,
    },
    face_match: {
      passed: overrides.face_match_passed ?? true,
      status: 'match',
      score: overrides.face_match_score ?? 97,
    },
    address: null,
  };
}

/**
 * Build an Address-workflow decision body.
 */
export function buildAddressDecisionBody(
  overrides: {
    session_id?: string;
    workflow_id?: string;
    vendor_data?: string;
    status?: DiditDecisionStatus;
    human_score?: number;
    address_verified?: boolean;
    address_document_type?: string;
    address_country?: string;
    created_at?: string;
  } = {},
): Record<string, unknown> {
  return {
    session_id: overrides.session_id ?? FIXTURE_SESSION_ID,
    session_number: 43,
    workflow_id: overrides.workflow_id ?? FIXTURE_ADDRESS_WORKFLOW_ID,
    vendor_data: overrides.vendor_data ?? FIXTURE_VENDOR_DATA,
    status: overrides.status ?? 'Approved',
    created_at: overrides.created_at ?? FIXTURE_NOW.toISOString(),
    human_score: overrides.human_score ?? 92,
    kyc: null,
    liveness: null,
    face_match: null,
    address: {
      address_verified: overrides.address_verified ?? true,
      document_type: overrides.address_document_type ?? 'UTILITY_BILL',
      country: overrides.address_country ?? 'TUR',
    },
  };
}

/**
 * Build a webhook POST body matching `WebhookBodySchema`. Defaults
 * mirror a KYC Approved notification.
 */
export function buildWebhookBody(
  overrides: {
    session_id?: string;
    workflow_id?: string;
    vendor_data?: string;
    status?: DiditDecisionStatus;
    webhook_type?: string;
    timestamp?: string;
    human_score?: number;
    document_number?: string;
    document_type?: string;
    issuing_country?: string;
    first_name?: string;
    last_name?: string;
    date_of_birth?: string;
  } = {},
): Record<string, unknown> {
  return {
    session_id: overrides.session_id ?? FIXTURE_SESSION_ID,
    workflow_id: overrides.workflow_id ?? FIXTURE_KYC_WORKFLOW_ID,
    vendor_data: overrides.vendor_data ?? FIXTURE_VENDOR_DATA,
    status: overrides.status ?? 'Approved',
    timestamp: overrides.timestamp ?? FIXTURE_NOW.toISOString(),
    // Real Didit V3 event type for session-level decision delivery.
    // Earlier this default was the synthetic `'session.completed'`
    // — a pre-V3 holdover that does not exist in Didit's documented
    // 9 event types. Switched to the canonical `'status.updated'` so
    // the fixture matches the wire format the handler actually
    // receives in production.
    webhook_type: overrides.webhook_type ?? 'status.updated',
    human_score: overrides.human_score ?? 95,
    kyc: {
      document_type: overrides.document_type ?? 'PASSPORT',
      document_number: overrides.document_number ?? 'P123456789',
      issuing_country: overrides.issuing_country ?? 'TUR',
      first_name: overrides.first_name ?? 'Ada',
      last_name: overrides.last_name ?? 'Lovelace',
      date_of_birth: overrides.date_of_birth ?? '1815-12-10',
    },
    liveness: { passed: true, status: 'live', score: 98 },
    face_match: { passed: true, status: 'match', score: 97 },
    address: null,
  };
}

/* ---------- Webhook signature helpers ---------- */

/**
 * Sign a webhook body the same way Didit's dispatcher does: HMAC
 * over `canonicalJson(body)` under the configured secret.
 */
export function signWebhookV2(secret: string, body: unknown): string {
  return createHmac('sha256', secret).update(canonicalJson(body), 'utf8').digest('hex');
}

/**
 * Sign a webhook body with the Simple fallback scheme:
 * HMAC over `${timestamp}:${session_id}:${status}:${webhook_type}`.
 */
export function signWebhookSimple(
  secret: string,
  body: {
    timestamp?: unknown;
    session_id?: unknown;
    status?: unknown;
    webhook_type?: unknown;
  },
): string {
  const payload = [
    typeof body.timestamp === 'string' ? body.timestamp : '',
    typeof body.session_id === 'string' ? body.session_id : '',
    typeof body.status === 'string' ? body.status : '',
    typeof body.webhook_type === 'string' ? body.webhook_type : '',
  ].join(':');
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Build a full verification input (body + headers) with a valid
 * V2 signature + timestamp at `FIXTURE_NOW_SECONDS`. Tests can
 * override any header to produce failure cases.
 */
export function buildSignedWebhookInput(
  secret: string,
  body: unknown,
  headerOverrides: Partial<Record<string, string | undefined>> = {},
): { readonly body: unknown; readonly headers: Record<string, string | undefined> } {
  const signature = signWebhookV2(secret, body);
  const headers: Record<string, string | undefined> = {
    'x-signature-v2': signature,
    'x-timestamp': String(FIXTURE_NOW_SECONDS),
    ...headerOverrides,
  };
  return { body, headers };
}

/* ---------- Canned decision payloads ---------- */

/**
 * Build a reduced `DiditDecisionPayload` for mapping tests. Defaults
 * produce an approved KYC decision matching `buildKycDecisionBody`.
 */
export function buildKycDecisionPayload(
  overrides: Partial<DiditDecisionPayload> = {},
): DiditDecisionPayload {
  return {
    sessionId: FIXTURE_SESSION_ID_BRANDED,
    workflowId: FIXTURE_KYC_WORKFLOW_BRANDED,
    workflowType: 'kyc',
    status: 'Approved',
    vendorData: FIXTURE_VENDOR_DATA_BRANDED,
    humanScore: 95,
    kyc: {
      documentType: 'PASSPORT',
      documentNumber: 'P123456789',
      personalNumber: null,
      issuingCountry: 'TUR',
      issuingState: null,
      firstName: 'Ada',
      lastName: 'Lovelace',
      fullName: 'Ada Lovelace',
      dateOfBirth: '1815-12-10',
      expirationDate: null,
      nationality: null,
    },
    liveness: { passed: true, score: 98 },
    faceMatch: { passed: true, score: 97 },
    address: null,
    faceSearchMatches: [],
    warnings: [],
    ipAnalyses: [],
    failureReasonCode: null,
    failureReasonText: null,
    createdAt: FIXTURE_NOW.toISOString(),
    ...overrides,
  };
}

/**
 * Build a reduced Address decision payload for mapping tests.
 */
export function buildAddressDecisionPayload(
  overrides: Partial<DiditDecisionPayload> = {},
): DiditDecisionPayload {
  return {
    sessionId: FIXTURE_SESSION_ID_BRANDED,
    workflowId: FIXTURE_ADDRESS_WORKFLOW_BRANDED,
    workflowType: 'address',
    status: 'Approved',
    vendorData: FIXTURE_VENDOR_DATA_BRANDED,
    humanScore: 92,
    kyc: null,
    liveness: null,
    faceMatch: null,
    address: {
      addressVerified: true,
      documentType: 'UTILITY_BILL',
      country: 'TUR',
    },
    faceSearchMatches: [],
    warnings: [],
    ipAnalyses: [],
    failureReasonCode: null,
    failureReasonText: null,
    createdAt: FIXTURE_NOW.toISOString(),
    ...overrides,
  };
}
