// @vitest-environment node
/**
 * Didit webhook — status mapping tests for Batch A.
 *
 * Pins the 2026-05-07 status fix:
 *
 *   - "In Review"   → `in_review`     (was: collapsed onto `in_progress`)
 *   - "Not Started" → `pending`       (was: dropped into unknown-status branch)
 *   - In Review path also writes a `customer.kyc_in_review` audit row
 *     (symmetric to `customer.kyc_failed` for Declined).
 *
 * The handler is exercised through `handleDiditWebhook` so the HMAC
 * verifier runs end-to-end. The DB is stubbed; the assertions key off
 * the `update().set(...)` call so the test sees exactly what status
 * value the handler tried to persist.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDiditWebhook } from '@/server/handlers/didit-webhook';
import {
  buildVerifiedDiditInput,
  buildCustomerWebhookCtx,
  type MockSessionRow,
} from '../../utils/didit-webhook-harness';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = 'test-webhook-secret-32-chars-000000';

vi.mock('@crivacy-fhe/adapter-didit/config', () => ({
  getDiditConfig: vi.fn(() => ({
    webhookSecret: WEBHOOK_SECRET,
    webhookDriftSeconds: 300,
    apiBaseUrl: 'https://didit.test',
    apiKey: 'fixture-api-key',
    // `resolveWorkflowType` falls back to 'kyc' when
    // `failClosedOnUnknownWorkflow` is unset (and our fixture
    // workflow_id matches neither kyc/address). That is the
    // intentional dev-mode permissive behaviour; the workflow-id
    // gate is not the subject under test in this file.
  })),
}));

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/audit/context', () => ({
  buildRequestContext: vi.fn((input: unknown) => ({ ...(input as object), __tag: 'audit-ctx' })),
}));

vi.mock('@/lib/notification', () => ({
  createNotification: vi.fn(async () => undefined),
}));

vi.mock('@/lib/webhook', () => ({
  emitUserEvent: vi.fn(async () => undefined),
}));

import * as auditWriter from '@/lib/audit/writer';
import * as webhookModule from '@/lib/webhook';
const mockWriteAudit = vi.mocked(auditWriter.writeAudit);
const mockEmitUserEvent = vi.mocked(webhookModule.emitUserEvent);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = new Date('2026-05-07T12:00:00.000Z').getTime();
const NOW = new Date(NOW_MS);
const CUSTOMER_ID = 'c1111111-1111-4111-8111-111111111111';
const SESSION_ID = 'ba111111-1111-4111-8111-111111111111';
const DIDIT_SESSION_ID = 'didit-session-abc';

// Local helpers wrap the shared harness with the file-scoped secret
// + clock so individual `it(...)` blocks stay readable.
function buildVerifiedInput(opts: { status: string; vendorData: unknown }) {
  return buildVerifiedDiditInput({
    webhookSecret: WEBHOOK_SECRET,
    status: opts.status,
    vendorData: opts.vendorData,
    diditSessionId: DIDIT_SESSION_ID,
    now: NOW,
  });
}

function buildCustomerCtx(sessionRow: MockSessionRow) {
  return buildCustomerWebhookCtx(sessionRow, { now: NOW });
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAudit.mockImplementation(async () => undefined as never);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('handleDiditWebhook — In Review status (2026-05-07 fix)', () => {
  const sessionRow: MockSessionRow = {
    id: SESSION_ID,
    customerId: CUSTOMER_ID,
    diditSessionId: DIDIT_SESSION_ID,
    workflow: 'identity',
    status: 'in_progress',
  };

  it('maps "In Review" to the new in_review enum value (not in_progress)', async () => {
    const { ctx, setCalls } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'In Review',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    // The handler must have called update().set({ status: 'in_review', ... }).
    // Pre-fix the value was 'in_progress' — the assertion would fail
    // against the old code, which is exactly the regression guard we want.
    const sessionUpdate = setCalls.find((call) => 'status' in call);
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate!['status']).toBe('in_review');

    // Not terminal — completedAt must NOT be stamped.
    expect(sessionUpdate!['completedAt']).toBeUndefined();
  });

  it('writes a customer.kyc_in_review audit row with the session metadata', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'In Review',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    await handleDiditWebhook(ctx, input);

    const inReviewAudit = mockWriteAudit.mock.calls.find((call) => {
      const payload = call[1] as { action: string };
      return payload.action === 'customer.kyc_in_review';
    });
    expect(inReviewAudit).toBeDefined();

    const auditPayload = inReviewAudit![1] as unknown as {
      action: string;
      target: { kind: string; id: string };
      meta: { sessionId: string; diditSessionId: string; workflow: string; rawStatus: string };
    };
    expect(auditPayload.target.kind).toBe('customer');
    expect(auditPayload.target.id).toBe(CUSTOMER_ID);
    expect(auditPayload.meta.sessionId).toBe(SESSION_ID);
    expect(auditPayload.meta.diditSessionId).toBe(DIDIT_SESSION_ID);
    expect(auditPayload.meta.workflow).toBe('identity');
    expect(auditPayload.meta.rawStatus).toBe('in_review');
  });

  it('does NOT write a customer.kyc_failed audit (rejection path is mutually exclusive)', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'In Review',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    await handleDiditWebhook(ctx, input);

    const failedAudit = mockWriteAudit.mock.calls.find((call) => {
      const payload = call[1] as { action: string };
      return payload.action === 'customer.kyc_failed';
    });
    expect(failedAudit).toBeUndefined();
  });

  it('emits kyc.session.in_review firm webhook event with the session payload', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'In Review',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    await handleDiditWebhook(ctx, input);

    expect(mockEmitUserEvent).toHaveBeenCalledTimes(1);
    const [, emitArg] = mockEmitUserEvent.mock.calls[0]!;
    expect(emitArg.type).toBe('kyc.session.in_review');
    expect(emitArg.idempotencyKey).toBe(`kyc.session.in_review:${SESSION_ID}`);
    expect(emitArg.sourceSessionId).toBe(SESSION_ID);
    expect(emitArg.payload).toMatchObject({
      sessionId: SESSION_ID,
      userRef: CUSTOMER_ID,
      workflow: 'identity',
      inReviewAt: NOW.toISOString(),
    });
  });
});

describe('handleDiditWebhook — Not Started status (2026-05-07 fix)', () => {
  const sessionRow: MockSessionRow = {
    id: SESSION_ID,
    customerId: CUSTOMER_ID,
    diditSessionId: DIDIT_SESSION_ID,
    workflow: 'identity',
    status: 'pending',
  };

  it('maps "Not Started" to pending — no unknown-status audit row', async () => {
    const { ctx, setCalls } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Not Started',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    // Status persists as 'pending' (the row was already pending; the
    // handler reaffirms it via the regular customer-flow update).
    const sessionUpdate = setCalls.find((call) => 'status' in call);
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate!['status']).toBe('pending');

    // Critically: the unknown-status branch must NOT have fired —
    // pre-fix "Not Started" fell into it, polluting SOC observability
    // with audit rows for a normal lifecycle transition.
    const unknownAudit = mockWriteAudit.mock.calls.find((call) => {
      const payload = call[1] as { action: string };
      return payload.action === 'kyc_session.webhook_unknown_status';
    });
    expect(unknownAudit).toBeUndefined();
  });
});

describe('handleDiditWebhook — Cancelled / Failed retired (2026-05-07 fix)', () => {
  // The legacy V2 statusMap carried Cancelled (→ expired) and Failed
  // (→ rejected). Neither value appears in Didit V3 docs; they were
  // dead branches masking observability for any genuinely-new value
  // Didit might ship. After the 2026-05-07 fix both fall into the
  // unknown-status branch (audit row + 200 ack + payload persisted).
  const sessionRow: MockSessionRow = {
    id: SESSION_ID,
    customerId: CUSTOMER_ID,
    diditSessionId: DIDIT_SESSION_ID,
    workflow: 'identity',
    status: 'in_progress',
  };

  it('"Cancelled" now hits the unknown-status branch (was: silently mapped to expired)', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Cancelled',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    const unknownAudit = mockWriteAudit.mock.calls.find((call) => {
      const payload = call[1] as { action: string };
      return payload.action === 'kyc_session.webhook_unknown_status';
    });
    expect(unknownAudit).toBeDefined();
  });

  it('"Failed" now hits the unknown-status branch (was: silently mapped to rejected)', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Failed',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    const unknownAudit = mockWriteAudit.mock.calls.find((call) => {
      const payload = call[1] as { action: string };
      return payload.action === 'kyc_session.webhook_unknown_status';
    });
    expect(unknownAudit).toBeDefined();
  });
});
