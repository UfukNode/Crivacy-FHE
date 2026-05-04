/**
 * SQL-facing token bucket — the only place in the library that writes
 * to `rate_limit_buckets`.
 *
 * The flow is a single atomic transaction:
 *
 *   BEGIN;
 *   -- 1. Lazy insert: create the row iff absent, at full capacity,
 *   --    so the very first request from a firm is not denied.
 *   INSERT INTO rate_limit_buckets (...)
 *   VALUES (...)
 *   ON CONFLICT (firm_id) DO NOTHING;
 *
 *   -- 2. Take a row lock. Returns the CURRENT row, which is either
 *   --    the row we just inserted OR a pre-existing row (possibly
 *   --    reflecting an older tier snapshot).
 *   SELECT capacity, refill_rate_per_sec, tokens, last_refill_at
 *     FROM rate_limit_buckets
 *    WHERE firm_id = $1
 *    FOR UPDATE;
 *
 *   -- 3. Reconcile tier drift: if the row's capacity/refill differ
 *   --    from the resolved tier, rewrite capacity/refill_rate_per_sec
 *   --    and (on upgrade) grant the capacity delta immediately.
 *   --    On downgrade we clamp to the new capacity.
 *
 *   -- 4. Run the pure bucket math (`consumeToken`) in JS.
 *
 *   -- 5. Write the result back with the same row locked.
 *   UPDATE rate_limit_buckets
 *      SET tokens = $tokensAfter,
 *          last_refill_at = $refilledAt,
 *          capacity = $tierCapacity,
 *          refill_rate_per_sec = $tierRate,
 *          updated_at = now()
 *    WHERE firm_id = $1;
 *
 *   COMMIT;
 *
 * The row lock (`FOR UPDATE`) serializes concurrent requests for the
 * same firm — a second request against the same firm waits on the
 * first's transaction commit, which is exactly what we want for a
 * monotonic token bucket. Requests from DIFFERENT firms do not
 * contend.
 *
 * Numeric columns (`tokens`, `refill_rate_per_sec`) are serialized to
 * strings by node-postgres; this file is responsible for parsing them
 * to `number` before calling `consumeToken` and promoting a
 * parse-failure to `bucket_row_malformed`.
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';

import { type BucketState, type ConsumeResult, assertBucketState, consumeToken } from './bucket';
import { RateLimitError } from './errors';
import type { TierLimits } from './tiers';

/* ---------- Types ---------- */

export interface ConsumeBucketInput {
  /** Primary key of the `rate_limit_buckets` row — the firm owning the request. */
  readonly firmId: string;
  /**
   * Tier limits in effect for this firm at decision time. The
   * consumer reconciles the stored row against this snapshot so a
   * firm whose tier changed between requests sees the new bucket
   * immediately.
   */
  readonly tier: TierLimits;
  /** Current wall clock. Test seam. */
  readonly now: Date;
  /** Request cost in tokens. Default 1; must be strictly positive. */
  readonly cost?: number;
}

/**
 * Full bucket-side decision, including the reconciled bucket state
 * as persisted. The middleware uses `result.allowed` and the bucket
 * fields for header computation.
 */
export interface ConsumeBucketOutcome {
  readonly result: ConsumeResult;
  /** The bucket state AS STORED after this transaction commits. */
  readonly persisted: BucketState;
  /** True if the underlying row was created by this call. */
  readonly rowCreated: boolean;
  /** True if the stored capacity/refill were overwritten by the tier snapshot. */
  readonly tierReconciled: boolean;
}

/* ---------- Row parsing ---------- */

/**
 * `numeric` columns come back as strings; `integer` as numbers;
 * `timestamp` (mode `'date'`) as `Date`. Anything else is a driver
 * surprise we escalate to `bucket_row_malformed`.
 *
 * Shape: the `db.execute` generic requires `Record<string, unknown>`,
 * so instead of a named interface we read the row as a loose record
 * and pick out fields through the parsers below.
 */
type RawBucketRow = Record<string, unknown>;

function parseCapacity(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw new RateLimitError('bucket_row_malformed', 'capacity column was not a positive integer', {
    details: { raw: String(raw) },
  });
}

function parseNumericString(raw: unknown, field: string): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  throw new RateLimitError(
    'bucket_row_malformed',
    `${field} column was not a non-negative number`,
    { details: { field, raw: String(raw) } },
  );
}

function parseDate(raw: unknown, field: string): Date {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new RateLimitError('bucket_row_malformed', `${field} column was not a valid timestamp`, {
    details: { field, raw: String(raw) },
  });
}

