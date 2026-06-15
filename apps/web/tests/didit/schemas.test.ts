/**
 * Tests for the Zod schemas that validate the Didit wire surface.
 *
 * The schemas are the ground-truth contract between this module and
 * the upstream Didit API. Any shape drift on their side surfaces
 * here as a single failure — the exact field, the exact constraint,
 * and the exact path. We pin:
 *
 *   * Required field presence on the session create + decision +
 *     webhook bodies.
 *   * The lowercase UUID regex for `workflow_id` (uppercase rejected
 *     on purpose so a caller that forwards Didit's old mixed-case
 *     format fails loudly).
 *   * 0..100 score range on liveness / face_match / human_score.
 *   * `.passthrough()` semantics: unknown fields must ride along so
 *     a new Didit field does not break the parse.
 *   * The structured error body is forgiving — every field optional.
 */

import { describe, expect, it } from 'vitest';

import {
  AddressBlockSchema,
  CreateSessionResponseSchema,
  DecisionResponseSchema,
  DiditApiErrorSchema,
  FaceMatchBlockSchema,
  KycDocumentBlockSchema,
  LivenessBlockSchema,
  WebhookBodySchema,
} from '@crivacy-fhe/adapter-didit';

import {
  FIXTURE_ADDRESS_WORKFLOW_ID,
  FIXTURE_KYC_WORKFLOW_ID,
  FIXTURE_NOW,
  FIXTURE_SESSION_ID,
  FIXTURE_VENDOR_DATA,
  buildAddressDecisionBody,
  buildCreateSessionResponseBody,
  buildKycDecisionBody,
  buildWebhookBody,
} from './fixtures';

/* ---------- DiditApiErrorSchema ---------- */

describe('DiditApiErrorSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    const parsed = DiditApiErrorSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('accepts the full canonical error shape', () => {
    const parsed = DiditApiErrorSchema.safeParse({
      detail: 'invalid api key',
      code: 'unauthorized',
      message: 'The api key is invalid',
      error: 'unauthorized',
      status: '401',
      request_id: 'req_123',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.detail).toBe('invalid api key');
      expect(parsed.data.code).toBe('unauthorized');
      expect(parsed.data.request_id).toBe('req_123');
    }
  });

  it('rides unknown fields through via passthrough', () => {
    const parsed = DiditApiErrorSchema.safeParse({ detail: 'x', extra_field: 'y' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)['extra_field']).toBe('y');
    }
  });

  it('rejects a non-string detail field', () => {
    const parsed = DiditApiErrorSchema.safeParse({ detail: 123 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a primitive instead of an object', () => {
    expect(DiditApiErrorSchema.safeParse('oops').success).toBe(false);
    expect(DiditApiErrorSchema.safeParse(42).success).toBe(false);
    expect(DiditApiErrorSchema.safeParse(null).success).toBe(false);
  });
});

/* ---------- CreateSessionResponseSchema ---------- */

