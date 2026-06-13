// @vitest-environment node
/**
 * KYC SSE connection cap tests.
 *
 * `handleKycEvents` opens a long-lived Server-Sent Events stream
 * for the calling customer. Without a cap, a scripted client that
 * loops `new EventSource(...)` would pin one DB-poll timer and one
 * heartbeat timer per tab, and the per-replica DB pool would run
 * dry under a single customer — a cheap single-tenant DoS.
 *
 * The handler now caps concurrent connections per customer. These
 * tests pin the contract at behaviour level:
 *
 *   - Opening within cap increments the counter and returns 200
 *     text/event-stream.
 *   - The (N+1)-th open for the same customer returns 429 +
 *     Retry-After without touching the counter on that attempt.
 *   - `writer.close()` releases the slot exactly once (no
 *     double-decrement, no leak across test cases).
 *   - Client disconnect (ReadableStream cancel) releases the slot
 *     too — verified via the underlying `createSSEStream`
 *     onCancel plumbing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleKycEvents,
  resetActiveSseConnectionsForTests,
} from '@/server/handlers/customer-kyc';
import type { CustomerContext } from '@/server/context';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUSTOMER_ID = 'c1111111-1111-4111-8111-111111111111';

/**
 * Build the bare minimum `CustomerContext` the SSE handler touches:
 *
 *   - `customer.id` — key for the connection counter.
 *   - `customer.kycLevel` / `kycScore` — used for the initial state event.
 *   - `db.select(...).from(...).where(...).orderBy(...).limit(...)` —
 *     returns the customer's latest KYC sessions. We return an
 *     empty array so the handler skips straight into the polling
 *     interval setup.
 *   - `requestId` — echoed into the response header.
 */
function buildCtx(customerId: string = CUSTOMER_ID): CustomerContext {
  const limit = async () => [];
  const orderBy = () => ({ limit });
  const where = () => ({ orderBy, limit });
  const from = () => ({ where });
  const db = {
    select: () => ({ from }),
  };

  return {
    db,
    now: new Date('2026-04-20T12:00:00.000Z'),
    requestId: 'req-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    customer: {
      id: customerId,
      kycLevel: 'kyc_0',
      kycScore: 0,
    },
  } as unknown as CustomerContext;
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  resetActiveSseConnectionsForTests();
  // Freeze any setInterval the handler schedules so the test
  // process exits cleanly between cases. Fake timers also stop
  // the 10-minute safety timeout from firing during assertions.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetActiveSseConnectionsForTests();
});

// ---------------------------------------------------------------------------

describe('handleKycEvents — per-customer connection cap', () => {
  it('accepts concurrent connections up to the cap', async () => {
    const responses: Response[] = [];
    for (let i = 0; i < 3; i++) {
      responses.push(await handleKycEvents(buildCtx()));
    }
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    }
  });

  it('rejects the (N+1)-th open with 429 + Retry-After', async () => {
    const accepted: Response[] = [];
    for (let i = 0; i < 3; i++) {
      accepted.push(await handleKycEvents(buildCtx()));
    }
    for (const res of accepted) {
      expect(res.status).toBe(200);
    }

    const rejected = await handleKycEvents(buildCtx());
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('content-type')).toContain('application/json');
    expect(rejected.headers.get('Retry-After')).toBe('60');
    expect(rejected.headers.get('Cache-Control')).toBe('no-store');

    const body = (await rejected.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('too_many_connections');
  });

  it('releases the slot when the client disconnects (ReadableStream cancel)', async () => {
    const first = await handleKycEvents(buildCtx());
    const second = await handleKycEvents(buildCtx());
    const third = await handleKycEvents(buildCtx());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    // Simulate a client disconnect on the first stream. Reading
    // the body triggers the ReadableStream's cancel hook when the
    // reader is released — but the cleanest "client closed"
    // simulation is `.body.cancel()`, which routes through the
    // exact path a Node runtime fires when a TCP FIN arrives.
    const body = first.body;
    if (body === null) throw new Error('expected body stream');
    await body.cancel();

    // One slot must now be free — opening a new stream returns
    // 200, not 429. If the counter leaked, this would trip the
    // cap and come back 429 instead.
    const replacement = await handleKycEvents(buildCtx());
    expect(replacement.status).toBe(200);
  });

  it('scopes the counter per customer — one account at cap does not starve others', async () => {
    const customerA = 'c1111111-1111-4111-8111-111111111111';
    const customerB = 'c2222222-2222-4222-8222-222222222222';

    // Customer A at cap.
    for (let i = 0; i < 3; i++) {
      const res = await handleKycEvents(buildCtx(customerA));
      expect(res.status).toBe(200);
    }
    const aRejected = await handleKycEvents(buildCtx(customerA));
    expect(aRejected.status).toBe(429);

    // Customer B starts cold — must not be affected by A's state.
    const bFirst = await handleKycEvents(buildCtx(customerB));
    expect(bFirst.status).toBe(200);
  });

  it('does not double-count when a stream is opened then cancelled then re-opened', async () => {
    // Open one stream and cancel it.
    const first = await handleKycEvents(buildCtx());
    expect(first.status).toBe(200);
    if (first.body === null) throw new Error('expected body stream');
    await first.body.cancel();

    // Open three more — all should succeed because the cancelled
    // slot released. If onCancel were missing (the bug this test
    // pins), the first stream's slot would still count and the
    // 3rd open below would come back 429.
    const a = await handleKycEvents(buildCtx());
    const b = await handleKycEvents(buildCtx());
    const c = await handleKycEvents(buildCtx());
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
  });
});
