/**
 * Decision composer. Uses the same mock-DB harness as the other
 * SQL-facing tests, so all flow verification is end-to-end at the
 * library level. The mock queue is primed for each branch:
 *
 *   Happy path (allowed):
 *     [0] consumeBucket: INSERT CTE   → { inserted: 0 }
 *     [1] consumeBucket: SELECT FOR UPDATE → bucket row
 *     [2] consumeBucket: UPDATE       → nothing
 *     [3] incrementQuota: UPSERT RETURNING → quota row
 *
 *   Bucket denial:
 *     [0] consumeBucket: INSERT CTE   → { inserted: 0 }
 *     [1] consumeBucket: SELECT FOR UPDATE → empty bucket
 *     [2] consumeBucket: UPDATE       → nothing
 *     [3] peekQuotaRow: SELECT        → quota row (or empty)
 *
 *   Quota denial:
 *     [0..2] as happy path
 *     [3] incrementQuota: UPSERT → row with count > limit
 */

import { describe, expect, it } from 'vitest';

import {
  UNLIMITED_QUOTA_SENTINEL,
  applyRateLimit,
  decisionToErrorBody,
  snapshotRateLimit,
} from '@/lib/ratelimit';

import {
  FIXTURE_FIRM_ID,
  FIXTURE_NOW,
  buildBucketRow,
  buildMockDb,
  buildQuotaRow,
} from './fixtures';

describe('applyRateLimit — allowed path', () => {
  it('runs bucket + quota and returns allowed: true with fully populated headers', async () => {
    const handle = buildMockDb();
    // consumeBucket sequence
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 0 }] });
    handle.queue({
      tag: 'select-for-update',
      rows: [buildBucketRow({ capacity: 5, refillRatePerSec: 1, tokens: 5 })],
    });
    handle.queue({ tag: 'update', rows: [] });
    // incrementQuota sequence
    handle.queue({
      tag: 'upsert-returning',
      rows: [buildQuotaRow({ count: 1, limitSnapshot: 1_000, overageCount: 0 })],
    });

    const decision = await applyRateLimit(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      firmTier: 'free',
      now: FIXTURE_NOW,
    });

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.tier.capacity).toBe(5);
      expect(decision.quota.count).toBe(1);
      expect(decision.headers['X-RateLimit-Limit']).toBe('5');
      expect(decision.headers['X-Quota-Limit']).toBe('1000');
      expect(decision.headers['Retry-After']).toBeUndefined();
    }
  });
});

describe('applyRateLimit — bucket denial', () => {
  it('returns reason=rate_limited and does NOT call incrementQuota', async () => {
    const handle = buildMockDb();
    // Empty bucket → bucket denial.
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
    // peekQuotaRow for headers on the denial branch.
    handle.queue({
      tag: 'peek-quota',
      rows: [buildQuotaRow({ count: 200, limitSnapshot: 1_000, overageCount: 0 })],
    });

    const decision = await applyRateLimit(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      firmTier: 'free',
      now: FIXTURE_NOW,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('rate_limited');
      expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(decision.headers['Retry-After']).toBeDefined();
      expect(decision.headers['X-RateLimit-Remaining']).toBe('0');
      expect(decision.headers['X-Quota-Remaining']).toBe('800');
    }

    // 4 calls: 3 for consumeBucket + 1 for peekQuotaRow. NO increment.
    expect(handle.calls).toHaveLength(4);
    const lastCall = handle.calls[3]?.sqlString ?? '';
    expect(lastCall).toContain('SELECT count');
    expect(lastCall).not.toContain('INSERT INTO quota_counters');
  });
});

describe('applyRateLimit — quota denial', () => {
  it('returns reason=quota_exceeded with Retry-After pointing at period end', async () => {
    const handle = buildMockDb();
    // Bucket has tokens.
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 0 }] });
    handle.queue({
      tag: 'select-for-update',
      rows: [buildBucketRow({ capacity: 5, refillRatePerSec: 1, tokens: 5 })],
    });
    handle.queue({ tag: 'update', rows: [] });
    // Quota exceeds cap.
    handle.queue({
      tag: 'upsert-returning',
      rows: [buildQuotaRow({ count: 1_001, limitSnapshot: 1_000, overageCount: 1 })],
    });

    const decision = await applyRateLimit(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      firmTier: 'free',
      now: FIXTURE_NOW,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('quota_exceeded');
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
      expect(decision.headers['X-Quota-Remaining']).toBe('0');
    }
  });
});

