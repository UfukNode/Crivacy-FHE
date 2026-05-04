/**
 * SQL-facing monthly quota counter — the only place in the library
 * that writes to `quota_counters`.
 *
 * Unlike the token bucket, which holds a single row per firm, the
 * quota counter is one row per `(firm_id, period)` where `period`
 * is the first-of-month UTC date. A new month rolls over automatically
 * the first time a request for that firm fires after midnight UTC on
 * the first.
 *
 * Atomicity strategy: single UPSERT per request.
 *
 *   INSERT INTO quota_counters (
 *     firm_id, period, count, limit_snapshot, reset_at,
 *     overage_count, last_billable_at, created_at, updated_at
 *   )
 *   VALUES (..., 1, $limit, $resetAt, 0, $now, $now, $now)
 *   ON CONFLICT (firm_id, period) DO UPDATE
 *     SET count = quota_counters.count + EXCLUDED.count,
 *         limit_snapshot = GREATEST(quota_counters.limit_snapshot, EXCLUDED.limit_snapshot),
 *         overage_count = quota_counters.overage_count + CASE
 *           WHEN quota_counters.count + EXCLUDED.count > GREATEST(quota_counters.limit_snapshot, EXCLUDED.limit_snapshot)
 *             THEN EXCLUDED.count
 *             ELSE 0
 *           END,
 *         last_billable_at = EXCLUDED.last_billable_at,
 *         updated_at = EXCLUDED.updated_at
 *   RETURNING count, limit_snapshot, overage_count, reset_at
 *
 * A single INSERT … ON CONFLICT executes under an implicit row lock
 * on the `(firm_id, period)` composite, so two concurrent requests
 * are serialized by Postgres without a transaction from our side.
 *
 * The `limit_snapshot` column stores the tier's monthly quota at the
 * time of first write, and is later upgraded to `GREATEST(old, new)`
 * so a mid-month tier upgrade doesn't shrink the effective cap.
 *
 * `UNLIMITED_QUOTA_SENTINEL` (imported from `tiers.ts`) is used when
 * the tier has `monthlyQuota: null`; the column is `NOT NULL bigint`
 * and the sentinel is `Number.MAX_SAFE_INTEGER` so the
 * `count <= limit_snapshot` invariant is trivially satisfied.
 *
 * Denial semantics: a request that would push `count > limit_snapshot`
 * is NOT aborted at the SQL layer — the UPSERT still runs, and the
 * `overage_count` column records the surplus. The middleware checks
 * the `allowed` flag computed in this file and returns 429
 * `quota_exceeded` BEFORE the request reaches the business logic. We
 * still persist the overage so billing and analytics see it; the
 * caller does not get a billable event (the bucket still deducts),
 * and the audit log records a `quota_exceeded` entry.
 *
 * NOTE: a "would-exceed" request still increments `count`. This is
 * deliberate — concurrent-request races cannot cleanly "undo" a
 * committed UPSERT, and atomic denial would require a SELECT-then-
 * UPDATE that loses Postgres's built-in single-row locking. The
 * overage is billed or comp'd by the operator via the admin panel.
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';

import { RateLimitError } from './errors';
import { type MonthlyPeriod, getMonthlyPeriod, periodToIsoDate } from './periods';
import { type TierLimits, UNLIMITED_QUOTA_SENTINEL, monthlyQuotaForStorage } from './tiers';

/* ---------- Types ---------- */

export interface IncrementQuotaInput {
  /** Firm that owns the request; half of the quota_counters PK. */
  readonly firmId: string;
  readonly tier: TierLimits;
  readonly now: Date;
  /** Billable units to add. Default 1. */
  readonly cost?: number;
}

export interface IncrementQuotaOutcome {
  /** `false` when the post-increment count is strictly greater than the tier cap. */
  readonly allowed: boolean;
  /** Total monthly count AFTER the increment. */
  readonly count: number;
  /** `limit_snapshot` as persisted (may be UNLIMITED_QUOTA_SENTINEL). */
  readonly limitSnapshot: number;
  /** Remaining quota for the period. `null` when unlimited. */
  readonly remaining: number | null;
  /** Cumulative overage count for the period. */
  readonly overage: number;
  /** The period this increment was attributed to. */
  readonly period: MonthlyPeriod;
}

/* ---------- Row parsing ---------- */

/**
 * `db.execute` generic requires `Record<string, unknown>`. The parsers
 * below pick out the fields from this loose shape.
 */
type RawQuotaRow = Record<string, unknown>;

function parseBigintNumber(raw: unknown, field: string): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === 'bigint') {
    const asNumber = Number(raw);
    if (Number.isSafeInteger(asNumber) && asNumber >= 0) {
      return asNumber;
    }
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  throw new RateLimitError(
    'quota_row_malformed',
    `${field} column was not a non-negative safe integer`,
    { details: { field, raw: String(raw) } },
  );
}

function parseDate(raw: unknown, field: string): Date {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new RateLimitError('quota_row_malformed', `${field} column was not a valid timestamp`, {
    details: { field, raw: String(raw) },
  });
}

/* ---------- Cost validation ---------- */

function assertCost(cost: number): void {
  if (!Number.isInteger(cost) || cost <= 0) {
    throw new RateLimitError(
      'invalid_request_cost',
      'monthly quota cost must be a positive integer',
      { details: { cost } },
    );
  }
}

/* ---------- Public API ---------- */

