import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  ticketAudienceEnum,
  ticketCreatorTypeEnum,
  ticketPriorityEnum,
  ticketStatusEnum,
} from './enums';
import { firms } from './firms';

// ---------------------------------------------------------------------------
// ticket_categories
// ---------------------------------------------------------------------------

/**
 * `ticket_categories` -- predefined categories for support tickets. Each
 * category has an `audience` that restricts who can create tickets in it:
 *
 *   * `customer` -- only end-user customers
 *   * `firm`     -- only firm dashboard users
 *   * `any`      -- both customer and firm users
 *
 * Categories are admin-managed. Soft-disabling via `is_active = false`
 * hides them from the ticket creation form while preserving referential
 * integrity on existing tickets.
 */
export const ticketCategories = pgTable(
  'ticket_categories',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    audience: ticketAudienceEnum('audience').notNull().default('any'),
    icon: text('icon'),
    displayOrder: integer('display_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('ticket_categories_audience_active_order_idx').on(
      table.audience,
      table.isActive,
      table.displayOrder,
    ),
  ],
);

export type TicketCategory = typeof ticketCategories.$inferSelect;
export type NewTicketCategory = typeof ticketCategories.$inferInsert;

// ---------------------------------------------------------------------------
// tickets
// ---------------------------------------------------------------------------

/**
 * `tickets` -- support tickets created by customers or firm users. Each
 * ticket carries a human-readable `reference_number` (format CRV-XXXXX)
 * that is displayed in the UI and email notifications. The `creator_type`
 * discriminates the FK target: `customer` points to `customers.id`,
 * `firm_user` points to `firm_users.id`.
 *
 * `firm_id` is populated only for firm-originated tickets to scope
 * dashboard visibility. Customer tickets always have `firm_id = null`.
 *
 * Status lifecycle:
 *   open -> in_progress -> waiting_customer -> in_progress -> resolved -> closed
 *
 * `resolved_at` stamps the moment an agent marks the ticket resolved;
 * `closed_at` stamps the final closure (possibly auto-closed after N days
 * of inactivity post-resolution).
 */
export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    referenceNumber: text('reference_number').notNull().unique(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => ticketCategories.id, { onDelete: 'restrict' }),
    creatorId: uuid('creator_id').notNull(),
    creatorType: ticketCreatorTypeEnum('creator_type').notNull(),
    firmId: uuid('firm_id').references(() => firms.id, { onDelete: 'set null' }),
    assignedTo: uuid('assigned_to'),
    subject: varchar('subject', { length: 200 }).notNull(),
    status: ticketStatusEnum('status').notNull().default('open'),
    priority: ticketPriorityEnum('priority').notNull().default('normal'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('tickets_creator_idx').on(table.creatorId, table.creatorType),
    index('tickets_assigned_to_idx').on(table.assignedTo),
    index('tickets_status_idx').on(table.status),
    index('tickets_firm_id_idx').on(table.firmId),
    uniqueIndex('tickets_reference_number_key').on(table.referenceNumber),
  ],
);

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;

// ---------------------------------------------------------------------------
// ticket_messages
// ---------------------------------------------------------------------------

/**
 * `ticket_messages` -- the conversation thread on a ticket. Each message
 * belongs to a sender identified by `sender_id` + `sender_type`. The
 * `sender_type` is a free-form discriminator:
 *
 *   * `customer`   -- end-user who created the ticket
 *   * `firm_user`  -- firm dashboard user
 *   * `admin_user` -- platform admin / support agent
 *   * `system`     -- auto-generated status change notices
 *
 * `is_internal` marks staff-only notes that are never exposed to the
 * ticket creator. The body is capped at 5000 characters to prevent abuse.
 */
export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id').notNull(),
    senderType: text('sender_type').notNull(),
    body: varchar('body', { length: 5000 }).notNull(),
    isInternal: boolean('is_internal').notNull().default(false),
    // `seen_by_other` drives the edit-lock. It flips to `true` the first
    // time any non-author loads the ticket detail (admin-side or
    // customer-side). Once true, the owner can no longer edit the body
    // — the PATCH endpoint rejects with 409 and the UI hides its edit
    // control. Historical messages were back-filled to `true` so nothing
    // pre-dating this feature is unexpectedly editable.
    seenByOther: boolean('seen_by_other').notNull().default(false),
    // `edited_at` is NULL until the first (and only permitted, i.e.
    // pre-seen) edit. Surfaced for audit / potential future UI, not
    // consulted by the lock check.
    editedAt: timestamp('edited_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('ticket_messages_ticket_created_idx').on(table.ticketId, table.createdAt),
  ],
);

export type TicketMessage = typeof ticketMessages.$inferSelect;
export type NewTicketMessage = typeof ticketMessages.$inferInsert;

// ---------------------------------------------------------------------------
// ticket_attachments
// ---------------------------------------------------------------------------

/**
 * `ticket_attachments` -- files attached to ticket messages. Storage is
 * handled externally (e.g. S3 / R2); this table tracks metadata only.
 * `storage_key` is the object key in the storage bucket. Dimensions
 * (`width`, `height`) are populated only for image attachments.
 */
export const ticketAttachments = pgTable(
  'ticket_attachments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    messageId: uuid('message_id')
      .notNull()
      .references(() => ticketMessages.id, { onDelete: 'cascade' }),
    originalFilename: text('original_filename').notNull(),
    storageKey: uuid('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('ticket_attachments_message_id_idx').on(table.messageId),
  ],
);

export type TicketAttachment = typeof ticketAttachments.$inferSelect;
export type NewTicketAttachment = typeof ticketAttachments.$inferInsert;
