import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { adminUsers, firmUsers } from './users';

/**
 * `firm_user_invites` — single-use tokens that let a brand-new firm
 * user bootstrap their account.
 *
 * Created alongside the `firm_users` row when an admin creates the
 * firm (or when an existing owner invites a teammate). The raw token
 * is only ever sent out in the welcome email; the DB stores its
 * SHA-256 hash so a leak cannot be replayed.
 *
 * Acceptance burns the row via `used_at` so the same email link
 * cannot set up two different accounts. `expires_at` is checked
 * server-side at accept time (default 72 hours after creation).
 */
export const firmUserInvites = pgTable(
  'firm_user_invites',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firmUserId: uuid('firm_user_id')
      .notNull()
      .references(() => firmUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('firm_user_invites_token_hash_key').on(table.tokenHash),
    index('firm_user_invites_firm_user_id_idx').on(table.firmUserId),
  ],
);

export type FirmUserInvite = typeof firmUserInvites.$inferSelect;
export type NewFirmUserInvite = typeof firmUserInvites.$inferInsert;
