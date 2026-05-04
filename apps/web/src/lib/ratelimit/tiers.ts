/**
 * Firm tier definitions.
 *
 * The numbers in `DEFAULT_TIER_LIMITS` are the contract defaults from
 * PLAN.md §9 — Free / Starter / Pro / Enterprise. They are treated as
 * product-level constants: changing a value is a commercial decision
 * and should land as a dedicated commit with a pricing-review
 * reference, NOT as an incidental edit.
 *
 *  | Tier       | RPS    | Burst  | Monthly quota | Webhooks |
 *  |------------|--------|--------|---------------|----------|
 *  | free       |    1   |    5   |         1 000 |     1    |
 *  | starter    |   10   |   30   |       100 000 |     5    |
 *  | pro        |  100   |  300   |     1 000 000 |    50    |
 *  | enterprise |  1 000 | 3 000  |     unlimited | unlimited|
 *
 * "Unlimited" is encoded as `null` on the public type and as
 * `UNLIMITED_QUOTA_SENTINEL` when a numeric value has to be persisted.
 * The sentinel is `Number.MAX_SAFE_INTEGER` so every guard of the form
 * `count <= limit_snapshot` is trivially satisfied without introducing
 * a nullable column on the storage layer (`quota_counters.limit_snapshot`
 * is `NOT NULL`).
 *
 * `resolveTierLimits(tier, overrides)` is the single source a caller
 * must use to turn a firm row into a `TierLimits`. Overrides are layered
 * on top of the tier defaults so an enterprise firm with a custom RPS
 * contract uses the same code path as every other tier; the caller
 * supplies the override, the library validates and returns the merged
 * limits. No silent partial configs: `assertTierLimits` throws on any
 * invalid field.
 */

import { z } from 'zod';

import type { FirmTier } from '@crivacy/shared-types';

import { RateLimitError } from './errors';

/* ---------- Types ---------- */

/**
 * Operational limits for a single firm tier.
 *
 * `monthlyQuota === null` and `webhookEndpoints === null` both mean
 * "not enforced" — the library skips the quota check when null and
 * the webhook-endpoint cap is surfaced to the route that manages
 * endpoints (step 12), not to the rate-limit middleware.
 */
export interface TierLimits {
  /** Burst capacity (tokens the bucket holds when full). */
  readonly capacity: number;
  /** Sustained refill rate in tokens per second. */
  readonly refillRatePerSec: number;
  /** Monthly request quota. `null` means not enforced. */
  readonly monthlyQuota: number | null;
  /** Max configured webhook endpoints. `null` means not enforced. */
  readonly webhookEndpoints: number | null;
  /**
   * Max registered OAuth clients per firm. `null` means unlimited.
   * Ceiling covers BOTH active and revoked rows (revoked rows stay
   * in the table as audit breadcrumbs, so a firm that repeatedly
   * revoked and recreated clients would still be bounded). The
   * dashboard create handler rejects the create with `tier_exceeded`
   * once the cap is reached.
   */
  readonly oauthClients: number | null;
  /**
   * Max active API keys per firm. `null` means unlimited. Only
   * non-revoked rows count toward the cap; revoking an old key
   * frees a slot so a firm can rotate without bumping into the
   * ceiling mid-rotation.
   */
  readonly apiKeys: number | null;
}

/**
 * Numeric sentinel used when we have to persist an "unlimited" quota
 * into a `NOT NULL` bigint column. Public code should keep `null` on
 * `TierLimits.monthlyQuota` and only translate to this sentinel when
 * building the DB row.
 */
export const UNLIMITED_QUOTA_SENTINEL = Number.MAX_SAFE_INTEGER;

/* ---------- Defaults ---------- */

/**
 * The PLAN.md §9 tier table, frozen as a read-only constant.
 *
 * Every value here is also asserted against `TierLimitsSchema` below at
 * module load time, so a typo in the table is caught at import rather
 * than at first request. The freeze is deep via
 * `Object.freeze(structuredClone(...))` so accidental mutation through
 * an object spread is rejected at runtime, not merely at the type level.
 */
export const DEFAULT_TIER_LIMITS: Readonly<Record<FirmTier, TierLimits>> = Object.freeze({
  free: Object.freeze({
    capacity: 5,
    refillRatePerSec: 1,
    monthlyQuota: 1_000,
    webhookEndpoints: 1,
    oauthClients: 1,
    apiKeys: 2,
  }),
  starter: Object.freeze({
    capacity: 30,
    refillRatePerSec: 10,
    monthlyQuota: 100_000,
    webhookEndpoints: 5,
    oauthClients: 3,
    apiKeys: 5,
  }),
  pro: Object.freeze({
    capacity: 300,
    refillRatePerSec: 100,
    monthlyQuota: 1_000_000,
    webhookEndpoints: 50,
    oauthClients: 20,
    apiKeys: 50,
  }),
  enterprise: Object.freeze({
    capacity: 3_000,
    refillRatePerSec: 1_000,
    monthlyQuota: null,
    webhookEndpoints: null,
    oauthClients: null,
    apiKeys: null,
  }),
});

/* ---------- Validation ---------- */

