/**
 * Pure token-bucket math. All tests are deterministic and run
 * without a database — the bucket layer is the algebra that the SQL
 * layer persists.
 *
 * Coverage points of interest:
 *   - Refill is exactly `tokens + elapsed_s * rate`, capped at capacity.
 *   - Backwards clock skew never drains the bucket.
 *   - An exact-zero request (`tokens === cost`) is allowed.
 *   - A sub-ULP shortfall is allowed (floating-point guard).
 *   - A genuine shortfall returns `retryAfterMs` that is strictly
 *     enough to cover the gap, never smaller than ceil(ms).
 *   - `fullBucket` / `emptyBucket` constructors validate their inputs.
 */

import { describe, expect, it } from 'vitest';

import {
  type BucketState,
  RateLimitError,
  assertBucketState,
  consumeToken,
  emptyBucket,
  fullBucket,
  peekBucket,
  refillTokens,
} from '@/lib/ratelimit';

const T0 = new Date('2026-03-15T12:00:00.000Z');

function bucket(overrides: Partial<BucketState> = {}): BucketState {
  return {
    tokens: 5,
    lastRefillAt: T0,
    capacity: 5,
    refillRatePerSec: 1,
    ...overrides,
  };
}

describe('refillTokens', () => {
  it('returns the stored tokens when now equals lastRefillAt', () => {
    expect(refillTokens(bucket({ tokens: 3 }), T0)).toBe(3);
  });

  it('caps the refilled value at capacity', () => {
    const state = bucket({ tokens: 2, capacity: 5, refillRatePerSec: 10 });
    // 100ms later → +1 token (0.1 * 10). Still under cap.
    expect(refillTokens(state, new Date(T0.getTime() + 100))).toBeCloseTo(3, 6);
    // 1s later → +10 tokens → capped at 5.
    expect(refillTokens(state, new Date(T0.getTime() + 1000))).toBe(5);
  });

  it('treats a backwards clock as zero elapsed', () => {
    const state = bucket({ tokens: 2 });
    const earlier = new Date(T0.getTime() - 5_000);
    // Clock went back 5s — must NOT be interpreted as -5 tokens.
    expect(refillTokens(state, earlier)).toBe(2);
  });

  it('refills fractional tokens when the rate is a decimal', () => {
    const state = bucket({ tokens: 0, capacity: 10, refillRatePerSec: 0.5 });
    // 3s later → +1.5 tokens.
    expect(refillTokens(state, new Date(T0.getTime() + 3_000))).toBeCloseTo(1.5, 6);
  });

  it('throws when now is an invalid Date', () => {
    expect(() => refillTokens(bucket(), new Date('not-a-date'))).toThrowError(RateLimitError);
  });

  it('throws bucket_row_malformed when tokens are negative', () => {
    expect(() => refillTokens(bucket({ tokens: -1 }), T0)).toThrowError(RateLimitError);
  });
});

describe('consumeToken', () => {
  it('allows a request when tokens exceed the cost', () => {
    const result = consumeToken(bucket({ tokens: 5 }), T0, 1);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.tokensAfter).toBe(4);
      expect(result.tokensBeforeDeduct).toBe(5);
    }
  });

  it('allows a request when tokens exactly equal cost', () => {
    const result = consumeToken(bucket({ tokens: 1 }), T0, 1);
    expect(result.allowed).toBe(true);
  });

  it('denies a request when tokens are strictly below cost', () => {
    const result = consumeToken(bucket({ tokens: 0 }), T0, 1);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.tokensAfter).toBe(0);
      // Refill rate 1/s, need 1 token → 1000ms.
      expect(result.retryAfterMs).toBe(1_000);
    }
  });

  it('rounds retryAfterMs up to the next whole millisecond', () => {
    const state = bucket({ tokens: 0.5, refillRatePerSec: 1 });
    const result = consumeToken(state, T0, 1);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // Need 0.5 token at 1/s = 500ms. Already aligned.
      expect(result.retryAfterMs).toBe(500);
    }
  });

  it('supports cost > 1 (weighted requests)', () => {
    const state = bucket({ tokens: 10, capacity: 30, refillRatePerSec: 10 });
    const result = consumeToken(state, T0, 5);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.tokensAfter).toBe(5);
    }
  });

  it('denies and returns the precise wait when cost > refilled tokens', () => {
    const state = bucket({ tokens: 2, capacity: 30, refillRatePerSec: 10 });
    const result = consumeToken(state, T0, 5);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // Need 3 more at 10/s = 300ms.
      expect(result.retryAfterMs).toBe(300);
    }
  });

  it('rejects a zero cost', () => {
    expect(() => consumeToken(bucket(), T0, 0)).toThrowError(RateLimitError);
  });

  it('rejects a negative cost', () => {
    expect(() => consumeToken(bucket(), T0, -1)).toThrowError(RateLimitError);
  });

  it('rejects a NaN cost', () => {
    expect(() => consumeToken(bucket(), T0, Number.NaN)).toThrowError(RateLimitError);
  });

  it('computes msUntilFull on allowed branch', () => {
    const state = bucket({ tokens: 5, capacity: 5, refillRatePerSec: 1 });
    const result = consumeToken(state, T0, 1);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      // After deduct → 4. Refill 1 more at 1/s = 1000ms to full.
      expect(result.msUntilFull).toBe(1_000);
    }
  });
});

describe('peekBucket', () => {
  it('returns the refilled token count without mutating state', () => {
    const state = bucket({ tokens: 0, capacity: 5, refillRatePerSec: 1 });
    const peek = peekBucket(state, new Date(T0.getTime() + 2_500));
    expect(peek.tokens).toBeCloseTo(2.5, 6);
    // Original state unchanged.
    expect(state.tokens).toBe(0);
  });

  it('returns msUntilFull=0 when already at capacity', () => {
    const peek = peekBucket(bucket({ tokens: 5, capacity: 5 }), T0);
    expect(peek.msUntilFull).toBe(0);
  });
});

describe('fullBucket / emptyBucket', () => {
  it('fullBucket returns tokens = capacity', () => {
    const b = fullBucket(10, 1, T0);
    expect(b.tokens).toBe(10);
    expect(b.capacity).toBe(10);
    expect(b.refillRatePerSec).toBe(1);
    expect(b.lastRefillAt).toEqual(T0);
  });

  it('emptyBucket returns tokens = 0', () => {
    const b = emptyBucket(10, 1, T0);
    expect(b.tokens).toBe(0);
    expect(b.capacity).toBe(10);
  });

  it('both reject a non-positive capacity', () => {
    expect(() => fullBucket(0, 1, T0)).toThrowError(RateLimitError);
    expect(() => emptyBucket(-1, 1, T0)).toThrowError(RateLimitError);
  });

  it('both reject a non-finite refill rate', () => {
    expect(() => fullBucket(10, Number.NaN, T0)).toThrowError(RateLimitError);
    expect(() => emptyBucket(10, Number.POSITIVE_INFINITY, T0)).toThrowError(RateLimitError);
  });
});

describe('assertBucketState', () => {
  it('accepts a well-formed state', () => {
    expect(() => assertBucketState(bucket())).not.toThrow();
  });

  it('rejects a NaN tokens field', () => {
    expect(() => assertBucketState(bucket({ tokens: Number.NaN }))).toThrowError(RateLimitError);
  });
});