function rowToState(row: RawBucketRow): BucketState {
  const state: BucketState = {
    capacity: parseCapacity(row['capacity']),
    refillRatePerSec: parseNumericString(row['refill_rate_per_sec'], 'refill_rate_per_sec'),
    tokens: parseNumericString(row['tokens'], 'tokens'),
    lastRefillAt: parseDate(row['last_refill_at'], 'last_refill_at'),
  };
  assertBucketState(state);
  return state;
}

/* ---------- Tier reconciliation ---------- */

/**
 * Fold the resolved `TierLimits` into the stored row. Returns the
 * reconciled `BucketState` plus a flag telling the caller whether the
 * stored `capacity` / `refill_rate_per_sec` columns need to be
 * overwritten.
 *
 * Upgrade: grant the capacity delta immediately (adds it to tokens,
 * capped at new capacity). This means a firm that upgrades from free
 * (cap 5) to starter (cap 30) with 3 tokens ends up with min(30, 3 +
 * 25) = 28 tokens — the delta is a free gift, not a reset.
 *
 * Downgrade: clamp tokens to the new capacity. A starter firm holding
 * 25 tokens who downgrades to free (cap 5) ends up with 5. This
 * protects the lower-tier SLA from a customer downgrading to burst.
 *
 * Rate change: always update the stored refill rate; future refills
 * use the new rate.
 *
 * No drift: nothing to reconcile. `reconciled` is `false`.
 */
function reconcileTier(
  stored: BucketState,
  tier: TierLimits,
): { readonly state: BucketState; readonly reconciled: boolean } {
  const capacityChanged = stored.capacity !== tier.capacity;
  const rateChanged = stored.refillRatePerSec !== tier.refillRatePerSec;
  if (!capacityChanged && !rateChanged) {
    return { state: stored, reconciled: false };
  }

  let nextTokens = stored.tokens;
  if (capacityChanged) {
    if (tier.capacity > stored.capacity) {
      const delta = tier.capacity - stored.capacity;
      nextTokens = Math.min(tier.capacity, stored.tokens + delta);
    } else {
      nextTokens = Math.min(stored.tokens, tier.capacity);
    }
  }

  const reconciledState: BucketState = {
    capacity: tier.capacity,
    refillRatePerSec: tier.refillRatePerSec,
    tokens: nextTokens,
    lastRefillAt: stored.lastRefillAt,
  };
  return { state: reconciledState, reconciled: true };
}

/* ---------- Public API ---------- */

/**
 * Attempt to consume `cost` tokens from an API key's bucket. Runs the
 * full INSERT → SELECT FOR UPDATE → (reconcile) → UPDATE cycle inside
 * a single transaction. Callers get back a `ConsumeBucketOutcome`
 * whose `result.allowed` is the authoritative decision and whose
 * `persisted` field is the bucket state the row holds post-commit.
 *
 * On an unexpected row-layout failure this function throws a
 * `RateLimitError('bucket_row_malformed', ...)`. On a genuine denied
 * request it RETURNS `{ result: { allowed: false, ... }, ... }` —
 * denials are never exceptions.
 */
