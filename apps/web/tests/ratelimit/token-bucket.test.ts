/**
 * SQL-facing token bucket. The tests use a mock `CrivacyDatabase`
 * (`fixtures.ts`) that records every `execute` call and returns
 * rows from a FIFO queue. We assert both that the library issued
 * the expected SQL statements in the expected order and that it
 * parsed the returned rows correctly.
 *
 * The real Postgres row lock / atomicity guarantees are verified by
 * the Drizzle integration tests in `tests/db/schema.test.ts`; these
 * tests are focused on the JS-side contract (call sequence, parser
 * errors, tier reconciliation).
 */

import { describe, expect, it } from 'vitest';

import {
  RateLimitError,
  consumeBucket,
  peekBucketRow,
  resetBucketToFull,
  resolveTierLimits,
} from '@/lib/ratelimit';

import {
  FIXTURE_FIRM_ID,
  FIXTURE_FREE_LIMITS,
  FIXTURE_NOW,
  FIXTURE_PRO_LIMITS,
  buildBucketRow,
  buildMockDb,
} from './fixtures';

describe('consumeBucket', () => {
  it('opens a transaction and issues INSERT, SELECT FOR UPDATE, UPDATE in order', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 0 }] });
    handle.queue({
      tag: 'select-for-update',
      rows: [buildBucketRow({ capacity: 5, refillRatePerSec: 1, tokens: 5 })],
    });
    handle.queue({ tag: 'update', rows: [] });

    const outcome = await consumeBucket(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      tier: FIXTURE_FREE_LIMITS,
      now: FIXTURE_NOW,
    });

    expect(handle.transactionOpened()).toBe(true);
    expect(handle.calls).toHaveLength(3);
    expect(handle.calls[0]?.sqlString).toContain('INSERT INTO rate_limit_buckets');
    expect(handle.calls[1]?.sqlString).toContain('FOR UPDATE');
    expect(handle.calls[2]?.sqlString).toContain('UPDATE rate_limit_buckets');
    expect(outcome.result.allowed).toBe(true);
    if (outcome.result.allowed) {
      expect(outcome.result.tokensAfter).toBe(4);
    }
    expect(outcome.rowCreated).toBe(false);
    expect(outcome.tierReconciled).toBe(false);
  });

  it('reports rowCreated=true when the INSERT produced a row', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 1 }] });
    handle.queue({
      tag: 'select-for-update',
      rows: [buildBucketRow({ capacity: 5, refillRatePerSec: 1, tokens: 5 })],
    });
    handle.queue({ tag: 'update', rows: [] });

    const outcome = await consumeBucket(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      tier: FIXTURE_FREE_LIMITS,
      now: FIXTURE_NOW,
    });

    expect(outcome.rowCreated).toBe(true);
  });

  it('reconciles a tier upgrade by granting the capacity delta', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 0 }] });
    // Stored row reflects the OLD tier (free: 5, 1/s) but the caller
    // is now pro (300, 100/s) — the library should rewrite capacity
    // and grant the delta.
    handle.queue({
      tag: 'select-for-update',
      rows: [buildBucketRow({ capacity: 5, refillRatePerSec: 1, tokens: 3 })],
    });
    handle.queue({ tag: 'update', rows: [] });

    const outcome = await consumeBucket(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      tier: FIXTURE_PRO_LIMITS,
      now: FIXTURE_NOW,
    });

    expect(outcome.tierReconciled).toBe(true);
    expect(outcome.persisted.capacity).toBe(300);
    expect(outcome.persisted.refillRatePerSec).toBe(100);
    // The UPDATE should include the new capacity + refill rate.
    expect(handle.calls[2]?.sqlString).toContain('capacity =');
    expect(handle.calls[2]?.sqlString).toContain('refill_rate_per_sec =');
  });

  it('reconciles a tier downgrade by clamping tokens to the new capacity', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 0 }] });
    // Stored: pro (capacity 300), 250 tokens. Caller downgraded to free (capacity 5).
    handle.queue({
      tag: 'select-for-update',
      rows: [buildBucketRow({ capacity: 300, refillRatePerSec: 100, tokens: 250 })],
    });
    handle.queue({ tag: 'update', rows: [] });

    const outcome = await consumeBucket(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      tier: FIXTURE_FREE_LIMITS,
      now: FIXTURE_NOW,
    });

    expect(outcome.tierReconciled).toBe(true);
    expect(outcome.persisted.capacity).toBe(5);
    // After reconcile: min(250, 5) = 5. Then consume 1 → 4.
    expect(outcome.result.allowed).toBe(true);
    if (outcome.result.allowed) {
      expect(outcome.result.tokensAfter).toBe(4);
    }
  });

  it('returns allowed=false when the bucket is empty (no refill delta)', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 0 }] });
    handle.queue({
      tag: 'select-for-update',
      rows: [
        buildBucketRow({
          capacity: 5,
          refillRatePerSec: 1,
          tokens: 0,
          lastRefillAt: FIXTURE_NOW,
        }),
      ],
    });
    handle.queue({ tag: 'update', rows: [] });

    const outcome = await consumeBucket(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      tier: FIXTURE_FREE_LIMITS,
      now: FIXTURE_NOW,
    });

    expect(outcome.result.allowed).toBe(false);
    if (!outcome.result.allowed) {
      expect(outcome.result.retryAfterMs).toBe(1_000);
    }
  });

  it('throws bucket_row_missing when SELECT FOR UPDATE returns no row', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 1 }] });
    handle.queue({ tag: 'select-for-update', rows: [] }); // empty — pathological

    await expect(
      consumeBucket(handle.db, {
        firmId: FIXTURE_FIRM_ID,
        tier: FIXTURE_FREE_LIMITS,
        now: FIXTURE_NOW,
      }),
    ).rejects.toMatchObject({
      name: 'RateLimitError',
      code: 'bucket_row_missing',
    });
  });

  it('throws bucket_row_malformed when tokens is a non-numeric string', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 0 }] });
    handle.queue({
      tag: 'select-for-update',
      rows: [buildBucketRow({ capacity: 5, refillRatePerSec: 1, tokens: 'banana' })],
    });

    await expect(
      consumeBucket(handle.db, {
        firmId: FIXTURE_FIRM_ID,
        tier: FIXTURE_FREE_LIMITS,
        now: FIXTURE_NOW,
      }),
    ).rejects.toMatchObject({
      name: 'RateLimitError',
      code: 'bucket_row_malformed',
    });
  });

  it('throws invalid_now_value when now is not a valid Date', async () => {
    const handle = buildMockDb();
    await expect(
      consumeBucket(handle.db, {
        firmId: FIXTURE_FIRM_ID,
        tier: FIXTURE_FREE_LIMITS,
        now: new Date('not-a-date'),
      }),
    ).rejects.toMatchObject({
      name: 'RateLimitError',
      code: 'invalid_now_value',
    });
  });
});

