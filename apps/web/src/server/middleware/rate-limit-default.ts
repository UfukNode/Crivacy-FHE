/**
 * Default rate-limit function the `apiRoute` builder injects when a
 * route does not pass one explicitly.
 *
 * The `@/lib/ratelimit` library's `applyRateLimit` returns a rich,
 * scope-aware decision object (bucket math + monthly quota +
 * pre-built header map). The api-route middleware was built around
 * an older, compact shape (`{ allowed, limit, remaining,
 * resetSeconds, ... }`) — this adapter bridges the two so every
 * `/api/v1/*` route picks up firm-keyed, tier-aware throttling
 * automatically without touching individual route files.
 *
 * Tests that want deterministic behaviour still override via the
 * `rateLimitFn:` option; `null` explicitly disables rate limiting.
 *
 * Fail-closed on a quota cap? NO. The api-route builder wraps this
 * call in a try/catch that fails OPEN (allows the request through
 * with a null snapshot). That is intentional: a rate-limit module
 * outage must not take the whole API offline. A genuine over-cap
 * request still returns `allowed: false` here — the catch only
 * fires on unexpected exceptions.
 *
 * @module
 */

import type { FirmTier } from '@crivacy/shared-types';

import type { CrivacyDatabase } from '@/lib/db/client';
import { applyRateLimit as applyRateLimitLib } from '@/lib/ratelimit';

import type { RateLimitDecision, RateLimitFn } from './api-route';

/**
 * Map the library's discriminated-union decision to the api-route
 * middleware's flat shape.
 */
export const defaultApiRateLimitFn: RateLimitFn = async (db, firmId, tier, now) => {
  const decision = await applyRateLimitLib(db, {
    firmId,
    firmTier: tier as FirmTier,
    now,
  });

  const bucketCapacity = decision.bucket.capacity;
  const bucketTokens = decision.bucket.tokens;
  const refillRate = decision.bucket.refillRatePerSec;

  // Bucket `resetSeconds` = wall time for the bucket to refill to
  // full. Zero when already full. Guard against divide-by-zero even
  // though tiers.ts rejects refillRatePerSec <= 0 at load time.
  const bucketResetSeconds =
    refillRate > 0
      ? Math.max(0, Math.ceil((bucketCapacity - bucketTokens) / refillRate))
      : 0;

  const quotaResetSeconds = Math.max(
    0,
    Math.ceil((decision.period.endAt.getTime() - now.getTime()) / 1000),
  );

  // Unlimited quota tiers (enterprise) surface `remaining: null`
  // from the library. Translate that to "omit the header fields" so
  // the downstream `X-Quota-*` headers stay absent rather than
  // claiming a literal MAX_SAFE_INTEGER ceiling.
  const unlimited = decision.quota.remaining === null;

  const quotaFields = unlimited
    ? {}
    : {
        quotaLimit: decision.quota.limitSnapshot,
        quotaRemaining: decision.quota.remaining,
        quotaResetSeconds,
      };

  const base: RateLimitDecision = {
    allowed: decision.allowed,
    limit: bucketCapacity,
    remaining: Math.max(0, Math.floor(bucketTokens)),
    resetSeconds: bucketResetSeconds,
    ...quotaFields,
  };

  if (decision.allowed) {
    return base;
  }

  return {
    ...base,
    retryAfterSeconds: decision.retryAfterSeconds,
  };
};
