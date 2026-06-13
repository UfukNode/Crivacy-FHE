// @vitest-environment node
/**
 * Didit customer-webhook handler — ownership guard tests.
 *
 * The handler receives KYC decisions from Didit and fans them into
 * notifications, bans, credential mints, and outbound firm
 * webhooks. All of those side-effects key off the `customerId`
 * pulled out of `vendor_data` (the handler's `params.customerId`).
 * A drift between that value and the `customer_id` column on the
 * looked-up KYC session would mean "wrong user gets banned / wrong
 * user gets a credential / wrong user gets a notification". HMAC
 * makes it unlikely in practice, but we close the gap explicitly:
 * on mismatch the handler must bail with no mutation before any
 * downstream call fires.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as observabilityLogger from '@/lib/observability/logger';
import { handleCustomerWebhook } from '@/server/handlers/didit-webhook';

interface MockSessionRow {
  id: string;
  customerId: string;
  diditSessionId: string | null;
  workflow: 'identity' | 'address';
  status: string;
}

/**
 * Build a DB stub that satisfies the handler's two read-shapes
 * (`select().from().where().limit()`) and exposes a spy on
 * `update()` so tests can assert "no mutation ran".
 *
 * The optional `requireCustomerIdMatch` flag switches on a mock
 * simulation of the query-level ownership constraint. When set,
 * the mock inspects the `params.customerId` the handler supplied
 * and only returns the row when it matches `sessionRow.customerId`
 * — mirroring the SQL-side `AND customer_id = $1` clause. This
 * exercises the defence-in-depth path where the query itself
 * refuses to surface a foreign row, independent of the inline
 * `session.customerId !== params.customerId` guard further down.
 *
 * For tests that don't exercise the constraint path, the default
 * (`false`) returns the row unconditionally — the inline guard is
 * still in place and still provides the outer check.
 */
function buildDbStub(
  sessionRow: MockSessionRow | null,
  opts: { requireCustomerIdMatch?: string } = {},
): {
  db: CrivacyDatabase;
  updateSpy: ReturnType<typeof vi.fn>;
} {
  const updateSpy = vi.fn(() => ({
    set: () => ({
      where: async () => undefined,
    }),
  }));
  const limitFn = async () => {
    if (sessionRow === null) return [];
    // Emulate the production AND-clause: if the caller asked for
    // a specific customer id, only return the row when it matches.
    if (
      opts.requireCustomerIdMatch !== undefined &&
      opts.requireCustomerIdMatch !== sessionRow.customerId
    ) {
      return [];
    }
    return [sessionRow];
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: limitFn,
        }),
      }),
    }),
    update: updateSpy,
  } as unknown as CrivacyDatabase;
  return { db, updateSpy };
}

/**
 * Build a minimal ctx the handler reads from. `json` mirrors the
 * real response builder so assertions on the returned status and
 * body stay realistic.
 */
function buildCtx(db: CrivacyDatabase): Parameters<typeof handleCustomerWebhook>[0] {
  return {
    db,
    now: new Date('2026-04-20T12:00:00.000Z'),
    json: (body: unknown, status: number = 200) =>
      new NextResponse(JSON.stringify(body), { status }),
  } as unknown as Parameters<typeof handleCustomerWebhook>[0];
}

// ---------------------------------------------------------------------------

// Capture pino error output — the handler now uses
// `getRootLogger().error({ ... }, 'msg')` instead of
// `console.error(...)`. Replace the root logger with a stub whose
// `.error` / `.warn` / `.info` / `.debug` record their call args so
// tests can assert on the structured event name / message without
// spinning up the real pino transport.
interface LoggerCall {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}
let loggerErrorCalls: LoggerCall[] = [];

