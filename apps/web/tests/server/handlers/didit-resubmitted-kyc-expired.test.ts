// @vitest-environment node
/**
 * Didit webhook — Batch B status mapping tests.
 *
 *   "Resubmitted" → `resubmission_pending` + parses `resubmit_info`
 *                   into the structured `resubmissionInfo` column,
 *                   writes `customer.kyc_resubmission_requested`
 *                   audit, pushes a localized notification, does NOT
 *                   enqueue the credential pipeline.
 *
 *   "Kyc Expired" → `kyc_expired` (terminal) + invokes
 *                   `revokeActiveCredentials` (Chain + DB + firm
 *                   webhook fan-out), resets `customers.kyc_level` to
 *                   `kyc_0`, writes `customer.kyc_expired` audit,
 *                   pushes a localized notification.
 *
 * The handler runs end-to-end through `handleDiditWebhook` so the
 * HMAC verifier, statusMap, and side-effect helpers all execute.
 * `revokeActiveCredentials` and `createNotification` are mocked so
 * the test can pin call shape without booting Chain or pg-boss.
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

vi.mock('@/lib/notification/dispatcher', () => ({
  notify: vi.fn(async () => ({ notificationCreated: true, emailEnqueued: true })),
}));

vi.mock('@/lib/fraud', async () => {
  const actual = await vi.importActual<typeof import('@/lib/fraud')>('@/lib/fraud');
  return {
    ...actual,
    revokeActiveCredentials: vi.fn(async () => 1),
    banCustomer: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/webhook', () => ({
  emitUserEvent: vi.fn(async () => undefined),
}));

import * as auditWriter from '@/lib/audit/writer';
import * as fraudModule from '@/lib/fraud';
import * as notificationModule from '@/lib/notification';
import * as dispatcherModule from '@/lib/notification/dispatcher';
import * as webhookModule from '@/lib/webhook';
const mockWriteAudit = vi.mocked(auditWriter.writeAudit);
const mockRevokeActiveCredentials = vi.mocked(fraudModule.revokeActiveCredentials);
const mockCreateNotification = vi.mocked(notificationModule.createNotification);
const mockNotify = vi.mocked(dispatcherModule.notify);
const mockEmitUserEvent = vi.mocked(webhookModule.emitUserEvent);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = new Date('2026-05-07T12:00:00.000Z').getTime();
const NOW = new Date(NOW_MS);
const CUSTOMER_ID = 'c1111111-1111-4111-8111-111111111111';
const SESSION_ID = 'ba111111-1111-4111-8111-111111111111';
const DIDIT_SESSION_ID = 'didit-session-abc';

// Local helpers wrap the shared harness with file-scoped secret +
// clock so individual `it(...)` blocks stay readable.
function buildVerifiedInput(opts: {
  status: string;
  vendorData: unknown;
  decoration?: Record<string, unknown>;
}) {
  return buildVerifiedDiditInput({
    webhookSecret: WEBHOOK_SECRET,
    status: opts.status,
    vendorData: opts.vendorData,
    diditSessionId: DIDIT_SESSION_ID,
    now: NOW,
    ...(opts.decoration !== undefined ? { decoration: opts.decoration } : {}),
  });
}

function buildCustomerCtx(sessionRow: MockSessionRow) {
  return buildCustomerWebhookCtx(sessionRow, { now: NOW });
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAudit.mockImplementation(async () => undefined as never);
  mockRevokeActiveCredentials.mockImplementation(async () => 1);
  mockCreateNotification.mockImplementation(async () => undefined as never);
  mockNotify.mockImplementation(async () => ({
    notificationCreated: true,
    emailEnqueued: true,
  }));
  mockEmitUserEvent.mockImplementation(async () => undefined as never);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('handleDiditWebhook — Resubmitted (Batch B)', () => {
  const sessionRow: MockSessionRow = {
    id: SESSION_ID,
    customerId: CUSTOMER_ID,
    diditSessionId: DIDIT_SESSION_ID,
    workflow: 'identity',
    status: 'in_review',
  };

  it('maps "Resubmitted" to resubmission_pending and persists a typed resubmission_info', async () => {
    const { ctx, setCalls } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Resubmitted',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
      decoration: {
        resubmit_info: {
          nodes_to_resubmit: [
            { node_id: 'feature_ocr', feature: 'OCR' },
            { node_id: 'feature_liveness', feature: 'LIVENESS' },
          ],
          reasons: {
            feature_ocr: 'Document image is blurry or unreadable',
            feature_liveness: 'Liveness check score below threshold',
          },
        },
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    const sessionUpdate = setCalls.find((call) => 'status' in call);
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate!['status']).toBe('resubmission_pending');

    // resubmission_pending is NOT terminal — completedAt must NOT be stamped
    expect(sessionUpdate!['completedAt']).toBeUndefined();

    const resubmissionInfo = sessionUpdate!['resubmissionInfo'] as {
      nodes: Array<{ node_id: string; feature: string }>;
      reasons: Record<string, string>;
      requested_at: string;
    };
    expect(resubmissionInfo).toBeDefined();
    expect(resubmissionInfo.nodes).toHaveLength(2);
    expect(resubmissionInfo.nodes[0]).toEqual({ node_id: 'feature_ocr', feature: 'OCR' });
    expect(resubmissionInfo.reasons['feature_liveness']).toBe(
      'Liveness check score below threshold',
    );
    expect(resubmissionInfo.requested_at).toBe(NOW.toISOString());
  });

  it('writes customer.kyc_resubmission_requested audit with the node count', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Resubmitted',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
      decoration: {
        resubmit_info: {
          nodes_to_resubmit: [{ node_id: 'feature_ocr', feature: 'OCR' }],
          reasons: { feature_ocr: 'blurry' },
        },
      },
    });

    await handleDiditWebhook(ctx, input);

    const auditCall = mockWriteAudit.mock.calls.find((call) => {
      const payload = call[1] as { action: string };
      return payload.action === 'customer.kyc_resubmission_requested';
    });
    expect(auditCall).toBeDefined();
    const auditPayload = auditCall![1] as unknown as {
      meta: { sessionId: string; nodesCount: number; rawStatus: string };
    };
    expect(auditPayload.meta.sessionId).toBe(SESSION_ID);
    expect(auditPayload.meta.nodesCount).toBe(1);
    expect(auditPayload.meta.rawStatus).toBe('resubmission_pending');
  });

  it('falls back to empty nodes when resubmit_info is missing', async () => {
    const { ctx, setCalls } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Resubmitted',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
      // No resubmit_info block on the body — defensive fallback
    });

    await handleDiditWebhook(ctx, input);

    const sessionUpdate = setCalls.find((call) => 'status' in call);
    const resubmissionInfo = sessionUpdate!['resubmissionInfo'] as {
      nodes: unknown[];
      reasons: Record<string, string>;
    };
    expect(resubmissionInfo.nodes).toEqual([]);
    expect(resubmissionInfo.reasons).toEqual({});
  });

  it('does NOT enqueue the credential pipeline (only Approved should)', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Resubmitted',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    await handleDiditWebhook(ctx, input);

    // The credential pipeline lives behind a `mappedStatus === 'approved'`
    // gate; the assertion is indirect — `revokeActiveCredentials` runs only
    // for kyc_expired, and the audit row distinguishes the path. As long as
    // we wrote `kyc_resubmission_requested` (not `kyc_completed`), the
    // pipeline branch was correctly skipped.
    expect(mockRevokeActiveCredentials).not.toHaveBeenCalled();
    const completedAudit = mockWriteAudit.mock.calls.find((call) => {
      const payload = call[1] as { action: string };
      return payload.action === 'customer.kyc_completed';
    });
    expect(completedAudit).toBeUndefined();
  });

  it('dispatches in-app + email via notify() with the "Verification needs additional steps" copy', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Resubmitted',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    await handleDiditWebhook(ctx, input);

    // notify() handles both channels; the legacy createNotification
    // path is reserved for in-app-only branches (approved, rejected,
    // identity_approved).
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    const [, notifyArg] = mockNotify.mock.calls[0]!;
    expect(notifyArg.eventType).toBe('kyc.status_changed');
    expect(notifyArg.recipient).toEqual({ type: 'customer', customerId: CUSTOMER_ID });
    expect(notifyArg.inApp.title).toBe('Verification needs additional steps');
    expect(notifyArg.inApp.link).toBe('/kyc');
    const email = notifyArg.email;
    if (email === undefined) throw new Error('expected email channel to be set');
    expect(email.emailType).toBe('notification');
    // Build the email content with a synthetic recipient to confirm
    // the template wires through the kyc-status-change builder.
    const built = email.build({ email: 'x@y.test', displayName: 'Faruk' });
    expect(built.subject).toMatch(/Verification.*steps need redoing/i);
    expect(built.html).toContain('Resubmission required');
  });

  it('emits kyc.session.resubmission_required firm webhook event with nodes + resume URL', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Resubmitted',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
      decoration: {
        resubmit_info: {
          nodes_to_resubmit: [
            { node_id: 'n1', feature: 'OCR' },
            { node_id: 'n2', feature: 'LIVENESS' },
          ],
          reasons: { n1: 'Document photo unclear', n2: 'Face not detected' },
        },
      },
    });

    await handleDiditWebhook(ctx, input);

    expect(mockEmitUserEvent).toHaveBeenCalledTimes(1);
    const [, emitArg] = mockEmitUserEvent.mock.calls[0]!;
    expect(emitArg.type).toBe('kyc.session.resubmission_required');
    expect(emitArg.idempotencyKey).toBe(
      `kyc.session.resubmission_required:${SESSION_ID}`,
    );
    expect(emitArg.sourceSessionId).toBe(SESSION_ID);
    expect(emitArg.payload).toMatchObject({
      sessionId: SESSION_ID,
      userRef: CUSTOMER_ID,
      workflow: 'identity',
      requestedAt: NOW.toISOString(),
      nodesToResubmit: [
        { feature: 'OCR', reason: 'Document photo unclear' },
        { feature: 'LIVENESS', reason: 'Face not detected' },
      ],
    });
  });
});

describe('handleDiditWebhook — Kyc Expired (Batch B)', () => {
  const sessionRow: MockSessionRow = {
    id: SESSION_ID,
    customerId: CUSTOMER_ID,
    diditSessionId: DIDIT_SESSION_ID,
    workflow: 'identity',
    status: 'approved',
  };

  it('maps "Kyc Expired" to kyc_expired (terminal) with completedAt stamped', async () => {
    const { ctx, setCalls } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Kyc Expired',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    const sessionUpdate = setCalls.find((call) => 'status' in call);
    expect(sessionUpdate!['status']).toBe('kyc_expired');
    expect(sessionUpdate!['completedAt']).toBeInstanceOf(Date);
    expect(sessionUpdate!['failureReason']).toBe('KYC expiration policy triggered by Didit');
  });

  it('invokes revokeActiveCredentials with reason "kyc_expired"', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Kyc Expired',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    await handleDiditWebhook(ctx, input);

    expect(mockRevokeActiveCredentials).toHaveBeenCalledTimes(1);
    const [, customerId, , reason] = mockRevokeActiveCredentials.mock.calls[0]!;
    expect(customerId).toBe(CUSTOMER_ID);
    expect(reason).toBe('kyc_expired');
  });

  it('updates the customers row to reset kyc_level + clear PII fields', async () => {
    const { ctx, setCalls } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Kyc Expired',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    await handleDiditWebhook(ctx, input);

    const customerUpdate = setCalls.find(
      (call) => 'kycLevel' in call && call['kycLevel'] === 'kyc_0',
    );
    expect(customerUpdate).toBeDefined();
    expect(customerUpdate!['kycScore']).toBe(0);
    expect(customerUpdate!['kycFieldsLocked']).toBe(false);
    // PII columns dropped from `customers` by migration 20260509000000.
    // The reset patch carries lifecycle fields only — there is nothing
    // to null because nothing is stored.
    expect('fullName' in customerUpdate!).toBe(false);
    expect('dateOfBirth' in customerUpdate!).toBe(false);
    expect('nationality' in customerUpdate!).toBe(false);
    expect('documentType' in customerUpdate!).toBe(false);
    expect('documentCountry' in customerUpdate!).toBe(false);
    expect('addressLine' in customerUpdate!).toBe(false);
    expect('addressCity' in customerUpdate!).toBe(false);
    expect('addressCountry' in customerUpdate!).toBe(false);
  });

  it('writes customer.kyc_expired audit row', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Kyc Expired',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    await handleDiditWebhook(ctx, input);

    const auditCall = mockWriteAudit.mock.calls.find((call) => {
      const payload = call[1] as { action: string };
      return payload.action === 'customer.kyc_expired';
    });
    expect(auditCall).toBeDefined();
    const auditPayload = auditCall![1] as unknown as {
      target: { kind: string; id: string };
      meta: { sessionId: string; rawStatus: string };
    };
    expect(auditPayload.target.kind).toBe('customer');
    expect(auditPayload.target.id).toBe(CUSTOMER_ID);
    expect(auditPayload.meta.rawStatus).toBe('kyc_expired');
  });

  it('dispatches in-app + email via notify() with the "Your KYC has expired" copy', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Kyc Expired',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    await handleDiditWebhook(ctx, input);

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).not.toHaveBeenCalled();
    const [, notifyArg] = mockNotify.mock.calls[0]!;
    expect(notifyArg.eventType).toBe('kyc.status_changed');
    expect(notifyArg.inApp.title).toBe('Your KYC has expired');
    const email = notifyArg.email;
    if (email === undefined) throw new Error('expected email channel to be set');
    const built = email.build({ email: 'x@y.test', displayName: 'Faruk' });
    expect(built.subject).toMatch(/KYC credential has expired/i);
    expect(built.html).toContain('Verification expired');
  });

  it('emits kyc.session.kyc_expired firm webhook event', async () => {
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Kyc Expired',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    await handleDiditWebhook(ctx, input);

    expect(mockEmitUserEvent).toHaveBeenCalledTimes(1);
    const [, emitArg] = mockEmitUserEvent.mock.calls[0]!;
    expect(emitArg.type).toBe('kyc.session.kyc_expired');
    expect(emitArg.idempotencyKey).toBe(`kyc.session.kyc_expired:${SESSION_ID}`);
    expect(emitArg.sourceSessionId).toBe(SESSION_ID);
    expect(emitArg.payload).toMatchObject({
      sessionId: SESSION_ID,
      userRef: CUSTOMER_ID,
      workflow: 'identity',
      expiredAt: NOW.toISOString(),
    });
  });

  it('returns 200 even when revokeActiveCredentials throws (best-effort + Didit retry safety)', async () => {
    mockRevokeActiveCredentials.mockRejectedValueOnce(new Error('chain offline'));
    const { ctx } = buildCustomerCtx(sessionRow);
    const input = buildVerifiedInput({
      status: 'Kyc Expired',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    // Audit + customers reset still ran — revoke failure must not abort
    // the lifecycle. (Otherwise Didit retries forever and we get duplicate
    // partial state.)
    const auditCall = mockWriteAudit.mock.calls.find((call) => {
      const payload = call[1] as { action: string };
      return payload.action === 'customer.kyc_expired';
    });
    expect(auditCall).toBeDefined();
  });
});
