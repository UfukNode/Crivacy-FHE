/**
 * Rate-limit response-header builder.
 *
 * Every public API response — allowed or denied — gets a consistent
 * set of `X-RateLimit-*` headers so dashboards, SDK clients, and
 * debug logs can introspect the bucket without re-calling the API.
 * The header set is also what the OpenAPI generator wires into
 * response schemas via `x-rate-limit-response-headers` in
 * `src/lib/openapi/common/errors.ts`.
 *
 * The header catalog (stable public contract):
 *
 *   X-RateLimit-Limit       Per-second burst capacity (bucket capacity,
 *                           NOT RPS — clients expect "how many requests
 *                           per window" where the window is infinite).
 *   X-RateLimit-Remaining   Floor of tokens remaining post-deduct (0
 *                           when denied).
 *   X-RateLimit-Reset       Unix seconds at which the bucket will
 *                           have been fully refilled.
 *   X-RateLimit-Policy      Human-readable refill policy, e.g.
 *                           `100;w=1s` per RFC 9459 draft.
 *
 *   X-Quota-Limit           Monthly quota cap (or -1 when unlimited).
 *   X-Quota-Remaining       Monthly quota remaining (or -1 when unlimited).
 *   X-Quota-Reset           Unix seconds of next period start.
 *   X-Quota-Period          ISO YYYY-MM-01 of the current period.
 *
 *   Retry-After             Set only on a denied decision. Value in
 *                           seconds, matching RFC 9110 §10.2.3. The
 *                           middleware picks the LARGER of the bucket
 *                           retry and the quota retry.
 *
 * The "-1 when unlimited" convention for `X-Quota-Limit` /
 * `X-Quota-Remaining` is symmetric with the PLAN.md §9 tier table
 * (enterprise has `unlimited` quota) and mirrors GitHub's own
 * rate-limit headers. Clients that cannot parse it still render `-1`
 * as a number, which is distinguishable from any real quota.
 */

import type { BucketState } from './bucket';
import { peekBucket } from './bucket';
import type { MonthlyPeriod } from './periods';
import { periodMsRemaining, periodSecondsRemaining, periodToIsoDate } from './periods';
import type { TierLimits } from './tiers';

/* ---------- Types ---------- */

/**
 * Input for the header builder. Every field is required so the caller
 * cannot accidentally omit the quota half and silently drop the
 * `X-Quota-*` headers.
 */
export interface HeaderInput {
  /** The bucket state AFTER the consume attempt (refilled + possibly decremented). */
  readonly bucket: BucketState;
  /** Tier limits in effect for this firm at decision time. */
  readonly tier: TierLimits;
  /** The monthly period the request was attributed to. */
  readonly period: MonthlyPeriod;
  /** Quota usage AFTER the increment, or BEFORE if the request was denied. */
  readonly quotaUsed: number;
  /** Current wall-clock time (test seam). */
  readonly now: Date;
  /** Did the request pass the rate-limit + quota gate? */
  readonly allowed: boolean;
  /**
   * Retry hint in seconds, picked as `max(bucketRetry, quotaRetry)`
   * by the middleware. Only honored when `allowed === false`;
   * otherwise `Retry-After` is omitted.
   */
  readonly retryAfterSeconds?: number;
}

/**
 * Output shape: a flat `Record<string, string>` so the Next.js route
 * handler can `headers.set(k, v)` in a single loop and there is no
 * bespoke header wrapper to keep in sync.
 */
export type HeaderMap = Record<string, string>;

/* ---------- Constants ---------- */

/**
 * Sentinel used in `X-Quota-*` headers when the tier has no monthly
 * cap. Distinct from `0` (denied), negative so a client treating the
 * value as a counter cannot ever hit it.
 */
export const UNLIMITED_HEADER_VALUE = '-1' as const;

/* ---------- Helpers ---------- */

/**
 * Format a `Date` as its unix-seconds representation, rounded UP so a
 * `Reset` header never lies about when the counter becomes zero.
 */
function unixSecondsCeil(date: Date): string {
  return Math.ceil(date.getTime() / 1000).toString();
}

/**
 * Format a token count for `X-RateLimit-Remaining`. Floored — we
 * never want to advertise a half-token as "1 request remaining".
 */