export async function consumeBucket(
  db: CrivacyDatabase,
  input: ConsumeBucketInput,
): Promise<ConsumeBucketOutcome> {
  const { firmId, tier, now, cost = 1 } = input;

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RateLimitError('invalid_now_value', 'now must be a valid Date', {
      details: { value: String(now) },
    });
  }

  return db.transaction(async (tx) => {
    // 1) Lazy insert at full capacity. A brand new firm should be
    //    able to burst immediately rather than wait on the refill.
    const insertResult = await tx.execute<{ inserted: number }>(sql`
      WITH ins AS (
        INSERT INTO rate_limit_buckets (
          firm_id,
          capacity,
          refill_rate_per_sec,
          tokens,
          window_start,
          last_refill_at,
          updated_at
        )
        VALUES (
          ${firmId}::uuid,
          ${tier.capacity}::integer,
          ${tier.refillRatePerSec}::numeric,
          ${tier.capacity}::numeric,
          ${now}::timestamptz,
          ${now}::timestamptz,
          ${now}::timestamptz
        )
        ON CONFLICT (firm_id) DO NOTHING
        RETURNING 1 AS inserted
      )
      SELECT COUNT(*)::int AS inserted FROM ins
    `);
    const insertRow = insertResult.rows[0];
    const rowCreated =
      insertRow !== undefined && typeof insertRow.inserted === 'number' && insertRow.inserted === 1;

    // 2) Lock the row. At this point the row is guaranteed to exist
    //    (we just inserted it, or it was already present).
    const lockResult = await tx.execute<RawBucketRow>(sql`
      SELECT
        capacity,
        refill_rate_per_sec::text AS refill_rate_per_sec,
        tokens::text AS tokens,
        last_refill_at
      FROM rate_limit_buckets
      WHERE firm_id = ${firmId}::uuid
      FOR UPDATE
    `);
    const lockedRow = lockResult.rows[0];
    if (lockedRow === undefined) {
      // The INSERT + SELECT are in the same transaction; a missing
      // row here is a hard invariant break.
      throw new RateLimitError(
        'bucket_row_missing',
        'rate_limit_buckets row disappeared mid-transaction',
        { details: { firmId } },
      );
    }

    const storedState = rowToState(lockedRow);

    // 3) Reconcile with the resolved tier snapshot. A tier change since
    //    the last write is absorbed here.
    const { state: reconciledState, reconciled: tierReconciled } = reconcileTier(storedState, tier);

    // 4) Run pure math.
    const result = consumeToken(reconciledState, now, cost);

    // 5) Persist. We always write `tokens` and `last_refill_at`; we
    //    additionally write `capacity` / `refill_rate_per_sec` when
    //    the tier was reconciled, and `window_start` when the tier
    //    change is an upgrade (so downstream analytics can see the
    //    boundary).
    const persistedTokens = result.tokensAfter;
    const persistedLastRefill = result.refilledAt;

    if (tierReconciled) {
      await tx.execute(sql`
        UPDATE rate_limit_buckets
           SET tokens = ${persistedTokens}::numeric,
               last_refill_at = ${persistedLastRefill}::timestamptz,
               capacity = ${tier.capacity}::integer,
               refill_rate_per_sec = ${tier.refillRatePerSec}::numeric,
               window_start = ${now}::timestamptz,
               updated_at = ${now}::timestamptz
         WHERE firm_id = ${firmId}::uuid
      `);
    } else {
      await tx.execute(sql`
        UPDATE rate_limit_buckets
           SET tokens = ${persistedTokens}::numeric,
               last_refill_at = ${persistedLastRefill}::timestamptz,
               updated_at = ${now}::timestamptz
         WHERE firm_id = ${firmId}::uuid
      `);
    }

    const persisted: BucketState = {
      capacity: tier.capacity,
      refillRatePerSec: tier.refillRatePerSec,
      tokens: persistedTokens,
      lastRefillAt: persistedLastRefill,
    };

    return {
      result,
      persisted,
      rowCreated,
      tierReconciled,
    };
  });
}

/**
 * Observe the bucket without mutating it. Returns the current stored
 * state reconciled against the supplied tier. Useful for
 * `GET /me/rate-limit` dashboards and for tests.
 */
export async function peekBucketRow(
  db: CrivacyDatabase,
  firmId: string,
  tier: TierLimits,
): Promise<BucketState | null> {
  const result = await db.execute<RawBucketRow>(sql`
    SELECT
      capacity,
      refill_rate_per_sec::text AS refill_rate_per_sec,
      tokens::text AS tokens,
      last_refill_at
    FROM rate_limit_buckets
    WHERE firm_id = ${firmId}::uuid
    LIMIT 1
  `);
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const stored = rowToState(row);
  return reconcileTier(stored, tier).state;
}

/**
 * Force-reset a firm's bucket to full at the given tier. Used by the
 * tier-upgrade flow outside the hot path. Idempotent. (API-key rotation
 * no longer touches the bucket — all of a firm's keys share one row.)
 */
export async function resetBucketToFull(
  db: CrivacyDatabase,
  firmId: string,
  tier: TierLimits,
  now: Date,
): Promise<void> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RateLimitError('invalid_now_value', 'now must be a valid Date');
  }
  await db.execute(sql`
    INSERT INTO rate_limit_buckets (
      firm_id,
      capacity,
      refill_rate_per_sec,
      tokens,
      window_start,
      last_refill_at,
      updated_at
    )
    VALUES (
      ${firmId}::uuid,
      ${tier.capacity}::integer,
      ${tier.refillRatePerSec}::numeric,
      ${tier.capacity}::numeric,
      ${now}::timestamptz,
      ${now}::timestamptz,
      ${now}::timestamptz
    )
    ON CONFLICT (firm_id) DO UPDATE
      SET capacity = EXCLUDED.capacity,
          refill_rate_per_sec = EXCLUDED.refill_rate_per_sec,
          tokens = EXCLUDED.tokens,
          window_start = EXCLUDED.window_start,
          last_refill_at = EXCLUDED.last_refill_at,
          updated_at = EXCLUDED.updated_at
  `);
}
