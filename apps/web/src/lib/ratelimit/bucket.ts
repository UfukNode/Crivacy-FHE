/**
 * Pure token-bucket math.
 *
 * Everything in this file is a deterministic function of its inputs — no
 * clocks, no I/O, no database. The SQL-facing layer (`token-bucket.ts`)
 * maps a `rate_limit_buckets` row into a `BucketState`, hands it to the
 * helpers here, and writes the result back under `FOR UPDATE` row-lock.
 *
 * Keeping the math isolated has two payoffs:
 *
 *   1. Unit tests drive every branch (exact-zero, just-above-capacity,
 *      negative clock skew, fractional tokens) without needing Postgres.
 *
 *   2. The exact same `refillTokens` formula is used by `headers.ts` to
 *      compute the `X-RateLimit-Remaining` / `X-RateLimit-Reset` values a
 *      request returns — so the middleware and the response header can
 *      never disagree.
 *
 * The SQL refill expression in `rate-limit.ts` (`tokenBucketRefillSql`) is
 * the authoritative implementation for the database side. This file
 * MIRRORS that formula in TypeScript; if you change one, change the other
 * in the same commit and update `bucket.test.ts` parity checks.
 *
 * The bucket is a classic leaky-bucket-as-meter (a.k.a. GCRA-equivalent
 * token bucket): tokens refill linearly at `refillRatePerSec`, capped at
 * `capacity`. A request of `cost` tokens is allowed iff `tokens >= cost`
 * after the refill; the post-consume count is `tokens - cost`. A clock
 * that goes backwards (NTP step, DST, test) is treated as "no elapsed
 * time" rather than negative elapsed time — i.e. we never drain the
 * bucket as a side-effect of the clock.
 */

import { RateLimitError } from './errors';

/* ---------- Types ---------- */

/**
 * Canonical token-bucket row, stripped of DB serialization concerns.
 *
 * The SQL layer converts the `numeric` string columns to `number` before
 * constructing this object. All four fields are required; there is no
 * "partially refilled" intermediate state exposed outside this module.
 */
export interface BucketState {
  /** Token count BEFORE refill. Always `>= 0`. */
  readonly tokens: number;
  /** The `last_refill_at` timestamp that `tokens` was measured against. */
  readonly lastRefillAt: Date;
  /** Bucket capacity (tokens when full). Always `> 0`. */
  readonly capacity: number;
  /** Sustained refill rate in tokens/second. Always `> 0`. */
  readonly refillRatePerSec: number;
}

/**
 * Outcome of `consumeToken`. `allowed === false` carries the bucket
 * state as-if no deduct happened plus the precise wait before the same
 * request could succeed.
 */
export type ConsumeResult =
  | {
      readonly allowed: true;
      /** Token count AFTER the successful refill+deduct. */
      readonly tokensAfter: number;
      /** Timestamp stamped onto the row as `last_refill_at`. */
      readonly refilledAt: Date;
      /** Tokens available pre-deduct, useful for metrics. */
      readonly tokensBeforeDeduct: number;
      /**
       * Milliseconds until the bucket would be completely full again
       * from `tokensAfter`. Zero when `tokensAfter === capacity`.
       */
      readonly msUntilFull: number;
    }
  | {
      readonly allowed: false;
      /** Post-refill token count (unchanged on denied request). */
      readonly tokensAfter: number;
      /** Timestamp stamped onto the row as `last_refill_at`. */
      readonly refilledAt: Date;
      /** Alias of `tokensAfter`, kept for metric symmetry with the allowed branch. */
      readonly tokensBeforeDeduct: number;
      /**
       * Milliseconds until `cost` tokens are available. Guaranteed
       * strictly `> 0` on this branch; computed from the shortfall and
       * the refill rate, rounded UP to the next millisecond so a
       * `Retry-After` header never under-advises the client.
       */
      readonly retryAfterMs: number;
    };

/* ---------- Validation ---------- */

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RateLimitError('invalid_tier_config', `${name} must be a positive integer`, {
      details: { field: name, value },
    });
  }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RateLimitError('invalid_tier_config', `${name} must be a positive finite number`, {
      details: { field: name, value },
    });
  }
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RateLimitError(
      'bucket_row_malformed',
      `${name} must be a non-negative finite number`,
      { details: { field: name, value } },
    );
  }
}

function assertValidDate(name: string, value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RateLimitError('invalid_now_value', `${name} must be a valid Date`, {
      details: { field: name, value: String(value) },
    });
  }
}

function assertCost(cost: number): void {
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new RateLimitError('invalid_request_cost', 'request cost must be a finite number > 0', {
      details: { cost },
    });
  }
}

/**
 * Throws on any structurally broken bucket row. The SQL layer calls
 * this after materializing a DB row so a malformed row becomes a
 * `bucket_row_malformed` error instead of `NaN` tokens leaking into
 * subsequent math.
 */
export function assertBucketState(state: BucketState): void {
  assertPositiveInt('capacity', state.capacity);
  assertPositiveFinite('refillRatePerSec', state.refillRatePerSec);
  assertNonNegativeFinite('tokens', state.tokens);
  assertValidDate('lastRefillAt', state.lastRefillAt);
  // A bucket whose stored token count somehow exceeds capacity is a
  // bug elsewhere (e.g. a missed UPDATE). Clamp silently at the math
  // layer so the caller sees consistent numbers, but surface the
  // anomaly on metrics via `tokensBeforeDeduct > capacity`.
}