/**
 * Zod schema mirror of `TierLimits`. Kept close to the constant so a
 * new field added to the interface causes the schema to fail
 * type-check. The schema is re-used by `config.ts` when parsing a
 * caller-supplied override map.
 */
export const TierLimitsSchema: z.ZodType<TierLimits> = z
  .object({
    capacity: z.number().int('capacity must be an integer').positive('capacity must be > 0'),
    refillRatePerSec: z
      .number()
      .finite('refillRatePerSec must be finite')
      .positive('refillRatePerSec must be > 0'),
    monthlyQuota: z
      .number()
      .int('monthlyQuota must be an integer')
      .positive('monthlyQuota must be > 0')
      .nullable(),
    webhookEndpoints: z
      .number()
      .int('webhookEndpoints must be an integer')
      .positive('webhookEndpoints must be > 0')
      .nullable(),
    oauthClients: z
      .number()
      .int('oauthClients must be an integer')
      .positive('oauthClients must be > 0')
      .nullable(),
    apiKeys: z
      .number()
      .int('apiKeys must be an integer')
      .positive('apiKeys must be > 0')
      .nullable(),
  })
  .strict();

/**
 * Throws a typed `RateLimitError('invalid_tier_config', ...)` if the
 * given value is not a well-formed `TierLimits`. Used both at module
 * load time (to validate `DEFAULT_TIER_LIMITS`) and at call time (to
 * validate a caller override).
 */
export function assertTierLimits(value: unknown): asserts value is TierLimits {
  const parsed = TierLimitsSchema.safeParse(value);
  if (!parsed.success) {
    throw new RateLimitError('invalid_tier_config', 'tier limits object failed validation', {
      cause: parsed.error,
      details: { issues: parsed.error.issues },
    });
  }
}

// Validate every shipped tier at module load. A typo in the table is a
// hard import-time failure, not a runtime mystery.
for (const [tier, limits] of Object.entries(DEFAULT_TIER_LIMITS)) {
  try {
    assertTierLimits(limits);
  } catch (cause) {
    throw new RateLimitError(
      'invalid_tier_config',
      `DEFAULT_TIER_LIMITS.${tier} is invalid — this is a product bug, fix tiers.ts`,
      { cause },
    );
  }
}

/* ---------- Resolution ---------- */

/**
 * Caller-supplied per-firm override. Every field is optional — if
 * omitted, the tier default is used. Explicit `null` on `monthlyQuota`
 * or `webhookEndpoints` IS respected (lifts the cap); undefined falls
 * through to the default.
 */
export type TierLimitsOverride = {
  readonly capacity?: number;
  readonly refillRatePerSec?: number;
  readonly monthlyQuota?: number | null;
  readonly webhookEndpoints?: number | null;
  readonly oauthClients?: number | null;
  readonly apiKeys?: number | null;
};

/**
 * Build the effective `TierLimits` for a firm. The return value is the
 * tier default merged with the override, in that order. The merged
 * result is re-validated so an override that accidentally drops the
 * capacity to 0 is caught at call time.
 *
 * `resolveTierLimits('enterprise', { refillRatePerSec: 500 })` is the
 * canonical way to configure a single custom-contract enterprise firm.
 */
export function resolveTierLimits(tier: FirmTier, overrides?: TierLimitsOverride): TierLimits {
  const base = DEFAULT_TIER_LIMITS[tier];
  if (base === undefined) {
    throw new RateLimitError('unknown_tier', `no default limits registered for tier "${tier}"`, {
      details: { tier },
    });
  }
  // `exactOptionalPropertyTypes` rejects `{ foo: undefined }`, so we
  // build the merged object field-by-field instead of a spread. The
  // `?? base.X` pattern respects an explicit `null` on the override
  // (overriding a nullable field to "unlimited") while still falling
  // back to the base for an omitted field.
  const merged: TierLimits = {
    capacity: overrides?.capacity ?? base.capacity,
    refillRatePerSec: overrides?.refillRatePerSec ?? base.refillRatePerSec,
    monthlyQuota:
      overrides !== undefined && 'monthlyQuota' in overrides
        ? (overrides.monthlyQuota ?? null)
        : base.monthlyQuota,
    webhookEndpoints:
      overrides !== undefined && 'webhookEndpoints' in overrides
        ? (overrides.webhookEndpoints ?? null)
        : base.webhookEndpoints,
    oauthClients:
      overrides !== undefined && 'oauthClients' in overrides
        ? (overrides.oauthClients ?? null)
        : base.oauthClients,
    apiKeys:
      overrides !== undefined && 'apiKeys' in overrides
        ? (overrides.apiKeys ?? null)
        : base.apiKeys,
  };
  assertTierLimits(merged);
  return merged;
}

/**
 * Translate a possibly-null `monthlyQuota` into a numeric value suitable
 * for persistence in `quota_counters.limit_snapshot` (NOT NULL bigint).
 * `null` maps to `UNLIMITED_QUOTA_SENTINEL` so the stored row is
 * coherent with the "count <= limit_snapshot" invariant.
 */
export function monthlyQuotaForStorage(limits: TierLimits): number {
  return limits.monthlyQuota ?? UNLIMITED_QUOTA_SENTINEL;
}
