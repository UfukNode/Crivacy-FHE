/**
 * Monthly quota period helpers.
 *
 * `quota_counters` uses a composite primary key of `(firm_id, period)`
 * where `period` is a `DATE` column representing the first day of the
 * UTC calendar month. Two concurrent requests in the same month hit
 * the same row and are serialized by Postgres; a request that crosses
 * midnight UTC on the first of a month automatically creates a new row.
 *
 * Everything in this file is UTC-relative. Local time zones never enter
 * the quota model: a firm in Sydney and a firm in Reykjavík see their
 * month roll over at the same instant. This is deliberate — monthly
 * quota is a product concept, not a calendar-UX concept, and making it
 * TZ-aware would turn concurrent-request serialization into a
 * per-firm-locale problem.
 *
 * The helpers here produce value objects with fully materialized
 * `startAt` / `endAt` `Date`s so the caller can use them both for DB
 * writes (as the `DATE` primary key) and for `X-RateLimit-Reset` header
 * computation without re-running the month math.
 */

import { RateLimitError } from './errors';

/* ---------- Types ---------- */

export interface MonthlyPeriod {
  /**
   * First-of-month 00:00:00 UTC. Stored in the `period` primary key
   * column of `quota_counters` (mode `'date'` in Drizzle).
   */
  readonly startAt: Date;
  /**
   * Start of the NEXT month at 00:00:00 UTC. This is the `reset_at`
   * column value and the basis for `X-RateLimit-Reset` on the quota
   * window. `endAt - startAt` is the period length in ms.
   */
  readonly endAt: Date;
  /**
   * Year (UTC) of `startAt`. Duplicated for convenience so callers
   * don't re-derive from `startAt`.
   */
  readonly year: number;
  /**
   * 1-indexed month number (1 = January) of `startAt`. Matches the
   * convention used by the OpenAPI `QuotaWindow.period` string.
   */
  readonly month: number;
}

/* ---------- Validation ---------- */

function assertValidNow(now: Date): void {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RateLimitError('invalid_now_value', 'now must be a valid Date', {
      details: { value: String(now) },
    });
  }
}

/* ---------- Core helpers ---------- */

/**
 * Build the `MonthlyPeriod` that `now` falls into. `startAt` is the
 * first instant of the current UTC month; `endAt` is the first instant
 * of the next UTC month.
 *
 * `new Date(Date.UTC(year, month, 1))` is the canonical way to produce
 * a midnight-UTC Date regardless of the host TZ. We also explicitly
 * reject a future `endAt` that overflows the `Date` representable
 * range (an edge case only reachable with an absurd `now` value,
 * but the SQL layer would choke on an Invalid Date).
 */
export function getMonthlyPeriod(now: Date): MonthlyPeriod {
  assertValidNow(now);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const startAt = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const endAt = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw new RateLimitError('period_calculation_failed', 'monthly period overflowed Date range', {
      details: { now: now.toISOString(), year, month },
    });
  }
  return {
    startAt,
    endAt,
    year,
    month: month + 1,
  };
}

/**
 * Ms remaining until the period ends. Used both for `Retry-After` on a
 * `quota_exceeded` 429 and for the `X-RateLimit-Reset` header on a
 * quota-tracked route.
 *
 * A `now` after `endAt` (shouldn't happen — the caller re-derives the
 * period at each request) returns `0`, not a negative number.
 */
export function periodMsRemaining(period: MonthlyPeriod, now: Date): number {
  assertValidNow(now);
  const remaining = period.endAt.getTime() - now.getTime();
  return remaining > 0 ? remaining : 0;
}

/**
 * Seconds-until-reset, rounded UP. `Retry-After` is a second-precision
 * header per RFC 9110 §10.2.3, and rounding up guarantees a retrying
 * client never lands inside the expiring period.
 */
export function periodSecondsRemaining(period: MonthlyPeriod, now: Date): number {
  const ms = periodMsRemaining(period, now);
  return Math.ceil(ms / 1000);
}

/**
 * True if two `MonthlyPeriod` objects describe the same UTC month. The
 * SQL UPSERT layer uses this to recognize when it needs to insert a
 * new row vs. increment an existing one, without re-serializing to
 * the `DATE` primary key.
 */
export function periodsEqual(a: MonthlyPeriod, b: MonthlyPeriod): boolean {
  return a.startAt.getTime() === b.startAt.getTime();
}

/**
 * Render the period as an ISO date string (YYYY-MM-01). This matches
 * the Postgres `DATE` literal format and what Drizzle's `date` column
 * serializer produces. Exposed for audit logs and dashboards.
 */
export function periodToIsoDate(period: MonthlyPeriod): string {
  const y = period.year.toString().padStart(4, '0');
  const m = period.month.toString().padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Compute the NEXT period after a given one. Handy for tests that need
 * to simulate rollover without re-running `getMonthlyPeriod` at a
 * moving wall-clock.
 */
export function nextPeriod(period: MonthlyPeriod): MonthlyPeriod {
  return getMonthlyPeriod(period.endAt);
}