describe('CreateSessionResponseSchema', () => {
  it('accepts the canonical create-session body', () => {
    const body = buildCreateSessionResponseBody();
    const parsed = CreateSessionResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.session_id).toBe(FIXTURE_SESSION_ID);
      expect(parsed.data.workflow_id).toBe(FIXTURE_KYC_WORKFLOW_ID);
      expect(parsed.data.vendor_data).toBe(FIXTURE_VENDOR_DATA);
      expect(parsed.data.status).toBe('Not Started');
    }
  });

  it('rejects a missing session_id', () => {
    const body = buildCreateSessionResponseBody();
    Reflect.deleteProperty(body as Record<string, unknown>, 'session_id');
    expect(CreateSessionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a session_id shorter than 8 chars', () => {
    const body = buildCreateSessionResponseBody({ session_id: 'short' });
    expect(CreateSessionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a session_id longer than 256 chars', () => {
    const body = buildCreateSessionResponseBody({ session_id: 's'.repeat(257) });
    expect(CreateSessionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a missing session_token', () => {
    const body = buildCreateSessionResponseBody();
    Reflect.deleteProperty(body as Record<string, unknown>, 'session_token');
    expect(CreateSessionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a session_url that is not a URL', () => {
    const body = buildCreateSessionResponseBody({ session_url: 'not a url' });
    expect(CreateSessionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an uppercase workflow_id (lowercase pin)', () => {
    const body = buildCreateSessionResponseBody({
      workflow_id: FIXTURE_KYC_WORKFLOW_ID.toUpperCase(),
    });
    expect(CreateSessionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a non-UUID workflow_id', () => {
    const body = buildCreateSessionResponseBody({ workflow_id: 'not-a-uuid-value' });
    expect(CreateSessionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an empty vendor_data', () => {
    const body = buildCreateSessionResponseBody({ vendor_data: '' });
    expect(CreateSessionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an empty status', () => {
    const body = buildCreateSessionResponseBody({ status: '' });
    expect(CreateSessionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('passes unknown fields through', () => {
    const body = { ...buildCreateSessionResponseBody(), new_field: 'v' };
    const parsed = CreateSessionResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)['new_field']).toBe('v');
    }
  });
});

/* ---------- KycDocumentBlockSchema ---------- */

describe('KycDocumentBlockSchema', () => {
  it('accepts an all-nullable block', () => {
    const parsed = KycDocumentBlockSchema.safeParse({
      document_type: null,
      document_number: null,
      issuing_country: null,
      first_name: null,
      last_name: null,
      date_of_birth: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty block (every field optional)', () => {
    expect(KycDocumentBlockSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a fully populated block', () => {
    const parsed = KycDocumentBlockSchema.safeParse({
      document_type: 'PASSPORT',
      document_number: 'P123',
      issuing_country: 'TUR',
      first_name: 'Ada',
      last_name: 'Lovelace',
      date_of_birth: '1815-12-10',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty issuing_country (min length 2)', () => {
    expect(KycDocumentBlockSchema.safeParse({ issuing_country: 'T' }).success).toBe(false);
  });

  it('rides unknown fields through', () => {
    const parsed = KycDocumentBlockSchema.safeParse({ first_name: 'Ada', raw_source: 'ocr' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)['raw_source']).toBe('ocr');
    }
  });
});

/* ---------- LivenessBlockSchema ---------- */

describe('LivenessBlockSchema', () => {
  it('accepts a canonical block', () => {
    const parsed = LivenessBlockSchema.safeParse({ passed: true, status: 'live', score: 98 });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty block', () => {
    expect(LivenessBlockSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a score below 0', () => {
    expect(LivenessBlockSchema.safeParse({ score: -0.1 }).success).toBe(false);
  });

  it('rejects a score above 100', () => {
    expect(LivenessBlockSchema.safeParse({ score: 100.1 }).success).toBe(false);
  });

  it('accepts a float score (coerced in the mapping layer)', () => {
    const parsed = LivenessBlockSchema.safeParse({ score: 98.6 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.score).toBe(98.6);
    }
  });

  // V3 wire format: `passed` is no longer a schema-defined field. The
  // canonical signal is `status` ('Approved' / 'Declined' / etc.), and
  // `passed` is derived in `hydrateDecisionResponse`. Anything Didit
  // sends in the legacy `passed` slot rides through `.passthrough()`
  // without bool-checking.
  it('lets a legacy V2 passed field ride through (passthrough, no bool-check)', () => {
    expect(LivenessBlockSchema.safeParse({ passed: 'yes' }).success).toBe(true);
  });
});

/* ---------- FaceMatchBlockSchema ---------- */

describe('FaceMatchBlockSchema', () => {
  it('accepts a canonical block', () => {
    const parsed = FaceMatchBlockSchema.safeParse({ passed: true, score: 97 });
    expect(parsed.success).toBe(true);
  });

  it('enforces the same 0..100 score range as liveness', () => {
    expect(FaceMatchBlockSchema.safeParse({ score: 101 }).success).toBe(false);
    expect(FaceMatchBlockSchema.safeParse({ score: -1 }).success).toBe(false);
  });
});

/* ---------- AddressBlockSchema ---------- */

describe('AddressBlockSchema', () => {
  it('accepts a canonical block', () => {
    const parsed = AddressBlockSchema.safeParse({
      address_verified: true,
      document_type: 'UTILITY_BILL',
      country: 'TUR',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty block', () => {
    expect(AddressBlockSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a null document_type', () => {
    expect(
      AddressBlockSchema.safeParse({
        address_verified: false,
        document_type: null,
        country: null,
      }).success,
    ).toBe(true);
  });

  // Same as LivenessBlockSchema: V3 derives `addressVerified` from `status`;
  // legacy `address_verified` is no longer a schema-defined field and rides
  // through `.passthrough()`.
  it('lets a legacy V2 address_verified ride through (passthrough, no bool-check)', () => {
    expect(AddressBlockSchema.safeParse({ address_verified: 'true' }).success).toBe(true);
  });
});

/* ---------- DecisionResponseSchema ---------- */

describe('DecisionResponseSchema', () => {
  it('accepts a canonical KYC decision body', () => {
    const parsed = DecisionResponseSchema.safeParse(buildKycDecisionBody());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('Approved');
      expect(parsed.data.workflow_id).toBe(FIXTURE_KYC_WORKFLOW_ID);
    }
  });

  it('accepts a canonical Address decision body', () => {
    const parsed = DecisionResponseSchema.safeParse(buildAddressDecisionBody());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.workflow_id).toBe(FIXTURE_ADDRESS_WORKFLOW_ID);
    }
  });

  it('accepts each of the nine documented statuses', () => {
    for (const status of [
      'Not Started',
      'In Progress',
      'In Review',
      'Resubmitted',
      'Approved',
      'Declined',
      'Expired',
      'Abandoned',
      'Kyc Expired',
    ] as const) {
      const parsed = DecisionResponseSchema.safeParse(buildKycDecisionBody({ status }));
      expect(parsed.success).toBe(true);
    }
  });

  // Status is now `z.string().min(1).max(64)` (forward-compatible). Mapping
  // layer + handler reduce unknown tokens to a fall-through outcome rather
  // than turning them into parse errors. See DC1 / DIDIT_STATUS notes.
  it('accepts an unknown status token (forward-compatible)', () => {
    const body = { ...buildKycDecisionBody(), status: 'MaybeApproved' };
    expect(DecisionResponseSchema.safeParse(body).success).toBe(true);
  });

  it('rejects an empty status string', () => {
    const body = { ...buildKycDecisionBody(), status: '' };
    expect(DecisionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a missing session_id', () => {
    const body = buildKycDecisionBody();
    Reflect.deleteProperty(body as Record<string, unknown>, 'session_id');
    expect(DecisionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a missing workflow_id', () => {
    const body = buildKycDecisionBody();
    Reflect.deleteProperty(body as Record<string, unknown>, 'workflow_id');
    expect(DecisionResponseSchema.safeParse(body).success).toBe(false);
  });

  // Didit's GET /v3/session/{id}/decision/ omits `created_at` empirically
  // (confirmed 2026-05-07). Hydrate defaults to '' when absent.
  it('accepts a missing created_at (V3 omits it on the decision GET)', () => {
    const body = buildKycDecisionBody();
    Reflect.deleteProperty(body as Record<string, unknown>, 'created_at');
    expect(DecisionResponseSchema.safeParse(body).success).toBe(true);
  });

  it('accepts a null kyc block', () => {
    const parsed = DecisionResponseSchema.safeParse({ ...buildKycDecisionBody(), kyc: null });
    expect(parsed.success).toBe(true);
  });

  it('accepts a null liveness block', () => {
    const parsed = DecisionResponseSchema.safeParse({
      ...buildKycDecisionBody(),
      liveness: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a null face_match block', () => {
    const parsed = DecisionResponseSchema.safeParse({
      ...buildKycDecisionBody(),
      face_match: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a null human_score', () => {
    const parsed = DecisionResponseSchema.safeParse({
      ...buildKycDecisionBody(),
      human_score: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a human_score above 100', () => {
    const parsed = DecisionResponseSchema.safeParse({
      ...buildKycDecisionBody(),
      human_score: 101,
    });
    expect(parsed.success).toBe(false);
  });

  it('rides unknown root fields through', () => {
    const body = { ...buildKycDecisionBody(), next_field: 'x' };
    const parsed = DecisionResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)['next_field']).toBe('x');
    }
  });

  it('preserves session_number as an int', () => {
    const parsed = DecisionResponseSchema.safeParse(buildKycDecisionBody());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.session_number).toBe(42);
    }
  });

  it('rejects a non-integer session_number', () => {
    const body = { ...buildKycDecisionBody(), session_number: 42.5 };
    expect(DecisionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('accepts a created_at as an ISO string', () => {
    const body = buildKycDecisionBody({ created_at: FIXTURE_NOW.toISOString() });
    const parsed = DecisionResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });
});

/* ---------- WebhookBodySchema ---------- */

describe('WebhookBodySchema', () => {
  it('accepts a canonical webhook body', () => {
    const parsed = WebhookBodySchema.safeParse(buildWebhookBody());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Updated 2026-05-08: fixture default switched from synthetic
      // 'session.completed' (not in Didit's documented event types) to
      // canonical V3 'status.updated'. See fixtures.ts comment.
      expect(parsed.data.webhook_type).toBe('status.updated');
      expect(parsed.data.status).toBe('Approved');
    }
  });

  it('accepts a body without timestamp + webhook_type (both optional)', () => {
    const body = buildWebhookBody();
    Reflect.deleteProperty(body as Record<string, unknown>, 'timestamp');
    Reflect.deleteProperty(body as Record<string, unknown>, 'webhook_type');
    expect(WebhookBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects an empty timestamp', () => {
    const parsed = WebhookBodySchema.safeParse(buildWebhookBody({ timestamp: '' }));
    expect(parsed.success).toBe(false);
  });

  it('rejects a webhook_type longer than 64 chars', () => {
    const parsed = WebhookBodySchema.safeParse(buildWebhookBody({ webhook_type: 'x'.repeat(65) }));
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing session_id', () => {
    const body = buildWebhookBody();
    Reflect.deleteProperty(body as Record<string, unknown>, 'session_id');
    expect(WebhookBodySchema.safeParse(body).success).toBe(false);
  });

  // Forward-compatible: webhook body status is `z.string().min(1).max(64)`.
  // Handler reduces unknown tokens to a fall-through audit branch rather than
  // a hard parse error (avoids converting a recoverable payload into an outage).
  it('accepts an unknown status token (forward-compatible)', () => {
    const body = { ...buildWebhookBody(), status: 'NotAThing' };
    expect(WebhookBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects an empty status string', () => {
    const body = { ...buildWebhookBody(), status: '' };
    expect(WebhookBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts an uppercase UUID workflow_id rejection (lowercase pin)', () => {
    const body = buildWebhookBody({ workflow_id: FIXTURE_KYC_WORKFLOW_ID.toUpperCase() });
    expect(WebhookBodySchema.safeParse(body).success).toBe(false);
  });

  it('rides unknown fields through', () => {
    const body = { ...buildWebhookBody(), raw_event_id: 'evt_1' };
    const parsed = WebhookBodySchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)['raw_event_id']).toBe('evt_1');
    }
  });
});
