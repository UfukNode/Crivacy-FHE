// @vitest-environment node
/**
 * Didit user-entity webhook tests (Batch E).
 *
 * Pins `handleUserEntityWebhook` behaviour for the 9 event variants
 * documented in DIDIT-STATUS-FIXES.md §E14:
 *
 *   1. user.data.updated + deleted_at         → revoke pipeline
 *   2. user.status.updated + BLOCKED          → revoke pipeline
 *   3. user.status.updated + FLAGGED          → audit-only, no revoke
 *   4. user.data.updated  display_name only   → noop
 *   5. revoke event for already-revoked user  → idempotent (no-op)
 *   6. vendor_data null                       → orphan audit, no state change
 *   7. customerId not in DB                   → orphan audit, no state change
 *   8. (start-session 409 guard)              → handled in customer-kyc test
 *   9. user.status.updated BLOCKED → ACTIVE   → no auto-restore
 *
 * The handler is exercised through `handleDiditWebhook` so the HMAC
 * verifier + schema parse run end-to-end. DB is stubbed; the
 * assertions key off the captured `update.set(...)` payloads + mocked
 * audit/firm-webhook calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDiditWebhook } from '@/server/handlers/didit-webhook';
import {
  buildUserEntityCtx,
  buildUserEntityWebhookInput,
  type MockCustomerRow,
} from '../../utils/didit-webhook-harness';

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

vi.mock('@/lib/fraud', () => ({
  classifyDecision: vi.fn(() => 'normal'),
  extractFraudSignals: vi.fn(() => []),
  pickFraudReason: vi.fn(() => null),
  banCustomer: vi.fn(async () => undefined),
  // The revoke pipeline calls into this mocked helper; the test
  // asserts presence of the call rather than Chain-side behaviour.
  revokeActiveCredentials: vi.fn(async () => 1),
}));

vi.mock('@/lib/webhook', () => ({
  emitUserEvent: vi.fn(async () => undefined),
  emitFirmEvent: vi.fn(async () => undefined),
}));

import * as auditWriter from '@/lib/audit/writer';
import * as fraudModule from '@/lib/fraud';
import * as webhookModule from '@/lib/webhook';
const mockWriteAudit = vi.mocked(auditWriter.writeAudit);
const mockRevokeActiveCredentials = vi.mocked(fraudModule.revokeActiveCredentials);
const mockEmitUserEvent = vi.mocked(webhookModule.emitUserEvent);

const NOW = new Date('2026-05-08T12:00:00.000Z');
const CUSTOMER_ID = 'c1111111-1111-4111-8111-111111111111';
const VENDOR_USER_ID = 'd2222222-2222-4222-8222-222222222222';
const CRIVACY_SESSION_ID = 'ba111111-1111-4111-8111-111111111111';

const VENDOR_DATA_CUSTOMER = {
  type: 'customer',
  customerId: CUSTOMER_ID,
  crivacySessionId: CRIVACY_SESSION_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAudit.mockImplementation(async () => undefined as never);
  mockRevokeActiveCredentials.mockImplementation(async () => 1);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env['CRIVACY_SELF_SERVICE_FIRM_ID'] = 'f0000000-0000-4000-8000-000000000000';
});

afterEach(() => {
  vi.useRealTimers();
});

const ACTIVE_CUSTOMER: MockCustomerRow = { id: CUSTOMER_ID, kycLevel: 'kyc_3' };
const REVOKED_CUSTOMER: MockCustomerRow = { id: CUSTOMER_ID, kycLevel: 'kyc_0' };

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('handleUserEntityWebhook — user.data.updated + deleted_at', () => {
  it('runs the revoke pipeline (Chain revoke + customers UPDATE + sessions bulk expire + audit + firm webhook)', async () => {
    const input = buildUserEntityWebhookInput({
      webhookSecret: WEBHOOK_SECRET,
      webhookType: 'user.data.updated',
      vendorData: VENDOR_DATA_CUSTOMER,
      vendorUserId: VENDOR_USER_ID,
      now: NOW,
      decoration: {
        deleted_at: NOW.toISOString(),
        changed_fields: ['deleted_at'],
        changes: {
          previous: { deleted_at: null },
          current: { deleted_at: NOW.toISOString() },
        },
      },
    });
    const bundle = buildUserEntityCtx(ACTIVE_CUSTOMER, { now: NOW });

    const res = await handleDiditWebhook(bundle.ctx, input);

    expect(res.status).toBe(200);
    expect(mockRevokeActiveCredentials).toHaveBeenCalledTimes(1);
    expect(mockRevokeActiveCredentials).toHaveBeenCalledWith(
      expect.anything(),
      CUSTOMER_ID,
      NOW,
      'didit_user_deleted',
    );
    // customers UPDATE — kyc_level reset + revoked stamps
    expect(bundle.customersUpdates).toHaveLength(1);
    const customerPatch = bundle.customersUpdates[0]!;
    expect(customerPatch['kycLevel']).toBe('kyc_0');
    expect(customerPatch['kycScore']).toBe(0);
    expect(customerPatch['kycFieldsLocked']).toBe(false);
    // PII columns dropped from `customers` by migration 20260509000000
    // (PII purge — non-custodial doctrine). Reset patch carries only
    // lifecycle fields; nothing to null because nothing is stored.
    expect('fullName' in customerPatch).toBe(false);
    expect('dateOfBirth' in customerPatch).toBe(false);
    expect('nationality' in customerPatch).toBe(false);
    expect('documentType' in customerPatch).toBe(false);
    expect('documentCountry' in customerPatch).toBe(false);
    expect('addressLine' in customerPatch).toBe(false);
    expect('addressCity' in customerPatch).toBe(false);
    expect('addressCountry' in customerPatch).toBe(false);
    expect(customerPatch['revokedAt']).toBe(NOW);
    expect(customerPatch['revokedReason']).toBe('didit_user_deleted');
    // customer_kyc_sessions bulk expire
    expect(bundle.sessionsUpdates).toHaveLength(1);
    expect(bundle.sessionsUpdates[0]!['status']).toBe('revoked');
    expect(bundle.sessionsUpdates[0]!['failureReason']).toBe('Didit user deleted');
    // audit row
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit.mock.calls[0]![1]).toMatchObject({
      action: 'customer.kyc_revoked_by_didit_user',
      meta: expect.objectContaining({
        reason: 'didit_user_deleted',
        webhookType: 'user.data.updated',
        vendorUserId: VENDOR_USER_ID,
      }),
    });
    // firm webhook
    expect(mockEmitUserEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitUserEvent.mock.calls[0]![1]).toMatchObject({
      customerId: CUSTOMER_ID,
      type: 'kyc.session.kyc_expired',
      payload: expect.objectContaining({ reason: 'didit_user_deleted' }),
    });
  });

  it('detects deletion via changes.current.deleted_at when top-level field is absent', async () => {
    const input = buildUserEntityWebhookInput({
      webhookSecret: WEBHOOK_SECRET,
      webhookType: 'user.data.updated',
      vendorData: VENDOR_DATA_CUSTOMER,
      vendorUserId: VENDOR_USER_ID,
      now: NOW,
      decoration: {
        changed_fields: ['deleted_at'],
        changes: {
          previous: { deleted_at: null },
          current: { deleted_at: NOW.toISOString() },
        },
      },
    });
    const bundle = buildUserEntityCtx(ACTIVE_CUSTOMER, { now: NOW });

    await handleDiditWebhook(bundle.ctx, input);

    expect(mockRevokeActiveCredentials).toHaveBeenCalledTimes(1);
    expect(bundle.customersUpdates[0]!['revokedReason']).toBe('didit_user_deleted');
  });
});

describe('handleUserEntityWebhook — user.status.updated', () => {
  it('runs revoke pipeline when status flips to BLOCKED', async () => {
    const input = buildUserEntityWebhookInput({
      webhookSecret: WEBHOOK_SECRET,
      webhookType: 'user.status.updated',
      vendorData: VENDOR_DATA_CUSTOMER,
      vendorUserId: VENDOR_USER_ID,
      now: NOW,
      decoration: {
        previous_status: 'ACTIVE',
        status: 'BLOCKED',
        reason: 'fraud detected',
      },
    });
    const bundle = buildUserEntityCtx(ACTIVE_CUSTOMER, { now: NOW });

    await handleDiditWebhook(bundle.ctx, input);

    expect(mockRevokeActiveCredentials).toHaveBeenCalledWith(
      expect.anything(),
      CUSTOMER_ID,
      NOW,
      'didit_user_blocked',
    );
    expect(bundle.customersUpdates[0]!['revokedReason']).toBe('didit_user_blocked');
    expect(mockEmitUserEvent.mock.calls[0]![1]!['payload']).toMatchObject({
      reason: 'didit_user_blocked',
    });
  });

  it('audits only (no revoke) when status flips to FLAGGED', async () => {
    const input = buildUserEntityWebhookInput({
      webhookSecret: WEBHOOK_SECRET,
      webhookType: 'user.status.updated',
      vendorData: VENDOR_DATA_CUSTOMER,
      vendorUserId: VENDOR_USER_ID,
      now: NOW,
      decoration: {
        previous_status: 'ACTIVE',
        status: 'FLAGGED',
      },
    });
    const bundle = buildUserEntityCtx(ACTIVE_CUSTOMER, { now: NOW });

    const res = await handleDiditWebhook(bundle.ctx, input);

    expect(res.status).toBe(200);
    expect(mockRevokeActiveCredentials).not.toHaveBeenCalled();
    expect(bundle.customersUpdates).toHaveLength(0);
    expect(bundle.sessionsUpdates).toHaveLength(0);
    expect(mockEmitUserEvent).not.toHaveBeenCalled();
  });

  it('does NOT auto-restore on BLOCKED → ACTIVE — no state change, audit-only', async () => {
    const input = buildUserEntityWebhookInput({
      webhookSecret: WEBHOOK_SECRET,
      webhookType: 'user.status.updated',
      vendorData: VENDOR_DATA_CUSTOMER,
      vendorUserId: VENDOR_USER_ID,
      now: NOW,
      decoration: {
        previous_status: 'BLOCKED',
        status: 'ACTIVE',
      },
    });
    // Customer is already at kyc_0 after the prior BLOCKED revoke
    // (ground truth in production); test ensures we do NOT magically
    // raise them back.
    const bundle = buildUserEntityCtx(REVOKED_CUSTOMER, { now: NOW });

    const res = await handleDiditWebhook(bundle.ctx, input);

    expect(res.status).toBe(200);
    expect(mockRevokeActiveCredentials).not.toHaveBeenCalled();
    expect(bundle.customersUpdates).toHaveLength(0);
    expect(mockEmitUserEvent).not.toHaveBeenCalled();
  });
});

describe('handleUserEntityWebhook — noop / idempotency / orphan', () => {
  it('treats user.data.updated with only display_name change as noop', async () => {
    const input = buildUserEntityWebhookInput({
      webhookSecret: WEBHOOK_SECRET,
      webhookType: 'user.data.updated',
      vendorData: VENDOR_DATA_CUSTOMER,
      vendorUserId: VENDOR_USER_ID,
      now: NOW,
      decoration: {
        changed_fields: ['display_name'],
        changes: {
          previous: { display_name: 'Ada' },
          current: { display_name: 'Ada Lovelace' },
        },
      },
    });
    const bundle = buildUserEntityCtx(ACTIVE_CUSTOMER, { now: NOW });

    const res = await handleDiditWebhook(bundle.ctx, input);

    expect(res.status).toBe(200);
    expect(mockRevokeActiveCredentials).not.toHaveBeenCalled();
    expect(bundle.customersUpdates).toHaveLength(0);
    expect(bundle.sessionsUpdates).toHaveLength(0);
    expect(mockWriteAudit).not.toHaveBeenCalled(); // noop branch — no audit row
    expect(mockEmitUserEvent).not.toHaveBeenCalled();
  });

  it('is idempotent for revoke replay against an already-revoked customer (no double work)', async () => {
    const input = buildUserEntityWebhookInput({
      webhookSecret: WEBHOOK_SECRET,
      webhookType: 'user.data.updated',
      vendorData: VENDOR_DATA_CUSTOMER,
      vendorUserId: VENDOR_USER_ID,
      now: NOW,
      decoration: {
        deleted_at: NOW.toISOString(),
        changed_fields: ['deleted_at'],
      },
    });
    const bundle = buildUserEntityCtx(REVOKED_CUSTOMER, { now: NOW });

    const res = await handleDiditWebhook(bundle.ctx, input);

    expect(res.status).toBe(200);
    expect(mockRevokeActiveCredentials).not.toHaveBeenCalled();
    expect(bundle.customersUpdates).toHaveLength(0);
    expect(bundle.sessionsUpdates).toHaveLength(0);
    expect(mockEmitUserEvent).not.toHaveBeenCalled();
  });

  it('writes an orphan audit row when vendor_data is missing', async () => {
    const input = buildUserEntityWebhookInput({
      webhookSecret: WEBHOOK_SECRET,
      webhookType: 'user.data.updated',
      vendorData: 'nope-not-our-vendor-data',
      vendorUserId: VENDOR_USER_ID,
      now: NOW,
      decoration: { deleted_at: NOW.toISOString() },
    });
    const bundle = buildUserEntityCtx(ACTIVE_CUSTOMER, { now: NOW });

    const res = await handleDiditWebhook(bundle.ctx, input);

    expect(res.status).toBe(200);
    expect(mockRevokeActiveCredentials).not.toHaveBeenCalled();
    expect(bundle.customersUpdates).toHaveLength(0);
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit.mock.calls[0]![1]).toMatchObject({
      action: 'kyc_session.webhook_unknown_status',
      meta: expect.objectContaining({
        reason: 'user_entity_webhook_no_customer_anchor',
      }),
    });
  });

  it('writes an orphan audit row when customer is not in DB', async () => {
    const input = buildUserEntityWebhookInput({
      webhookSecret: WEBHOOK_SECRET,
      webhookType: 'user.data.updated',
      vendorData: VENDOR_DATA_CUSTOMER,
      vendorUserId: VENDOR_USER_ID,
      now: NOW,
      decoration: { deleted_at: NOW.toISOString() },
    });
    const bundle = buildUserEntityCtx(null, { now: NOW });

    const res = await handleDiditWebhook(bundle.ctx, input);

    expect(res.status).toBe(200);
    expect(mockRevokeActiveCredentials).not.toHaveBeenCalled();
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit.mock.calls[0]![1]).toMatchObject({
      action: 'kyc_session.webhook_unknown_status',
      meta: expect.objectContaining({
        reason: 'user_entity_webhook_orphan_customer',
        customerId: CUSTOMER_ID,
      }),
    });
  });
});
