/**
 * Ticket system handlers -- customer and admin ticket operations.
 *
 * Each exported function takes a typed context (`CustomerContext` or
 * `AdminContext`) and returns a `NextResponse`. The route files wire
 * these handlers through the appropriate middleware pipeline.
 *
 * Customer handlers enforce ownership: a customer can only see/interact
 * with tickets they created. Admin handlers see all tickets and can
 * perform privileged operations (assign, change status, add internal
 * notes).
 *
 * Every mutation writes an audit entry via the standard audit writer.
 *
 * @module
 */

import { and, count, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { NextResponse } from 'next/server';

import { adminUserActor, customerActor, customerLabel } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import { getAppUrl } from '@/lib/env/app-url';
import {
  notifyAdminDirectAdded,
  notifyAdminInviteRescinded,
  notifyAdminInviteResponded,
  notifyAdminNewTicket,
  notifyAdminParticipantInvited,
  notifyAdminParticipantLeft,
  notifyAdminTicketAssigned,
  notifyAdminTicketCustomerReply,
  notifyAdminTicketMentioned,
  notifyAdminTicketNeedsPickup,
  notifyAdminTicketTakenOver,
  notifyCustomerTicketReply,
  notifyCustomerTicketStatusChange,
} from '@/lib/notification';
import { hasSupportChip, pickAutoAssignee } from '@/lib/ticket/auto-assign';
import {
  checkAdminMessageRate,
  checkCustomerMessageRate,
} from '@/lib/ticket/rate-limit';
import {
  filterMentionable,
  filterMentionableForCustomer,
  parseMentions,
} from '@/lib/ticket/mentions';
import {
  atLeast,
  canPerformTicketAction,
  outranks,
  ROLE_RANK,
  type AdminRole,
  type ParticipantRef,
  type TicketPermissionContext,
} from '@/lib/ticket/permissions';
import {
  buildTicketVisibilityCondition,
  getParticipantRef,
  listTicketParticipants,
} from '@/lib/ticket/visibility';
import { uuidSchema } from '@/lib/validation/common';
import {
  adminMessageSchema,
  adminUpdateTicketSchema,
  createCategorySchema,
  createTicketSchema,
  customerMessageSchema,
  editMessageSchema,
  ticketInviteParticipantSchema,
  ticketRemoveParticipantSchema,
  ticketTakeOverSchema,
  updateCategorySchema,
} from '@/lib/validation/ticket';
import type { AdminContext, CustomerContext } from '../context';
import {
  fetchActiveAdminIdsShared,
  generateUniqueReferenceShared,
  mapMessageRowShared,
  mapTicketRowShared,
  truncateForEmailShared,
} from './_ticket-shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of simultaneously open tickets per customer. */
const MAX_OPEN_TICKETS_PER_CUSTOMER = 2;

/** Default page size for ticket listings. */
const DEFAULT_PAGE_SIZE = 20;

/** Maximum page size for ticket listings. */
const MAX_PAGE_SIZE = 100;

/** Pending participant invites expire after this window (1 day). */
const INVITE_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an audit request context from a base request context.
 */
function auditCtxFrom(ctx: CustomerContext | AdminContext) {
  return buildAuditRequestContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
}

/**
 * Reject malformed UUIDs coming from route params before they reach Postgres.
 * Without this guard, Drizzle forwards the raw string to the `uuid` cast and
 * the database responds with a generic `invalid input syntax for type uuid`
 * 500. A short-circuit 400 is both safer and clearer for API consumers.
 *
 * @param field Human-readable identifier used in the error message
 *              (e.g. `'ticket'`, `'category'`, `'message'`).
 */
function invalidUuidResponse(ctx: CustomerContext | AdminContext, field: string): NextResponse {
  return ctx.errorJson('invalid_id', `Invalid ${field} ID format.`, 400);
}

/**
 * Parse a positive integer from a URL search parameter.
 * Returns the default if absent or invalid.
 */
function parsePositiveInt(value: string | null, defaultValue: number, max: number): number {
  if (value === null) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return defaultValue;
  }
  return Math.min(parsed, max);
}

/**
 * Map a ticket row to the API response shape.
 */
// Ticket + message row mappers and notification-fan-out helpers
// live in `./_ticket-shared` so the customer, admin, and firm paths
// stay in lock-step on the wire format. The names below are local
// aliases to keep the existing call sites untouched while the
// underlying logic is single-sourced.
const mapTicketRow = mapTicketRowShared;
const mapMessageRow = mapMessageRowShared;

/**
 * Map a category row to the API response shape.
 */
function mapCategoryRow(row: typeof schema.ticketCategories.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    audience: row.audience,
    icon: row.icon,
    displayOrder: row.displayOrder,
  } as const;
}

/** Absolute URL to the customer-facing ticket page. */
function buildCustomerTicketUrl(ticketId: string): string {
  return `${getAppUrl()}/tickets/${ticketId}`;
}

/** Absolute URL to the admin-facing ticket detail page. */
function buildAdminTicketUrl(ticketId: string): string {
  return `${getAppUrl()}/admin/tickets/${ticketId}`;
}

// `fetchActiveAdminIds`, `truncateForEmail`, and
// `generateUniqueReference` all moved to `./_ticket-shared` to stop
// drifting from the firm-ticket handler copies. Local aliases so the
// existing call sites don't need touch-ups.
const fetchActiveAdminIds = fetchActiveAdminIdsShared;
const truncateForEmail = truncateForEmailShared;
const generateUniqueReference = generateUniqueReferenceShared;

// ---------------------------------------------------------------------------
// handleListTicketCategories
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/tickets/categories
 *
 * Returns active ticket categories visible to customers (audience =
 * 'customer' or 'any'), ordered by `display_order`.
 */
export async function handleListTicketCategories(ctx: CustomerContext): Promise<NextResponse> {
  const { db } = ctx;

  const categories = await db
    .select()
    .from(schema.ticketCategories)
    .where(
      and(
        eq(schema.ticketCategories.isActive, true),
        or(
          eq(schema.ticketCategories.audience, 'customer'),
          eq(schema.ticketCategories.audience, 'any'),
        ),
      ),
    )
    .orderBy(schema.ticketCategories.displayOrder);

  return ctx.json({
    categories: categories.map(mapCategoryRow),
  });
}

// ---------------------------------------------------------------------------
// handleListCustomerTickets
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/tickets
 *
 * List tickets owned by the authenticated customer. Supports filtering
 * by status and cursor-based pagination via `cursor` (ticket id) and
 * `limit` query parameters.
 */