/**
 * Atomically record a billable request against the monthly quota.
 *
 * On the FIRST request of a period the row is inserted with
 * `count = cost`, `limit_snapshot = tier.monthlyQuota ??
 * UNLIMITED_QUOTA_SENTINEL`, `overage_count = 0` iff the increment
 * stays under the cap. On subsequent requests the ON CONFLICT branch
 * adds to the existing `count`, bumps `overage_count` as needed, and
 * refreshes `limit_snapshot` to `GREATEST(old, new)` so a tier upgrade
 * that happened mid-month is honored.
 *
 * Returns an `IncrementQuotaOutcome` containing the post-commit
 * counters and a boolean `allowed` that is `true` iff the request
 * stayed under (or exactly at) the cap.
 */
export async function incrementQuota(
  db: CrivacyDatabase,
  input: IncrementQuotaInput,
): Promise<IncrementQuotaOutcome> {
  const { firmId, tier, now, cost = 1 } = input;

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RateLimitError('invalid_now_value', 'now must be a valid Date', {
      details: { value: String(now) },
    });
  }
  assertCost(cost);

  const period = getMonthlyPeriod(now);
  const limitSnapshot = monthlyQuotaForStorage(tier);

  // `period` is written as a plain ISO DATE literal; `reset_at` is
  // the first instant of the next month, already in UTC.
  const periodIso = periodToIsoDate(period);

  const result = await db.execute<RawQuotaRow>(sql`
    INSERT INTO quota_counters (
      firm_id,
      period,
      count,
      limit_snapshot,
      reset_at,
      overage_count,
      last_billable_at,
      created_at,
      updated_at
    )
    VALUES (
      ${firmId}::uuid,
      ${periodIso}::date,
      ${cost}::bigint,
      ${limitSnapshot}::bigint,
      ${period.endAt}::timestamptz,
      CASE WHEN ${cost}::bigint > ${limitSnapshot}::bigint
        THEN (${cost}::bigint - ${limitSnapshot}::bigint)
        ELSE 0::bigint
      END,
      ${now}::timestamptz,
      ${now}::timestamptz,
      ${now}::timestamptz
    )
    ON CONFLICT (firm_id, period) DO UPDATE
      SET count = quota_counters.count + ${cost}::bigint,
          limit_snapshot = GREATEST(
            quota_counters.limit_snapshot,
            ${limitSnapshot}::bigint
          ),
          overage_count = quota_counters.overage_count + CASE
            WHEN quota_counters.count + ${cost}::bigint
                 > GREATEST(quota_counters.limit_snapshot, ${limitSnapshot}::bigint)
            THEN LEAST(
              ${cost}::bigint,
              (quota_counters.count + ${cost}::bigint)
              - GREATEST(quota_counters.limit_snapshot, ${limitSnapshot}::bigint)
            )
            ELSE 0::bigint
          END,
          last_billable_at = ${now}::timestamptz,
          updated_at = ${now}::timestamptz
    RETURNING
      count,
      limit_snapshot,
      overage_count,
      reset_at
  `);

  const row = result.rows[0];
  if (row === undefined) {
    throw new RateLimitError('quota_row_missing', 'quota_counters UPSERT returned no row', {
      details: { firmId, period: periodIso },
    });
  }

  const count = parseBigintNumber(row['count'], 'count');
  const storedLimit = parseBigintNumber(row['limit_snapshot'], 'limit_snapshot');
  const overage = parseBigintNumber(row['overage_count'], 'overage_count');
  // `reset_at` is read back and validated so a drifted row surfaces
  // the problem on the hot path rather than at billing time.
  parseDate(row['reset_at'], 'reset_at');

  const unlimited = storedLimit >= UNLIMITED_QUOTA_SENTINEL;
  const allowed = unlimited || count <= storedLimit;
  const remaining = unlimited ? null : Math.max(0, storedLimit - count);

  return {
    allowed,
    count,
    limitSnapshot: storedLimit,
    remaining,
    overage,
    period,
  };
}

/**
 * Observe the current period's counter without mutating it. Returns
 * the post-commit view as if no request had been made. Used by
 * `GET /me/quota` dashboards and by the middleware when a bucket-only
 * denial needs the quota header values.
 */
export async function peekQuotaRow(
  db: CrivacyDatabase,
  firmId: string,
  tier: TierLimits,
  now: Date,
): Promise<{
  readonly count: number;
  readonly limitSnapshot: number;
  readonly remaining: number | null;
  readonly overage: number;
  readonly period: MonthlyPeriod;
}> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RateLimitError('invalid_now_value', 'now must be a valid Date');
  }
  const period = getMonthlyPeriod(now);
  const periodIso = periodToIsoDate(period);
  const result = await db.execute<RawQuotaRow>(sql`
    SELECT count, limit_snapshot, overage_count, reset_at
    FROM quota_counters
    WHERE firm_id = ${firmId}::uuid
      AND period = ${periodIso}::date
    LIMIT 1
  `);
  const row = result.rows[0];
  if (row === undefined) {
    // No row yet for this period = zero count, full allowance.
    const limit = monthlyQuotaForStorage(tier);
    const unlimited = limit >= UNLIMITED_QUOTA_SENTINEL;
    return {
      count: 0,
      limitSnapshot: limit,
      remaining: unlimited ? null : limit,
      overage: 0,
      period,
    };
  }
  const count = parseBigintNumber(row['count'], 'count');
  const storedLimit = parseBigintNumber(row['limit_snapshot'], 'limit_snapshot');
  const overage = parseBigintNumber(row['overage_count'], 'overage_count');
  parseDate(row['reset_at'], 'reset_at');
  const unlimited = storedLimit >= UNLIMITED_QUOTA_SENTINEL;
  const remaining = unlimited ? null : Math.max(0, storedLimit - count);
  return {
    count,
    limitSnapshot: storedLimit,
    remaining,
    overage,
    period,
  };
}
