/**
 * Rate-limit decision composer.
 *
 * This is the module every route handler calls. It orchestrates the
 * bucket + quota checks, produces a `RateLimitDecision` that is
 * always well-formed, and delegates header construction to
 * `headers.ts`. The middleware does NOT talk to the database directly
 * except via `consumeBucket` / `incrementQuota`.
 *
 * Order of evaluation:
 *
 *   1. Run `consumeBucket`. If the bucket denies the request we STOP
 *      — we do NOT also increment the monthly quota counter because a
 *      bucket denial is a retry-able burst error, not a billable
 *      event. We still emit the quota headers (from `peekQuotaRow`)
 *      so the client sees the current monthly state.
 *
 *   2. If the bucket allowed, run `incrementQuota`. If the quota
 *      row says `allowed: false` (i.e. the increment pushed count
 *      over the cap), we return a `quota_exceeded` decision with
 *      `Retry-After` set to the period roll-over.
 *
 *   3. Otherwise the request is fully allowed and the caller
 *      proceeds to the business logic.
 *
 * This order matches PLAN.md §9 and the OpenAPI 429 contract in
 * `apps/web/src/lib/openapi/common/errors.ts` (`rate_limited` + wait
 * in seconds, `quota_exceeded` + wait until period roll-over).
 *
 * ALL decisions — allowed AND denied — return the same
 * `RateLimitDecision` object with `headers` fully populated, so
 * routes can `for (const [k, v] of Object.entries(decision.headers))`
 * unconditionally without branching.
 */

import type { CrivacyDatabase } from '@/lib/db/client';

import type { FirmTier } from '@crivacy/shared-types';
import type { BucketState } from './bucket';
import { peekBucket } from './bucket';
import { RateLimitError } from './errors';
import { type HeaderMap, buildRateLimitHeaders, retryAfterFromMs, retryAfterMax } from './headers';
import type { MonthlyPeriod } from './periods';
import { getMonthlyPeriod, periodSecondsRemaining } from './periods';
import { type IncrementQuotaOutcome, incrementQuota, peekQuotaRow } from './quota';
import { type TierLimits, type TierLimitsOverride, resolveTierLimits } from './tiers';
import { consumeBucket } from './token-bucket';

/* ---------- Types ---------- */

/**
 * Decision returned to the caller. The discriminant is `allowed`
 * (plus `reason` on the denial branch). `headers` is always fully
 * populated — the caller never has to branch on which headers to
 * send.
 */
export type RateLimitDecision =
  | {
      readonly allowed: true;
      readonly tier: TierLimits;
      readonly bucket: BucketState;
      readonly period: MonthlyPeriod;
      readonly quota: IncrementQuotaOutcome;
      readonly headers: HeaderMap;
    }
  | {
      readonly allowed: false;
      readonly reason: 'rate_limited' | 'quota_exceeded';
      readonly retryAfterSeconds: number;
      readonly tier: TierLimits;
      readonly bucket: BucketState;
      readonly period: MonthlyPeriod;
      /**
       * Present iff the quota increment actually happened (the
       * request was denied by quota, not by bucket). On a bucket
       * denial the middleware exposes a `peekQuotaRow` snapshot here
       * instead, so the headers always reflect some quota state.
       */
      readonly quota: IncrementQuotaOutcome | QuotaPeek;
      readonly headers: HeaderMap;
    };

/**
 * Shape of the quota snapshot returned by `peekQuotaRow`; duplicated
 * here so the `RateLimitDecision` discriminated union can carry it on
 * the `rate_limited` branch without importing quota.ts's private type.
 */
export interface QuotaPeek {
  readonly count: number;
  readonly limitSnapshot: number;
  readonly remaining: number | null;
  readonly overage: number;
  readonly period: MonthlyPeriod;
}

export interface ApplyRateLimitInput {
  /** Firm that owns the request. Both the bucket and the quota counter
   *  are keyed on this — every credential (api key, OAuth token) a firm
   *  issues shares the same rate-limit and monthly quota. */
  readonly firmId: string;
  readonly firmTier: FirmTier;
  /** Per-firm override applied on top of the tier defaults. */
  readonly tierOverride?: TierLimitsOverride;
  readonly now: Date;
  /** Request cost in tokens. Default 1. */
  readonly cost?: number;
}

/* ---------- Core composer ---------- */

/**
 * Evaluate the bucket + quota gates for a single request and return
 * the composed `RateLimitDecision`. Fully idempotent with respect to
 * `cost === 0`? — no, cost must be > 0 and `consumeBucket` will
 * reject zero. For a read-only "peek" call use
 * `snapshotRateLimit` (below).
 */
