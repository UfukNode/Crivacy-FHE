/**
 * Tier defaults + `resolveTierLimits` merger.
 *
 * The PLAN.md §9 tier table is the product contract; these tests
 * pin every row of it so a future edit fails the suite and forces
 * the engineer to update both places in the same commit.
 *
 * The merger tests cover the `exactOptionalPropertyTypes`-safe field
 * merging: omitted fields fall through to defaults, explicit `null`
 * on the nullable fields lifts the cap, and explicit `0` / NaN
 * inputs are rejected at merge time.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIER_LIMITS,
  RateLimitError,
  TierLimitsSchema,
  UNLIMITED_QUOTA_SENTINEL,
  assertTierLimits,
  monthlyQuotaForStorage,
  resolveTierLimits,
} from '@/lib/ratelimit';

describe('DEFAULT_TIER_LIMITS', () => {
  it('matches the PLAN.md §9 free-tier row', () => {
    expect(DEFAULT_TIER_LIMITS.free).toEqual({
      capacity: 5,
      refillRatePerSec: 1,
      monthlyQuota: 1_000,
      webhookEndpoints: 1,
      oauthClients: 1,
      apiKeys: 2,
    });
  });

  it('matches the PLAN.md §9 starter-tier row', () => {
    expect(DEFAULT_TIER_LIMITS.starter).toEqual({
      capacity: 30,
      refillRatePerSec: 10,
      monthlyQuota: 100_000,
      webhookEndpoints: 5,
      oauthClients: 3,
      apiKeys: 5,
    });
  });

  it('matches the PLAN.md §9 pro-tier row', () => {
    expect(DEFAULT_TIER_LIMITS.pro).toEqual({
      capacity: 300,
      refillRatePerSec: 100,
      monthlyQuota: 1_000_000,
      webhookEndpoints: 50,
      oauthClients: 20,
      apiKeys: 50,
    });
  });

  it('matches the PLAN.md §9 enterprise-tier row (unlimited quota)', () => {
    expect(DEFAULT_TIER_LIMITS.enterprise).toEqual({
      capacity: 3_000,
      refillRatePerSec: 1_000,
      monthlyQuota: null,
      webhookEndpoints: null,
      oauthClients: null,
      apiKeys: null,
    });
  });

  it('is deeply frozen to prevent accidental mutation', () => {
    expect(Object.isFrozen(DEFAULT_TIER_LIMITS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TIER_LIMITS.free)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TIER_LIMITS.enterprise)).toBe(true);
  });
});

describe('TierLimitsSchema', () => {
  it('parses a well-formed free-tier row', () => {
    const parsed = TierLimitsSchema.parse({
      capacity: 5,
      refillRatePerSec: 1,
      monthlyQuota: 1000,
      webhookEndpoints: 1,
      oauthClients: 1,
      apiKeys: 2,
    });
    expect(parsed.capacity).toBe(5);
  });

  it('rejects a non-integer capacity', () => {
    const result = TierLimitsSchema.safeParse({
      capacity: 5.5,
      refillRatePerSec: 1,
      monthlyQuota: 1000,
      webhookEndpoints: 1,
      oauthClients: 1,
      apiKeys: 2,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a zero refill rate', () => {
    const result = TierLimitsSchema.safeParse({
      capacity: 5,
      refillRatePerSec: 0,
      monthlyQuota: 1000,
      webhookEndpoints: 1,
      oauthClients: 1,
      apiKeys: 2,
    });
    expect(result.success).toBe(false);
  });

  it('accepts null on monthlyQuota, webhookEndpoints, oauthClients, apiKeys (unlimited)', () => {
    expect(
      TierLimitsSchema.safeParse({
        capacity: 3000,
        refillRatePerSec: 1000,
        monthlyQuota: null,
        webhookEndpoints: null,
        oauthClients: null,
        apiKeys: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a negative monthly quota', () => {
    const result = TierLimitsSchema.safeParse({
      capacity: 5,
      refillRatePerSec: 1,
      monthlyQuota: -1,
      webhookEndpoints: 1,
      oauthClients: 1,
      apiKeys: 2,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields in strict mode', () => {
    const result = TierLimitsSchema.safeParse({
      capacity: 5,
      refillRatePerSec: 1,
      monthlyQuota: 1000,
      webhookEndpoints: 1,
      oauthClients: 1,
      apiKeys: 2,
      secretField: 'boom',
    });
    expect(result.success).toBe(false);
  });
});

describe('assertTierLimits', () => {
  it('throws a RateLimitError with code invalid_tier_config on bad input', () => {
    expect(() => assertTierLimits({ capacity: 'five' })).toThrowError(RateLimitError);
    try {
      assertTierLimits({
        capacity: 0,
        refillRatePerSec: 1,
        monthlyQuota: null,
        webhookEndpoints: null,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).code).toBe('invalid_tier_config');
    }
  });

  it('returns (narrows type) without throwing on a valid object', () => {
    const candidate: unknown = {
      capacity: 10,
      refillRatePerSec: 2,
      monthlyQuota: 500,
      webhookEndpoints: 1,
      oauthClients: 1,
      apiKeys: 1,
    };
    assertTierLimits(candidate);
    // After the assertion the compiler treats `candidate` as TierLimits.
    expect(candidate.capacity).toBe(10);
  });
});

describe('resolveTierLimits', () => {
  it('returns the default when no overrides are supplied', () => {
    expect(resolveTierLimits('free')).toEqual(DEFAULT_TIER_LIMITS.free);
  });

  it('merges a single scalar override without touching other fields', () => {
    const merged = resolveTierLimits('starter', { capacity: 60 });
    expect(merged).toEqual({
      capacity: 60,
      refillRatePerSec: 10,
      monthlyQuota: 100_000,
      webhookEndpoints: 5,
      oauthClients: DEFAULT_TIER_LIMITS.starter.oauthClients,
      apiKeys: DEFAULT_TIER_LIMITS.starter.apiKeys,
    });
  });

  it('respects explicit null on monthlyQuota to lift the cap', () => {
    const merged = resolveTierLimits('pro', { monthlyQuota: null });
    expect(merged.monthlyQuota).toBeNull();
  });

  it('respects explicit null on webhookEndpoints to lift the cap', () => {
    const merged = resolveTierLimits('pro', { webhookEndpoints: null });
    expect(merged.webhookEndpoints).toBeNull();
  });

  it('does not lift a cap when the override is an empty object', () => {
    const merged = resolveTierLimits('free', {});
    expect(merged.monthlyQuota).toBe(1_000);
    expect(merged.webhookEndpoints).toBe(1);
  });

  it('throws on a tier name that is not in the table', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberate bad input
      resolveTierLimits('platinum' as any),
    ).toThrowError(/unknown_tier|no default limits/);
  });

  it('throws when an override produces an invalid merged object', () => {
    try {
      resolveTierLimits('free', { capacity: 0 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).code).toBe('invalid_tier_config');
    }
  });

  it('enables a custom-contract enterprise firm with a lowered refill rate', () => {
    const merged = resolveTierLimits('enterprise', { refillRatePerSec: 500 });
    expect(merged).toEqual({
      capacity: 3_000,
      refillRatePerSec: 500,
      monthlyQuota: null,
      webhookEndpoints: null,
      oauthClients: null,
      apiKeys: null,
    });
  });
});

describe('monthlyQuotaForStorage', () => {
  it('returns the quota verbatim when the tier has a cap', () => {
    expect(monthlyQuotaForStorage(DEFAULT_TIER_LIMITS.pro)).toBe(1_000_000);
  });

  it('returns the sentinel when the tier is unlimited', () => {
    expect(monthlyQuotaForStorage(DEFAULT_TIER_LIMITS.enterprise)).toBe(UNLIMITED_QUOTA_SENTINEL);
    expect(UNLIMITED_QUOTA_SENTINEL).toBe(Number.MAX_SAFE_INTEGER);
  });
});