export async function handleListCustomerTickets(ctx: CustomerContext): Promise<NextResponse> {
  const { customer, db, request } = ctx;
  const url = new URL(request.url);

  const statusFilter = url.searchParams.get('status');
  const cursor = url.searchParams.get('cursor');
  const limit = parsePositiveInt(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  // Build conditions
  const conditions = [
    eq(schema.tickets.creatorId, customer.id),
    eq(schema.tickets.creatorType, 'customer'),
  ];

  if (statusFilter !== null && statusFilter.length > 0) {
    const validStatuses = [
      'open',
      'in_progress',
      'waiting_customer',
      'resolved',
      'closed',
    ] as const;
    if ((validStatuses as readonly string[]).includes(statusFilter)) {
      conditions.push(eq(schema.tickets.status, statusFilter as (typeof validStatuses)[number]));
    }
  }

  // Cursor-based pagination: fetch tickets created before the cursor ticket
  if (cursor !== null && cursor.length > 0) {
    const cursorRows = await db
      .select({ createdAt: schema.tickets.createdAt })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, cursor))
      .limit(1);

    const cursorRow = cursorRows[0];
    if (cursorRow !== undefined) {
      conditions.push(sql`${schema.tickets.createdAt} < ${cursorRow.createdAt}`);
    }
  }

  const rows = await db
    .select({
      ticket: schema.tickets,
      categoryName: schema.ticketCategories.name,
    })
    .from(schema.tickets)
    .leftJoin(schema.ticketCategories, eq(schema.tickets.categoryId, schema.ticketCategories.id))
    .where(and(...conditions))
    .orderBy(desc(schema.tickets.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && pageRows.length > 0 ? (pageRows[pageRows.length - 1]?.ticket.id ?? null) : null;

  return ctx.json({
    tickets: pageRows.map((row) => ({
      ...mapTicketRow(row.ticket),
      categoryName: row.categoryName ?? 'Uncategorized',
    })),
    nextCursor,
    hasMore,
  });
}

// ---------------------------------------------------------------------------
// handleCreateCustomerTicket
// ---------------------------------------------------------------------------

/**
 * POST /api/customer/tickets
 *
 * Create a new support ticket. The customer must provide a category,
 * subject, and initial message body. Enforces:
 *   - Subject max 200 characters
 *   - Body max 5000 characters
 *   - Category audience must be 'customer' or 'any'
 *   - Max 5 open tickets per customer
 *
 * Creates the ticket + initial message in a single transaction.
 */
export async function handleCreateCustomerTicket(ctx: CustomerContext): Promise<NextResponse> {
  const { customer, db, now } = ctx;

  // --- 1. Parse and validate body ---
  let rawBody: unknown;
  try {
    rawBody = await ctx.request.json();
  } catch {
    return ctx.errorJson('invalid_body', 'Request body must be valid JSON.', 400);
  }

  const parsed = createTicketSchema.safeParse(rawBody);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }

  const { categoryId, subject, body: messageBody } = parsed.data;

  // --- 2. Validate category exists and audience matches ---
  const categoryRows = await db
    .select()
    .from(schema.ticketCategories)
    .where(
      and(eq(schema.ticketCategories.id, categoryId), eq(schema.ticketCategories.isActive, true)),
    )
    .limit(1);

  const category = categoryRows[0];
  if (category === undefined) {
    return ctx.errorJson('not_found', 'Ticket category not found or inactive.', 404);
  }

  if (category.audience !== 'customer' && category.audience !== 'any') {
    return ctx.errorJson(
      'audience_mismatch',
      'This category is not available for customer tickets.',
      403,
    );
  }

  // --- 3. Rate limit: max open tickets ---
  const openTicketCount = await db
    .select({ value: count() })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.creatorId, customer.id),
        eq(schema.tickets.creatorType, 'customer'),
        inArray(schema.tickets.status, ['open', 'in_progress', 'waiting_customer']),
      ),
    );

  const openCount = openTicketCount[0]?.value ?? 0;
  if (openCount >= MAX_OPEN_TICKETS_PER_CUSTOMER) {
    return ctx.errorJson(
      'rate_limit_exceeded',
      `You can have at most ${String(MAX_OPEN_TICKETS_PER_CUSTOMER)} open tickets at a time.`,
      429,
    );
  }

  // --- 4. Generate unique reference number ---
  const referenceNumber = await generateUniqueReference(db);
  if (referenceNumber === null) {
    return ctx.errorJson(
      'internal_error',
      'Failed to generate a unique ticket reference. Please try again.',
      500,
    );
  }

  // --- 5. Create ticket + initial message in transaction ---
  // If the initial message contains the `@support` chip we also attempt
  // to auto-assign an admin from the category pool (load-balanced, with
  // jitter tiebreak). A successful auto-assignment writes a matching
  // participant row and a dedicated audit entry; the downstream
  // notification fan-out is then narrowed to just the picked assignee.
  const autoAssignRequested = hasSupportChip(messageBody);

  const { ticket: result, autoAssignedTo } = await db.transaction(async (tx) => {
    const ticketInserted = await tx
      .insert(schema.tickets)
      .values({
        referenceNumber,
        categoryId,
        creatorId: customer.id,
        creatorType: 'customer',
        firmId: null,
        subject,
        status: 'open',
        priority: 'normal',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const ticket = ticketInserted[0];
    if (ticket === undefined) {
      throw new Error('Ticket insert returned no row');
    }

    await tx.insert(schema.ticketMessages).values({
      ticketId: ticket.id,
      senderId: customer.id,
      senderType: 'customer',
      body: messageBody,
      isInternal: false,
      createdAt: now,
    });

    // Audit inside the transaction
    await writeAudit(tx, {
      action: 'ticket.created',
      actor: customerActor({ id: customer.id, label: customerLabel(customer) }),
      target: uuidTarget({ kind: 'ticket', id: ticket.id, ref: referenceNumber }),
      context: auditCtxFrom(ctx),
      meta: {
        categoryId,
        categorySlug: category.slug,
        subject,
      },
      ts: now,
    });

    // Auto-assignment via `@support` chip. The picker is best-effort:
    // a null result (empty pool after filtering) falls through to the
    // normal unassigned flow and the broad fan-out will still surface
    // the ticket for pickup.
    let autoAssignedAdminId: string | null = null;
    let assignedTicket = ticket;
    if (autoAssignRequested) {
      autoAssignedAdminId = await pickAutoAssignee(tx, categoryId);
      if (autoAssignedAdminId !== null) {
        const updatedRows = await tx
          .update(schema.tickets)
          .set({ assignedTo: autoAssignedAdminId, updatedAt: now })
          .where(eq(schema.tickets.id, ticket.id))
          .returning();
        const updated = updatedRows[0];
        if (updated === undefined) {
          throw new Error('Ticket auto-assign update returned no row');
        }
        assignedTicket = updated;

        // The ticket is brand-new so no prior participant row for this
        // admin can exist -- a plain INSERT is sufficient. We use the
        // assignee role with active status; `invitedBy` is null to
        // signal a system-initiated assignment (as opposed to an
        // admin-initiated reassign which stores the inviter id).
        await tx.insert(schema.ticketParticipants).values({
          ticketId: ticket.id,
          adminUserId: autoAssignedAdminId,
          role: 'assignee',
          status: 'active',
          invitedBy: null,
          invitedAt: now,
          respondedAt: now,
          createdAt: now,
          updatedAt: now,
        });

        await writeAudit(tx, {
          action: 'ticket.auto_assigned',
          actor: customerActor({ id: customer.id, label: customerLabel(customer) }),
          target: uuidTarget({ kind: 'ticket', id: ticket.id, ref: referenceNumber }),
          context: auditCtxFrom(ctx),
          meta: {
            assignedTo: autoAssignedAdminId,
            strategy: 'support_chip',
            categoryId,
            categorySlug: category.slug,
          },
          ts: now,
        });
      }
    }

    return { ticket: assignedTicket, autoAssignedTo: autoAssignedAdminId };
  });

  // Notify path splits on auto-assignment:
  //   - Assigned → narrow ping to the picked admin only (they now own
  //     the ticket; broad fan-out would just be noise).
  //   - Unassigned → fan out to all active admins so the pickup pool
  //     stays healthy.
  // The dispatcher contains errors internally so a notification
  // failure can never block ticket creation.
  if (autoAssignedTo !== null) {
    await notifyAdminTicketAssigned(db, {
      adminUserId: autoAssignedTo,
      ticket: {
        ticketId: result.id,
        referenceNumber: result.referenceNumber,
        subject: result.subject,
        ticketUrl: buildAdminTicketUrl(result.id),
      },
      assignedByName: 'Auto-assignment',
    });
  } else {
    const adminIds = await fetchActiveAdminIds(db);
    if (adminIds.length > 0) {
      await notifyAdminNewTicket(db, {
        adminUserIds: adminIds,
        ticket: {
          ticketId: result.id,
          referenceNumber: result.referenceNumber,
          subject: result.subject,
          ticketUrl: buildAdminTicketUrl(result.id),
        },
        customerLabel: customerLabel(customer),
        priority: result.priority,
      });
    }
  }

  return ctx.json(
    {
      ticket: mapTicketRow(result),
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// handleGetCustomerTicket
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/tickets/[id]
 *
 * Returns a single ticket with its messages (excluding internal notes).
 * Verifies ownership before returning data.
 */
export async function handleGetCustomerTicket(
  ctx: CustomerContext,
  ticketId: string,
): Promise<NextResponse> {
  const { customer, db } = ctx;

  // --- 0. Validate route param format ---
  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }

  // --- 1. Fetch ticket and verify ownership (join with category) ---
  const ticketRows = await db
    .select({
      ticket: schema.tickets,
      categoryName: schema.ticketCategories.name,
    })
    .from(schema.tickets)
    .leftJoin(schema.ticketCategories, eq(schema.tickets.categoryId, schema.ticketCategories.id))
    .where(
      and(
        eq(schema.tickets.id, ticketId),
        eq(schema.tickets.creatorId, customer.id),
        eq(schema.tickets.creatorType, 'customer'),
      ),
    )
    .limit(1);

  const row = ticketRows[0];
  if (row === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // --- 2. Mark-as-seen: flip `seen_by_other` on admin-authored
  // messages so their owners can no longer edit once the customer has
  // loaded the thread. Customer-authored messages are skipped because
  // the customer IS the author. Internal notes are not touched here:
  // customers can't see them, so a customer view must not lock them.
  await db
    .update(schema.ticketMessages)
    .set({ seenByOther: true })
    .where(
      and(
        eq(schema.ticketMessages.ticketId, ticketId),
        eq(schema.ticketMessages.seenByOther, false),
        eq(schema.ticketMessages.isInternal, false),
        or(
          sql`${schema.ticketMessages.senderId} != ${customer.id}`,
          sql`${schema.ticketMessages.senderType} != 'customer'`,
        ) as SQL,
      ),
    );

  // --- 3. Fetch messages (exclude internal notes). LEFT JOIN both
  // sender tables so we can resolve the display name in one trip:
  // admin_users for `sender_type = 'admin_user'`, customers for
  // `sender_type = 'customer'`. `system` messages have no sender and
  // the join simply returns null on both sides — the mapper falls
  // back to a generic label for those. ---
  const messageRows = await db
    .select({
      message: schema.ticketMessages,
      adminName: schema.adminUsers.displayName,
      customerName: schema.customers.displayName,
      customerEmail: schema.customers.email,
    })
    .from(schema.ticketMessages)
    .leftJoin(
      schema.adminUsers,
      and(
        eq(schema.ticketMessages.senderType, 'admin_user'),
        eq(schema.ticketMessages.senderId, schema.adminUsers.id),
      ),
    )
    .leftJoin(
      schema.customers,
      and(
        eq(schema.ticketMessages.senderType, 'customer'),
        eq(schema.ticketMessages.senderId, schema.customers.id),
      ),
    )
    .where(
      and(
        eq(schema.ticketMessages.ticketId, ticketId),
        eq(schema.ticketMessages.isInternal, false),
      ),
    )
    .orderBy(schema.ticketMessages.createdAt);

  return ctx.json({
    ticket: {
      ...mapTicketRow(row.ticket),
      categoryName: row.categoryName ?? 'Uncategorized',
    },
    messages: messageRows.map((r) =>
      mapMessageRow(
        r.message,
        r.adminName ?? r.customerName ?? r.customerEmail ?? null,
      ),
    ),
  });
}

// ---------------------------------------------------------------------------
// handleAddCustomerMessage
// ---------------------------------------------------------------------------

/**
 * POST /api/customer/tickets/[id]/messages
 *
 * Add a customer message to an existing ticket. Verifies ownership,
 * enforces rate limiting (max 10 messages per hour per ticket), and
 * transitions the ticket status from `waiting_customer` to `in_progress`
 * when the customer replies.
 */
export async function handleAddCustomerMessage(
  ctx: CustomerContext,
  ticketId: string,
): Promise<NextResponse> {
  const { customer, db, now } = ctx;

  // --- 0. Validate route param format ---
  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }

  // --- 1. Parse body ---
  let rawBody: unknown;
  try {
    rawBody = await ctx.request.json();
  } catch {
    return ctx.errorJson('invalid_body', 'Request body must be valid JSON.', 400);
  }

  const parsed = customerMessageSchema.safeParse(rawBody);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }

  const { body: messageBody } = parsed.data;

  // --- 2. Verify ticket ownership ---
  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.id, ticketId),
        eq(schema.tickets.creatorId, customer.id),
        eq(schema.tickets.creatorType, 'customer'),
      ),
    )
    .limit(1);

  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // --- 3. Check ticket is not closed or resolved ---
  if (ticket.status === 'closed' || ticket.status === 'resolved') {
    return ctx.errorJson(
      'ticket_closed',
      'This ticket has been resolved or closed. Please open a new ticket if you need further assistance.',
      409,
    );
  }

  // --- 4. Rate limit: conversation-aware (see lib/ticket/rate-limit).
  // Layered guards catch bursts, duplicate-body spam, and runaway
  // one-sided chatter. The first rejection wins so the client surfaces
  // the most actionable error. ---
  const rateCheck = await checkCustomerMessageRate({
    db,
    ticketId,
    customerId: customer.id,
    body: messageBody,
    now,
    ticketCreatedAt: ticket.createdAt,
  });
  if (!rateCheck.ok) {
    return ctx.errorJson(rateCheck.code, rateCheck.message, 429);
  }

  // --- 5. Insert message and update ticket ---
  // Customers may tag admins that have actually responded on this
  // ticket (active participants). Tags of non-participants are
  // dropped silently before insert so a customer cannot use mentions
  // to probe admin existence.
  const rawMentions = parseMentions(messageBody);
  const mentionedIds =
    rawMentions.length > 0
      ? await filterMentionableForCustomer(db, ticketId, rawMentions)
      : [];

  const newMessageId = await db.transaction(async (tx) => {
    const insertedMessage = await tx
      .insert(schema.ticketMessages)
      .values({
        ticketId,
        senderId: customer.id,
        senderType: 'customer',
        body: messageBody,
        isInternal: false,
        createdAt: now,
      })
      .returning({ id: schema.ticketMessages.id });

    const insertedMessageId = insertedMessage[0]?.id;
    if (insertedMessageId === undefined) {
      throw new Error('Customer message insert returned no row');
    }

    if (mentionedIds.length > 0) {
      await tx.insert(schema.ticketMessageMentions).values(
        mentionedIds.map((adminId) => ({
          messageId: insertedMessageId,
          mentionedAdminId: adminId,
          createdAt: now,
        })),
      );
    }

    // Transition from waiting_customer to in_progress when customer replies
    const newStatus =
      ticket.status === 'waiting_customer' ? ('in_progress' as const) : ticket.status;
    await tx
      .update(schema.tickets)
      .set({
        status: newStatus,
        updatedAt: now,
      })
      .where(eq(schema.tickets.id, ticketId));

    // Audit
    const actor = customerActor({ id: customer.id, label: customerLabel(customer) });
    const target = uuidTarget({ kind: 'ticket', id: ticketId, ref: ticket.referenceNumber });
    const auditContext = auditCtxFrom(ctx);

    await writeAudit(tx, {
      action: 'ticket.message_added',
      actor,
      target,
      context: auditContext,
      meta: {
        senderType: 'customer',
        statusBefore: ticket.status,
        statusAfter: newStatus,
        mentionCount: mentionedIds.length,
      },
      ts: now,
    });

    for (const mentionedAdminId of mentionedIds) {
      await writeAudit(tx, {
        action: 'ticket.mention_created',
        actor,
        target,
        context: auditContext,
        meta: {
          messageId: insertedMessageId,
          mentionedAdminId,
          isInternal: false,
        },
        ts: now,
      });
    }

    return insertedMessageId;
  });

  // Mention fan-out takes precedence over the generic customer-reply
  // notification for the tagged admins (they already get an elevated
  // ping). Non-mentioned admins still receive the standard reply
  // notification below.
  if (mentionedIds.length > 0) {
    await notifyAdminTicketMentioned(db, {
      adminUserIds: mentionedIds,
      ticket: {
        ticketId: ticket.id,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildAdminTicketUrl(ticket.id),
      },
      authorName: customerLabel(customer),
      messagePreview: truncateForEmail(messageBody),
      isInternal: false,
      messageId: newMessageId,
    });
  }

  // Notify the assigned admin, or fan out to all active admins if the
  // ticket is unassigned. Tagged admins are filtered out to avoid
  // duplicate pings -- they already received the mention notification.
  const baseRecipients =
    ticket.assignedTo !== null ? [ticket.assignedTo] : await fetchActiveAdminIds(db);
  const mentionedSet = new Set(mentionedIds);
  const adminRecipients = baseRecipients.filter((id) => !mentionedSet.has(id));

  if (adminRecipients.length > 0) {
    await notifyAdminTicketCustomerReply(db, {
      adminUserIds: adminRecipients,
      ticket: {
        ticketId: ticket.id,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildAdminTicketUrl(ticket.id),
      },
      customerLabel: customerLabel(customer),
      replyPreview: truncateForEmail(messageBody),
      messageId: newMessageId,
    });
  }

  return ctx.json({ success: true });
}

// ---------------------------------------------------------------------------
// handleEditCustomerMessage
// ---------------------------------------------------------------------------

/**
 * PATCH /api/customer/tickets/[id]/messages/[messageId]
 *
 * Edit a customer-authored message. The body is the only mutable field;
 * authorship and `is_internal` are immutable.
 *
 * The edit is permitted only while `seen_by_other = false` — i.e. no
 * admin has loaded the ticket since the message was posted. Once any
 * admin view flips the flag, the author is locked out forever (no
 * recovery mechanism by design; the accountability guarantee would
 * evaporate otherwise).
 *
 * Mentions are re-parsed and diffed against the previous set:
 *   - Added mentions get a fresh `ticket_message_mentions` row and an
 *     elevated in-app + email notification.
 *   - Removed mentions have their mention row deleted AND their
 *     unread in-app notification purged so the bell icon doesn't keep
 *     dangling "you were mentioned" pings for a mention that no
 *     longer exists. Read notifications stay — the recipient already
 *     saw the original text, so silently deleting them would hide
 *     history.
 */
export async function handleEditCustomerMessage(
  ctx: CustomerContext,
  ticketId: string,
  messageId: string,
): Promise<NextResponse> {
  const { customer, db, now } = ctx;

  // --- 0. Validate route params ---
  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }
  if (!uuidSchema.safeParse(messageId).success) {
    return invalidUuidResponse(ctx, 'message');
  }

  // --- 1. Parse body ---
  let rawBody: unknown;
  try {
    rawBody = await ctx.request.json();
  } catch {
    return ctx.errorJson('invalid_body', 'Request body must be valid JSON.', 400);
  }

  const parsed = editMessageSchema.safeParse(rawBody);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }

  const { body: newBody } = parsed.data;

  // --- 2. Fetch ticket (ownership-gated) ---
  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.id, ticketId),
        eq(schema.tickets.creatorId, customer.id),
        eq(schema.tickets.creatorType, 'customer'),
      ),
    )
    .limit(1);

  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // --- 3. Fetch message + enforce authorship + seen-lock ---
  const messageRows = await db
    .select()
    .from(schema.ticketMessages)
    .where(
      and(
        eq(schema.ticketMessages.id, messageId),
        eq(schema.ticketMessages.ticketId, ticketId),
      ),
    )
    .limit(1);

  const message = messageRows[0];
  if (message === undefined) {
    return ctx.errorJson('not_found', 'Message not found.', 404);
  }

  if (message.senderType !== 'customer' || message.senderId !== customer.id) {
    // Surface 404 rather than 403 to avoid leaking that the customer
    // is trying to touch a message they don't own.
    return ctx.errorJson('not_found', 'Message not found.', 404);
  }

  if (message.seenByOther) {
    return ctx.errorJson(
      'message_locked',
      'This message has already been seen and can no longer be edited.',
      409,
    );
  }

  // No-op: body identical, skip the transaction and audit noise.
  if (message.body === newBody) {
    return ctx.json({
      message: mapMessageRow({ ...message, body: newBody }),
    });
  }

  // --- 4. Diff mentions against the new body ---
  const oldMentionRows = await db
    .select({ mentionedAdminId: schema.ticketMessageMentions.mentionedAdminId })
    .from(schema.ticketMessageMentions)
    .where(eq(schema.ticketMessageMentions.messageId, messageId));
  const oldMentionSet = new Set(oldMentionRows.map((r) => r.mentionedAdminId));

  const rawNewMentions = parseMentions(newBody);
  const newMentionIds =
    rawNewMentions.length > 0
      ? await filterMentionableForCustomer(db, ticketId, rawNewMentions)
      : [];
  const newMentionSet = new Set(newMentionIds);

  const addedMentions = newMentionIds.filter((id) => !oldMentionSet.has(id));
  const removedMentions = [...oldMentionSet].filter((id) => !newMentionSet.has(id));

  // --- 5. Commit ---
  const updatedRow = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.ticketMessages)
      .set({ body: newBody, editedAt: now })
      .where(eq(schema.ticketMessages.id, messageId))
      .returning();

    if (row === undefined) {
      throw new Error('Message edit returned no row');
    }

    if (removedMentions.length > 0) {
      await tx
        .delete(schema.ticketMessageMentions)
        .where(
          and(
            eq(schema.ticketMessageMentions.messageId, messageId),
            inArray(schema.ticketMessageMentions.mentionedAdminId, removedMentions),
          ),
        );

      // Purge ONLY unread bell-icon notifications for revoked mentions
      // on this ticket. Read notifications stay -- the recipient saw
      // the original and deleting their history would be dishonest.
      const mentionLink = `/admin/tickets/${ticketId}`;
      await tx
        .delete(schema.notifications)
        .where(
          and(
            eq(schema.notifications.type, 'ticket.mentioned'),
            eq(schema.notifications.link, mentionLink),
            isNull(schema.notifications.readAt),
            inArray(schema.notifications.adminUserId, removedMentions),
          ),
        );
    }

    if (addedMentions.length > 0) {
      await tx.insert(schema.ticketMessageMentions).values(
        addedMentions.map((adminId) => ({
          messageId,
          mentionedAdminId: adminId,
          createdAt: now,
        })),
      );
    }

    const actor = customerActor({ id: customer.id, label: customerLabel(customer) });
    const target = uuidTarget({ kind: 'ticket', id: ticketId, ref: ticket.referenceNumber });
    const auditContext = auditCtxFrom(ctx);

    await writeAudit(tx, {
      action: 'ticket.message_edited',
      actor,
      target,
      context: auditContext,
      meta: {
        messageId,
        bodyBefore: message.body,
        bodyAfter: newBody,
        mentionsAdded: addedMentions,
        mentionsRemoved: removedMentions,
      },
      ts: now,
    });

    for (const adminId of removedMentions) {
      await writeAudit(tx, {
        action: 'ticket.mention_revoked',
        actor,
        target,
        context: auditContext,
        meta: { messageId, mentionedAdminId: adminId },
        ts: now,
      });
    }

    for (const adminId of addedMentions) {
      await writeAudit(tx, {
        action: 'ticket.mention_created',
        actor,
        target,
        context: auditContext,
        meta: { messageId, mentionedAdminId: adminId, isInternal: false },
        ts: now,
      });
    }

    return row;
  });

  // Fan-out new mention notifications post-commit so a dispatcher
  // failure never rolls back the edit itself.
  if (addedMentions.length > 0) {
    await notifyAdminTicketMentioned(db, {
      adminUserIds: addedMentions,
      ticket: {
        ticketId: ticket.id,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildAdminTicketUrl(ticket.id),
      },
      authorName: customerLabel(customer),
      messagePreview: truncateForEmail(newBody),
      isInternal: false,
      messageId,
    });
  }

  return ctx.json({ message: mapMessageRow(updatedRow) });
}

