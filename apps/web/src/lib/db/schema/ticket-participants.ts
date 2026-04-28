import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  ticketParticipantRoleEnum,
  ticketParticipantStatusEnum,
} from './enums';
import { adminUsers } from './users';
import { tickets } from './tickets';

/**
 * `ticket_participants` -- admins that can see or act on a ticket.
 *
 * The legacy `tickets.assigned_to` column remains as a denormalised
 * pointer to the current `assignee` participant so existing queries
 * and indexes continue to work unchanged. This table is the source of
 * truth for the full participant list (assignee + collaborators).
 *
 * Invariants:
 *
 *   * At most one row per (ticket, admin) -- enforced by
 *     `ticket_participants_ticket_admin_key`. If an admin is
 *     `declined` / `removed` and later re-invited, the same row is
 *     revived via UPDATE (status -> pending/active, responded_at
 *     cleared) rather than a second INSERT.
 *   * At most one ACTIVE assignee per ticket -- enforced by the
 *     partial unique index `ticket_participants_active_assignee_key`.
 *     Collaborators may be multiple; pending/declined/removed rows
 *     never collide.
 *
 * Flows:
 *
 *   * Invite (same level): INSERT status=`pending`, expires_at=now+1d,
 *     invited_by=caller. Target admin accepts -> status=`active`,
 *     responded_at=now. Declines -> status=`declined`.
 *   * Direct add (lower level): INSERT status=`active`,
 *     invited_at=responded_at=now. No decline right.
 *   * Superadmin join-as-collab: INSERT status=`active` directly.
 *     Take-over-as-assignee: UPDATE existing assignee row to status=
 *     `removed` + INSERT new superadmin row as assignee.
 *   * Self-leave (collaborator): UPDATE status=`removed`,
 *     removed_at=now.
 *
 * The `muted` column suppresses ticket-specific notifications for the
 * participant without removing them from the ticket.
 */
export const ticketParticipants = pgTable(
  'ticket_participants',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    role: ticketParticipantRoleEnum('role').notNull(),
    status: ticketParticipantStatusEnum('status').notNull(),
    invitedBy: uuid('invited_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    invitedAt: timestamp('invited_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true, mode: 'date' }),
    /** Pending invites expire and are auto-`removed` after this moment. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
    /** Reason captured for transferred-down assignments (surfaced in audit + notification). */
    transferReason: text('transfer_reason'),
    muted: boolean('muted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ticket_participants_ticket_admin_key').on(table.ticketId, table.adminUserId),
    uniqueIndex('ticket_participants_active_assignee_key')
      .on(table.ticketId)
      .where(sql`${table.role} = 'assignee' AND ${table.status} = 'active'`),
    index('ticket_participants_admin_status_idx').on(table.adminUserId, table.status),
    index('ticket_participants_ticket_status_idx').on(table.ticketId, table.status),
    index('ticket_participants_expires_at_idx')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export type TicketParticipant = typeof ticketParticipants.$inferSelect;
export type NewTicketParticipant = typeof ticketParticipants.$inferInsert;
