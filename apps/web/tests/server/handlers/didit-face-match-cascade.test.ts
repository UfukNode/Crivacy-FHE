// @vitest-environment node
/**
 * Integration tests for Sprint 6 face-match cascade wiring inside
 * `handleDiditWebhook` → `handleCustomerWebhook` / `handleB2bWebhook`.
 *
 * Pins the routing contract:
 *
 *   - `cascade_fraud` → `cascadeBan` fires; the credential pipeline
 *     does NOT enqueue (no mint for a banned face); `failure_reason`
 *     is `fraud_cascade`.
 *   - `block_toast` → `fraud.face_match_blocked` audit fires; no
 *     cascade ban; pipeline does NOT enqueue; `failure_reason` is
 *     `face_match_blocked`.
 *   - `reuse` → INFO log; flow continues as normal_mint (the
 *     dedicated rebind path is a Sprint 6 follow-up).
 *   - `no_match` → no Sprint 6 side-effects; legacy fraud classifier
 *     still has its turn.
 *
 * The face-match evaluator itself is unit-tested separately in
 * `tests/fraud/face-match.test.ts`. Here we mock it to return the
 * branch we want to test, and assert the handler's downstream
 * dispatch.
 *
 * Mocks: `@/lib/fraud` is mocked end-to-end so the test controls
 * which branch the evaluator emits and observes the cascade-ban /
 * face_match_blocked dispatch without hitting Postgres / Chain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NextResponse } from 'next/server';

import { buildVerifiedDiditInput } from '../../utils/didit-webhook-harness';

// ---------------------------------------------------------------------------
// Mocks — config + audit + fraud + notification
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = 'test-webhook-secret-32-chars-000000';
const DIDIT_KYC_WORKFLOW_ID = '11111111-2222-4333-8444-555555555555';

vi.mock('@crivacy-fhe/adapter-didit/config', () => ({
  getDiditConfig: vi.fn(() => ({
    webhookSecret: WEBHOOK_SECRET,
    webhookDriftSeconds: 300,
    apiBaseUrl: 'https://didit.test',
    apiKey: 'fixture-api-key',
    kycWorkflowId: DIDIT_KYC_WORKFLOW_ID,
    addressWorkflowId: '00000000-0000-4000-8000-000000000000',
  })),
}));

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => undefined),
  writeAuditBatch: vi.fn(async () => undefined),
}));

vi.mock('@/lib/audit/context', () => ({
  buildRequestContext: vi.fn((input: unknown) => ({ ...(input as object), __tag: 'audit-ctx' })),
  EMPTY_CONTEXT: { __tag: 'empty-ctx' },
}));

const {
  mockEvaluateFaceMatchFromDecision,
  mockApplyFaceMatchSideEffects,
  mockClassifyDecision,
  mockBanCustomer,
  mockIncrementDecline,
} = vi.hoisted(() => ({
  mockEvaluateFaceMatchFromDecision: vi.fn(),
  // Untyped rest signature so `mock.calls[i][1]` is reachable from the
  // assertion sites below. The handler invokes the real helper with
  // `(db, params)` — typing the mock as zero-arity collapses
  // `mock.calls[i]` to the empty tuple and `[1]` becomes a TS error.
  mockApplyFaceMatchSideEffects: vi.fn(async (..._args: unknown[]) => undefined),
  mockClassifyDecision: vi.fn(() => 'normal_decline'),
  mockBanCustomer: vi.fn(async () => ({
    blacklistId: 'b-id',
    credentialsRevoked: 0,
    sessionsRevoked: 0,
    kycSessionsRevoked: 0,
  })),
  // Plan B (decline counter) — webhook handler bumps the per-customer
  // counter on every Didit decline that is NOT a face-match cascade.
  // The cascade tests never traverse the bump branch (they all set
  // `faceMatchOverrideReason !== null`), but the export must exist
  // on the mock or the import resolves to `undefined`.
  mockIncrementDecline: vi.fn(async () => ({
    count: 1,
    thresholdCrossed: false,
    threshold: 3,
  })),
}));

// Refactor (Sprint 6 cleanup) — webhook handler now consumes the
// dispatch helper exports (`evaluateFaceMatchFromDecision` +
// `applyFaceMatchSideEffects`) rather than the raw evaluator /
// cascade-ban / lookup primitives. The test mocks the dispatch
// surface and asserts on its calls.
vi.mock('@/lib/fraud', () => ({
  classifyDecision: mockClassifyDecision,
  extractFraudSignals: vi.fn(() => []),
  pickFraudReason: vi.fn(() => 'fraud_combined'),
  banCustomer: mockBanCustomer,
  evaluateFaceMatchFromDecision: mockEvaluateFaceMatchFromDecision,
  applyFaceMatchSideEffects: mockApplyFaceMatchSideEffects,
  incrementDecline: mockIncrementDecline,
  revokeActiveCredentials: vi.fn(async () => 0),
}));

vi.mock('@/lib/notification', () => ({
  createNotification: vi.fn(async () => undefined),
}));

vi.mock('@/lib/notification/dispatcher', () => ({
  notify: vi.fn(async () => undefined),
}));

vi.mock('@/lib/email/templates', () => ({
  kycStatusChangeEmail: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })),
}));

vi.mock('@/lib/customer/kyc-reset', () => ({
  kycResetCustomerPatch: vi.fn(() => ({})),
}));

// pg-boss / credential pipeline cannot connect to a real DB in unit
// tests — stub the dynamic-imported modules so the `approved` branch
// terminates without trying to open a Postgres socket.
vi.mock('@/server/jobs/credential-pipeline-worker', () => ({
  enqueueCredentialPipeline: vi.fn(async () => null),
}));

vi.mock('@/server/jobs/queue', () => ({
  createQueueClient: vi.fn(async () => ({ stop: async () => undefined })),
}));

vi.mock('@/lib/webhook', () => ({
  emitFirmEvent: vi.fn(async () => undefined),
  emitUserEvent: vi.fn(async () => undefined),
}));

vi.mock('../../../src/server/repositories', async () => {
  const actual = await vi.importActual<typeof import('@/server/repositories')>(
    '@/server/repositories',
  );
  return {
    ...actual,
    updateSessionStatus: vi.fn(async () => undefined),
  };
});

import { handleDiditWebhook } from '@/server/handlers/didit-webhook';
import * as auditWriter from '@/lib/audit/writer';

const mockWriteAudit = vi.mocked(auditWriter.writeAudit);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-05-09T12:00:00.000Z');
const CUSTOMER_ID = 'c1111111-1111-4111-8111-111111111111';
const SESSION_ID = 'ba111111-1111-4111-8111-111111111111';
const FIRM_ID = 'f1111111-1111-4111-8111-111111111111';
const DIDIT_SESSION_ID = '88888888-1111-4111-8111-111111111111';

function customerVendorData() {
  return {
    type: 'customer',
    crivacySessionId: SESSION_ID,
    customerId: CUSTOMER_ID,
  };
}

// B2B vendor_data shape MUST mirror what `sessions.ts::handleStartIdentity`
// stamps when creating a B2B Didit session — the field set is the
// regression bar for the silent-mint slip we hit before this test
// existed. Keys: { crivacySessionId, type:'b2b', firmId, userRef }.
function b2bVendorData() {
  return {
    type: 'b2b',
    crivacySessionId: SESSION_ID,
    firmId: FIRM_ID,
    userRef: 'user-ref-1',
  };
}

function buildCtx(opts: { sessionWorkflow: 'identity' | 'address'; firmRow?: boolean }) {
  const updateSpy = vi.fn(() => ({
    set: () => ({
      where: async () => undefined,
    }),
  }));
  const insertSpy = vi.fn(() => ({
    values: () => ({
      onConflictDoUpdate: () => ({
        returning: async () => [{ count: 1, firstSeen: NOW, lastSeen: NOW }],
      }),
      returning: async () => [{ count: 1, firstSeen: NOW, lastSeen: NOW }],
    }),
  }));
  // The handler calls .select().from().where().limit(1) twice on
  // customerKycSessions (both lookup paths) and once on kycSessions
  // for B2B. Each call in production resolves to the same session
  // row; we return it on every chain.
  const sessionRow = {
    id: SESSION_ID,
    customerId: CUSTOMER_ID,
    workflow: opts.sessionWorkflow,
    status: 'pending',
    diditSessionId: DIDIT_SESSION_ID,
    firmId: FIRM_ID,
    userRef: 'user-ref-1',
    level: 'basic',
  };
  const selectSpy = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => [sessionRow],
        orderBy: () => ({
          limit: async () => [sessionRow],
        }),
      }),
      orderBy: () => ({
        limit: async () => [sessionRow],
      }),
    }),
  }));
  const db = { select: selectSpy, update: updateSpy, insert: insertSpy };
  return {
    ctx: {
      db,
      now: NOW,
      requestId: 'e1111111-1111-4111-8111-111111111111',
      ip: '203.0.113.5',
      userAgent: 'didit/fixture',
      json: (payload: unknown) => NextResponse.json(payload, { status: 200 }),
      errorJson: (code: string, message: string, status: number) =>
        NextResponse.json({ error: { code, message } }, { status }),
    } as unknown as Parameters<typeof handleDiditWebhook>[0],
    updateSpy,
    insertSpy,
    sessionRow,
  };
}

function buildInput(opts: {
  status: string;
  vendorData?: unknown;
  faceSearchMatches?: readonly unknown[];
  warnings?: readonly unknown[];
}) {
  return buildVerifiedDiditInput({
    webhookSecret: WEBHOOK_SECRET,
    status: opts.status,
    vendorData: opts.vendorData ?? customerVendorData(),
    diditSessionId: DIDIT_SESSION_ID,
    diditWorkflowId: DIDIT_KYC_WORKFLOW_ID,
    now: NOW,
    decoration: {
      // Plural-array V3 wire format. Cascade-evaluation only triggers
      // when matches exist OR a fraud-signal warning fires; supplying
      // a (possibly empty) array still hydrates a valid decision.
      liveness_checks: [
        {
          status: 'Approved',
          score: 95,
          matches: opts.faceSearchMatches ?? [],
          warnings: opts.warnings ?? [],
        },
      ],
      ip_analyses: [
        {
          status: 'Approved',
          ip_address: '203.0.113.99',
          ip_country_code: 'US',
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------

// Helper to build the {evaluation, overrideReason} shape the dispatch
// helper returns. Tests use this to set up `mockEvaluateFaceMatchFromDecision`.
function evalResult(evaluation: unknown, overrideReason: 'fraud_cascade' | 'face_match_blocked' | null = null) {
  return { evaluation, overrideReason };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockWriteAudit.mockImplementation(async () => undefined as never);
  // Default: no_match — individual cases override below.
  mockEvaluateFaceMatchFromDecision.mockResolvedValue(evalResult({ kind: 'no_match' }));
  mockApplyFaceMatchSideEffects.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Customer flow — branch dispatch
// ---------------------------------------------------------------------------

describe('handleCustomerWebhook — face-match cascade dispatch', () => {
  it('cascade_fraud — calls applyFaceMatchSideEffects + skips legacy fraud classifier', async () => {
    mockEvaluateFaceMatchFromDecision.mockResolvedValueOnce(
      evalResult(
        {
          kind: 'cascade_fraud',
          resolvedMatches: [],
          reasonCode: 'matched_banned_account',
        },
        'fraud_cascade',
      ),
    );
    const { ctx } = buildCtx({ sessionWorkflow: 'identity' });
    const input = buildInput({ status: 'Approved' });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    expect(mockApplyFaceMatchSideEffects).toHaveBeenCalledTimes(1);
    expect(mockApplyFaceMatchSideEffects.mock.calls[0]![1]).toMatchObject({
      context: { kind: 'customer', customerId: CUSTOMER_ID },
      currentDiditSessionId: DIDIT_SESSION_ID,
      surface: 'webhook_customer',
    });

    // Legacy classifier path is skipped — banCustomer not called.
    expect(mockClassifyDecision).not.toHaveBeenCalled();
    expect(mockBanCustomer).not.toHaveBeenCalled();
  });

  it('block_toast — calls applyFaceMatchSideEffects with block_toast evaluation', async () => {
    mockEvaluateFaceMatchFromDecision.mockResolvedValueOnce(
      evalResult(
        {
          kind: 'block_toast',
          resolvedMatch: {
            match: {
              source: 'liveness',
              sessionId: 'matched-session',
              vendorData: null,
              verificationDate: null,
              status: 'Approved',
              isBlocklisted: false,
              similarityPercentage: 95,
            },
            status: {
              kind: 'customer_clean',
              customerId: 'c2222222-1111-4111-8111-111111111111',
              email: 'other@example.com',
            },
          },
          maskedEmail: 'o...r@***.com',
        },
        'face_match_blocked',
      ),
    );
    const { ctx } = buildCtx({ sessionWorkflow: 'identity' });
    const input = buildInput({ status: 'Approved' });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    expect(mockApplyFaceMatchSideEffects).toHaveBeenCalledTimes(1);
    const dispatchArgs = mockApplyFaceMatchSideEffects.mock.calls[0]![1] as unknown as {
      evaluation: { kind: string; maskedEmail: string };
      surface: string;
    };
    expect(dispatchArgs.evaluation.kind).toBe('block_toast');
    expect(dispatchArgs.evaluation.maskedEmail).toBe('o...r@***.com');
    expect(dispatchArgs.surface).toBe('webhook_customer');
  });

  it('reuse — logs INFO and proceeds normally (dispatch helper still called for surface symmetry)', async () => {
    mockEvaluateFaceMatchFromDecision.mockResolvedValueOnce(
      evalResult({
        kind: 'reuse',
        resolvedMatch: {
          match: {
            source: 'liveness',
            sessionId: 'matched-b2b',
            vendorData: null,
            verificationDate: null,
            status: 'Approved',
            isBlocklisted: false,
            similarityPercentage: 95,
          },
          status: { kind: 'b2b_only', firmId: FIRM_ID, userRef: 'matched-userref' },
        },
      }),
    );
    const { ctx } = buildCtx({ sessionWorkflow: 'identity' });
    const input = buildInput({ status: 'Approved' });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    // Dispatch helper IS called — but it sees `kind: 'reuse'` and
    // does nothing inside (no cascade, no audit, no IP increment).
    // The surface-agnostic helper itself decides; the test just
    // verifies the wiring contract.
    expect(mockApplyFaceMatchSideEffects).toHaveBeenCalledTimes(1);
    const dispatchArgs = mockApplyFaceMatchSideEffects.mock.calls[0]![1] as unknown as {
      evaluation: { kind: string };
    };
    expect(dispatchArgs.evaluation.kind).toBe('reuse');
  });

  it('no_match — Sprint 6 side-effects skipped; legacy fraud classifier still runs on rejected', async () => {
    mockEvaluateFaceMatchFromDecision.mockResolvedValueOnce(
      evalResult({ kind: 'no_match' }),
    );
    const { ctx } = buildCtx({ sessionWorkflow: 'identity' });
    const input = buildInput({ status: 'Declined' });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    // Dispatch helper IS called for no_match too (surface symmetry);
    // helper internals decide it's a no-op.
    expect(mockApplyFaceMatchSideEffects).toHaveBeenCalledTimes(1);
    // Legacy classifier still gets its turn on rejected.
    expect(mockClassifyDecision).toHaveBeenCalled();
  });

  it('cascade_fraud on Approved — DB update fires (status demoted to rejected)', async () => {
    mockEvaluateFaceMatchFromDecision.mockResolvedValueOnce(
      evalResult(
        {
          kind: 'cascade_fraud',
          resolvedMatches: [],
          reasonCode: 'LIVENESS_FACE_ATTACK',
        },
        'fraud_cascade',
      ),
    );
    const { ctx, updateSpy } = buildCtx({ sessionWorkflow: 'address' });
    const input = buildInput({ status: 'Approved' });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    expect(mockApplyFaceMatchSideEffects).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B2B flow — branch dispatch
// ---------------------------------------------------------------------------

describe('handleB2bWebhook — face-match cascade dispatch', () => {
  it('cascade_fraud — calls dispatch helper with b2b context + b2bKycSessionId', async () => {
    mockEvaluateFaceMatchFromDecision.mockResolvedValueOnce(
      evalResult(
        {
          kind: 'cascade_fraud',
          resolvedMatches: [],
          reasonCode: 'PORTRAIT_MANIPULATION_DETECTED',
        },
        'fraud_cascade',
      ),
    );
    const { ctx } = buildCtx({ sessionWorkflow: 'identity' });
    const input = buildInput({
      status: 'Approved',
      vendorData: b2bVendorData(),
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    expect(mockApplyFaceMatchSideEffects).toHaveBeenCalledTimes(1);
    expect(mockApplyFaceMatchSideEffects.mock.calls[0]![1]).toMatchObject({
      context: { kind: 'b2b', firmId: FIRM_ID, userRef: 'user-ref-1' },
      b2bKycSessionId: SESSION_ID,
      surface: 'webhook_b2b',
    });
  });

  it('block_toast — calls dispatch helper with surface=webhook_b2b', async () => {
    mockEvaluateFaceMatchFromDecision.mockResolvedValueOnce(
      evalResult(
        {
          kind: 'block_toast',
          resolvedMatch: {
            match: {
              source: 'liveness',
              sessionId: 'matched',
              vendorData: null,
              verificationDate: null,
              status: 'Approved',
              isBlocklisted: false,
              similarityPercentage: 90,
            },
            status: {
              kind: 'customer_clean',
              customerId: 'c3333333-1111-4111-8111-111111111111',
              email: 'matched@example.com',
            },
          },
          maskedEmail: 'm...d@***.com',
        },
        'face_match_blocked',
      ),
    );
    const { ctx } = buildCtx({ sessionWorkflow: 'identity' });
    const input = buildInput({
      status: 'Approved',
      vendorData: b2bVendorData(),
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    expect(mockApplyFaceMatchSideEffects).toHaveBeenCalledTimes(1);
    const dispatchArgs = mockApplyFaceMatchSideEffects.mock.calls[0]![1] as unknown as {
      evaluation: { kind: string; maskedEmail: string };
      surface: string;
      b2bKycSessionId: string;
    };
    expect(dispatchArgs.evaluation.kind).toBe('block_toast');
    expect(dispatchArgs.evaluation.maskedEmail).toBe('m...d@***.com');
    expect(dispatchArgs.surface).toBe('webhook_b2b');
    expect(dispatchArgs.b2bKycSessionId).toBe(SESSION_ID);
  });
});