describe('applyRateLimit — unlimited tier', () => {
  it('emits the -1 sentinel on enterprise quota headers', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 0 }] });
    handle.queue({
      tag: 'select-for-update',
      rows: [buildBucketRow({ capacity: 3_000, refillRatePerSec: 1_000, tokens: 3_000 })],
    });
    handle.queue({ tag: 'update', rows: [] });
    handle.queue({
      tag: 'upsert-returning',
      rows: [
        buildQuotaRow({
          count: 42,
          limitSnapshot: UNLIMITED_QUOTA_SENTINEL,
          overageCount: 0,
        }),
      ],
    });

    const decision = await applyRateLimit(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      firmTier: 'enterprise',
      now: FIXTURE_NOW,
    });

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.headers['X-Quota-Limit']).toBe('-1');
      expect(decision.headers['X-Quota-Remaining']).toBe('-1');
    }
  });
});

describe('applyRateLimit — invalid input', () => {
  it('rejects a NaN now', async () => {
    const handle = buildMockDb();
    await expect(
      applyRateLimit(handle.db, {
        firmId: FIXTURE_FIRM_ID,
        firmTier: 'free',
        now: new Date('nope'),
      }),
    ).rejects.toMatchObject({
      name: 'RateLimitError',
      code: 'invalid_now_value',
    });
  });
});

describe('snapshotRateLimit', () => {
  it('peeks bucket + quota without running a transaction', async () => {
    const handle = buildMockDb();
    // peekBucketRow
    handle.queue({
      tag: 'peek-bucket',
      rows: [buildBucketRow({ capacity: 5, refillRatePerSec: 1, tokens: 3 })],
    });
    // peekQuotaRow
    handle.queue({
      tag: 'peek-quota',
      rows: [buildQuotaRow({ count: 100, limitSnapshot: 1_000, overageCount: 0 })],
    });

    const snap = await snapshotRateLimit(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      firmTier: 'free',
      now: FIXTURE_NOW,
    });

    expect(snap.bucket).not.toBeNull();
    expect(snap.bucket?.tokens).toBe(3);
    expect(snap.quota.count).toBe(100);
    expect(snap.headers['X-RateLimit-Limit']).toBe('5');
    expect(snap.headers['X-Quota-Limit']).toBe('1000');
    expect(handle.transactionOpened()).toBe(false);
  });

  it('falls back to a full synthetic bucket when no row exists', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'peek-bucket', rows: [] });
    handle.queue({ tag: 'peek-quota', rows: [] });

    const snap = await snapshotRateLimit(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      firmTier: 'free',
      now: FIXTURE_NOW,
    });

    expect(snap.bucket).toBeNull();
    expect(snap.headers['X-RateLimit-Limit']).toBe('5');
    expect(snap.headers['X-RateLimit-Remaining']).toBe('5');
  });
});

describe('decisionToErrorBody', () => {
  it('serializes a rate_limited decision', async () => {
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
    handle.queue({
      tag: 'peek-quota',
      rows: [buildQuotaRow({ count: 0, limitSnapshot: 1_000, overageCount: 0 })],
    });

    const decision = await applyRateLimit(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      firmTier: 'free',
      now: FIXTURE_NOW,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      const body = decisionToErrorBody(decision);
      expect(body.error.code).toBe('rate_limited');
      expect(body.error.retry_after_seconds).toBeGreaterThanOrEqual(1);
      expect(body.error.details.limit).toBe(5);
    }
  });

  it('serializes a quota_exceeded decision with the period string', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'insert-cte', rows: [{ inserted: 0 }] });
    handle.queue({
      tag: 'select-for-update',
      rows: [buildBucketRow({ capacity: 5, refillRatePerSec: 1, tokens: 5 })],
    });
    handle.queue({ tag: 'update', rows: [] });
    handle.queue({
      tag: 'upsert-returning',
      rows: [buildQuotaRow({ count: 1_001, limitSnapshot: 1_000, overageCount: 1 })],
    });

    const decision = await applyRateLimit(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      firmTier: 'free',
      now: FIXTURE_NOW,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      const body = decisionToErrorBody(decision);
      expect(body.error.code).toBe('quota_exceeded');
      expect(body.error.details.period).toBe('2026-03');
      expect(body.error.details.limit).toBe(1_000);
      expect(body.error.details.remaining).toBe(0);
    }
  });
});
