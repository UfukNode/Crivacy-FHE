/**
 * `admin_login_challenges` — short-lived, IP-bound challenge tokens for the
 * two-step admin login flow.
 *
 * Step 1 (email + password + Turnstile) creates a challenge row.
 * Step 2 (TOTP code + challenge token) verifies the TOTP, marks the
 * challenge as used, and issues session cookies.
 *
 * Security properties:
 *   - Token is stored as a SHA-256 hash (the raw token is only ever sent once)
 *   - IP-bound: step 2 must come from the same IP as step 1
 *   - TTL: 2 minutes (expires_at enforced on lookup)
 *   - Single-use: used_at is set after successful TOTP verification
 *   - Attempt-limited: max 3 TOTP attempts per challenge
 *   - Expired rows are cleaned up on every step-1 call
 *
 * @module
 */

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { adminUsers } from './users';

export const adminLoginChallenges = pgTable(
  'admin_login_challenges',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    /** SHA-256 hash of the raw challenge token (hex). */
    challengeTokenHash: text('challenge_token_hash').notNull(),
    /** Client IP that initiated step 1 — step 2 must match. */
    ipAddress: text('ip_address').notNull(),
    /** Number of TOTP verification attempts made against this challenge. */
    totpAttempts: integer('totp_attempts').notNull().default(0),
    /** When this challenge expires (2 minutes after creation). */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Set when the challenge is successfully consumed (TOTP verified). */
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('admin_login_challenges_token_hash_key').on(table.challengeTokenHash),
    index('admin_login_challenges_admin_user_id_idx').on(table.adminUserId),
    index('admin_login_challenges_expires_at_idx').on(table.expiresAt),
  ],
);

export type AdminLoginChallenge = typeof adminLoginChallenges.$inferSelect;
export type NewAdminLoginChallenge = typeof adminLoginChallenges.$inferInsert;
