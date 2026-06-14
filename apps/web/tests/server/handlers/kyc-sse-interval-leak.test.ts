// @vitest-environment node
/**
 * KYC SSE interval-leak regression test.
 *
 * `handleKycEvents` schedules two intervals after the stream opens:
 *
 *   - `heartbeatInterval` (30 s) — sends `: heartbeat\n\n`.
 *   - `pollInterval`      (5 s)  — runs a `SELECT … FROM customer_kyc_sessions`
 *                                  to detect status changes.
 *
 * When the client disconnects, the ReadableStream `cancel` callback
 * fires `onCancel` (decrements the connection counter) — but the two
 * `setInterval` handles are NOT cleared. Without a 10-minute safety
 * timeout, both intervals would tick forever; with it, they tick for
 * up to 10 minutes after the socket is gone, doing one DB poll every
 * 5 s into a void writer.
 *
 * This test pins the contract: post-cancel poll cycles MUST stop
 * issuing DB queries. With the bug present, the assertion below sees
 * dozens of background queries after `body.cancel()`. With the fix
 * (intervals cleared from the same cancel path), the count stays at
 * the initial-state read and never grows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleKycEvents,
  resetActiveSseConnectionsForTests,
} from '@/server/handlers/customer-kyc';
import type { CustomerContext } from '@/server/context';

const CUSTOMER_ID = 'c1111111-1111-4111-8111-111111111111';

/**
 * Build a `CustomerContext` whose `db.select(...).from(...).where(...)
 * .orderBy(...).limit(...)` chain resolves to an empty array AND
 * counts every terminal `limit()` call. Each call corresponds to one
 * DB query the handler issues — the initial-state read at stream
 * open, and one per `pollInterval` tick.
 */
function buildCtxWithQueryCounter(): { ctx: CustomerContext; getQueryCount: () => number } {
  let queryCount = 0;
  const limit = async () => {
    queryCount += 1;
    return [];
  };
  const orderBy = () => ({ limit });
  const where = () => ({ orderBy, limit });
  const from = () => ({ where });
  const db = {
    select: () => ({ from }),
  };

  const ctx = {
    db,
    now: new Date('2026-04-20T12:00:00.000Z'),
    requestId: 'req-leak-test-aaaa-bbbb-cccc-dddd',
    customer: {
      id: CUSTOMER_ID,
      kycLevel: 'kyc_0',
      kycScore: 0,
    },
  } as unknown as CustomerContext;

  return { ctx, getQueryCount: () => queryCount };
}

beforeEach(() => {
  resetActiveSseConnectionsForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetActiveSseConnectionsForTests();
});

describe('handleKycEvents — interval cleanup on client disconnect', () => {
  it('stops issuing DB poll queries after the client disconnects', async () => {
    const { ctx, getQueryCount } = buildCtxWithQueryCounter();

    const response = await handleKycEvents(ctx);
    expect(response.status).toBe(200);

    // Initial-state read fires synchronously inside the handler.
    // (`await db.select(...).limit(10)` runs before the response
    // returns. Every subsequent query comes from `pollInterval`.)
    const initialQueries = getQueryCount();
    expect(initialQueries).toBeGreaterThanOrEqual(1);

    // Drive the poll interval once before the disconnect to confirm
    // it IS running while connected.
    await vi.advanceTimersByTimeAsync(5_000);
    const queriesWhileConnected = getQueryCount();
    expect(queriesWhileConnected).toBeGreaterThan(initialQueries);

    // --- Simulate client disconnect ---
    if (response.body === null) throw new Error('expected body stream');
    await response.body.cancel();

    // Snapshot the count AT cancel — anything beyond this point is
    // a leaked interval still doing work after the socket is gone.
    const queriesAtCancel = getQueryCount();

    // Advance time by 30 seconds — would normally fire ~6 poll
    // ticks. With the leak, queryCount climbs by 6+; with the fix,
    // it stays flat.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(getQueryCount()).toBe(queriesAtCancel);
  });

  it('stops issuing DB poll queries even if the safety timeout has not fired yet', async () => {
    const { ctx, getQueryCount } = buildCtxWithQueryCounter();

    const response = await handleKycEvents(ctx);
    expect(response.status).toBe(200);

    if (response.body === null) throw new Error('expected body stream');
    await response.body.cancel();

    const baseline = getQueryCount();

    // Five minutes of fake time — the 10-minute safety timeout
    // should NOT be the only thing keeping leaks bounded. The
    // contract: cancel = stop, immediately.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(getQueryCount()).toBe(baseline);
  });
});
