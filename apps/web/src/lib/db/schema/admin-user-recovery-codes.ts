import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { adminUsers } from './users';

/**
 * `admin_user_recovery_codes` — single-use backup codes that let an
 * admin complete the TOTP step if they've lost access to their
 * authenticator app.
 *
 * Mirror of `firm_user_recovery_codes`: same columns, same semantics,
 * same burn-on-use `used_at` stamp. The shared
 * {@link lib/auth/totp-management} primitive operates on either table
 * via {@link ADMIN_TOTP_TABLE} / {@link FIRM_TOTP_TABLE} — keeping the
 * schemas byte-identical means the primitive can issue the same SQL
 * on either audience without audience-specific branches.
 *
 * `ON DELETE CASCADE` ensures deleting an admin row wipes their
 * recovery codes atomically, so a decommissioned account cannot be
 * resurrected via leftover codes.
 */
export const adminUserRecoveryCodes = pgTable(
  'admin_user_recovery_codes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('admin_user_recovery_codes_code_hash_key').on(table.codeHash),
    index('admin_user_recovery_codes_admin_user_id_idx').on(table.adminUserId),
  ],
);

export type AdminUserRecoveryCode = typeof adminUserRecoveryCodes.$inferSelect;
export type NewAdminUserRecoveryCode = typeof adminUserRecoveryCodes.$inferInsert;