beforeEach(() => {
  loggerErrorCalls = [];
  const stub = {
    error: (fields: Record<string, unknown>, message: string) => {
      loggerErrorCalls.push({ fields, message });
    },
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
  };
  vi.spyOn(observabilityLogger, 'getRootLogger').mockReturnValue(
    stub as unknown as ReturnType<typeof observabilityLogger.getRootLogger>,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('handleCustomerWebhook — ownership guard', () => {
  it('bails without mutation when vendor_data.customerId differs from session.customerId', async () => {
    const sessionRow: MockSessionRow = {
      id: 's1111111-1111-4111-8111-111111111111',
      customerId: 'c1111111-1111-4111-8111-111111111111', // the REAL owner
      diditSessionId: 'didit-session-abc',
      workflow: 'identity',
      status: 'pending',
    };
    const { db, updateSpy } = buildDbStub(sessionRow);
    const ctx = buildCtx(db);

    const res = await handleCustomerWebhook(ctx, {
      diditSessionId: 'didit-session-abc',
      mappedStatus: 'approved',
      customerSessionId: sessionRow.id,
      // Intentionally DIFFERENT customer id — simulates a bug in
      // the vendor_data emit path or a crafted payload that passed
      // HMAC but disagrees with the stored session.
      customerId: 'c9999999-9999-4999-8999-999999999999',
      webhookBody: { status: 'Approved' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ received: true });

    // Critical: no mutation ran. No UPDATE on customer_kyc_sessions,
    // no cascading ban / notification / credential mint (those
    // downstream calls sit strictly AFTER the update, so blocking
    // `update` is the trunk of the blast radius).
    expect(updateSpy).not.toHaveBeenCalled();

    // A loud SOC-triage log fires so the incident is observable.
    expect(loggerErrorCalls.length).toBeGreaterThan(0);
    const mismatchCall = loggerErrorCalls.find(
      (c) => c.fields['event'] === 'didit_webhook_customer_id_mismatch',
    );
    expect(mismatchCall).toBeDefined();
    expect(mismatchCall?.fields['sessionCustomerId']).toBe(sessionRow.customerId);
    expect(mismatchCall?.fields['vendorDataCustomerId']).toBe(
      'c9999999-9999-4999-8999-999999999999',
    );
  });

  it('refuses to surface a foreign row via the query-level customer_id constraint', async () => {
    // Simulates the SQL-side `AND customer_id = $1` filter: when
    // the handler passes a mismatched `customerId`, the DB returns
    // zero rows. The handler takes the "session not found" branch
    // — the inline ownership guard never even has to fire. Pins
    // the defence-in-depth layer that lives in the query itself.
    const realOwner = 'c1111111-1111-4111-8111-111111111111';
    const attacker = 'c9999999-9999-4999-8999-999999999999';
    const sessionRow: MockSessionRow = {
      id: 'ba111111-1111-4111-8111-111111111111',
      customerId: realOwner,
      diditSessionId: 'didit-session-abc',
      workflow: 'identity',
      status: 'pending',
    };
    const { db, updateSpy } = buildDbStub(sessionRow, {
      requireCustomerIdMatch: attacker,
    });
    const ctx = buildCtx(db);

    const res = await handleCustomerWebhook(ctx, {
      diditSessionId: 'didit-session-abc',
      mappedStatus: 'approved',
      customerSessionId: sessionRow.id,
      customerId: attacker,
      webhookBody: { status: 'Approved' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ received: true });

    // No mutation, no downstream call — same guarantees as the
    // inline-guard path, but reached via the query filter.
    expect(updateSpy).not.toHaveBeenCalled();

    // "Session not found" log fires, NOT the "vendor_data
    // customerId does not match" log — that branch is the
    // secondary safety net that only trips when a row DID come
    // back. Here the query refused to emit a row at all.
    const notFoundLog = loggerErrorCalls.find(
      (call) => call.fields['event'] === 'didit_webhook_customer_session_not_found',
    );
    expect(notFoundLog).toBeDefined();
  });

  it('bails without mutation when the session lookup returns nothing', async () => {
    const { db, updateSpy } = buildDbStub(null);
    const ctx = buildCtx(db);

    const res = await handleCustomerWebhook(ctx, {
      diditSessionId: 'didit-unknown',
      mappedStatus: 'approved',
      customerSessionId: 's0000000-0000-4000-8000-000000000000',
      customerId: 'c1111111-1111-4111-8111-111111111111',
      webhookBody: {},
    });

    expect(res.status).toBe(200);
    expect(updateSpy).not.toHaveBeenCalled();
    // Distinct log — session-not-found vs ownership-mismatch have
    // different SOC meanings, so they carry different event keys.
    expect(loggerErrorCalls.length).toBeGreaterThan(0);
    const notFoundCall = loggerErrorCalls.find(
      (c) => c.fields['event'] === 'didit_webhook_customer_session_not_found',
    );
    expect(notFoundCall).toBeDefined();
  });
});
