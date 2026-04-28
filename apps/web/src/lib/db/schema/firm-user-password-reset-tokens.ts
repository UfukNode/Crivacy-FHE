import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { firmUsers } from './users';

// ---------------------------------------------------------------------------
// firm_user_password_reset_tokens
// ---------------------------------------------------------------------------

/**
 * `firm_user_password_reset_tokens` — one-time 6-digit codes for the
 * firm-user "forgot password" flow. Mirror of `password_reset_tokens`
 * on the customer side; kept as a separate table to preserve the
 * audience-based schema isolation the rest of the project uses (no
 * polymorphic FK / nullable-user-id columns).
 *
 *   - `token_hash` — SHA-256 of the raw 6-digit code. The raw code
 *     is emitted to the recipient's email exactly once.
 *   - `attempts` — number of wrong code submissions. Caps at
 *     MAX_CODE_ATTEMPTS (5); the 5th wrong attempt invalidates the
 *     code so an attacker can't brute-force more than a few digits.
 *   - `invalidated_at` — set when a newer reset supersedes this one
 *     OR when attempts are exhausted.
 *   - `ip_address` — who asked for the reset, for audit triage.
 */
export const firmUserPasswordResetTokens = pgTable(
  'firm_user_password_reset_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firmUserId: uuid('firm_user_id')
      .notNull()
      .references(() => firmUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    attempts: integer('attempts').notNull().default(0),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true, mode: 'date' }),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('firm_user_password_reset_tokens_token_hash_idx').on(table.tokenHash),
    index('firm_user_password_reset_tokens_user_created_idx').on(
      table.firmUserId,
      table.createdAt,
    ),
  ],
);

export type FirmUserPasswordResetToken = typeof firmUserPasswordResetTokens.$inferSelect;
export type NewFirmUserPasswordResetToken = typeof firmUserPasswordResetTokens.$inferInsert;