// ===========================================================================
// Admin handlers
// ===========================================================================

// ---------------------------------------------------------------------------
// handleListAdminTickets
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/tickets
 *
 * List all tickets with optional filters: status, assignedTo, categoryId,
 * priority. Supports offset-based pagination.
 */
const VALID_LIST_VIEWS = ['inbox', 'invites', 'team', 'all'] as const;
type AdminListView = (typeof VALID_LIST_VIEWS)[number];

export async function handleListAdminTickets(ctx: AdminContext): Promise<NextResponse> {
  const { user, db, request } = ctx;
  const url = new URL(request.url);

  const searchParam = url.searchParams.get('search');
  const statusFilter = url.searchParams.get('status');
  const assignedToFilter = url.searchParams.get('assignedTo');
  const categoryIdFilter = url.searchParams.get('categoryId');
  const priorityFilter = url.searchParams.get('priority');
  const viewParam = url.searchParams.get('view');
  const page = parsePositiveInt(url.searchParams.get('page'), 1, 10000);
  const limit = parsePositiveInt(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = (page - 1) * limit;

  const view: AdminListView =
    viewParam !== null && (VALID_LIST_VIEWS as readonly string[]).includes(viewParam)
      ? (viewParam as AdminListView)
      : 'all';
  if (viewParam !== null && !(VALID_LIST_VIEWS as readonly string[]).includes(viewParam)) {
    return ctx.errorJson(
      'invalid_filter',
      `view must be one of: ${VALID_LIST_VIEWS.join(', ')}.`,
      400,
    );
  }

  // Build conditions. The `all` view preserves the legacy behaviour —
  // superadmin bypasses visibility and sees every ticket, while
  // admin/support are capped at unassigned + participant visible set.
  // The other views are tighter predicates and apply to every role;
  // a superadmin asking for "inbox" wants their own assignee rows,
  // not the global stream.
  const conditions: SQL[] = [];
  if (view === 'all') {
    if (user.role !== 'superadmin') {
      conditions.push(buildTicketVisibilityCondition(user.id));
    }
  } else if (view === 'inbox') {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${schema.ticketParticipants} AS p
      WHERE p.ticket_id = ${schema.tickets.id}
        AND p.admin_user_id = ${user.id}
        AND p.status = 'active'
    )`);
  } else if (view === 'invites') {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${schema.ticketParticipants} AS p
      WHERE p.ticket_id = ${schema.tickets.id}
        AND p.admin_user_id = ${user.id}
        AND p.status = 'pending'
    )`);
  } else {
    // view === 'team' -- tickets whose category the caller belongs to.
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${schema.ticketCategoryAdmins} AS tca
      WHERE tca.category_id = ${schema.tickets.categoryId}
        AND tca.admin_user_id = ${user.id}
    )`);
  }

  // Free-text search against ticket reference, subject, and customer email / name.
  // The JOIN on customers is always present below, so ilike over customer columns
  // is safe even when search isn't provided.
  const search = searchParam?.trim() ?? '';
  if (search.length > 0) {
    const pattern = `%${search}%`;
    const orClause = or(
      ilike(schema.tickets.referenceNumber, pattern),
      ilike(schema.tickets.subject, pattern),
      ilike(schema.customers.email, pattern),
      ilike(schema.customers.displayName, pattern),
    );
    if (orClause !== undefined) {
      conditions.push(orClause);
    }
  }

  const validStatuses = ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as const;
  if (
    statusFilter !== null &&
    statusFilter.length > 0 &&
    (validStatuses as readonly string[]).includes(statusFilter)
  ) {
    conditions.push(eq(schema.tickets.status, statusFilter as (typeof validStatuses)[number]));
  }

  if (assignedToFilter !== null && assignedToFilter.length > 0) {
    if (assignedToFilter === 'unassigned') {
      conditions.push(sql`${schema.tickets.assignedTo} is null`);
    } else if (uuidSchema.safeParse(assignedToFilter).success) {
      conditions.push(eq(schema.tickets.assignedTo, assignedToFilter));
    } else {
      return ctx.errorJson(
        'invalid_filter',
        'assignedTo must be a valid UUID or the literal "unassigned".',
        400,
      );
    }
  }

  if (categoryIdFilter !== null && categoryIdFilter.length > 0) {
    if (!uuidSchema.safeParse(categoryIdFilter).success) {
      return ctx.errorJson('invalid_filter', 'categoryId must be a valid UUID.', 400);
    }
    conditions.push(eq(schema.tickets.categoryId, categoryIdFilter));
  }

  const validPriorities = ['low', 'normal', 'high', 'urgent'] as const;
  if (
    priorityFilter !== null &&
    priorityFilter.length > 0 &&
    (validPriorities as readonly string[]).includes(priorityFilter)
  ) {
    conditions.push(
      eq(schema.tickets.priority, priorityFilter as (typeof validPriorities)[number]),
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Fetch total count — JOIN customers here too so search can filter on
  // customer columns consistently across count and list queries.
  const totalResult = await db
    .select({ value: count() })
    .from(schema.tickets)
    .leftJoin(schema.customers, eq(schema.tickets.creatorId, schema.customers.id))
    .where(whereClause);
  const total = totalResult[0]?.value ?? 0;

  // Fetch page with joins for enriched data. The `viewer` sub-select
  // resolves the caller's relationship to each row in one round-trip,
  // so the UI can render the correct role indicator (assignee /
  // collaborator / pending invite) without a second fetch.
  //
  // `creator_type` can be `customer` OR `firm_user`. Each side lives
  // in a different table, so we LEFT-JOIN both and let the caller
  // pick whichever side filled in. `firms` is joined through
  // `tickets.firm_id` — populated for firm tickets, null for customer
  // tickets — so we never walk `firm_users` twice.
  const rows = await db
    .select({
      ticket: schema.tickets,
      categoryName: schema.ticketCategories.name,
      customerEmail: schema.customers.email,
      customerName: schema.customers.displayName,
      firmUserEmail: schema.firmUsers.email,
      firmName: schema.firms.name,
      assignedToName: schema.adminUsers.displayName,
      viewerParticipantRole: sql<
        'assignee' | 'collaborator' | null
      >`(SELECT p.role FROM ${schema.ticketParticipants} AS p
        WHERE p.ticket_id = ${schema.tickets.id}
          AND p.admin_user_id = ${user.id}
          AND p.status IN ('active', 'pending')
        LIMIT 1)`,
      viewerParticipantStatus: sql<
        'active' | 'pending' | null
      >`(SELECT p.status FROM ${schema.ticketParticipants} AS p
        WHERE p.ticket_id = ${schema.tickets.id}
          AND p.admin_user_id = ${user.id}
          AND p.status IN ('active', 'pending')
        LIMIT 1)`,
    })
    .from(schema.tickets)
    .leftJoin(schema.ticketCategories, eq(schema.tickets.categoryId, schema.ticketCategories.id))
    .leftJoin(schema.customers, eq(schema.tickets.creatorId, schema.customers.id))
    .leftJoin(schema.firmUsers, eq(schema.tickets.creatorId, schema.firmUsers.id))
    .leftJoin(schema.firms, eq(schema.tickets.firmId, schema.firms.id))
    .leftJoin(schema.adminUsers, eq(schema.tickets.assignedTo, schema.adminUsers.id))
    .where(whereClause)
    .orderBy(desc(schema.tickets.createdAt))
    .limit(limit)
    .offset(offset);

  // Pending-invite badge count -- shown on the "Invites" tab. This is
  // the caller's own pending count, independent of the current view's
  // filters, so the badge stays accurate when the caller is browsing
  // any other tab.
  const pendingInvitesResult = await db
    .select({ value: count() })
    .from(schema.ticketParticipants)
    .where(
      and(
        eq(schema.ticketParticipants.adminUserId, user.id),
        eq(schema.ticketParticipants.status, 'pending'),
      ),
    );
  const pendingInvitesCount = pendingInvitesResult[0]?.value ?? 0;

  return ctx.json({
    tickets: rows.map((row) => {
      // Surface a single "creator" block the UI can render without
      // caring which side authored the ticket.
      const creator =
        row.ticket.creatorType === 'firm_user'
          ? {
              kind: 'firm_user' as const,
              label: row.firmName ?? 'Unknown firm',
              email: row.firmUserEmail ?? 'unknown',
            }
          : {
              kind: 'customer' as const,
              label: row.customerName ?? row.customerEmail ?? 'Unknown customer',
              email: row.customerEmail ?? 'unknown',
            };

      return {
        ...mapTicketRow(row.ticket),
        categoryName: row.categoryName ?? 'Uncategorized',
        customerEmail: creator.email,
        customerName: creator.kind === 'customer' ? (row.customerName ?? null) : creator.label,
        creator,
        assignedToName: row.assignedToName ?? null,
        viewerParticipantRole: row.viewerParticipantRole,
        viewerParticipantStatus: row.viewerParticipantStatus,
      };
    }),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    view,
    pendingInvitesCount,
  });
}

// ---------------------------------------------------------------------------
// handleGetAdminTicket
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/tickets/[id]
 *
 * Returns a single ticket with all messages (including internal notes).
 */
export async function handleGetAdminTicket(
  ctx: AdminContext,
  ticketId: string,
): Promise<NextResponse> {
  const { user, db } = ctx;

  // --- 0. Validate route param format ---
  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }

  const ticketRows = await db
    .select({
      ticket: schema.tickets,
      categoryName: schema.ticketCategories.name,
      customerEmail: schema.customers.email,
      customerName: schema.customers.displayName,
      firmUserEmail: schema.firmUsers.email,
      firmName: schema.firms.name,
      firmTier: schema.firms.tier,
      assignedToName: schema.adminUsers.displayName,
    })
    .from(schema.tickets)
    .leftJoin(schema.ticketCategories, eq(schema.tickets.categoryId, schema.ticketCategories.id))
    .leftJoin(schema.customers, eq(schema.tickets.creatorId, schema.customers.id))
    .leftJoin(schema.firmUsers, eq(schema.tickets.creatorId, schema.firmUsers.id))
    .leftJoin(schema.firms, eq(schema.tickets.firmId, schema.firms.id))
    .leftJoin(schema.adminUsers, eq(schema.tickets.assignedTo, schema.adminUsers.id))
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);

  const row = ticketRows[0];
  if (row === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // --- Visibility gate. A caller that cannot read the ticket receives
  // 404 -- NOT 403 -- so we don't leak ticket existence across teams.
  const participant = await getParticipantRef(db, ticketId, user.id);
  const ticketCtx: TicketPermissionContext = {
    assignedTo: row.ticket.assignedTo,
    status: row.ticket.status,
  };
  if (!canPerformTicketAction(user, participant, 'read', ticketCtx)) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // Pending invitees see the ticket so they have context to
  // accept/decline, but internal notes must stay hidden from them --
  // they have not joined the ticket yet. Active participants and
  // superadmins see the full thread.
  const hideInternalNotes =
    user.role !== 'superadmin' && participant !== null && participant.status === 'pending';

  // Mark-as-seen: before reading the thread, flip `seen_by_other` to
  // true for every message this viewer is allowed to see that wasn't
  // authored by them. The edit-lock derives from this flag, so the
  // UPDATE must precede the SELECT to avoid a brief window where the
  // author refreshes, sees their message still unlocked, and races
  // someone else's concurrent view.
  //
  // Internal notes are excluded for pending invitees — they cannot
  // see those rows, so they must not be the ones that lock them.
  const seenConditions: SQL[] = [
    eq(schema.ticketMessages.ticketId, ticketId),
    eq(schema.ticketMessages.seenByOther, false),
    or(
      sql`${schema.ticketMessages.senderId} != ${user.id}`,
      sql`${schema.ticketMessages.senderType} != 'admin_user'`,
    ) as SQL,
  ];
  if (hideInternalNotes) {
    seenConditions.push(eq(schema.ticketMessages.isInternal, false));
  }
  await db
    .update(schema.ticketMessages)
    .set({ seenByOther: true })
    .where(and(...seenConditions));

  const messageConditions: SQL[] = [eq(schema.ticketMessages.ticketId, ticketId)];
  if (hideInternalNotes) {
    messageConditions.push(eq(schema.ticketMessages.isInternal, false));
  }
  // Same LEFT-JOIN enrichment as the customer GET: pull the sender's
  // display name in one round-trip so the thread UI can drop the
  // generic "Admin" / "Customer" placeholder labels in favour of the
  // actual name. Admin may be viewing a customer ticket OR a firm
  // ticket, so we join all three sender tables and let the mapper
  // pick whichever row filled in.
  const messageRows = await db
    .select({
      message: schema.ticketMessages,
      adminName: schema.adminUsers.displayName,
      customerName: schema.customers.displayName,
      customerEmail: schema.customers.email,
      firmUserEmail: schema.firmUsers.email,
    })
    .from(schema.ticketMessages)
    .leftJoin(
      schema.adminUsers,
      and(
        eq(schema.ticketMessages.senderType, 'admin_user'),
        eq(schema.ticketMessages.senderId, schema.adminUsers.id),
      ),
    )
    .leftJoin(
      schema.customers,
      and(
        eq(schema.ticketMessages.senderType, 'customer'),
        eq(schema.ticketMessages.senderId, schema.customers.id),
      ),
    )
    .leftJoin(
      schema.firmUsers,
      and(
        eq(schema.ticketMessages.senderType, 'firm_user'),
        eq(schema.ticketMessages.senderId, schema.firmUsers.id),
      ),
    )
    .where(and(...messageConditions))
    .orderBy(schema.ticketMessages.createdAt);

  const participants = await listTicketParticipants(db, ticketId);

  // Surface the caller's computed capabilities so the UI can hide /
  // disable controls rather than relying on the client to re-implement
  // the matrix. This is advisory only -- the server still rechecks
  // every mutation.
  // Self-claim (aka "Assign to me") is a special transition that
  // bypasses the `reassign` matrix entry: an unassigned ticket in the
  // pickup pool can be grabbed by any non-pending admin/support with
  // read access. Superadmins also satisfy all predicates. The flag is
  // surfaced separately from `reassign` because the UI shows a
  // dedicated "Assign to me" button rather than the Select dropdown
  // for this case.
  const isTerminal =
    row.ticket.status === 'resolved' || row.ticket.status === 'closed';
  const isPending = participant !== null && participant.status === 'pending';
  const isActiveAssignee =
    participant !== null && participant.status === 'active' && participant.role === 'assignee';
  const canSelfClaim =
    row.ticket.assignedTo === null && !isTerminal && !isPending && !isActiveAssignee;

  const capabilities = {
    reply: canPerformTicketAction(user, participant, 'reply', ticketCtx),
    internalNote: canPerformTicketAction(user, participant, 'internal_note', ticketCtx),
    changeStatus: canPerformTicketAction(user, participant, 'change_status', ticketCtx),
    changePriority: canPerformTicketAction(user, participant, 'change_priority', ticketCtx),
    reassign: canPerformTicketAction(user, participant, 'reassign', ticketCtx),
    invite: canPerformTicketAction(user, participant, 'invite_participant', ticketCtx),
    addParticipant: canPerformTicketAction(user, participant, 'add_participant', ticketCtx),
    removeParticipant: canPerformTicketAction(user, participant, 'remove_participant', ticketCtx),
    takeOver: canPerformTicketAction(user, participant, 'take_over', ticketCtx),
    selfClaim: canSelfClaim,
  } as const;

  // Build a single `creator` block the UI can render without
  // branching on creator_type. For firm tickets the label is the
  // firm name and we also expose the tier so the admin sidebar can
  // show a tier badge for prioritisation.
  const creator =
    row.ticket.creatorType === 'firm_user'
      ? {
          kind: 'firm_user' as const,
          label: row.firmName ?? 'Unknown firm',
          email: row.firmUserEmail ?? 'unknown',
          firmTier: row.firmTier ?? null,
        }
      : {
          kind: 'customer' as const,
          label: row.customerName ?? row.customerEmail ?? 'Unknown customer',
          email: row.customerEmail ?? 'unknown',
          firmTier: null as null,
        };

  // AUD-X-THREAT-002 fix: admin reading a ticket sees the customer's
  // email + display name + message body (potentially containing PII
  // the customer pasted in a complaint). Audit the read for the same
  // insider-trail reasons as `admin_user.customer_viewed`.
  await writeAudit(db, {
    action: 'admin_user.ticket_viewed',
    actor: adminUserActor({ id: user.id, label: user.email }),
    target: uuidTarget({ kind: 'ticket', id: ticketId }),
    context: buildAuditRequestContext({
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId,
    }),
    meta: {},
    ts: ctx.now,
  });

  return ctx.json({
    ticket: {
      ...mapTicketRow(row.ticket),
      categoryName: row.categoryName ?? 'Uncategorized',
      customerEmail: creator.email,
      customerName: creator.kind === 'customer' ? (row.customerName ?? null) : creator.label,
      creator,
      assignedToName: row.assignedToName ?? null,
    },
    messages: messageRows.map((r) =>
      mapMessageRow(
        r.message,
        r.adminName ?? r.customerName ?? r.customerEmail ?? r.firmUserEmail ?? null,
      ),
    ),
    participants,
    viewer: {
      role: user.role,
      participant: participant ?? null,
      capabilities,
    },
  });
}

// ---------------------------------------------------------------------------
// handleUpdateAdminTicket
// ---------------------------------------------------------------------------

/**
 * PATCH /api/admin/tickets/[id]
 *
 * Update ticket fields: status, assignedTo, priority. Sets resolvedAt /
 * closedAt timestamps automatically based on status transitions. Writes
 * audit entries for each change.
 */
export async function handleUpdateAdminTicket(
  ctx: AdminContext,
  ticketId: string,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  // --- 0. Validate route param format ---
  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }

  // --- 1. Parse body ---
  let rawBody: unknown;
  try {
    rawBody = await ctx.request.json();
  } catch {
    return ctx.errorJson('invalid_body', 'Request body must be valid JSON.', 400);
  }

  const parsed = adminUpdateTicketSchema.safeParse(rawBody);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }

  const {
    status: newStatus,
    priority: newPriority,
    assignedTo: newAssignedTo,
    oldAssigneeStaysAsCollab,
    reassignReason,
  } = parsed.data;

  // --- 2. Fetch existing ticket ---
  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);

  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // --- 2a. Visibility + authorization gate ---------------------------------
  // The participant row + role + ticket state feed the permission matrix.
  // A caller who cannot even *see* the ticket receives a 404 (not 403) so
  // we don't leak existence across teams. Authorized mutations are scoped
  // per-field below.
  const participant = await getParticipantRef(db, ticketId, user.id);
  const ticketCtx: TicketPermissionContext = {
    assignedTo: ticket.assignedTo,
    status: ticket.status,
  };

  if (!canPerformTicketAction(user, participant, 'read', ticketCtx)) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // Determine which field-level actions the caller is attempting. Skip
  // no-op updates (e.g. PATCH with status unchanged) so a permission
  // check doesn't 403 on a redundant payload.
  const isStatusChange = newStatus !== undefined && newStatus !== ticket.status;
  const isPriorityChange = newPriority !== undefined && newPriority !== ticket.priority;
  const isAssignmentChange =
    newAssignedTo !== undefined && newAssignedTo !== ticket.assignedTo;

  // Transition classification -- used for authorization, audit action
  // selection, and participant-row bookkeeping below. Exactly one of
  // {isSelfClaim, isClaimFromPool, isReassignToOther, isUnassign} is
  // true on any assignment change; all four are false on a no-op.
  //
  //   * self-claim         : null -> user.id
  //   * claim-from-pool    : null -> other admin   (admin claiming for someone)
  //   * reassign-to-other  : concreteA -> concreteB
  //   * unassign           : concrete -> null
  const isSelfClaim =
    isAssignmentChange && ticket.assignedTo === null && newAssignedTo === user.id;
  const isClaimFromPool =
    isAssignmentChange &&
    ticket.assignedTo === null &&
    newAssignedTo !== null &&
    newAssignedTo !== user.id;
  const isReassignToOther =
    isAssignmentChange && ticket.assignedTo !== null && newAssignedTo !== null;
  const isUnassign = isAssignmentChange && newAssignedTo === null;

  // --- Reopen cascade ------------------------------------------------------
  // When a ticket returns from a terminal state (resolved/closed) to an
  // active one (open/in_progress) AND the caller does not specify an
  // explicit assignee AND the ticket has no current assignee, we walk the
  // participant graph to pick a new owner. The locked priority order is:
  //
  //   1. the original assignee (if still an active admin, i.e. not locked)
  //   2. the lowest-ranked active participant (ROLE_RANK ASC,
  //      invitedAt ASC as FIFO tie-break -- oldest participant wins)
  //   3. no candidate -> ticket stays unassigned and every active admin
  //      gets a needs-pickup notification
  //
  // The cascade runs inside the same transaction as the main update so
  // the participant graph, `tickets.assigned_to`, and audit log are all
  // atomic. We reuse the existing `ticket.assigned` / `ticket.unassigned`
  // audit actions and stamp `{cascade: true, strategy, reopenFrom}` in
  // the meta so the trail is still discoverable.
  const isReopen =
    isStatusChange &&
    (ticket.status === 'resolved' || ticket.status === 'closed') &&
    (newStatus === 'open' || newStatus === 'in_progress');

  const shouldCascade =
    isReopen && newAssignedTo === undefined && ticket.assignedTo === null;

  if (
    isStatusChange &&
    !canPerformTicketAction(user, participant, 'change_status', ticketCtx)
  ) {
    return ctx.errorJson(
      'forbidden',
      'Only the ticket assignee or a superadmin can change ticket status.',
      403,
    );
  }
  if (
    isPriorityChange &&
    !canPerformTicketAction(user, participant, 'change_priority', ticketCtx)
  ) {
    return ctx.errorJson(
      'forbidden',
      'Only the ticket assignee or a superadmin can change ticket priority.',
      403,
    );
  }
  if (
    isAssignmentChange &&
    !isSelfClaim &&
    !canPerformTicketAction(user, participant, 'reassign', ticketCtx)
  ) {
    return ctx.errorJson(
      'forbidden',
      'Only the ticket assignee or a superadmin can reassign the ticket.',
      403,
    );
  }

  // Self-claim has its own eligibility floor that the matrix does not
  // cover: pending invitees must accept before taking the ticket
  // (otherwise they'd side-step the accept/decline workflow), and
  // closed / resolved tickets are immutable ownership-wise (reopen
  // first, then claim). Superadmin satisfies both guards by design.
  if (isSelfClaim && participant !== null && participant.status === 'pending') {
    return ctx.errorJson(
      'forbidden',
      'Accept the invitation before claiming this ticket.',
      403,
    );
  }
  if (
    isSelfClaim &&
    (ticket.status === 'resolved' || ticket.status === 'closed') &&
    user.role !== 'superadmin'
  ) {
    return ctx.errorJson(
      'forbidden',
      'Reopen the ticket before claiming it.',
      403,
    );
  }

  // --- 2b. Verify new assignee exists + fetch role for hierarchy check.
  // Null clears the assignment; undefined leaves it unchanged. Any other
  // value must point to a real admin user so we never store dangling FKs.
  // We pull `role` too so we can enforce "cannot reassign to someone
  // ranked above you" without a second round-trip.
  let newAssigneeRole: AdminRole | null = null;
  if (newAssignedTo !== undefined && newAssignedTo !== null) {
    const assigneeRows = await db
      .select({ id: schema.adminUsers.id, role: schema.adminUsers.role })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, newAssignedTo))
      .limit(1);

    const assigneeRow = assigneeRows[0];
    if (assigneeRow === undefined) {
      return ctx.errorJson('invalid_assignee', 'Assigned admin user not found.', 400);
    }
    newAssigneeRole = assigneeRow.role;
  }

  // --- 2c. Hierarchy gate -------------------------------------------------
  // Only the superadmin take-over endpoint can move a ticket to an admin
  // ranked strictly above the caller. Here a regular assignee can reassign
  // to peers or juniors; self-claim is always allowed (you're reassigning
  // to yourself). `atLeast(caller, target)` holds when caller >= target,
  // which is the allowed direction (same rank or downgrade).
  if (
    (isReassignToOther || isClaimFromPool) &&
    user.role !== 'superadmin' &&
    newAssigneeRole !== null &&
    !atLeast(user.role, newAssigneeRole)
  ) {
    return ctx.errorJson(
      'forbidden',
      'Cannot reassign the ticket to an admin ranked above you.',
      403,
    );
  }

  // --- 2d. Explanation required for active-assignment transfers ----------
  // Reassigning an already-owned ticket to another admin costs the
  // outgoing assignee their ownership; the explanation is surfaced in
  // the participant row and the audit log. Self-claim, claim-from-pool,
  // and unassign don't need a reason.
  if (
    isReassignToOther &&
    (reassignReason === undefined || reassignReason.length === 0)
  ) {
    return ctx.errorJson(
      'validation_error',
      'Please provide a short explanation for the reassignment.',
      400,
    );
  }

  // --- 3. Build update set ---
  const updates: Record<string, unknown> = { updatedAt: now };

  // Apply status change
  if (newStatus !== undefined) {
    updates['status'] = newStatus;

    // Set resolvedAt when transitioning to resolved
    if (newStatus === 'resolved' && ticket.status !== 'resolved') {
      updates['resolvedAt'] = now;
    }
    // Set closedAt when transitioning to closed
    if (newStatus === 'closed' && ticket.status !== 'closed') {
      updates['closedAt'] = now;
    }
    // Clear resolvedAt if reopening
    if (
      (newStatus === 'open' || newStatus === 'in_progress') &&
      (ticket.status === 'resolved' || ticket.status === 'closed')
    ) {
      updates['resolvedAt'] = null;
      updates['closedAt'] = null;
    }
  }

  // Apply assignedTo change (null is a valid value meaning "unassign").
  if (newAssignedTo !== undefined) {
    updates['assignedTo'] = newAssignedTo;
  }

  // Apply priority change
  if (newPriority !== undefined) {
    updates['priority'] = newPriority;
  }

  // --- 4. Apply update + sync participants in a transaction ----------------
  // The `ticket_participants` table is the source of truth for multi-admin
  // involvement; `tickets.assigned_to` is kept in sync so the existing
  // list/filter queries keep working. Doing both in one transaction
  // guarantees the two never diverge.
  type CascadeStrategy = 'original_assignee' | 'lowest_tier' | 'unassigned';

  const { updatedRow, cascadeStrategy, cascadeAssigneeId } = await db.transaction(async (tx) => {
    // --- Reopen cascade: pick a new assignee from the participant graph.
    // Runs BEFORE the main UPDATE so the cascade-chosen id can be folded
    // into `updates.assignedTo`, keeping `tickets.assigned_to` in sync
    // with the participant row we'll UPSERT below.
    let cascadeStrategy: CascadeStrategy | null = null;
    let cascadeAssigneeId: string | null = null;

    if (shouldCascade) {
      // Step 1 -- is there still an active assignee row? Only possible
      // through a data-consistency edge case (participant row stayed
      // `assignee`/`active` while `tickets.assigned_to` was zeroed),
      // but defensive: if found and the admin is not locked, use them.
      const originalRows = await tx
        .select({
          adminUserId: schema.ticketParticipants.adminUserId,
          adminLockedAt: schema.adminUsers.lockedAt,
        })
        .from(schema.ticketParticipants)
        .innerJoin(
          schema.adminUsers,
          eq(schema.ticketParticipants.adminUserId, schema.adminUsers.id),
        )
        .where(
          and(
            eq(schema.ticketParticipants.ticketId, ticketId),
            eq(schema.ticketParticipants.role, 'assignee'),
            eq(schema.ticketParticipants.status, 'active'),
          ),
        )
        .orderBy(desc(schema.ticketParticipants.invitedAt))
        .limit(1);

      const original = originalRows[0];
      if (original !== undefined && original.adminLockedAt === null) {
        cascadeStrategy = 'original_assignee';
        cascadeAssigneeId = original.adminUserId;
      } else {
        // Step 2 -- lowest-ranked active collaborator among admins
        // that are not locked out. ROLE_RANK ASC (support < admin <
        // superadmin), invitedAt ASC (oldest participant first) as
        // the FIFO tie-break. We fetch candidates and sort in JS so
        // we can reuse the shared ROLE_RANK map without recreating
        // it as a SQL CASE expression.
        const candidateRows = await tx
          .select({
            adminUserId: schema.ticketParticipants.adminUserId,
            adminRole: schema.adminUsers.role,
            invitedAt: schema.ticketParticipants.invitedAt,
          })
          .from(schema.ticketParticipants)
          .innerJoin(
            schema.adminUsers,
            eq(schema.ticketParticipants.adminUserId, schema.adminUsers.id),
          )
          .where(
            and(
              eq(schema.ticketParticipants.ticketId, ticketId),
              eq(schema.ticketParticipants.status, 'active'),
              isNull(schema.adminUsers.lockedAt),
            ),
          );

        if (candidateRows.length > 0) {
          const sorted = [...candidateRows].sort((a, b) => {
            const rankDelta = ROLE_RANK[a.adminRole] - ROLE_RANK[b.adminRole];
            if (rankDelta !== 0) return rankDelta;
            return a.invitedAt.getTime() - b.invitedAt.getTime();
          });
          const picked = sorted[0];
          if (picked !== undefined) {
            cascadeStrategy = 'lowest_tier';
            cascadeAssigneeId = picked.adminUserId;
          }
        }

        if (cascadeAssigneeId === null) {
          cascadeStrategy = 'unassigned';
        }
      }

      // Fold cascade-picked assignee into the update set so the
      // ticket row and the participant graph commit in lock-step.
      if (cascadeAssigneeId !== null) {
        updates['assignedTo'] = cascadeAssigneeId;
      }
    }

    const updatedRows = await tx
      .update(schema.tickets)
      .set(updates)
      .where(eq(schema.tickets.id, ticketId))
      .returning();

    const updatedRow = updatedRows[0];
    if (updatedRow === undefined) {
      throw new Error('Ticket update returned no row');
    }

    if (isAssignmentChange) {
      // Handle the outgoing assignee's participant row. Two branches:
      //
      //   1. Stay-as-collab (default on reassign): demote from
      //      `assignee` to `collaborator`, keep active, record the
      //      reassignment explanation. Preserves context on the ticket
      //      without forcing the previous owner off. Only applies to
      //      concrete-to-concrete reassign.
      //   2. Otherwise (unassign, or explicit stay=false): mark the
      //      row `removed` -- audit history stays, visibility drops.
      //
      // We also clear the assignee partial-unique-index by moving the
      // old row OFF `(role=assignee, status=active)` before the new
      // assignee lands on the same key below.
      const keepOldAsCollab = isReassignToOther && oldAssigneeStaysAsCollab !== false;

      if (ticket.assignedTo !== null) {
        if (keepOldAsCollab) {
          await tx
            .update(schema.ticketParticipants)
            .set({
              role: 'collaborator',
              status: 'active',
              transferReason: reassignReason ?? null,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.ticketParticipants.ticketId, ticketId),
                eq(schema.ticketParticipants.adminUserId, ticket.assignedTo),
                eq(schema.ticketParticipants.role, 'assignee'),
                eq(schema.ticketParticipants.status, 'active'),
              ),
            );
        } else {
          await tx
            .update(schema.ticketParticipants)
            .set({
              status: 'removed',
              removedAt: now,
              transferReason: reassignReason ?? null,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.ticketParticipants.ticketId, ticketId),
                eq(schema.ticketParticipants.adminUserId, ticket.assignedTo),
                eq(schema.ticketParticipants.role, 'assignee'),
                eq(schema.ticketParticipants.status, 'active'),
              ),
            );
        }
      }

      // Promote (or revive) the new assignee row. UPSERT on the
      // `(ticket_id, admin_user_id)` unique key so a previously-declined
      // or removed row is reused rather than causing a constraint
      // violation. The partial unique index on active assignees also
      // relies on the old row no longer being `(assignee, active)`
      // (handled above). We also clear any pending-invite bookkeeping
      // (`expiresAt`, stale `removedAt`) so a revival starts clean.
      if (newAssignedTo !== null) {
        await tx
          .insert(schema.ticketParticipants)
          .values({
            ticketId,
            adminUserId: newAssignedTo,
            role: 'assignee',
            status: 'active',
            invitedBy: user.id,
            invitedAt: now,
            respondedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              schema.ticketParticipants.ticketId,
              schema.ticketParticipants.adminUserId,
            ],
            set: {
              role: 'assignee',
              status: 'active',
              invitedBy: user.id,
              invitedAt: now,
              respondedAt: now,
              removedAt: null,
              expiresAt: null,
              updatedAt: now,
            },
          });
      }
    }

    // Cascade-picked assignee: sync the participant row the same way a
    // normal self-claim would. UPSERT on `(ticket_id, admin_user_id)`
    // so a cascade target that was previously a collaborator gets
    // promoted in place rather than inserted as a duplicate. We clear
    // `expiresAt` and `removedAt` so a revival starts clean.
    if (shouldCascade && cascadeAssigneeId !== null) {
      await tx
        .insert(schema.ticketParticipants)
        .values({
          ticketId,
          adminUserId: cascadeAssigneeId,
          role: 'assignee',
          status: 'active',
          invitedBy: user.id,
          invitedAt: now,
          respondedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.ticketParticipants.ticketId,
            schema.ticketParticipants.adminUserId,
          ],
          set: {
            role: 'assignee',
            status: 'active',
            invitedBy: user.id,
            invitedAt: now,
            respondedAt: now,
            removedAt: null,
            expiresAt: null,
            updatedAt: now,
          },
        });
    }

    // --- Audit inside the transaction so state + history commit atomically.
    const actor = adminUserActor({ id: user.id, label: user.email });
    const target = uuidTarget({ kind: 'ticket', id: ticketId, ref: ticket.referenceNumber });
    const auditContext = auditCtxFrom(ctx);

    if (isStatusChange) {
      const statusAction =
        newStatus === 'resolved'
          ? ('ticket.resolved' as const)
          : newStatus === 'closed'
            ? ('ticket.closed' as const)
            : ('ticket.status_changed' as const);

      await writeAudit(tx, {
        action: statusAction,
        actor,
        target,
        context: auditContext,
        meta: {
          statusBefore: ticket.status,
          statusAfter: newStatus,
        },
        ts: now,
      });
    }

    if (isAssignmentChange) {
      // Three distinct audit actions cover the transition:
      //   * unassigned         : assignedTo was set, now null
      //   * assignee_transferred : concrete -> concrete
      //   * assigned           : null -> concrete (self-claim or claim-from-pool)
      const assignAction = isUnassign
        ? ('ticket.unassigned' as const)
        : isReassignToOther
          ? ('ticket.assignee_transferred' as const)
          : ('ticket.assigned' as const);

      await writeAudit(tx, {
        action: assignAction,
        actor,
        target,
        context: auditContext,
        meta: {
          assignedToBefore: ticket.assignedTo,
          assignedToAfter: newAssignedTo,
          selfClaim: isSelfClaim,
          ...(isReassignToOther
            ? {
                oldAssigneeStaysAsCollab: oldAssigneeStaysAsCollab !== false,
                reassignReason: reassignReason ?? null,
              }
            : {}),
        },
        ts: now,
      });
    }

    // Cascade audit -- only emitted when the cascade actually picked a
    // new assignee. The "no candidates, stays unassigned" branch does
    // not produce an assignment audit (nothing changed on that axis);
    // the status-change audit above already records the reopen.
    if (shouldCascade && cascadeAssigneeId !== null) {
      await writeAudit(tx, {
        action: 'ticket.assigned',
        actor,
        target,
        context: auditContext,
        meta: {
          assignedToBefore: null,
          assignedToAfter: cascadeAssigneeId,
          selfClaim: cascadeAssigneeId === user.id,
          cascade: true,
          strategy: cascadeStrategy,
          reopenFrom: ticket.status,
        },
        ts: now,
      });
    }

    return { updatedRow, cascadeStrategy, cascadeAssigneeId };
  });

  // --- 6. Notifications (post-commit, dispatcher-gated) ---

  // Status changed → notify the ticket creator (customer only; firm-created
  // tickets flow through a different notification path we do not own here).
  if (newStatus !== undefined && newStatus !== ticket.status && ticket.creatorType === 'customer') {
    await notifyCustomerTicketStatusChange(db, {
      customerId: ticket.creatorId,
      ticket: {
        ticketId,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildCustomerTicketUrl(ticketId),
      },
      status: newStatus,
    });
  }

  // Newly assigned admin → personal notification. Self-assignment is
  // silent since the admin already knows they took the ticket.
  if (
    newAssignedTo !== undefined &&
    newAssignedTo !== null &&
    newAssignedTo !== ticket.assignedTo &&
    newAssignedTo !== user.id
  ) {
    await notifyAdminTicketAssigned(db, {
      adminUserId: newAssignedTo,
      ticket: {
        ticketId,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildAdminTicketUrl(ticketId),
      },
      assignedByName: user.displayName ?? user.email,
    });
  }

  // Unassign → broad fan-out so the pickup pool doesn't go stale. The
  // caller already knows (they did it), so filter themselves out.
  if (isUnassign) {
    const adminIds = await fetchActiveAdminIds(db);
    const recipients = adminIds.filter((id) => id !== user.id);
    if (recipients.length > 0) {
      await notifyAdminTicketNeedsPickup(db, {
        adminUserIds: recipients,
        ticket: {
          ticketId,
          referenceNumber: ticket.referenceNumber,
          subject: ticket.subject,
          ticketUrl: buildAdminTicketUrl(ticketId),
        },
        reason: `Unassigned by ${user.displayName ?? user.email}`,
      });
    }
  }

  // Reopen cascade → dispatch the notifications the cascade strategy
  // implies. When a candidate was picked we notify them exactly once
  // (skipping the caller themselves, who already knows). When no
  // candidate was found we fan out a needs-pickup notification to the
  // entire active admin pool so the reopened ticket does not go stale.
  if (cascadeStrategy !== null) {
    if (cascadeAssigneeId !== null && cascadeAssigneeId !== user.id) {
      await notifyAdminTicketAssigned(db, {
        adminUserId: cascadeAssigneeId,
        ticket: {
          ticketId,
          referenceNumber: ticket.referenceNumber,
          subject: ticket.subject,
          ticketUrl: buildAdminTicketUrl(ticketId),
        },
        assignedByName: user.displayName ?? user.email,
      });
    } else if (cascadeStrategy === 'unassigned') {
      const adminIds = await fetchActiveAdminIds(db);
      const recipients = adminIds.filter((id) => id !== user.id);
      if (recipients.length > 0) {
        await notifyAdminTicketNeedsPickup(db, {
          adminUserIds: recipients,
          ticket: {
            ticketId,
            referenceNumber: ticket.referenceNumber,
            subject: ticket.subject,
            ticketUrl: buildAdminTicketUrl(ticketId),
          },
          reason: `Ticket reopened with no available participants`,
        });
      }
    }
  }

  return ctx.json({
    ticket: mapTicketRow(updatedRow),
  });
}

// ---------------------------------------------------------------------------
// handleInviteParticipant
// ---------------------------------------------------------------------------

/**
 * Invite another admin to collaborate on a ticket, or direct-add a lower-
 * ranked admin. The mode is chosen by hierarchy:
 *
 *   * caller -> peer (same rank) : pending invite, 1-day expiry, recipient
 *     must accept/decline to become active.
 *   * caller -> junior (strict)  : direct-add as active collaborator;
 *     the junior cannot decline (hierarchical override).
 *   * superadmin -> anyone       : direct-add.
 *
 * Non-superadmins may NOT invite admins ranked above them. The superadmin
 * take-over endpoint is the escape hatch for higher-tier intervention.
 *
 * Precondition: the caller is the active assignee or a superadmin
 * (enforced via `canPerformTicketAction('invite_participant')`).
 */
export async function handleInviteParticipant(
  ctx: AdminContext,
  ticketId: string,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }

  let rawBody: unknown;
  try {
    rawBody = await ctx.request.json();
  } catch {
    return ctx.errorJson('invalid_body', 'Request body must be valid JSON.', 400);
  }

  const parsed = ticketInviteParticipantSchema.safeParse(rawBody);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }

  const { adminUserId: targetId, message: inviteMessage } = parsed.data;

  if (targetId === user.id) {
    return ctx.errorJson('invalid_target', 'You cannot invite yourself.', 400);
  }

  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);
  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // Visibility + authorization. 404 masks "exists but invisible"; 403
  // is reserved for "you see it but can't invite people".
  const participant = await getParticipantRef(db, ticketId, user.id);
  const ticketCtx: TicketPermissionContext = {
    assignedTo: ticket.assignedTo,
    status: ticket.status,
  };

  if (!canPerformTicketAction(user, participant, 'read', ticketCtx)) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }
  if (!canPerformTicketAction(user, participant, 'invite_participant', ticketCtx)) {
    return ctx.errorJson(
      'forbidden',
      'Only the ticket assignee or a superadmin can invite participants.',
      403,
    );
  }

  // Target admin exists + role for hierarchy decision.
  const targetRows = await db
    .select({ id: schema.adminUsers.id, role: schema.adminUsers.role })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, targetId))
    .limit(1);
  const targetAdmin = targetRows[0];
  if (targetAdmin === undefined) {
    return ctx.errorJson('invalid_target', 'Target admin user not found.', 400);
  }

  // Non-superadmin caller cannot invite upward in the hierarchy.
  if (user.role !== 'superadmin' && outranks(targetAdmin.role, user.role)) {
    return ctx.errorJson(
      'forbidden',
      'You cannot invite an admin ranked above you.',
      403,
    );
  }

  // Mode: superadmin always direct-adds; peers get a pending invite;
  // strict juniors are direct-added without a decline right.
  const isDirectAdd =
    user.role === 'superadmin' || outranks(user.role, targetAdmin.role);
  const inviteExpiresAt = new Date(now.getTime() + INVITE_EXPIRY_MS);

  // Conflict detection on the existing participant row (if any). `declined`
  // and `removed` rows are eligible for revival via the upsert below.
  const existingRows = await db
    .select({
      role: schema.ticketParticipants.role,
      status: schema.ticketParticipants.status,
    })
    .from(schema.ticketParticipants)
    .where(
      and(
        eq(schema.ticketParticipants.ticketId, ticketId),
        eq(schema.ticketParticipants.adminUserId, targetId),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (existing !== undefined) {
    if (existing.status === 'active') {
      return ctx.errorJson(
        'already_participant',
        'This admin is already an active participant on the ticket.',
        409,
      );
    }
    if (existing.status === 'pending') {
      return ctx.errorJson(
        'invite_pending',
        'There is already a pending invite for this admin.',
        409,
      );
    }
  }

  // Commit: upsert participant + audit in one transaction.
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.ticketParticipants)
      .values({
        ticketId,
        adminUserId: targetId,
        role: 'collaborator',
        status: isDirectAdd ? 'active' : 'pending',
        invitedBy: user.id,
        invitedAt: now,
        respondedAt: isDirectAdd ? now : null,
        expiresAt: isDirectAdd ? null : inviteExpiresAt,
        removedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.ticketParticipants.ticketId,
          schema.ticketParticipants.adminUserId,
        ],
        set: {
          role: 'collaborator',
          status: isDirectAdd ? 'active' : 'pending',
          invitedBy: user.id,
          invitedAt: now,
          respondedAt: isDirectAdd ? now : null,
          expiresAt: isDirectAdd ? null : inviteExpiresAt,
          removedAt: null,
          transferReason: null,
          updatedAt: now,
        },
      });

    const actor = adminUserActor({ id: user.id, label: user.email });
    const target = uuidTarget({
      kind: 'ticket',
      id: ticketId,
      ref: ticket.referenceNumber,
    });
    const auditContext = auditCtxFrom(ctx);

    await writeAudit(tx, {
      action: isDirectAdd
        ? ('ticket.participant_joined' as const)
        : ('ticket.participant_invited' as const),
      actor,
      target,
      context: auditContext,
      meta: {
        targetAdminId: targetId,
        targetAdminRole: targetAdmin.role,
        isDirectAdd,
        hasMessage: inviteMessage !== undefined,
      },
      ts: now,
    });
  });

  // Post-commit notification. `notifyAdminParticipantInvited` carries the
  // accept/decline CTA; `notifyAdminDirectAdded` confirms the forced add.
  const ticketDesc = {
    ticketId,
    referenceNumber: ticket.referenceNumber,
    subject: ticket.subject,
    ticketUrl: buildAdminTicketUrl(ticketId),
  };

  if (isDirectAdd) {
    await notifyAdminDirectAdded(db, {
      adminUserId: targetId,
      ticket: ticketDesc,
      addedByName: user.displayName ?? user.email,
      addedMessage: inviteMessage,
    });
  } else {
    await notifyAdminParticipantInvited(db, {
      adminUserId: targetId,
      ticket: ticketDesc,
      inviterName: user.displayName ?? user.email,
      inviteMessage,
    });
  }

  return ctx.json({
    status: isDirectAdd ? 'added' : 'invited',
    adminUserId: targetId,
    expiresAt: isDirectAdd ? null : inviteExpiresAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// handleAcceptParticipantInvite
// ---------------------------------------------------------------------------

/**
 * The invited admin accepts a pending invite on a ticket. Only the
 * recipient (caller) can accept their own invite -- there is no
 * adminId URL param because delegated accepting is disallowed.
 *
 * Expired invites are lazily cleaned up and rejected with 410 (Gone).
 */
export async function handleAcceptParticipantInvite(
  ctx: AdminContext,
  ticketId: string,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }

  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);
  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  const rows = await db
    .select({
      role: schema.ticketParticipants.role,
      status: schema.ticketParticipants.status,
      invitedBy: schema.ticketParticipants.invitedBy,
      expiresAt: schema.ticketParticipants.expiresAt,
    })
    .from(schema.ticketParticipants)
    .where(
      and(
        eq(schema.ticketParticipants.ticketId, ticketId),
        eq(schema.ticketParticipants.adminUserId, user.id),
      ),
    )
    .limit(1);
  const row = rows[0];

  if (row === undefined || row.status !== 'pending') {
    return ctx.errorJson('no_pending_invite', 'No pending invite to accept.', 404);
  }

  // Lazy expiry check -- auto-remove and audit so a stale pending row
  // doesn't linger and later accidentally flip to active.
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.ticketParticipants)
        .set({ status: 'removed', removedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.ticketParticipants.ticketId, ticketId),
            eq(schema.ticketParticipants.adminUserId, user.id),
            eq(schema.ticketParticipants.status, 'pending'),
          ),
        );
      await writeAudit(tx, {
        action: 'ticket.invite_expired',
        actor: adminUserActor({ id: user.id, label: user.email }),
        target: uuidTarget({
          kind: 'ticket',
          id: ticketId,
          ref: ticket.referenceNumber,
        }),
        context: auditCtxFrom(ctx),
        meta: {
          adminUserId: user.id,
          invitedBy: row.invitedBy,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        },
        ts: now,
      });
    });
    return ctx.errorJson('invite_expired', 'This invite has expired.', 410);
  }

  // Flip pending -> active + audit atomically.
  await db.transaction(async (tx) => {
    await tx
      .update(schema.ticketParticipants)
      .set({
        status: 'active',
        respondedAt: now,
        expiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.ticketParticipants.ticketId, ticketId),
          eq(schema.ticketParticipants.adminUserId, user.id),
          eq(schema.ticketParticipants.status, 'pending'),
        ),
      );

    await writeAudit(tx, {
      action: 'ticket.participant_accepted',
      actor: adminUserActor({ id: user.id, label: user.email }),
      target: uuidTarget({
        kind: 'ticket',
        id: ticketId,
        ref: ticket.referenceNumber,
      }),
      context: auditCtxFrom(ctx),
      meta: {
        invitedBy: row.invitedBy,
        role: row.role,
      },
      ts: now,
    });
  });

  // Notify inviter (fire-and-forget).
  if (row.invitedBy !== null && row.invitedBy !== user.id) {
    await notifyAdminInviteResponded(db, {
      adminUserId: row.invitedBy,
      ticket: {
        ticketId,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildAdminTicketUrl(ticketId),
      },
      inviteeName: user.displayName ?? user.email,
      accepted: true,
    });
  }

  return ctx.json({ status: 'active' });
}

// ---------------------------------------------------------------------------
// handleDeclineParticipantInvite
// ---------------------------------------------------------------------------

/**
 * The invited admin declines a pending invite on a ticket. Symmetric to
 * {@link handleAcceptParticipantInvite}: only the recipient can act, and
 * expired invites are lazily cleaned up.
 */
export async function handleDeclineParticipantInvite(
  ctx: AdminContext,
  ticketId: string,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }

  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);
  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  const rows = await db
    .select({
      role: schema.ticketParticipants.role,
      status: schema.ticketParticipants.status,
      invitedBy: schema.ticketParticipants.invitedBy,
      expiresAt: schema.ticketParticipants.expiresAt,
    })
    .from(schema.ticketParticipants)
    .where(
      and(
        eq(schema.ticketParticipants.ticketId, ticketId),
        eq(schema.ticketParticipants.adminUserId, user.id),
      ),
    )
    .limit(1);
  const row = rows[0];

  if (row === undefined || row.status !== 'pending') {
    return ctx.errorJson('no_pending_invite', 'No pending invite to decline.', 404);
  }

  // Lazy expiry (same shape as accept).
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.ticketParticipants)
        .set({ status: 'removed', removedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.ticketParticipants.ticketId, ticketId),
            eq(schema.ticketParticipants.adminUserId, user.id),
            eq(schema.ticketParticipants.status, 'pending'),
          ),
        );
      await writeAudit(tx, {
        action: 'ticket.invite_expired',
        actor: adminUserActor({ id: user.id, label: user.email }),
        target: uuidTarget({
          kind: 'ticket',
          id: ticketId,
          ref: ticket.referenceNumber,
        }),
        context: auditCtxFrom(ctx),
        meta: {
          adminUserId: user.id,
          invitedBy: row.invitedBy,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        },
        ts: now,
      });
    });
    return ctx.errorJson('invite_expired', 'This invite has expired.', 410);
  }

  // Flip pending -> declined + audit atomically.
  await db.transaction(async (tx) => {
    await tx
      .update(schema.ticketParticipants)
      .set({
        status: 'declined',
        respondedAt: now,
        expiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.ticketParticipants.ticketId, ticketId),
          eq(schema.ticketParticipants.adminUserId, user.id),
          eq(schema.ticketParticipants.status, 'pending'),
        ),
      );

    await writeAudit(tx, {
      action: 'ticket.participant_declined',
      actor: adminUserActor({ id: user.id, label: user.email }),
      target: uuidTarget({
        kind: 'ticket',
        id: ticketId,
        ref: ticket.referenceNumber,
      }),
      context: auditCtxFrom(ctx),
      meta: {
        invitedBy: row.invitedBy,
        role: row.role,
      },
      ts: now,
    });
  });

  // Notify inviter (fire-and-forget).
  if (row.invitedBy !== null && row.invitedBy !== user.id) {
    await notifyAdminInviteResponded(db, {
      adminUserId: row.invitedBy,
      ticket: {
        ticketId,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildAdminTicketUrl(ticketId),
      },
      inviteeName: user.displayName ?? user.email,
      accepted: false,
    });
  }

  return ctx.json({ status: 'declined' });
}

// ---------------------------------------------------------------------------
// handleRemoveParticipant
// ---------------------------------------------------------------------------

/**
 * Remove a participant from a ticket. Covers three distinct flows:
 *
 *   * Self-leave (caller === target, active) : a collaborator steps
 *     away voluntarily. Not available to the active assignee -- they
 *     must reassign or hand the ticket off. Not available for pending
 *     invites either -- the invitee must use decline.
 *   * Remove-other (active)                  : the assignee (or a
 *     superadmin) kicks a collaborator. The active assignee cannot be
 *     removed through this endpoint; use reassign or take-over.
 *   * Rescind-pending                        : the assignee (or a
 *     superadmin) cancels a pending invite before the invitee responds.
 *     Invitee is notified in-app only; no team fan-out because pending
 *     rows are not yet visible collaborators.
 *
 * Non-superadmin callers cannot remove a participant that outranks
 * them (hierarchy guard).
 */
export async function handleRemoveParticipant(
  ctx: AdminContext,
  ticketId: string,
  targetAdminId: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }
  if (!uuidSchema.safeParse(targetAdminId).success) {
    return invalidUuidResponse(ctx, 'participant');
  }

  // Body is pre-parsed by the route layer (envelope split for the
  // destructive-reauth gate). Empty body is valid (the self-leave UI
  // posts no payload at all) and yields `{}` here.
  const parsed = ticketRemoveParticipantSchema.safeParse(body);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }
  const { reason } = parsed.data;

  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);
  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  const callerParticipant = await getParticipantRef(db, ticketId, user.id);
  const ticketCtx: TicketPermissionContext = {
    assignedTo: ticket.assignedTo,
    status: ticket.status,
  };
  if (!canPerformTicketAction(user, callerParticipant, 'read', ticketCtx)) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  const isSelfLeave = targetAdminId === user.id;

  // Target row + admin role for the hierarchy guard.
  const targetRows = await db
    .select({
      role: schema.ticketParticipants.role,
      status: schema.ticketParticipants.status,
      adminRole: schema.adminUsers.role,
    })
    .from(schema.ticketParticipants)
    .innerJoin(
      schema.adminUsers,
      eq(schema.ticketParticipants.adminUserId, schema.adminUsers.id),
    )
    .where(
      and(
        eq(schema.ticketParticipants.ticketId, ticketId),
        eq(schema.ticketParticipants.adminUserId, targetAdminId),
      ),
    )
    .limit(1);
  const target = targetRows[0];
  if (
    target === undefined ||
    (target.status !== 'active' && target.status !== 'pending')
  ) {
    return ctx.errorJson('not_found', 'Participant not found on this ticket.', 404);
  }

  const isPendingRescind = target.status === 'pending';

  // Active assignee cannot be removed via this endpoint -- use
  // reassign (hand-off) or take-over (superadmin escape hatch).
  // (Pending rows are always invited as `collaborator`, so this only
  // fires on active assignees.)
  if (target.role === 'assignee') {
    return ctx.errorJson(
      'conflict',
      'The active assignee cannot be removed here. Use reassign or take-over.',
      409,
    );
  }

  if (isSelfLeave) {
    // Self-leaving a pending invite is `decline`, not remove.
    if (isPendingRescind) {
      return ctx.errorJson(
        'conflict',
        'Use the decline endpoint to reject a pending invite.',
        409,
      );
    }
    if (callerParticipant === null || callerParticipant.status !== 'active') {
      return ctx.errorJson(
        'forbidden',
        'Only active participants can leave the ticket.',
        403,
      );
    }
  } else {
    if (!canPerformTicketAction(user, callerParticipant, 'remove_participant', ticketCtx)) {
      return ctx.errorJson(
        'forbidden',
        isPendingRescind
          ? 'Only the ticket assignee or a superadmin can cancel a pending invite.'
          : 'Only the ticket assignee or a superadmin can remove participants.',
        403,
      );
    }
    // Hierarchy guard: a non-superadmin cannot remove a participant
    // ranked above them.
    if (user.role !== 'superadmin' && outranks(target.adminRole as AdminRole, user.role)) {
      return ctx.errorJson(
        'forbidden',
        'You cannot remove an admin ranked above you.',
        403,
      );
    }
  }

  // Commit: mark the row removed + audit in one transaction. The
  // previous-status constraint in the WHERE clause ensures we only
  // touch the row we validated above, so a concurrent accept/decline
  // cannot race the rescind into an impossible state.
  const previousStatus = target.status;
  await db.transaction(async (tx) => {
    await tx
      .update(schema.ticketParticipants)
      .set({
        status: 'removed',
        removedAt: now,
        transferReason: reason ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.ticketParticipants.ticketId, ticketId),
          eq(schema.ticketParticipants.adminUserId, targetAdminId),
          eq(schema.ticketParticipants.status, previousStatus),
        ),
      );

    const actor = adminUserActor({ id: user.id, label: user.email });
    const auditTarget = uuidTarget({
      kind: 'ticket',
      id: ticketId,
      ref: ticket.referenceNumber,
    });
    const auditContext = auditCtxFrom(ctx);

    const auditAction = isPendingRescind
      ? ('ticket.invite_rescinded' as const)
      : isSelfLeave
        ? ('ticket.participant_left' as const)
        : ('ticket.participant_removed' as const);

    await writeAudit(tx, {
      action: auditAction,
      actor,
      target: auditTarget,
      context: auditContext,
      meta: {
        targetAdminId,
        voluntary: isSelfLeave,
        reason: reason ?? null,
        previousStatus,
      },
      ts: now,
    });
  });

  // Post-commit fan-out. Three branches:
  //   * Pending rescind: notify the invitee in-app only. No team
  //     signal because a pending invite was never a visible member.
  //   * Self-leave: remaining active participants get the "X left"
  //     notice.
  //   * Involuntary removal: the team gets the notice AND the removed
  //     admin receives a personal notification so they know their
  //     access dropped.
  const participants = await listTicketParticipants(db, ticketId);
  const ticketDesc = {
    ticketId,
    referenceNumber: ticket.referenceNumber,
    subject: ticket.subject,
    ticketUrl: buildAdminTicketUrl(ticketId),
  };

  if (isPendingRescind) {
    await notifyAdminInviteRescinded(db, {
      adminUserId: targetAdminId,
      ticket: ticketDesc,
      rescindedByName: user.displayName ?? user.email,
      reason: reason ?? undefined,
    });

    return ctx.json({
      status: 'rescinded',
      adminUserId: targetAdminId,
      voluntary: false,
    });
  }

  const leaverName = isSelfLeave
    ? (user.displayName ?? user.email)
    : (participants.find((p) => p.adminUserId === targetAdminId)?.displayName ??
       `Admin ${targetAdminId.slice(0, 8)}`);

  const teamRecipients = participants
    .filter(
      (p) =>
        p.status === 'active' &&
        p.adminUserId !== user.id &&
        p.adminUserId !== targetAdminId,
    )
    .map((p) => p.adminUserId);

  if (teamRecipients.length > 0) {
    await notifyAdminParticipantLeft(db, {
      adminUserIds: teamRecipients,
      ticket: ticketDesc,
      leaverName,
      voluntary: isSelfLeave,
    });
  }

  if (!isSelfLeave) {
    // Dedicated notification to the removed admin -- second-person
    // context still reads correctly ("X was removed from TICKET").
    await notifyAdminParticipantLeft(db, {
      adminUserIds: [targetAdminId],
      ticket: ticketDesc,
      leaverName,
      voluntary: false,
    });
  }

  return ctx.json({
    status: 'removed',
    adminUserId: targetAdminId,
    voluntary: isSelfLeave,
  });
}

// ---------------------------------------------------------------------------
// handleTakeOverTicket
// ---------------------------------------------------------------------------

/**
 * Superadmin-only escape hatch for reclaiming an assigned ticket. The
 * previous assignee is demoted to an active collaborator by default
 * (`previousAssigneeStaysAsCollab` default = `true`) so they retain
 * visibility. When `false`, the old row is marked `removed`.
 *
 * No-op cases return 409:
 *   * Caller is already the assignee.
 *   * Ticket is terminal (`resolved` / `closed`).
 *
 * When the ticket was unassigned, this endpoint is equivalent to a
 * self-claim and just installs the superadmin as assignee.
 */
export async function handleTakeOverTicket(
  ctx: AdminContext,
  ticketId: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }

  // Body is pre-parsed by the route layer (envelope split for the
  // destructive-reauth gate).
  const parsed = ticketTakeOverSchema.safeParse(body);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }
  const { reason, previousAssigneeStaysAsCollab } = parsed.data;
  const keepPrevAsCollab = previousAssigneeStaysAsCollab !== false;

  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);
  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  const participant = await getParticipantRef(db, ticketId, user.id);
  const ticketCtx: TicketPermissionContext = {
    assignedTo: ticket.assignedTo,
    status: ticket.status,
  };
  if (!canPerformTicketAction(user, participant, 'take_over', ticketCtx)) {
    return ctx.errorJson(
      'forbidden',
      'Only superadmins can take over a ticket.',
      403,
    );
  }

  if (ticket.status === 'resolved' || ticket.status === 'closed') {
    return ctx.errorJson(
      'conflict',
      'Cannot take over a ticket in a terminal state.',
      409,
    );
  }
  if (ticket.assignedTo === user.id) {
    return ctx.errorJson(
      'conflict',
      'You are already the assignee on this ticket.',
      409,
    );
  }

  const previousAssigneeId = ticket.assignedTo;

  // Commit: participant graph + tickets.assigned_to + audit atomically.
  await db.transaction(async (tx) => {
    if (previousAssigneeId !== null) {
      if (keepPrevAsCollab) {
        await tx
          .update(schema.ticketParticipants)
          .set({
            role: 'collaborator',
            status: 'active',
            transferReason: reason ?? null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.ticketParticipants.ticketId, ticketId),
              eq(schema.ticketParticipants.adminUserId, previousAssigneeId),
              eq(schema.ticketParticipants.role, 'assignee'),
              eq(schema.ticketParticipants.status, 'active'),
            ),
          );
      } else {
        await tx
          .update(schema.ticketParticipants)
          .set({
            status: 'removed',
            removedAt: now,
            transferReason: reason ?? null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.ticketParticipants.ticketId, ticketId),
              eq(schema.ticketParticipants.adminUserId, previousAssigneeId),
              eq(schema.ticketParticipants.role, 'assignee'),
              eq(schema.ticketParticipants.status, 'active'),
            ),
          );
      }
    }

    // Install the superadmin as assignee. UPSERT so a pre-existing
    // collab / declined / removed row for this admin is promoted
    // cleanly instead of tripping the (ticket_id, admin_user_id) key.
    await tx
      .insert(schema.ticketParticipants)
      .values({
        ticketId,
        adminUserId: user.id,
        role: 'assignee',
        status: 'active',
        invitedBy: user.id,
        invitedAt: now,
        respondedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.ticketParticipants.ticketId,
          schema.ticketParticipants.adminUserId,
        ],
        set: {
          role: 'assignee',
          status: 'active',
          invitedBy: user.id,
          invitedAt: now,
          respondedAt: now,
          removedAt: null,
          expiresAt: null,
          transferReason: null,
          updatedAt: now,
        },
      });

    // Sync the denormalised assignee column on tickets.
    await tx
      .update(schema.tickets)
      .set({ assignedTo: user.id, updatedAt: now })
      .where(eq(schema.tickets.id, ticketId));

    const actor = adminUserActor({ id: user.id, label: user.email });
    const auditTarget = uuidTarget({
      kind: 'ticket',
      id: ticketId,
      ref: ticket.referenceNumber,
    });
    const auditContext = auditCtxFrom(ctx);

    await writeAudit(tx, {
      action: 'ticket.taken_over' as const,
      actor,
      target: auditTarget,
      context: auditContext,
      meta: {
        previousAssigneeId,
        previousAssigneeStaysAsCollab: keepPrevAsCollab,
        reason: reason ?? null,
      },
      ts: now,
    });
  });

  // Post-commit: notify the displaced assignee (in-app + email) with
  // the stay-as-collab verdict and optional reason.
  if (previousAssigneeId !== null && previousAssigneeId !== user.id) {
    await notifyAdminTicketTakenOver(db, {
      adminUserId: previousAssigneeId,
      ticket: {
        ticketId,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildAdminTicketUrl(ticketId),
      },
      takenByName: user.displayName ?? user.email,
      stayedAsCollab: keepPrevAsCollab,
      reason,
    });
  }

  return ctx.json({
    status: 'taken_over',
    previousAssigneeId,
    previousAssigneeStaysAsCollab: keepPrevAsCollab,
  });
}

// ---------------------------------------------------------------------------
// handleSuperadminJoinAsCollab
// ---------------------------------------------------------------------------

/**
 * Superadmin-only "silent watch" flow: join a ticket as an active
 * collaborator without sending a message and without becoming the
 * assignee. The regular invite endpoint is not available to a
 * non-participant superadmin because it requires the caller to
 * already be the assignee -- this endpoint is the designated entry
 * point for silent oversight.
 *
 * Idempotent on an existing active collaborator row (returns 200).
 * Rejected (409) when the caller is already the active assignee --
 * they cannot "downgrade" themselves; use reassign first.
 */
export async function handleSuperadminJoinAsCollab(
  ctx: AdminContext,
  ticketId: string,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }

  if (user.role !== 'superadmin') {
    return ctx.errorJson(
      'forbidden',
      'Only superadmins can join a ticket as collaborator via this endpoint.',
      403,
    );
  }

  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);
  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  if (ticket.status === 'resolved' || ticket.status === 'closed') {
    return ctx.errorJson(
      'conflict',
      'Cannot join a ticket in a terminal state.',
      409,
    );
  }

  const existing = await getParticipantRef(db, ticketId, user.id);
  if (existing !== null && existing.status === 'active' && existing.role === 'assignee') {
    return ctx.errorJson(
      'conflict',
      'You are the assignee on this ticket.',
      409,
    );
  }

  const alreadyActiveCollab =
    existing !== null && existing.status === 'active' && existing.role === 'collaborator';

  if (alreadyActiveCollab) {
    return ctx.json({ status: 'already_participant' });
  }

  // Commit: upsert a collaborator row + audit.
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.ticketParticipants)
      .values({
        ticketId,
        adminUserId: user.id,
        role: 'collaborator',
        status: 'active',
        invitedBy: user.id,
        invitedAt: now,
        respondedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.ticketParticipants.ticketId,
          schema.ticketParticipants.adminUserId,
        ],
        set: {
          role: 'collaborator',
          status: 'active',
          invitedBy: user.id,
          invitedAt: now,
          respondedAt: now,
          removedAt: null,
          expiresAt: null,
          transferReason: null,
          updatedAt: now,
        },
      });

    const actor = adminUserActor({ id: user.id, label: user.email });
    const auditTarget = uuidTarget({
      kind: 'ticket',
      id: ticketId,
      ref: ticket.referenceNumber,
    });
    const auditContext = auditCtxFrom(ctx);

    await writeAudit(tx, {
      action: 'ticket.participant_joined' as const,
      actor,
      target: auditTarget,
      context: auditContext,
      meta: {
        selfJoin: true,
        superadmin: true,
      },
      ts: now,
    });
  });

  return ctx.json({ status: 'joined' });
}

// ---------------------------------------------------------------------------
// handleAddAdminMessage
// ---------------------------------------------------------------------------

/**
 * POST /api/admin/tickets/[id]/messages
 *
 * Add an admin/staff message to a ticket. Supports `isInternal` flag
 * for staff-only notes. Optionally transitions the ticket status to
 * `waiting_customer` when the admin replies (unless isInternal).
 */
export async function handleAddAdminMessage(
  ctx: AdminContext,
  ticketId: string,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  // --- 0. Validate route param format ---
  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }

  // --- 1. Parse body ---
  let rawBody: unknown;
  try {
    rawBody = await ctx.request.json();
  } catch {
    return ctx.errorJson('invalid_body', 'Request body must be valid JSON.', 400);
  }

  const parsed = adminMessageSchema.safeParse(rawBody);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }

  const { body: messageBody, isInternal } = parsed.data;

  // --- 2. Verify ticket exists ---
  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);

  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // --- 2a. Visibility + authorization gate ---------------------------------
  // Message posting requires either an active participant row OR
  // superadmin (who auto-joins as collaborator on reply). Terminal-state
  // tickets accept no new messages -- that rule lives in the matrix.
  const participant = await getParticipantRef(db, ticketId, user.id);
  const ticketCtx: TicketPermissionContext = {
    assignedTo: ticket.assignedTo,
    status: ticket.status,
  };

  if (!canPerformTicketAction(user, participant, 'read', ticketCtx)) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  const action = isInternal ? ('internal_note' as const) : ('reply' as const);
  if (!canPerformTicketAction(user, participant, action, ticketCtx)) {
    const message =
      ticket.status === 'resolved' || ticket.status === 'closed'
        ? 'This ticket is resolved or closed and accepts no new messages.'
        : 'You must be an active participant on this ticket to post messages.';
    return ctx.errorJson('forbidden', message, 403);
  }

  // Rate limiting — superadmins are exempt entirely, non-super admins
  // get burst + duplicate checks on every post plus a reply-chain cap
  // on public replies (internal notes bypass the reply-chain guard
  // because they're admin-to-admin coordination). See
  // `lib/ticket/rate-limit.ts` for the full matrix.
  const rateCheck = await checkAdminMessageRate({
    db,
    ticketId,
    adminId: user.id,
    isSuperadmin: user.role === 'superadmin',
    isInternal,
    body: messageBody,
    now,
    ticketCreatedAt: ticket.createdAt,
  });
  if (!rateCheck.ok) {
    return ctx.errorJson(rateCheck.code, rateCheck.message, 429);
  }

  // Superadmin side-door: when a superadmin replies to a ticket they
  // have not joined, they auto-enrol as a collaborator. This gives them
  // the power to intervene without a formal invite flow while keeping
  // the participant graph complete for audit + future replies.
  const shouldAutoJoin =
    user.role === 'superadmin' &&
    (participant === null || participant.status !== 'active');

  // --- 3. Insert message and update ticket ---
  // Mentions are parsed from the raw body BEFORE the transaction so we
  // know which admin UUIDs to insert into `ticket_message_mentions`
  // and which recipients to notify post-commit. The filter rejects
  // non-participants and the author themselves so `@mention` cannot
  // be used to back-door someone onto a ticket -- that requires the
  // explicit invite flow.
  const rawMentions = parseMentions(messageBody);
  const mentionedIds =
    rawMentions.length > 0
      ? await filterMentionable(db, {
          ticketId,
          candidateIds: rawMentions,
          authorId: user.id,
        })
      : [];

  const messageId = await db.transaction(async (tx) => {
    if (shouldAutoJoin) {
      // UPSERT so a previously-removed / declined superadmin row is
      // revived rather than violating the (ticket_id, admin_user_id)
      // unique key. We never demote an existing assignee back to
      // collaborator -- only touch `status`, `respondedAt`, `removedAt`
      // so role survives any prior state.
      await tx
        .insert(schema.ticketParticipants)
        .values({
          ticketId,
          adminUserId: user.id,
          role: 'collaborator',
          status: 'active',
          invitedBy: user.id,
          invitedAt: now,
          respondedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.ticketParticipants.ticketId,
            schema.ticketParticipants.adminUserId,
          ],
          set: {
            status: 'active',
            respondedAt: now,
            removedAt: null,
            updatedAt: now,
          },
        });
    }

    const insertedMessage = await tx
      .insert(schema.ticketMessages)
      .values({
        ticketId,
        senderId: user.id,
        senderType: 'admin_user',
        body: messageBody,
        isInternal,
        createdAt: now,
      })
      .returning({ id: schema.ticketMessages.id });

    const insertedMessageId = insertedMessage[0]?.id;
    if (insertedMessageId === undefined) {
      throw new Error('Ticket message insert returned no row');
    }

    // Persist distinct mention rows so rendering + audit queries can
    // reconstruct the fan-out later without re-parsing the body.
    if (mentionedIds.length > 0) {
      await tx.insert(schema.ticketMessageMentions).values(
        mentionedIds.map((adminId) => ({
          messageId: insertedMessageId,
          mentionedAdminId: adminId,
          createdAt: now,
        })),
      );
    }

    // For non-internal replies, transition to waiting_customer if ticket is open/in_progress
    const shouldTransition =
      !isInternal && (ticket.status === 'open' || ticket.status === 'in_progress');

    const newStatus = shouldTransition ? ('waiting_customer' as const) : ticket.status;

    await tx
      .update(schema.tickets)
      .set({
        status: newStatus,
        updatedAt: now,
      })
      .where(eq(schema.tickets.id, ticketId));

    // Audit
    const actor = adminUserActor({ id: user.id, label: user.email });
    const target = uuidTarget({ kind: 'ticket', id: ticketId, ref: ticket.referenceNumber });
    const auditContext = auditCtxFrom(ctx);

    await writeAudit(tx, {
      action: 'ticket.message_added',
      actor,
      target,
      context: auditContext,
      meta: {
        senderType: 'admin_user',
        isInternal,
        statusBefore: ticket.status,
        statusAfter: newStatus,
        superadminAutoJoined: shouldAutoJoin,
        mentionCount: mentionedIds.length,
      },
      ts: now,
    });

    // One audit entry per mention: makes "who mentioned whom" a
    // first-class query and keeps the per-recipient history aligned
    // with the dispatched notifications.
    for (const mentionedAdminId of mentionedIds) {
      await writeAudit(tx, {
        action: 'ticket.mention_created',
        actor,
        target,
        context: auditContext,
        meta: {
          messageId: insertedMessageId,
          mentionedAdminId,
          isInternal,
        },
        ts: now,
      });
    }

    return insertedMessageId;
  });

  // Notify the ticket creator (customer) about the reply — in-app + email,
  // gated by channel preferences in the dispatcher. Skipped for internal
  // notes and self-replies. `messageId` lets the customer's ticket page
  // deep-link and scroll-highlight the exact reply from the email/bell.
  if (!isInternal && ticket.creatorType === 'customer' && ticket.creatorId !== user.id) {
    await notifyCustomerTicketReply(db, {
      customerId: ticket.creatorId,
      ticket: {
        ticketId: ticket.id,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildCustomerTicketUrl(ticket.id),
      },
      replyPreview: truncateForEmail(messageBody),
      messageId,
    });
  }

  // Elevated-priority mention fan-out (post-commit so a dispatcher
  // failure cannot roll back the message itself). Deep-link to the
  // mentioning message so the recipient lands directly on it instead
  // of at the bottom of a long thread.
  if (mentionedIds.length > 0) {
    await notifyAdminTicketMentioned(db, {
      adminUserIds: mentionedIds,
      ticket: {
        ticketId: ticket.id,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildAdminTicketUrl(ticket.id),
      },
      authorName: user.displayName ?? user.email,
      messagePreview: truncateForEmail(messageBody),
      isInternal,
      messageId,
    });
  }

  return ctx.json({ success: true });
}

// ---------------------------------------------------------------------------
// handleEditAdminMessage
// ---------------------------------------------------------------------------

/**
 * PATCH /api/internal/admin/tickets/[id]/messages/[messageId]
 *
 * Edit an admin-authored message. Mirror of `handleEditCustomerMessage`
 * but with admin participant validation on the mention diff (same rule
 * as `handleAddAdminMessage`: mentions must target active participants
 * on this ticket). `is_internal` and authorship are immutable.
 *
 * Edit is allowed only while `seen_by_other = false`. The flag flips
 * the moment any admin (other than the author) or the customer loads
 * the ticket detail, so the editable window is short by design — the
 * goal is to let an author fix an immediate typo, not to rewrite
 * history after the fact.
 */
export async function handleEditAdminMessage(
  ctx: AdminContext,
  ticketId: string,
  messageId: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  // --- 0. Validate route params ---
  if (!uuidSchema.safeParse(ticketId).success) {
    return invalidUuidResponse(ctx, 'ticket');
  }
  if (!uuidSchema.safeParse(messageId).success) {
    return invalidUuidResponse(ctx, 'message');
  }

  // --- 1. Validate body shape ---
  // Body is pre-parsed by the route layer (envelope split for the
  // destructive-reauth gate).
  const parsed = editMessageSchema.safeParse(body);
  if (!parsed.success) {
    return ctx.errorJson(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid input.',
      400,
    );
  }

  const { body: newBody } = parsed.data;

  // --- 2. Fetch ticket + message together ---
  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);
  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  const messageRows = await db
    .select()
    .from(schema.ticketMessages)
    .where(
      and(
        eq(schema.ticketMessages.id, messageId),
        eq(schema.ticketMessages.ticketId, ticketId),
      ),
    )
    .limit(1);

  const message = messageRows[0];
  if (message === undefined) {
    return ctx.errorJson('not_found', 'Message not found.', 404);
  }

  // --- 3. Visibility gate (so we don't leak message existence to
  // admins who can't see the ticket). Mirrors handleGetAdminTicket. ---
  const participant = await getParticipantRef(db, ticketId, user.id);
  const ticketCtx: TicketPermissionContext = {
    assignedTo: ticket.assignedTo,
    status: ticket.status,
  };
  if (!canPerformTicketAction(user, participant, 'read', ticketCtx)) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // --- 4. Authorship + seen-lock ---
  if (message.senderType !== 'admin_user' || message.senderId !== user.id) {
    return ctx.errorJson('not_found', 'Message not found.', 404);
  }

  if (message.seenByOther) {
    return ctx.errorJson(
      'message_locked',
      'This message has already been seen and can no longer be edited.',
      409,
    );
  }

  if (message.body === newBody) {
    return ctx.json({
      message: mapMessageRow({ ...message, body: newBody }),
    });
  }

  // --- 5. Diff mentions ---
  const oldMentionRows = await db
    .select({ mentionedAdminId: schema.ticketMessageMentions.mentionedAdminId })
    .from(schema.ticketMessageMentions)
    .where(eq(schema.ticketMessageMentions.messageId, messageId));
  const oldMentionSet = new Set(oldMentionRows.map((r) => r.mentionedAdminId));

  const rawNewMentions = parseMentions(newBody);
  const newMentionIds =
    rawNewMentions.length > 0
      ? await filterMentionable(db, {
          ticketId,
          candidateIds: rawNewMentions,
          authorId: user.id,
        })
      : [];
  const newMentionSet = new Set(newMentionIds);

  const addedMentions = newMentionIds.filter((id) => !oldMentionSet.has(id));
  const removedMentions = [...oldMentionSet].filter((id) => !newMentionSet.has(id));

  // --- 6. Commit ---
  const updatedRow = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.ticketMessages)
      .set({ body: newBody, editedAt: now })
      .where(eq(schema.ticketMessages.id, messageId))
      .returning();

    if (row === undefined) {
      throw new Error('Message edit returned no row');
    }

    if (removedMentions.length > 0) {
      await tx
        .delete(schema.ticketMessageMentions)
        .where(
          and(
            eq(schema.ticketMessageMentions.messageId, messageId),
            inArray(schema.ticketMessageMentions.mentionedAdminId, removedMentions),
          ),
        );

      const mentionLink = `/admin/tickets/${ticketId}`;
      await tx
        .delete(schema.notifications)
        .where(
          and(
            eq(schema.notifications.type, 'ticket.mentioned'),
            eq(schema.notifications.link, mentionLink),
            isNull(schema.notifications.readAt),
            inArray(schema.notifications.adminUserId, removedMentions),
          ),
        );
    }

    if (addedMentions.length > 0) {
      await tx.insert(schema.ticketMessageMentions).values(
        addedMentions.map((adminId) => ({
          messageId,
          mentionedAdminId: adminId,
          createdAt: now,
        })),
      );
    }

    const actor = adminUserActor({ id: user.id, label: user.email });
    const target = uuidTarget({ kind: 'ticket', id: ticketId, ref: ticket.referenceNumber });
    const auditContext = auditCtxFrom(ctx);

    await writeAudit(tx, {
      action: 'ticket.message_edited',
      actor,
      target,
      context: auditContext,
      meta: {
        messageId,
        isInternal: message.isInternal,
        bodyBefore: message.body,
        bodyAfter: newBody,
        mentionsAdded: addedMentions,
        mentionsRemoved: removedMentions,
      },
      ts: now,
    });

    for (const adminId of removedMentions) {
      await writeAudit(tx, {
        action: 'ticket.mention_revoked',
        actor,
        target,
        context: auditContext,
        meta: { messageId, mentionedAdminId: adminId, isInternal: message.isInternal },
        ts: now,
      });
    }

    for (const adminId of addedMentions) {
      await writeAudit(tx, {
        action: 'ticket.mention_created',
        actor,
        target,
        context: auditContext,
        meta: { messageId, mentionedAdminId: adminId, isInternal: message.isInternal },
        ts: now,
      });
    }

    return row;
  });

  if (addedMentions.length > 0) {
    await notifyAdminTicketMentioned(db, {
      adminUserIds: addedMentions,
      ticket: {
        ticketId: ticket.id,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: buildAdminTicketUrl(ticket.id),
      },
      authorName: user.displayName ?? user.email,
      messagePreview: truncateForEmail(newBody),
      isInternal: message.isInternal,
      messageId,
    });
  }

  return ctx.json({ message: mapMessageRow(updatedRow) });
}

// ===========================================================================
// Admin — Ticket Category CRUD
// ===========================================================================

// ---------------------------------------------------------------------------
// handleListAdminCategories
// ---------------------------------------------------------------------------

/**
 * GET /api/internal/admin/tickets/categories
 *
 * Returns all categories (including inactive) for admin management.
 */
export async function handleListAdminCategories(ctx: AdminContext): Promise<NextResponse> {
  const categories = await ctx.db
    .select()
    .from(schema.ticketCategories)
    .orderBy(schema.ticketCategories.displayOrder);

  return ctx.json({
    categories: categories.map((row) => ({
      ...mapCategoryRow(row),
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

// ---------------------------------------------------------------------------
// handleCreateAdminCategory
// ---------------------------------------------------------------------------

/**
 * POST /api/internal/admin/tickets/categories
 *
 * Create a new ticket category. Requires `ticket:manage_categories`.
 */
export async function handleCreateAdminCategory(ctx: AdminContext): Promise<NextResponse> {
  const { user, db, now } = ctx;

  let rawBody: unknown;
  try {
    rawBody = await ctx.request.json();
  } catch {
    return ctx.errorJson('invalid_body', 'Request body must be valid JSON.', 400);
  }

  const parsed = createCategorySchema.safeParse(rawBody);
  if (!parsed.success) {
    return ctx.errorJson('validation_error', 'Invalid input.', 400, {
      issues: parsed.error.issues,
    });
  }

  const { name, slug, audience, description, icon, displayOrder } = parsed.data;

  // Check slug uniqueness
  const existing = await db
    .select({ id: schema.ticketCategories.id })
    .from(schema.ticketCategories)
    .where(eq(schema.ticketCategories.slug, slug))
    .limit(1);

  if (existing.length > 0) {
    return ctx.errorJson('conflict', 'A category with this slug already exists.', 409);
  }

  const inserted = await db
    .insert(schema.ticketCategories)
    .values({
      name,
      slug,
      audience,
      description: description ?? null,
      icon: icon ?? null,
      displayOrder,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const category = inserted[0];
  if (category === undefined) {
    return ctx.errorJson('internal_error', 'Failed to create category.', 500);
  }

  await writeAudit(db, {
    action: 'ticket.category_created',
    actor: adminUserActor({ id: user.id, label: user.email }),
    target: uuidTarget({ kind: 'ticket_category', id: category.id, ref: slug }),
    context: auditCtxFrom(ctx),
    meta: { name, slug, audience },
    ts: now,
  });

  return ctx.json(
    {
      category: {
        ...mapCategoryRow(category),
        isActive: category.isActive,
        createdAt: category.createdAt.toISOString(),
        updatedAt: category.updatedAt.toISOString(),
      },
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// handleUpdateAdminCategory
// ---------------------------------------------------------------------------

/**
 * PATCH /api/internal/admin/tickets/categories/[id]
 *
 * Update a ticket category. Requires `ticket:manage_categories`.
 */
export async function handleUpdateAdminCategory(
  ctx: AdminContext,
  categoryId: string,
  /**
   * Pre-parsed body. The route handler runs the destructive-reauth
   * envelope parse (which consumes `request.body`), then forwards
   * the remaining keys here so this handler can validate the
   * category-update shape without a second body read.
   */
  body: unknown,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  // Validate route param format before touching the DB.
  if (!uuidSchema.safeParse(categoryId).success) {
    return invalidUuidResponse(ctx, 'category');
  }

  const parsed = updateCategorySchema.safeParse(body);
  if (!parsed.success) {
    return ctx.errorJson('validation_error', 'Invalid input.', 400, {
      issues: parsed.error.issues,
    });
  }

  // Fetch existing
  const existingRows = await db
    .select()
    .from(schema.ticketCategories)
    .where(eq(schema.ticketCategories.id, categoryId))
    .limit(1);

  const existingCategory = existingRows[0];
  if (existingCategory === undefined) {
    return ctx.errorJson('not_found', 'Category not found.', 404);
  }

  const { name, slug, audience, description, icon, displayOrder, isActive } = parsed.data;

  // Check slug uniqueness if changing
  if (slug !== undefined && slug !== existingCategory.slug) {
    const slugConflict = await db
      .select({ id: schema.ticketCategories.id })
      .from(schema.ticketCategories)
      .where(eq(schema.ticketCategories.slug, slug))
      .limit(1);

    if (slugConflict.length > 0) {
      return ctx.errorJson('conflict', 'A category with this slug already exists.', 409);
    }
  }

  const updates: Record<string, unknown> = { updatedAt: now };
  if (name !== undefined) updates['name'] = name;
  if (slug !== undefined) updates['slug'] = slug;
  if (audience !== undefined) updates['audience'] = audience;
  if (description !== undefined) updates['description'] = description;
  if (icon !== undefined) updates['icon'] = icon;
  if (displayOrder !== undefined) updates['displayOrder'] = displayOrder;
  if (isActive !== undefined) updates['isActive'] = isActive;

  const updated = await db
    .update(schema.ticketCategories)
    .set(updates)
    .where(eq(schema.ticketCategories.id, categoryId))
    .returning();

  const category = updated[0];
  if (category === undefined) {
    return ctx.errorJson('internal_error', 'Failed to update category.', 500);
  }

  await writeAudit(db, {
    action: 'ticket.category_updated',
    actor: adminUserActor({ id: user.id, label: user.email }),
    target: uuidTarget({ kind: 'ticket_category', id: categoryId, ref: category.slug }),
    context: auditCtxFrom(ctx),
    meta: { changes: parsed.data },
    ts: now,
  });

  return ctx.json({
    category: {
      ...mapCategoryRow(category),
      isActive: category.isActive,
      createdAt: category.createdAt.toISOString(),
      updatedAt: category.updatedAt.toISOString(),
    },
  });
}

// ---------------------------------------------------------------------------
// handleDeleteAdminCategory
// ---------------------------------------------------------------------------

/**
 * DELETE /api/internal/admin/tickets/categories/[id]
 *
 * Soft-delete: sets is_active = false if tickets reference it.
 * Hard delete only if no tickets use it.
 * Requires `ticket:manage_categories`.
 */
export async function handleDeleteAdminCategory(
  ctx: AdminContext,
  categoryId: string,
): Promise<NextResponse> {
  const { user, db, now } = ctx;

  // Validate route param format before touching the DB.
  if (!uuidSchema.safeParse(categoryId).success) {
    return invalidUuidResponse(ctx, 'category');
  }

  const existingRows = await db
    .select()
    .from(schema.ticketCategories)
    .where(eq(schema.ticketCategories.id, categoryId))
    .limit(1);

  const existingCategory = existingRows[0];
  if (existingCategory === undefined) {
    return ctx.errorJson('not_found', 'Category not found.', 404);
  }

  // Check if tickets reference this category
  const ticketCountResult = await db
    .select({ value: count() })
    .from(schema.tickets)
    .where(eq(schema.tickets.categoryId, categoryId));

  const usedByTickets = (ticketCountResult[0]?.value ?? 0) > 0;

  if (usedByTickets) {
    // Soft delete — deactivate so existing tickets keep their FK
    await db
      .update(schema.ticketCategories)
      .set({ isActive: false, updatedAt: now })
      .where(eq(schema.ticketCategories.id, categoryId));

    await writeAudit(db, {
      action: 'ticket.category_deactivated',
      actor: adminUserActor({ id: user.id, label: user.email }),
      target: uuidTarget({ kind: 'ticket_category', id: categoryId, ref: existingCategory.slug }),
      context: auditCtxFrom(ctx),
      meta: { reason: 'has_tickets', ticketCount: ticketCountResult[0]?.value },
      ts: now,
    });

    return ctx.json({
      deleted: false,
      deactivated: true,
      reason: 'Category has existing tickets. It has been deactivated instead.',
    });
  }

  // Hard delete — no tickets reference it
  await db.delete(schema.ticketCategories).where(eq(schema.ticketCategories.id, categoryId));

  await writeAudit(db, {
    action: 'ticket.category_deleted',
    actor: adminUserActor({ id: user.id, label: user.email }),
    target: uuidTarget({ kind: 'ticket_category', id: categoryId, ref: existingCategory.slug }),
    context: auditCtxFrom(ctx),
    meta: { name: existingCategory.name, slug: existingCategory.slug },
    ts: now,
  });

  return ctx.json({ deleted: true, deactivated: false });
}
