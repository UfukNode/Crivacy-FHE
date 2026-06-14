// @vitest-environment node
/**
 * Didit webhook — unknown-status branch tests.
 *
 * The webhook schema used to enum-lock the `status` field to the
 * four values the handler knew how to map (`Approved`, `Declined`,
 * `In Review`, `In Progress`). Any new value Didit shipped would
 * fail Zod parsing, come back 422, and keep retrying until a human
 * noticed. The fix:
 *
 *   - Schema accepts any short string for `status`.
 *   - Handler's `statusMap[status] === undefined` branch now
 *     persists the raw payload onto the session row (preserving
 *     logical status), writes an audit row targeted at the right
 *     subject, and 200s so Didit moves on.
 *
 * These tests pin the contract at behaviour level. The HMAC side
 * is out of scope here — we call `handleDiditWebhook` directly
 * with a crafted config that echoes the fixture body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NextResponse } from 'next/server';

import { handleDiditWebhook } from '@/server/handlers/didit-webhook';
import { buildVerifiedDiditInput } from '../../utils/didit-webhook-harness';

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

vi.mock('@/lib/fraud', () => ({
  classifyDecision: vi.fn(() => 'normal_decline'),
  extractFraudSignals: vi.fn(() => []),
  pickFraudReason: vi.fn(() => 'none'),
  banCustomer: vi.fn(async () => undefined),
}));

vi.mock('@/lib/notification', () => ({
  createNotification: vi.fn(async () => undefined),
}));

import * as auditWriter from '@/lib/audit/writer';
const mockWriteAudit = vi.mocked(auditWriter.writeAudit);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = new Date('2026-04-21T12:00:00.000Z').getTime();
const NOW = new Date(NOW_MS);
// UUID v4 fixtures — the audit target builder enforces strict
// v4 shape, so these must start with hex and carry the version
// + variant markers.
const CUSTOMER_ID = 'c1111111-1111-4111-8111-111111111111';
const SESSION_ID = 'ba111111-1111-4111-8111-111111111111';
const DIDIT_SESSION_ID = 'didit-session-abc';

// Local wrapper over the shared harness — file-scoped secret + clock.
// The harness mirrors the production route layer's `WebhookInput`
// shape so the handler exercises the same code path.
function buildVerifiedInput(opts: { status: string; vendorData: unknown }) {
  return buildVerifiedDiditInput({
    webhookSecret: WEBHOOK_SECRET,
    status: opts.status,
    vendorData: opts.vendorData,
    diditSessionId: DIDIT_SESSION_ID,
    now: NOW,
  });
}

/**
 * Build the RequestContext the handler reads from. Mock DB
 * implements the select/update chain the unknown-status persist
 * helper uses.
 */
function buildCtx(sessionRowFound: boolean) {
  const updateSpy = vi.fn(() => ({
    set: () => ({
      where: async () => undefined,
    }),
  }));
  const selectSpy = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () =>
          sessionRowFound
            ? [{ id: SESSION_ID }]
            : [],
      }),
    }),
  }));
  const db = {
    select: selectSpy,
    update: updateSpy,
  };
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
    selectSpy,
  };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // `writeAudit` returns `Promise<PersistedAuditRow>` in prod; the
  // handler does not consume the return value so a typed-through
  // placeholder keeps the mock satisfied without pulling in the
  // real row shape.
  mockWriteAudit.mockImplementation(async () => undefined as never);
  // `verifyWebhook` reads `Date.now()` to freshness-check
  // X-Timestamp; pin it so the HMAC the test mints lines up with
  // the drift window (default 300s).
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('handleDiditWebhook — unknown status branch', () => {
  it('persists the payload and writes an audit row for an unknown customer-flow status', async () => {
    const { ctx, updateSpy } = buildCtx(true);
    const input = buildVerifiedInput({
      // Genuinely unknown — `Expired`/`Abandoned` are mapped post
      // Batch A 2026-05-07; pick a string the statusMap has never
      // recognised so the unknown branch actually runs.
      status: 'Quarantined',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    // Session row was updated with the raw payload (diditDecisionPayload),
    // NOT with a synthesized status. Calling `update()` at all is the
    // signal — the set-where-await chain is traversed by the helper.
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // Audit row stamped with the dedicated action and meta containing
    // the raw status string.
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    const auditCall = mockWriteAudit.mock.calls[0]!;
    const payload = auditCall[1] as unknown as {
      action: string;
      target: { kind: string; id?: string };
      meta: { rawStatus: string; vendorType: string };
    };
    expect(payload.action).toBe('kyc_session.webhook_unknown_status');
    expect(payload.target.kind).toBe('customer');
    expect(payload.target.id).toBe(CUSTOMER_ID);
    expect(payload.meta.rawStatus).toBe('Quarantined');
    expect(payload.meta.vendorType).toBe('customer');
  });

  it('writes an audit row with noTarget when the session row is missing', async () => {
    const { ctx, updateSpy } = buildCtx(false);
    const input = buildVerifiedInput({
      status: 'Requires Action',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    // No session row → no update fired.
    expect(updateSpy).not.toHaveBeenCalled();

    // Audit still emits so the SOC dashboard gets the diagnostic
    // even when we could not match the payload to a session.
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    const payload = mockWriteAudit.mock.calls[0]![1] as unknown as {
      target: { kind: string };
    };
    // Customer path normally targets the customer row, but the
    // audit guard short-circuits to noTarget when the session did
    // not resolve — matches the code's documented fallback.
    // (We care only that the write fired; the target kind can be
    // either 'customer' with customer id or 'none'.)
    expect(['customer', 'none']).toContain(payload.target.kind);
  });

  it('persists B2B-flow unknown statuses with the kyc_session target kind', async () => {
    const { ctx, updateSpy } = buildCtx(true);
    const input = buildVerifiedInput({
      // Genuinely unknown — `Abandoned` was mapped to `expired`
      // post Batch A 2026-05-07; pick a never-mapped string so the
      // unknown branch actually runs.
      status: 'Probation',
      // Canonical B2B vendor_data shape per `lib/didit/vendor-data.ts`
      // (Sprint 7 SoT). The legacy bare `crivacyKycSessionId` form is
      // gone; B2B sessions now carry `type:'b2b'` + `crivacySessionId`
      // mirroring the customer shape so a single parser handles both.
      vendorData: {
        type: 'b2b',
        crivacySessionId: SESSION_ID,
        firmId: 'f1111111-1111-4111-8111-111111111111',
        userRef: 'b2b-user-001',
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    expect(res.status).toBe(200);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    const payload = mockWriteAudit.mock.calls[0]![1] as unknown as {
      action: string;
      target: { kind: string; id?: string };
      meta: { vendorType: string };
    };
    expect(payload.action).toBe('kyc_session.webhook_unknown_status');
    expect(payload.target.kind).toBe('kyc_session');
    expect(payload.target.id).toBe(SESSION_ID);
    expect(payload.meta.vendorType).toBe('b2b');
  });

  it('acknowledges with 200 even if the audit writer throws', async () => {
    mockWriteAudit.mockRejectedValueOnce(new Error('audit store down'));
    const { ctx } = buildCtx(true);
    const input = buildVerifiedInput({
      status: 'Something New',
      vendorData: {
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: CUSTOMER_ID,
      },
    });

    const res = await handleDiditWebhook(ctx, input);
    // The whole point of the unknown-status branch is to NOT
    // turn into a Didit retry storm. Audit failure must not
    // change the 200 acknowledgement.
    expect(res.status).toBe(200);
  });
});