export async function applyRateLimit(
  db: CrivacyDatabase,
  input: ApplyRateLimitInput,
): Promise<RateLimitDecision> {
  const { firmId, firmTier, tierOverride, now, cost = 1 } = input;

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RateLimitError('invalid_now_value', 'now must be a valid Date', {
      details: { value: String(now) },
    });
  }

  const tier = resolveTierLimits(firmTier, tierOverride);
  const period = getMonthlyPeriod(now);

  // ---- Stage 1: bucket ----
  const bucketOutcome = await consumeBucket(db, { firmId, tier, now, cost });
  const bucket = bucketOutcome.persisted;

  if (!bucketOutcome.result.allowed) {
    const quotaSnapshot = await peekQuotaRow(db, firmId, tier, now);
    const retryFromBucket = retryAfterFromMs(bucketOutcome.result.retryAfterMs);
    const headers = buildRateLimitHeaders({
      bucket,
      tier,
      period,
      quotaUsed: quotaSnapshot.count,
      now,
      allowed: false,
      retryAfterSeconds: retryFromBucket,
    });
    return {
      allowed: false,
      reason: 'rate_limited',
      retryAfterSeconds: retryFromBucket,
      tier,
      bucket,
      period,
      quota: quotaSnapshot,
      headers,
    };
  }

  // ---- Stage 2: quota ----
  const quotaOutcome = await incrementQuota(db, { firmId, tier, now, cost });

  if (!quotaOutcome.allowed) {
    const retryFromPeriod = periodSecondsRemaining(period, now);
    // A quota denial uses the period roll-over as the primary retry
    // hint; if the bucket still has wait time for a later request
    // we pick the larger of the two.
    const bucketPeekAfterQuota = peekBucket(bucket, now);
    const retryFromBucket =
      bucketPeekAfterQuota.tokens < cost
        ? retryAfterFromMs(((cost - bucketPeekAfterQuota.tokens) / bucket.refillRatePerSec) * 1000)
        : 0;
    const retryAfterSeconds = retryAfterMax(retryFromPeriod, retryFromBucket);
    const headers = buildRateLimitHeaders({
      bucket,
      tier,
      period,
      quotaUsed: quotaOutcome.count,
      now,
      allowed: false,
      retryAfterSeconds,
    });
    return {
      allowed: false,
      reason: 'quota_exceeded',
      retryAfterSeconds,
      tier,
      bucket,
      period,
      quota: quotaOutcome,
      headers,
    };
  }

  // ---- Allowed ----
  const headers = buildRateLimitHeaders({
    bucket,
    tier,
    period,
    quotaUsed: quotaOutcome.count,
    now,
    allowed: true,
  });
  return {
    allowed: true,
    tier,
    bucket,
    period,
    quota: quotaOutcome,
    headers,
  };
}

/**
 * Read-only snapshot of the current bucket + quota state for an API
 * key. Used by dashboards. Does NOT increment anything.
 */
export async function snapshotRateLimit(
  db: CrivacyDatabase,
  input: Omit<ApplyRateLimitInput, 'cost'>,
): Promise<{
  readonly tier: TierLimits;
  readonly bucket: BucketState | null;
  readonly quota: QuotaPeek;
  readonly period: MonthlyPeriod;
  readonly headers: HeaderMap;
}> {
  const { firmId, firmTier, tierOverride, now } = input;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RateLimitError('invalid_now_value', 'now must be a valid Date');
  }
  const tier = resolveTierLimits(firmTier, tierOverride);
  const period = getMonthlyPeriod(now);
  // Import `peekBucketRow` lazily to avoid a circular between
  // middleware.ts and token-bucket.ts. Both files import `bucket.ts`;
  // middleware additionally imports `token-bucket.ts`; token-bucket
  // never imports middleware. No cycle in fact — keep it direct.
  const { peekBucketRow } = await import('./token-bucket');
  const bucket = await peekBucketRow(db, firmId, tier);
  const quota = await peekQuotaRow(db, firmId, tier, now);

  const headers = buildRateLimitHeaders({
    bucket: bucket ?? {
      tokens: tier.capacity,
      capacity: tier.capacity,
      refillRatePerSec: tier.refillRatePerSec,
      lastRefillAt: now,
    },
    tier,
    period,
    quotaUsed: quota.count,
    now,
    allowed: true,
  });

  return {
    tier,
    bucket,
    quota,
    period,
    headers,
  };
}

/**
 * Helper used by the error-serialization layer: takes a denied
 * decision and returns the structured JSON body the public OpenAPI
 * 429 schema expects. Kept here so a future schema change flows
 * through one call site.
 */
export function decisionToErrorBody(decision: Extract<RateLimitDecision, { allowed: false }>): {
  readonly error: {
    readonly code: 'rate_limited' | 'quota_exceeded';
    readonly message: string;
    readonly retry_after_seconds: number;
    readonly details: {
      readonly limit: number;
      readonly remaining: number;
      readonly reset_at: string;
      readonly period?: string;
    };
  };
} {
  const base = {
    retry_after_seconds: decision.retryAfterSeconds,
  };
  if (decision.reason === 'rate_limited') {
    return {
      error: {
        code: 'rate_limited',
        message: `request rate exceeded; retry after ${decision.retryAfterSeconds}s`,
        ...base,
        details: {
          limit: decision.bucket.capacity,
          remaining: Math.max(0, Math.floor(decision.bucket.tokens)),
          reset_at: new Date(
            decision.bucket.lastRefillAt.getTime() +
              ((decision.bucket.capacity - decision.bucket.tokens) /
                decision.bucket.refillRatePerSec) *
                1000,
          ).toISOString(),
        },
      },
    };
  }
  // quota_exceeded
  const limitSnapshot = decision.quota.limitSnapshot;
  const count = decision.quota.count;
  return {
    error: {
      code: 'quota_exceeded',
      message: 'monthly quota exceeded; resets at period roll-over',
      ...base,
      details: {
        limit: limitSnapshot,
        remaining: Math.max(0, limitSnapshot - count),
        reset_at: decision.period.endAt.toISOString(),
        period: `${decision.period.year}-${decision.period.month.toString().padStart(2, '0')}`,
      },
    },
  };
}