/* ---------- Core math ---------- */

/**
 * Compute the refilled token count given the elapsed wall-clock time
 * between `state.lastRefillAt` and `now`. Mirrors `tokenBucketRefillSql`
 * exactly (least(capacity, tokens + elapsed_seconds * rate)).
 *
 * A negative elapsed (clock going backwards) yields `state.tokens`,
 * never a drained bucket. The caller is responsible for passing a `now`
 * it trusts; this helper refuses NaN dates but accepts arbitrary
 * past/future values.
 */
export function refillTokens(state: BucketState, now: Date): number {
  assertBucketState(state);
  assertValidDate('now', now);

  const elapsedMs = now.getTime() - state.lastRefillAt.getTime();
  // Clock-skew defense: treat a backwards clock as zero elapsed. This
  // matches the `now()` guarantee used by the SQL variant (Postgres's
  // `now()` is monotonic within a transaction).
  if (elapsedMs <= 0) {
    return Math.min(state.tokens, state.capacity);
  }
  const elapsedSeconds = elapsedMs / 1000;
  const refilled = state.tokens + elapsedSeconds * state.refillRatePerSec;
  // Cap at capacity and guard against floating-point drift producing a
  // value a few ULPs above capacity (which then round-trips as a number
  // SQL refuses to store in `numeric(20,6)`).
  return Math.min(refilled, state.capacity);
}

/**
 * Compute the ms-wait until `targetTokens` are available in the bucket,
 * starting from `fromTokens`. Always rounds UP to the next whole
 * millisecond so a `Retry-After` header never promises "now" while the
 * underlying refill is still fractional.
 */
function msUntilTokens(fromTokens: number, targetTokens: number, ratePerSec: number): number {
  if (fromTokens >= targetTokens) {
    return 0;
  }
  const shortfall = targetTokens - fromTokens;
  const seconds = shortfall / ratePerSec;
  return Math.ceil(seconds * 1000);
}

/**
 * Refill + attempt to consume `cost` tokens from the bucket.
 *
 * This is a pure function; it returns the next `BucketState` implicitly
 * via `tokensAfter` + `refilledAt`, leaving persistence to the caller.
 *
 * Success path: `tokens >= cost` post-refill → `allowed: true`,
 * `tokensAfter = refilled - cost`, `msUntilFull` derived.
 *
 * Denial path: `tokens < cost` post-refill → `allowed: false`,
 * `retryAfterMs` derived from the shortfall and the refill rate.
 *
 * `cost === 1` is the common case; `cost > 1` is reserved for future
 * "weighted" endpoints (e.g. a batch verify that spends 5 tokens).
 */
export function consumeToken(state: BucketState, now: Date, cost = 1): ConsumeResult {
  assertBucketState(state);
  assertValidDate('now', now);
  assertCost(cost);

  const refilled = refillTokens(state, now);

  if (refilled + 1e-9 < cost) {
    // Denial branch. `+1e-9` absorbs a ULP-level shortfall so a bucket
    // that mathematically holds exactly `cost` tokens is allowed.
    const retryAfterMs = msUntilTokens(refilled, cost, state.refillRatePerSec);
    return {
      allowed: false,
      tokensAfter: refilled,
      refilledAt: now,
      tokensBeforeDeduct: refilled,
      retryAfterMs,
    };
  }

  const tokensAfter = Math.max(0, refilled - cost);
  const msUntilFull = msUntilTokens(tokensAfter, state.capacity, state.refillRatePerSec);
  return {
    allowed: true,
    tokensAfter,
    refilledAt: now,
    tokensBeforeDeduct: refilled,
    msUntilFull,
  };
}

/**
 * Observe the bucket without consuming. Used by dashboards and by the
 * header builder to compute `X-RateLimit-Remaining` / `X-RateLimit-Reset`
 * on a denied request. Returns the same refilled token count
 * `consumeToken` would have seen, plus the ms-until-full, without
 * mutating any conceptual state.
 */
export function peekBucket(
  state: BucketState,
  now: Date,
): { readonly tokens: number; readonly msUntilFull: number } {
  const refilled = refillTokens(state, now);
  const msUntilFull = msUntilTokens(refilled, state.capacity, state.refillRatePerSec);
  return { tokens: refilled, msUntilFull };
}

/**
 * Compute the fully-refilled bucket state. Used when a firm is upgraded
 * to a higher tier and we want to grant the new capacity immediately
 * without waiting for the refill clock.
 */
export function fullBucket(capacity: number, refillRatePerSec: number, now: Date): BucketState {
  assertPositiveInt('capacity', capacity);
  assertPositiveFinite('refillRatePerSec', refillRatePerSec);
  assertValidDate('now', now);
  return {
    tokens: capacity,
    lastRefillAt: now,
    capacity,
    refillRatePerSec,
  };
}

/**
 * Compute an empty bucket. Used in tests and by the SQL layer when the
 * INSERT side of `INSERT ... ON CONFLICT DO NOTHING` is the side that
 * ran — we immediately overwrite `tokens` to capacity in the same
 * transaction, so the "empty" form is only used for the lazy-insert
 * default row.
 */
export function emptyBucket(capacity: number, refillRatePerSec: number, now: Date): BucketState {
  assertPositiveInt('capacity', capacity);
  assertPositiveFinite('refillRatePerSec', refillRatePerSec);
  assertValidDate('now', now);
  return {
    tokens: 0,
    lastRefillAt: now,
    capacity,
    refillRatePerSec,
  };
}
