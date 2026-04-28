import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// auth_rate_limit_events
// ---------------------------------------------------------------------------

/**
 * `auth_rate_limit_events` — one row per hit on a rate-limited auth
 * endpoint, keyed by `(endpoint, ip_hash)`. The helper in
 * `lib/auth-rate-limit/enforce.ts` inserts a row on every request and
 * rejects with 429 when the count in the configured sliding window
 * exceeds the per-endpoint cap.
 *
 * Unlike the firm-tier token-bucket in `lib/ratelimit/*`, this table
 * is keyed on a hashed client IP instead of an apiKey row — public
 * auth endpoints (login, register, forgot-password, verify-reset-code)
 * have no apiKey and the threat is IP-wide credential-stuffing, so
 * a separate surface is appropriate.
 *
 *   - `endpoint` — stable identifier (e.g. `'customer_login'`,
 *     `'firm_verify_reset_code'`). A typo in the caller key turns
 *     into its own bucket, which is safer than silently disabling
 *     the limit.
 *   - `ip_hash` — SHA-256 of the client IP, so the raw address is
 *     never written to disk (GDPR-friendly and mitigates accidental
 *     log exposure).
 *   - `created_at` — used as both the sliding-window timestamp and
 *     the cleanup cutoff. Rows outside the widest window are pruned
 *     opportunistically inside the helper.
 *
 * The composite `(endpoint, ip_hash, created_at)` index backs the
 * window count; the `created_at`-only index backs the janitor
 * cleanup sweep that runs with every enforce call.
 */
export const authRateLimitEvents = pgTable(
  'auth_rate_limit_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    endpoint: text('endpoint').notNull(),
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('auth_rate_limit_events_endpoint_ip_created_idx').on(
      table.endpoint,
      table.ipHash,
      table.createdAt,
    ),
    index('auth_rate_limit_events_created_at_idx').on(table.createdAt),
  ],
);

export type AuthRateLimitEvent = typeof authRateLimitEvents.$inferSelect;
export type NewAuthRateLimitEvent = typeof authRateLimitEvents.$inferInsert;
