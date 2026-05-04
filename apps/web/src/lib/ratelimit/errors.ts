/**
 * Rate-limit library error taxonomy.
 *
 * A denied request (429 `rate_limited` / 429 `quota_exceeded`) is NOT an
 * exception — the `applyRateLimit()` composer returns a structured
 * `RateLimitDecision` with `allowed: false`. Exceptions from this module
 * are reserved for unambiguous bugs: invariants the callers expect to
 * hold (a corrupt bucket row, a misconfigured tier, a period calc that
 * should never fail). The calling route translates a throw into a
 * plain `internal_error` 500; a denied decision into a 429 with the
 * correct error code and headers.
 *
 * This is the same split the auth library uses between "normal failure
 * signals" (return booleans) and "invariants violated" (throw typed
 * `AuthError`s). Keep the two layers separate so hot-path code never
 * catches a rate-limit denial as an exception.
 */

export type RateLimitErrorCode =
  /** `resolveTierLimits()` was called with a tier name not in the table. */
  | 'unknown_tier'
  /**
   * A caller-supplied `TierLimits` object failed validation. Carries the
   * offending field name(s) in `details`.
   */
  | 'invalid_tier_config'
  /**
   * The atomic bucket UPDATE returned zero rows. In correct use this is
   * impossible — the preceding INSERT ON CONFLICT DO NOTHING either
   * creates the row or finds it. Surfacing it as a typed error
   * distinguishes a disappeared row from a genuine rate-limit denial.
   */
  | 'bucket_row_missing'
  /**
   * The bucket row RETURNING produced fields of an unexpected type.
   * Catches a mismatch between the SQL cast strategy and the Postgres
   * driver's numeric handling.
   */
  | 'bucket_row_malformed'
  /**
   * The quota UPSERT returned zero rows. Same reasoning as
   * `bucket_row_missing`.
   */
  | 'quota_row_missing'
  /** The quota row RETURNING fields were of an unexpected type. */
  | 'quota_row_malformed'
  /**
   * `getMonthlyPeriod()` was called with a value that is not a valid
   * Date, or the computed boundary is outside the representable range.
   */
  | 'period_calculation_failed'
  /**
   * The cost argument to `consumeBucket()` / `applyRateLimit()` was
   * non-positive, non-finite, or NaN. Cost must be a positive number
   * (usually `1`); callers must not pass `0` to mean "read-only".
   */
  | 'invalid_request_cost'
  /**
   * The library was handed a `Date` instance whose time is NaN. This
   * usually means the caller did `new Date(undefined)` somewhere;
   * surface it loudly instead of emitting `NaN` into RETURNING.
   */
  | 'invalid_now_value';

export interface RateLimitErrorOptions {
  /** Underlying driver or Zod error. */
  readonly cause?: unknown;
  /** Structured context — serialized by the error logger, never user-facing. */
  readonly details?: Record<string, unknown>;
}

/**
 * Single error class emitted by the rate-limit library. Route code that
 * catches unexpected exceptions from `applyRateLimit()` only needs to
 * handle one type.
 */
export class RateLimitError extends Error {
  override readonly name = 'RateLimitError' as const;
  readonly code: RateLimitErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: RateLimitErrorCode, message: string, options: RateLimitErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.details = options.details;
  }
}