function floorTokenHeader(tokens: number): string {
  return Math.max(0, Math.floor(tokens)).toString();
}

/**
 * Format the `X-RateLimit-Policy` header value following the
 * draft-ietf-httpapi-ratelimit-headers rendering: `capacity;w=<window>`,
 * where `w` is the refill window in seconds (derived from the refill
 * rate). A refill rate of `100/s` with capacity `300` renders as
 * `300;w=3s` — the window is the time to refill from empty to full.
 */
function formatPolicy(bucket: BucketState): string {
  const windowSeconds = Math.ceil(bucket.capacity / bucket.refillRatePerSec);
  return `${bucket.capacity};w=${windowSeconds}s`;
}

/* ---------- Builder ---------- */

/**
 * Build the complete header map for a rate-limit decision. Always
 * returns all 8 `X-*` headers plus (conditionally) `Retry-After`.
 * The caller loops over the object and sets each pair on the outgoing
 * Response — no ordering concerns, no conditional branches on the
 * caller side.
 */
export function buildRateLimitHeaders(input: HeaderInput): HeaderMap {
  const { bucket, tier, period, quotaUsed, now, allowed, retryAfterSeconds } = input;

  // Bucket headers. `peekBucket` gives us the post-refill view we want
  // in the header response even on a denied decision (where the caller
  // passed in the pre-deduct state unchanged).
  const peek = peekBucket(bucket, now);
  const resetAt = new Date(now.getTime() + peek.msUntilFull);

  const headers: HeaderMap = {
    'X-RateLimit-Limit': bucket.capacity.toString(),
    'X-RateLimit-Remaining': floorTokenHeader(peek.tokens),
    'X-RateLimit-Reset': unixSecondsCeil(resetAt),
    'X-RateLimit-Policy': formatPolicy(bucket),
  };

  // Quota headers. `tier.monthlyQuota === null` means enterprise /
  // unlimited; we emit the sentinel `-1` for both Limit and Remaining
  // so clients don't need two code paths.
  const quotaLimit = tier.monthlyQuota;
  if (quotaLimit === null) {
    headers['X-Quota-Limit'] = UNLIMITED_HEADER_VALUE;
    headers['X-Quota-Remaining'] = UNLIMITED_HEADER_VALUE;
  } else {
    const remaining = Math.max(0, quotaLimit - quotaUsed);
    headers['X-Quota-Limit'] = quotaLimit.toString();
    headers['X-Quota-Remaining'] = remaining.toString();
  }
  headers['X-Quota-Reset'] = unixSecondsCeil(period.endAt);
  headers['X-Quota-Period'] = periodToIsoDate(period);

  // Retry-After is only meaningful on denial. Explicit `retryAfterSeconds`
  // wins over the derived value so the middleware can pass `max(bucket,
  // quota)` without re-deriving inside the header builder.
  if (!allowed) {
    const retry =
      retryAfterSeconds !== undefined
        ? Math.max(1, Math.ceil(retryAfterSeconds))
        : Math.max(1, periodSecondsRemaining(period, now));
    headers['Retry-After'] = retry.toString();
  }

  return headers;
}

/**
 * Shortcut: compute `Retry-After` in seconds from a raw ms value
 * (as produced by `consumeToken().retryAfterMs`). Rounds UP and
 * floors at 1 so the smallest advertised retry is 1 second — a
 * `Retry-After: 0` reply is meaningless and some proxies coerce it
 * to a default.
 */
export function retryAfterFromMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Shortcut: compute the larger of two retry hints, preserving the "at
 * least 1 second" floor. Used by the middleware to pick one
 * `Retry-After` value from the bucket retry + the quota retry.
 */
export function retryAfterMax(a: number, b: number): number {
  const floorA = Number.isFinite(a) && a > 0 ? a : 0;
  const floorB = Number.isFinite(b) && b > 0 ? b : 0;
  return Math.max(1, floorA, floorB);
}

/**
 * `periodMsRemaining` is re-exported so route code can compute an
 * exact wall-clock-ms countdown for structured error payloads without
 * importing from two modules.
 */
export { periodMsRemaining };
