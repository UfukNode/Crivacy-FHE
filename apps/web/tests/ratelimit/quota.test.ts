/**
 * SQL-facing monthly quota. Uses the same mock-DB harness as
 * `token-bucket.test.ts`. Focus areas:
 *   - Single UPSERT emitted with the expected columns.
 *   - Allowed / denied classification from the RETURNING row.
 *   - Unlimited tier is encoded as the MAX_SAFE_INTEGER sentinel
 *     and rendered as `remaining: null` in the outcome.
 *   - peek returns zero when no row exists for the period.
 *   - Malformed row surfaces as quota_row_malformed.
 */

import { describe, expect, it } from 'vitest';

import { UNLIMITED_QUOTA_SENTINEL, incrementQuota, peekQuotaRow } from '@/lib/ratelimit';

import {
  FIXTURE_FIRM_ID,
  FIXTURE_ENTERPRISE_LIMITS,
  FIXTURE_FREE_LIMITS,
  FIXTURE_NOW,
  FIXTURE_PRO_LIMITS,
  buildMockDb,
  buildQuotaRow,
} from './fixtures';

describe('incrementQuota', () => {
  it('emits a single UPSERT and returns the allowed outcome on an under-cap row', async () => {
    const handle = buildMockDb();
    handle.queue({
      tag: 'upsert-returning',
      rows: [buildQuotaRow({ count: 1, limitSnapshot: 1_000, overageCount: 0 })],
    });

    const outcome = await incrementQuota(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      tier: FIXTURE_FREE_LIMITS,
      now: FIXTURE_NOW,
    });

    expect(handle.calls).toHaveLength(1);
    const sql = handle.calls[0]?.sqlString ?? '';
    expect(sql).toContain('INSERT INTO quota_counters');
    expect(sql).toContain('ON CONFLICT (firm_id, period) DO UPDATE');
    expect(sql).toContain('RETURNING');
    expect(outcome.allowed).toBe(true);
    expect(outcome.count).toBe(1);
    expect(outcome.remaining).toBe(999);
    expect(outcome.limitSnapshot).toBe(1_000);
    expect(outcome.overage).toBe(0);
  });

  it('returns allowed=false when the post-increment count exceeds the cap', async () => {
    const handle = buildMockDb();
    handle.queue({
      tag: 'upsert-returning',
      rows: [buildQuotaRow({ count: 1_001, limitSnapshot: 1_000, overageCount: 1 })],
    });
    const outcome = await incrementQuota(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      tier: FIXTURE_FREE_LIMITS,
      now: FIXTURE_NOW,
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.remaining).toBe(0);
    expect(outcome.overage).toBe(1);
  });

  it('treats a pro-tier row identically (bigger cap)', async () => {
    const handle = buildMockDb();
    handle.queue({
      tag: 'upsert-returning',
      rows: [buildQuotaRow({ count: 500, limitSnapshot: 1_000_000, overageCount: 0 })],
    });
    const outcome = await incrementQuota(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      tier: FIXTURE_PRO_LIMITS,
      now: FIXTURE_NOW,
    });
    expect(outcome.allowed).toBe(true);
    expect(outcome.remaining).toBe(999_500);
  });

  it('encodes enterprise (unlimited) as the sentinel and remaining=null', async () => {
    const handle = buildMockDb();
    handle.queue({
      tag: 'upsert-returning',
      rows: [
        buildQuotaRow({
          count: 999_999_999,
          limitSnapshot: UNLIMITED_QUOTA_SENTINEL,
          overageCount: 0,
        }),
      ],
    });
    const outcome = await incrementQuota(handle.db, {
      firmId: FIXTURE_FIRM_ID,
      tier: FIXTURE_ENTERPRISE_LIMITS,
      now: FIXTURE_NOW,
    });
    expect(outcome.allowed).toBe(true);
    expect(outcome.remaining).toBeNull();
    expect(outcome.limitSnapshot).toBe(UNLIMITED_QUOTA_SENTINEL);
  });

  it('throws quota_row_missing when the UPSERT returns zero rows', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'empty', rows: [] });
    await expect(
      incrementQuota(handle.db, {
        firmId: FIXTURE_FIRM_ID,
        tier: FIXTURE_FREE_LIMITS,
        now: FIXTURE_NOW,
      }),
    ).rejects.toMatchObject({
      name: 'RateLimitError',
      code: 'quota_row_missing',
    });
  });

  it('throws quota_row_malformed when count is not a safe integer', async () => {
    const handle = buildMockDb();
    handle.queue({
      tag: 'upsert-returning',
      rows: [
        {
          count: 'not-a-number',
          limit_snapshot: 1_000,
          overage_count: 0,
          reset_at: new Date('2026-04-01T00:00:00Z'),
        },
      ],
    });
    await expect(
      incrementQuota(handle.db, {
        firmId: FIXTURE_FIRM_ID,
        tier: FIXTURE_FREE_LIMITS,
        now: FIXTURE_NOW,
      }),
    ).rejects.toMatchObject({
      name: 'RateLimitError',
      code: 'quota_row_malformed',
    });
  });

  it('rejects a non-integer cost with invalid_request_cost', async () => {
    const handle = buildMockDb();
    await expect(
      incrementQuota(handle.db, {
        firmId: FIXTURE_FIRM_ID,
        tier: FIXTURE_FREE_LIMITS,
        now: FIXTURE_NOW,
        cost: 1.5,
      }),
    ).rejects.toMatchObject({
      name: 'RateLimitError',
      code: 'invalid_request_cost',
    });
  });

  it('rejects a non-Date now with invalid_now_value', async () => {
    const handle = buildMockDb();
    await expect(
      incrementQuota(handle.db, {
        firmId: FIXTURE_FIRM_ID,
        tier: FIXTURE_FREE_LIMITS,
        now: new Date('invalid'),
      }),
    ).rejects.toMatchObject({
      name: 'RateLimitError',
      code: 'invalid_now_value',
    });
  });
});

describe('peekQuotaRow', () => {
  it('returns zero count + full remaining when no row exists for this period', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'select', rows: [] });
    const peek = await peekQuotaRow(
      handle.db,
      FIXTURE_FIRM_ID,
      FIXTURE_FREE_LIMITS,
      FIXTURE_NOW,
    );
    expect(peek.count).toBe(0);
    expect(peek.remaining).toBe(1_000);
    expect(peek.overage).toBe(0);
  });

  it('parses an existing row and returns the remaining count', async () => {
    const handle = buildMockDb();
    handle.queue({
      tag: 'select',
      rows: [buildQuotaRow({ count: 250, limitSnapshot: 1_000, overageCount: 0 })],
    });
    const peek = await peekQuotaRow(
      handle.db,
      FIXTURE_FIRM_ID,
      FIXTURE_FREE_LIMITS,
      FIXTURE_NOW,
    );
    expect(peek.count).toBe(250);
    expect(peek.remaining).toBe(750);
  });

  it('returns remaining=null for an enterprise tier without a row', async () => {
    const handle = buildMockDb();
    handle.queue({ tag: 'select', rows: [] });
    const peek = await peekQuotaRow(
      handle.db,
      FIXTURE_FIRM_ID,
      FIXTURE_ENTERPRISE_LIMITS,
      FIXTURE_NOW,
    );
    expect(peek.remaining).toBeNull();
    expect(peek.limitSnapshot).toBe(UNLIMITED_QUOTA_SENTINEL);
  });
});
