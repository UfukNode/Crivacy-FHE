import { index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';

import { adminUsers } from './users';
import { ticketCategories } from './tickets';

/**
 * `ticket_category_admins` -- explicit admin pool per ticket category.
 *
 * Used by the auto-assignment algorithm for new customer-opened
 * tickets. When a customer drops the `@support` chip, the algorithm
 * picks an assignee by ranking members of this pool on load, recency,
 * and a small jitter. Superadmins are never auto-assigned even if
 * they appear in the pool -- filtered at selection time, not at
 * insert, so a superadmin can still be listed for manual invite.
 *
 * Pool resolution for category C:
 *
 *   1. If any rows exist for C -> use exactly that set.
 *   2. If no rows exist for C -> algorithm falls back to every active
 *      admin whose role is `admin` or `support` (existing behaviour
 *      pre-pool).
 *
 * This lets operators leave the table empty during migration and
 * populate it incrementally without the algorithm stalling.
 *
 * The composite primary key enforces at-most-one row per pair; there
 * is no standalone `id` column because the table has no outbound
 * references.
 */
export const ticketCategoryAdmins = pgTable(
  'ticket_category_admins',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => ticketCategories.id, { onDelete: 'cascade' }),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    addedBy: uuid('added_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'ticket_category_admins_pk',
      columns: [table.categoryId, table.adminUserId],
    }),
    index('ticket_category_admins_admin_idx').on(table.adminUserId),
  ],
);

export type TicketCategoryAdmin = typeof ticketCategoryAdmins.$inferSelect;
export type NewTicketCategoryAdmin = typeof ticketCategoryAdmins.$inferInsert;
