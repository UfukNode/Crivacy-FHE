import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { firms } from './firms';

/**
 * `rate_limit_buckets` — per-firm token bucket. One row per firm, shared
 * across every API key and OAuth access token the firm issues. Keying on
 * `firm_id` (not `api_key_id`) closes the "create N keys to multiply
 * throughput" loophole that a per-key bucket would allow, and matches
 * how Stripe / GitHub / AWS aggregate rate limits at the account level.
 *
 * Capacity and refill rate are denormalized snapshots of the firm's tier
 * at the time the bucket was last reset. When a firm is upgraded we bump
 * `window_start` so the worker can recognize the tier change, overwrite
 * capacity/refill, and fill the bucket to the new maximum.
 *
 * Fractional tokens (`numeric(20, 6)`) allow sub-request precision when
 * the refill rate is not an integer per second.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    firmId: uuid('firm_id')
      .primaryKey()
      .references(() => firms.id, { onDelete: 'cascade' }),
    capacity: integer('capacity').notNull(),
    refillRatePerSec: numeric('refill_rate_per_sec', { precision: 10, scale: 4 }).notNull(),
    tokens: numeric('tokens', { precision: 20, scale: 6 }).notNull(),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastRefillAt: timestamp('last_refill_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('rate_limit_buckets_last_refill_at_idx').on(table.lastRefillAt)],
);

export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;
export type NewRateLimitBucket = typeof rateLimitBuckets.$inferInsert;

/**
 * `quota_counters` — monthly quota counters per firm. A new row is
 * inserted at the start of each period (first day of the month at
 * 00:00:00 UTC). The current period's row is updated atomically on each
 * billable request via `UPDATE ... SET count = count + 1 WHERE firm_id
 * = $1 AND period = $2` — the composite primary key guarantees
 * single-row contention without a separate lock.
 *
 * Per-key attribution is intentionally out of scope here. If later
 * needed, it belongs in `usage_events` (row-per-request), not in this
 * aggregated counter table.
 */
export const quotaCounters = pgTable(
  'quota_counters',
  {
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    period: date('period', { mode: 'date' }).notNull(),
    count: bigint('count', { mode: 'number' })
      .notNull()
      .default(sql`0`),
    limitSnapshot: bigint('limit_snapshot', { mode: 'number' }).notNull(),
    resetAt: timestamp('reset_at', { withTimezone: true, mode: 'date' }).notNull(),
    overageCount: bigint('overage_count', { mode: 'number' })
      .notNull()
      .default(sql`0`),
    lastBillableAt: timestamp('last_billable_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'quota_counters_pk',
      columns: [table.firmId, table.period],
    }),
    index('quota_counters_period_idx').on(table.period),
    index('quota_counters_reset_at_idx').on(table.resetAt),
  ],
);

export type QuotaCounter = typeof quotaCounters.$inferSelect;
export type NewQuotaCounter = typeof quotaCounters.$inferInsert;

/**
 * Expression-only helper so callers that build raw SQL for the atomic
 * token bucket refill share a single canonical formula.
 *
 * Used by the rate-limit middleware (PLAN.md step 6). Kept with the schema
 * so any column rename causes a compile error here too.
 */
export const tokenBucketRefillSql = sql`
  least(
    ${rateLimitBuckets.capacity}::numeric,
    ${rateLimitBuckets.tokens} + (
      extract(epoch from (now() - ${rateLimitBuckets.lastRefillAt}))
      * ${rateLimitBuckets.refillRatePerSec}
    )
  )
`;
