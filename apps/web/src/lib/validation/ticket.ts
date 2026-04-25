/**
 * Ticket validation schemas — single source of truth for ticket subject,
 * body, and message fields across all layers.
 *
 * Frontend forms and backend handlers both import from here.
 *
 * @module
 */

import { z } from 'zod';

import { uuidSchema } from './common';

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/** Ticket subject — 1-200 characters. */
export const ticketSubjectSchema = z
  .string()
  .min(1, 'Subject is required.')
  .max(200, 'Subject must be at most 200 characters.');

/** Ticket message body — 1-5000 characters. */
export const ticketBodySchema = z
  .string()
  .min(1, 'Message body is required.')
  .max(5000, 'Message body must be at most 5000 characters.');

/** Ticket category ID — must be a valid UUID. */
export const ticketCategoryIdSchema = uuidSchema;

/** Valid ticket statuses for admin updates. */
export const ticketStatusSchema = z.enum(
  ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'],
  { message: 'Invalid ticket status.' },
);

/** Valid ticket priorities for admin updates. */
export const ticketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent'], {
  message: 'Invalid ticket priority.',
});

// ---------------------------------------------------------------------------
// Category field schemas (admin CRUD)
// ---------------------------------------------------------------------------

/** Category name — 1-100 characters. Matches DB text column. */
export const categoryNameSchema = z
  .string()
  .min(1, 'Category name is required.')
  .max(100, 'Category name must be at most 100 characters.');

/** Category slug — lowercase alphanumeric + hyphens, 2-64 characters. */
export const categorySlugSchema = z
  .string()
  .min(2, 'Slug must be at least 2 characters.')
  .max(64, 'Slug must be at most 64 characters.')
  .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens.');

/** Category audience — who can create tickets in this category. */
export const categoryAudienceSchema = z.enum(['customer', 'firm', 'any'], {
  message: 'Invalid audience value.',
});

/** Category description — optional, max 500 characters. */
export const categoryDescriptionSchema = z
  .string()
  .max(500, 'Description must be at most 500 characters.')
  .optional()
  .transform((v) => (v?.trim().length === 0 ? undefined : v));

/** Category icon — optional identifier string. */
export const categoryIconSchema = z
  .string()
  .max(50, 'Icon must be at most 50 characters.')
  .optional()
  .transform((v) => (v?.trim().length === 0 ? undefined : v));

/** Category display order — non-negative integer. */
export const categoryDisplayOrderSchema = z
  .number()
  .int('Display order must be a whole number.')
  .min(0, 'Display order must be 0 or greater.')
  .max(9999, 'Display order must be at most 9999.');

// ---------------------------------------------------------------------------
// Category composite schemas
// ---------------------------------------------------------------------------

/** Schema for creating a ticket category (admin). */
export const createCategorySchema = z.object({
  name: categoryNameSchema,
  slug: categorySlugSchema,
  audience: categoryAudienceSchema.default('any'),
  description: categoryDescriptionSchema,
  icon: categoryIconSchema,
  displayOrder: categoryDisplayOrderSchema.default(0),
});

/** Schema for updating a ticket category (admin). All fields optional. */
export const updateCategorySchema = z.object({
  name: categoryNameSchema.optional(),
  slug: categorySlugSchema.optional(),
  audience: categoryAudienceSchema.optional(),
  description: categoryDescriptionSchema,
  icon: categoryIconSchema,
  displayOrder: categoryDisplayOrderSchema.optional(),
  isActive: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Composite schemas
// ---------------------------------------------------------------------------

/** Schema for creating a new ticket (customer). */
export const createTicketSchema = z.object({
  categoryId: ticketCategoryIdSchema,
  subject: ticketSubjectSchema,
  body: ticketBodySchema,
});

/** Schema for adding a customer message to a ticket. */
export const customerMessageSchema = z.object({
  body: ticketBodySchema,
});

/** Schema for adding an admin message (with optional internal flag). */
export const adminMessageSchema = z.object({
  body: ticketBodySchema,
  isInternal: z.boolean().optional().default(false),
});

/**
 * Schema for editing an existing message (admin or customer side).
 *
 * Only `body` is editable — `is_internal` and authorship are immutable.
 * Server additionally enforces that the caller is the author and that
 * `seen_by_other` is still `false`; the schema only validates the new
 * body shape so we catch oversized / empty input early.
 */
export const editMessageSchema = z.object({
  body: ticketBodySchema,
});

/**
 * Short freeform explanation (≤ 500 chars) attached to reassign, remove,
 * and take-over actions. Stored in `ticket_participants.transfer_reason`
 * so audit readers can see *why* a participant-graph change happened.
 *
 * Optional at the field level — handlers enforce "required" for the
 * specific transitions that need a justification (e.g. reassign-to-other
 * downgrades) so pickup-pool self-claims don't need to fabricate a reason.
 */
export const ticketTransferReasonSchema = z
  .string()
  .trim()
  .min(1, 'Please provide a short explanation.')
  .max(500, 'Explanation must be at most 500 characters.');

/** Optional message attached to an invite (shown in the recipient's inbox). */
export const ticketInviteMessageSchema = z
  .string()
  .trim()
  .max(500, 'Invite message must be at most 500 characters.')
  .optional()
  .transform((v) => (v === undefined || v.length === 0 ? undefined : v));

/** Schema for admin ticket update (status, priority, assignedTo, reassign flow). */
export const adminUpdateTicketSchema = z.object({
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  assignedTo: uuidSchema.nullable().optional(),
  /**
   * When reassigning to another admin, the outgoing assignee is offered
   * the option to stay on the ticket as a collaborator. Default `true`
   * -- the UI presents this as a checkbox ticked on by default.
   * Ignored on self-claims and on clearing the assignment (null).
   */
  oldAssigneeStaysAsCollab: z.boolean().optional(),
  /**
   * Required free-form explanation when reassigning an assigned ticket
   * to another admin. Optional here; the handler enforces presence for
   * the specific transitions that need it so self-claims / unassign
   * don't need to fabricate one.
   */
  reassignReason: ticketTransferReasonSchema.optional(),
});

/** Schema for inviting / direct-adding an admin as a ticket participant. */
export const ticketInviteParticipantSchema = z.object({
  adminUserId: uuidSchema,
  /** Optional short note the invite recipient sees. */
  message: ticketInviteMessageSchema,
});

/** Schema for removing a participant (reason optional, useful for audit). */
export const ticketRemoveParticipantSchema = z.object({
  reason: ticketTransferReasonSchema.optional(),
});

/** Schema for the superadmin take-over endpoint. */
export const ticketTakeOverSchema = z.object({
  /** Optional explanation persisted on the displaced assignee's row. */
  reason: ticketTransferReasonSchema.optional(),
  /**
   * When true, the previous assignee is demoted to an active collaborator
   * rather than `removed`. Default `true` -- mirrors the reassign flow.
   */
  previousAssigneeStaysAsCollab: z.boolean().optional(),
});