describe('peekBucketRow', () => {
  it('returns null when no row exists', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'select', rows: [] });
    const result = await peekBucketRow(handle.db, FIXTURE_FIRM_ID, FIXTURE_FREE_LIMITS);
    expect(result).toBeNull();
  });

  it('parses an existing row and reconciles with the tier', async () => {
    const handle = buildMockDb();
    handle.queue({
      tag: 'select',
      rows: [buildBucketRow({ capacity: 5, refillRatePerSec: 1, tokens: 3 })],
    });
    const result = await peekBucketRow(handle.db, FIXTURE_FIRM_ID, FIXTURE_FREE_LIMITS);
    expect(result).not.toBeNull();
    expect(result?.capacity).toBe(5);
    expect(result?.tokens).toBe(3);
  });
});

describe('resetBucketToFull', () => {
  it('issues an UPSERT that sets tokens=capacity', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'upsert', rows: [] });
    await resetBucketToFull(
      handle.db,
      FIXTURE_FIRM_ID,
      resolveTierLimits('starter'),
      FIXTURE_NOW,
    );
    expect(handle.calls).toHaveLength(1);
    const upsertSql = handle.calls[0]?.sqlString ?? '';
    expect(upsertSql).toContain('INSERT INTO rate_limit_buckets');
    expect(upsertSql).toContain('ON CONFLICT');
    expect(upsertSql).toContain('DO UPDATE');
  });

  it('rejects an invalid now Date', async () => {
    const handle = buildMockDb();
    await expect(
      resetBucketToFull(handle.db, FIXTURE_FIRM_ID, FIXTURE_FREE_LIMITS, new Date('invalid')),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});
