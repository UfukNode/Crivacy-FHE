import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { firmUsers } from './users';

/**
 * `firm_user_recovery_codes` — single-use backup codes that let a firm
 * user complete the TOTP step if they've lost access to their
 * authenticator app (phone wiped, 2FA app uninstalled, etc.).
 *
 * Generated in batches of eight during invite acceptance and whenever
 * the user regenerates from the security settings page. Only the
 * SHA-256 hash lives in the DB — the raw codes are surfaced to the user
 * exactly once in the response and can never be retrieved again.
 *
 * `used_at` burns a code after a single successful redemption. Expiry
 * is tied to the row's existence: regenerating wipes the whole batch
 * and inserts a fresh set, so "expired" is modelled as "row deleted".
 *
 * Deleting a firm user cascades into this table — cleanup is automatic.
 */
export const firmUserRecoveryCodes = pgTable(
  'firm_user_recovery_codes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firmUserId: uuid('firm_user_id')
      .notNull()
      .references(() => firmUsers.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('firm_user_recovery_codes_code_hash_key').on(table.codeHash),
    index('firm_user_recovery_codes_firm_user_id_idx').on(table.firmUserId),
  ],
);

export type FirmUserRecoveryCode = typeof firmUserRecoveryCodes.$inferSelect;
export type NewFirmUserRecoveryCode = typeof firmUserRecoveryCodes.$inferInsert;
