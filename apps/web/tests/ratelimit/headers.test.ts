/**
 * Response header builder. Every field of the output map is covered:
 *   - The 4 X-RateLimit-* headers on an allowed request.
 *   - The 4 X-Quota-* headers on an allowed request.
 *   - The -1 unlimited sentinel on enterprise tier.
 *   - Retry-After presence ONLY on a denied decision, floored at 1s.
 *   - retryAfterFromMs / retryAfterMax helper guards.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIER_LIMITS,
  UNLIMITED_HEADER_VALUE,
  buildRateLimitHeaders,
  fullBucket,
  getMonthlyPeriod,
  retryAfterFromMs,
  retryAfterMax,
} from '@/lib/ratelimit';

const T0 = new Date('2026-03-15T12:00:00.000Z');

describe('buildRateLimitHeaders', () => {
  const bucket = fullBucket(100, 10, T0);
  const period = getMonthlyPeriod(T0);
  const tier = DEFAULT_TIER_LIMITS.pro;

  it('emits all X-RateLimit-* headers on an allowed request', () => {
    const headers = buildRateLimitHeaders({
      bucket,
      tier,
      period,
      quotaUsed: 10,
      now: T0,
      allowed: true,
    });
    expect(headers['X-RateLimit-Limit']).toBe('100');
    expect(headers['X-RateLimit-Remaining']).toBe('100');
    expect(headers['X-RateLimit-Policy']).toBe('100;w=10s');
    // Reset is "now" because the bucket is already full.
    expect(Number.parseInt(headers['X-RateLimit-Reset'] ?? '', 10)).toBeGreaterThanOrEqual(
      Math.ceil(T0.getTime() / 1000),
    );
  });

  it('emits all X-Quota-* headers with the numeric cap on a pro tier', () => {
    const headers = buildRateLimitHeaders({
      bucket,
      tier,
      period,
      quotaUsed: 500,
      now: T0,
      allowed: true,
    });
    expect(headers['X-Quota-Limit']).toBe('1000000');
    expect(headers['X-Quota-Remaining']).toBe('999500');
    expect(headers['X-Quota-Period']).toBe('2026-03-01');
    expect(Number.parseInt(headers['X-Quota-Reset'] ?? '', 10)).toBe(
      Math.ceil(new Date('2026-04-01T00:00:00Z').getTime() / 1000),
    );
  });

  it('emits the -1 sentinel on X-Quota-Limit/Remaining for enterprise', () => {
    const headers = buildRateLimitHeaders({
      bucket: fullBucket(3_000, 1_000, T0),
      tier: DEFAULT_TIER_LIMITS.enterprise,
      period,
      quotaUsed: 1_000_000_000,
      now: T0,
      allowed: true,
    });
    expect(headers['X-Quota-Limit']).toBe(UNLIMITED_HEADER_VALUE);
    expect(headers['X-Quota-Remaining']).toBe(UNLIMITED_HEADER_VALUE);
  });

  it('omits Retry-After when the decision is allowed', () => {
    const headers = buildRateLimitHeaders({
      bucket,
      tier,
      period,
      quotaUsed: 0,
      now: T0,
      allowed: true,
    });
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('sets Retry-After on a denied decision, using the explicit override', () => {
    const headers = buildRateLimitHeaders({
      bucket,
      tier,
      period,
      quotaUsed: 0,
      now: T0,
      allowed: false,
      retryAfterSeconds: 42,
    });
    expect(headers['Retry-After']).toBe('42');
  });

  it('defaults Retry-After to periodSecondsRemaining when omitted on a denial', () => {
    const headers = buildRateLimitHeaders({
      bucket,
      tier,
      period,
      quotaUsed: 0,
      now: new Date('2026-03-31T23:59:00Z'),
      allowed: false,
    });
    expect(headers['Retry-After']).toBeDefined();
    // 60 seconds to period end.
    expect(Number.parseInt(headers['Retry-After'] ?? '0', 10)).toBe(60);
  });

  it('floors a fractional X-RateLimit-Remaining so 0.9 → 0', () => {
    const partialBucket = {
      tokens: 0.9,
      capacity: 5,
      refillRatePerSec: 1,
      lastRefillAt: T0,
    };
    const headers = buildRateLimitHeaders({
      bucket: partialBucket,
      tier: DEFAULT_TIER_LIMITS.free,
      period,
      quotaUsed: 0,
      now: T0,
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(headers['X-RateLimit-Remaining']).toBe('0');
  });
});

describe('retryAfterFromMs', () => {
  it('rounds ms up to the next whole second', () => {
    expect(retryAfterFromMs(1)).toBe(1);
    expect(retryAfterFromMs(999)).toBe(1);
    expect(retryAfterFromMs(1_001)).toBe(2);
  });

  it('floors at 1 second for zero and negative inputs', () => {
    expect(retryAfterFromMs(0)).toBe(1);
    expect(retryAfterFromMs(-5)).toBe(1);
    expect(retryAfterFromMs(Number.NaN)).toBe(1);
  });
});

describe('retryAfterMax', () => {
  it('returns the larger of two positive values', () => {
    expect(retryAfterMax(5, 12)).toBe(12);
    expect(retryAfterMax(30, 1)).toBe(30);
  });

  it('never returns below 1', () => {
    expect(retryAfterMax(0, 0)).toBe(1);
    expect(retryAfterMax(-5, -10)).toBe(1);
  });
});
