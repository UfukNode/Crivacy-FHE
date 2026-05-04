/**
 * Rate-limit library barrel.
 *
 * Public API — everything the route layer and tests need from one
 * import path. Internal helpers (raw row parsers, private SQL
 * constants) are NOT re-exported: callers that think they need them
 * should add a test fixture, not deepen the public surface.
 *
 * Layering (bottom → top):
 *
 *   errors.ts          → RateLimitError taxonomy
 *   tiers.ts           → TierLimits, DEFAULT_TIER_LIMITS, resolveTierLimits
 *   bucket.ts          → pure token-bucket math (no I/O)
 *   periods.ts         → monthly period value objects
 *   headers.ts         → X-RateLimit-* header builder
 *   token-bucket.ts    → SQL-facing bucket writer (consumeBucket)
 *   quota.ts           → SQL-facing quota writer (incrementQuota)
 *   middleware.ts      → applyRateLimit decision composer
 *
 * Route handlers call `applyRateLimit(db, { firmId, firmTier, now })`
 * and inspect `.allowed` / `.headers` / `.reason`. Dashboards call
 * `snapshotRateLimit`. Admin tooling uses `resetBucketToFull`.
 */

export { RateLimitError, type RateLimitErrorCode, type RateLimitErrorOptions } from './errors';

export {
  DEFAULT_TIER_LIMITS,
  TierLimitsSchema,
  UNLIMITED_QUOTA_SENTINEL,
  type TierLimits,
  type TierLimitsOverride,
  assertTierLimits,
  monthlyQuotaForStorage,
  resolveTierLimits,
} from './tiers';

export {
  type BucketState,
  type ConsumeResult,
  assertBucketState,
  consumeToken,
  emptyBucket,
  fullBucket,
  peekBucket,
  refillTokens,
} from './bucket';

export {
  type MonthlyPeriod,
  getMonthlyPeriod,
  nextPeriod,
  periodMsRemaining,
  periodSecondsRemaining,
  periodToIsoDate,
  periodsEqual,
} from './periods';

export {
  UNLIMITED_HEADER_VALUE,
  type HeaderInput,
  type HeaderMap,
  buildRateLimitHeaders,
  retryAfterFromMs,
  retryAfterMax,
} from './headers';

export {
  type ConsumeBucketInput,
  type ConsumeBucketOutcome,
  consumeBucket,
  peekBucketRow,
  resetBucketToFull,
} from './token-bucket';

export {
  type IncrementQuotaInput,
  type IncrementQuotaOutcome,
  incrementQuota,
  peekQuotaRow,
} from './quota';

export {
  type ApplyRateLimitInput,
  type QuotaPeek,
  type RateLimitDecision,
  applyRateLimit,
  decisionToErrorBody,
  snapshotRateLimit,
} from './middleware';
