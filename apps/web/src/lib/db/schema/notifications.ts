import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { customers } from './customers';

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

/**
 * `notifications` — in-app notification center entries. Each row targets
 * exactly ONE user type (customer, firm_user, or admin_user) enforced by
 * the `exactly_one_recipient` check constraint.
 *
 * Notifications are created by event handlers (credential issued, ticket
 * reply, KYC status change, etc.) and delivered to the user via the bell
 * icon dropdown in the navbar. The `read_at` column tracks whether the
 * user has acknowledged the notification.
 *
 * Types are validated at the API boundary via Zod against the
 * `NOTIFICATION_TYPES` union in shared-types.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Customer recipient (null if targeting firm_user or admin_user). */
    customerId: uuid('customer_id').references(() => customers.id, {
      onDelete: 'cascade',
    }),
    /** Firm user recipient (null if targeting customer or admin_user). */
    firmUserId: uuid('firm_user_id'),
    /** Admin user recipient (null if targeting customer or firm_user). */
    adminUserId: uuid('admin_user_id'),
    /** Notification type — validated by Zod at API boundary. */
    type: varchar('type', { length: 64 }).notNull(),
    /** Short title shown in the bell dropdown. */
    title: varchar('title', { length: 200 }).notNull(),
    /** Longer body text with notification details. */
    body: text('body').notNull(),
    /** In-app navigation path (e.g., '/kyc' or '/tickets/CRV-00042'). */
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'exactly_one_recipient',
      sql`(
        (${table.customerId} IS NOT NULL)::int +
        (${table.firmUserId} IS NOT NULL)::int +
        (${table.adminUserId} IS NOT NULL)::int
      ) = 1`,
    ),
    index('notifications_customer_read_created_idx').on(
      table.customerId,
      table.readAt,
      table.createdAt,
    ),
    index('notifications_firm_user_read_created_idx').on(
      table.firmUserId,
      table.readAt,
      table.createdAt,
    ),
    index('notifications_admin_user_read_created_idx').on(
      table.adminUserId,
      table.readAt,
      table.createdAt,
    ),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
