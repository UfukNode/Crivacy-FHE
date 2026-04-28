import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `ip_abuse_signals` — per-IP counter for the Sprint 6 repeat-evader
 * gate. Every `fraud.face_match_blocked` audit increments the
 * corresponding (hashed) IP's row; if `count` passes the 3-strike
 * threshold within the active window, the next start-session call
 * is rejected with HTTP 503 BEFORE going to Didit.
 *
 * Schema notes:
 *   - `ip_hash` (PK) — SHA-256 of `${ip}:${secret}`. The secret is
 *     `IP_ABUSE_HASH_SECRET` env var; rotation invalidates all
 *     existing rows by design (a privacy-friendly soft-reset).
 *   - `count` — number of `face_match_blocked` events observed.
 *     CHECK > 0 because every row exists because of an event.
 *   - `first_seen` / `last_seen` — drive the 7-day TTL prune
 *     (`last_seen < now() - interval '7 days'`).
 *
 * Global table — IP abuse is a system-level signal, not firm- or
 * customer-scoped. Read by the pre-Didit start-session gate;
 * written by `lib/fraud/ip-abuse.ts::incrementSignal` from the
 * face-match cascade.
 *
 * Privacy: NEVER store raw IP. The hashing layer in `ip-abuse.ts`
 * is the only place that touches the raw value.
 */
export const ipAbuseSignals = pgTable(
  'ip_abuse_signals',
  {
    /** SHA-256 of `${ip}:${IP_ABUSE_HASH_SECRET}`. */
    ipHash: text('ip_hash').primaryKey(),
    count: integer('count').notNull().default(1),
    firstSeen: timestamp('first_seen', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('ip_abuse_signals_last_seen_idx').on(table.lastSeen),
    check('ip_abuse_signals_count_positive', sql`${table.count} > 0`),
  ],
);

export type IpAbuseSignalRow = typeof ipAbuseSignals.$inferSelect;
export type NewIpAbuseSignalRow = typeof ipAbuseSignals.$inferInsert;
