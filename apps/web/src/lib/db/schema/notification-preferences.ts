import { sql } from 'drizzle-orm';
import {
  boolean,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { roleUserTypeEnum } from './enums';

// ---------------------------------------------------------------------------
// notification_preferences
// ---------------------------------------------------------------------------

/**
 * `notification_preferences` — per-user, per-event, per-channel toggles for
 * the notification system. Each row controls whether a specific event type
 * triggers an in-app notification and/or an email for a given user.
 *
 * Default behavior (when no row exists): both channels are enabled.
 * Security events (`session.new_device`, `password.changed`) are NOT stored
 * here — they are always sent regardless of preferences.
 *
 * The unique constraint on `(user_id, user_type, event_type)` ensures at
 * most one preference row per user per event. The `user_type` discriminant
 * is needed because `user_id` values from different user tables could
 * theoretically collide (though UUID v4 makes this astronomically unlikely).
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** UUID of the user (customer, firm_user, or admin_user). */
    userId: uuid('user_id').notNull(),
    /** Discriminant: which user table `user_id` references. */
    userType: roleUserTypeEnum('user_type').notNull(),
    /** Event type identifier (e.g., 'kyc.status_changed', 'ticket.reply'). */
    eventType: varchar('event_type', { length: 64 }).notNull(),
    /** Whether to deliver as in-app notification (bell icon dropdown). */
    channelInApp: boolean('channel_in_app').notNull().default(true),
    /** Whether to deliver via email. */
    channelEmail: boolean('channel_email').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('notification_preferences_user_event_key').on(
      table.userId,
      table.userType,
      table.eventType,
    ),
  ],
);

export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert;
