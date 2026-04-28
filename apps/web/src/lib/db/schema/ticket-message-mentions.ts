import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { adminUsers } from './users';
import { ticketMessages } from './tickets';

/**
 * `ticket_message_mentions` -- records each distinct `@admin` mention
 * inside a ticket message body.
 *
 * One row per (message, mentioned_admin). Duplicates inside the same
 * message (e.g. `@alice @alice @alice`) collapse to a single row so
 * downstream notification fan-out stays bounded.
 *
 * Scope -- only admin-to-participant mentions are persisted here:
 *
 *   * Customer first message may contain a single `@support` chip that
 *     triggers the auto-assignment algorithm. This is NOT stored in
 *     this table (it targets no specific admin).
 *   * Customer follow-up messages may tag each responding admin at
 *     most once. Those mentions ARE stored here.
 *   * Admin messages may tag the assignee + collaborators excluding
 *     themselves; tags of the author are silently dropped before
 *     insert.
 *
 * The foreign keys cascade so deleting a message or an admin user
 * also prunes their mention rows without dangling references.
 */
export const ticketMessageMentions = pgTable(
  'ticket_message_mentions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    messageId: uuid('message_id')
      .notNull()
      .references(() => ticketMessages.id, { onDelete: 'cascade' }),
    mentionedAdminId: uuid('mentioned_admin_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ticket_message_mentions_message_admin_key').on(
      table.messageId,
      table.mentionedAdminId,
    ),
    index('ticket_message_mentions_admin_idx').on(table.mentionedAdminId),
  ],
);

export type TicketMessageMention = typeof ticketMessageMentions.$inferSelect;
export type NewTicketMessageMention = typeof ticketMessageMentions.$inferInsert;
