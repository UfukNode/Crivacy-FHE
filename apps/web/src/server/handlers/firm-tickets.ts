/**
 * Firm-facing ticket handlers — create / list / get / reply.
 *
 * Mirrors the customer-side ticket flow, but authored by a
 * `firm_user` and scoped to a firm. Team visibility is the key
 * difference: all active firm_users of the same firm can see AND
 * reply to every ticket opened by any of their teammates (Stripe /
 * Linear / Intercom pattern — team shared inbox).
 *
 * Shared infrastructure stays centralised and is re-used verbatim:
 *   - validation schemas (`createTicketSchema`, `customerMessageSchema`)
 *   - reference number generator (`generateUniqueReference`)
 *   - rate-limit module (`lib/ticket/rate-limit`) — this file adds a
 *     dedicated `checkFirmMessageRate` wrapper over the same guards
 *     the customer path uses, keyed on senderType='firm_user'
 *   - email dispatcher + rate-limit + templates
 *   - chain-neutral `mapTicketRow` / `mapMessageRow` mappers
 *
 * What's different from the customer module:
 *   - `tickets.firm_id` is populated (null on customer tickets) so
 *     team visibility queries can filter by firm without walking
 *     `firm_users`.
 *   - Category audience must be `firm` or `any` (not `customer`).
 *   - Open-ticket cap is looked up from the firm's subscription tier
 *     (`getFirmOpenTicketLimit`), not a single constant.
 *   - Notifications fan out to every active firm_user for team
 *     awareness; the admin-side fan-out is identical to the customer
 *     path (notify assigned admin or the active admin pool).
 *
 * @module
 */

import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { NextResponse } from 'next/server';

import { firmUserActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import * as schema from '@/lib/db/schema';
import { getAppUrl } from '@/lib/env/app-url';
import {
  notifyAdminNewTicket,
  notifyAdminTicketCustomerReply,
} from '@/lib/notification';
import { checkAdminMessageRate } from '@/lib/ticket/rate-limit';
import { getFirmOpenTicketLimit } from '@/lib/ticket/tier-limits';
import { uuidSchema } from '@/lib/validation/common';
import {
  createTicketSchema,
  customerMessageSchema,
  editMessageSchema,
} from '@/lib/validation/ticket';

import type { DashboardContext } from '../context';
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

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a positive-int query parameter with a fallback + ceiling.
 * Local copy because the other variants differ in signature across
 * handler files (e.g. customer path returns 0 on empty). Keeping
 * this 3-liner local avoids bikeshedding over a shared utility.
 */
function parsePositiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function auditCtxFrom(ctx: DashboardContext) {
  return buildAuditRequestContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
}

function firmUserActorFromCtx(ctx: DashboardContext) {
  return firmUserActor({
    id: ctx.user.id,
    label: ctx.user.email,
    firmId: ctx.firm.id,
  });
}

// `mapTicketRow`, `mapMessageRow`, `generateUniqueReference`,
// `fetchActiveAdminIds`, and `truncateForEmail` used to live here as
// per-handler copies. They are now re-exported from
// `_ticket-shared.ts` (imported above as `*Shared`) so the wire
// format and queries stay in lock-step with the customer / admin
// paths.
const mapTicketRow = mapTicketRowShared;
const mapMessageRow = mapMessageRowShared;
const generateUniqueReference = generateUniqueReferenceShared;
const fetchActiveAdminIds = fetchActiveAdminIdsShared;
const truncateForEmail = truncateForEmailShared;

// ---------------------------------------------------------------------------
// List categories available for firm tickets
// ---------------------------------------------------------------------------

export async function handleListFirmTicketCategories(
  ctx: DashboardContext,
): Promise<NextResponse> {
  const { db } = ctx;

  const rows = await db
    .select({
      id: schema.ticketCategories.id,
      name: schema.ticketCategories.name,
      slug: schema.ticketCategories.slug,
      description: schema.ticketCategories.description,
      audience: schema.ticketCategories.audience,
      icon: schema.ticketCategories.icon,
      displayOrder: schema.ticketCategories.displayOrder,
    })
    .from(schema.ticketCategories)
    .where(
      and(
        eq(schema.ticketCategories.isActive, true),
        inArray(schema.ticketCategories.audience, ['firm', 'any']),
      ),
    )
    .orderBy(schema.ticketCategories.displayOrder, schema.ticketCategories.name);

  return ctx.json({ categories: rows });
}

// ---------------------------------------------------------------------------
// List firm tickets (team visibility)
// ---------------------------------------------------------------------------

export async function handleListFirmTickets(ctx: DashboardContext): Promise<NextResponse> {
  const { firm, db, request } = ctx;
  const url = new URL(request.url);

  const statusFilter = url.searchParams.get('status');
  const cursor = url.searchParams.get('cursor');
  const limit = parsePositiveInt(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  // Team visibility — every active firm_user of the firm sees the
  // same shared inbox. We scope with `firm_id` rather than
  // `creator_id` so a ticket stays visible even if its creator was
  // deactivated or removed from the firm.
  const conditions: SQL[] = [
    eq(schema.tickets.firmId, firm.id),
    eq(schema.tickets.creatorType, 'firm_user'),
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
      creatorEmail: schema.firmUsers.email,
    })
    .from(schema.tickets)
    .leftJoin(schema.ticketCategories, eq(schema.tickets.categoryId, schema.ticketCategories.id))
    .leftJoin(schema.firmUsers, eq(schema.tickets.creatorId, schema.firmUsers.id))
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
      creatorEmail: row.creatorEmail ?? null,
    })),
    nextCursor,
    hasMore,
  });
}

// ---------------------------------------------------------------------------
// Create firm ticket
// ---------------------------------------------------------------------------

export async function handleCreateFirmTicket(ctx: DashboardContext): Promise<NextResponse> {
  const { firm, user, db, now } = ctx;

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

  // Category must be active AND open to firm audience.
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
  if (category.audience !== 'firm' && category.audience !== 'any') {
    return ctx.errorJson(
      'audience_mismatch',
      'This category is not available for firm tickets.',
      403,
    );
  }

  // Tier-scoped open-ticket cap — counted across the whole firm so
  // the team shares one inbox budget rather than each member opening
  // their own `limit` concurrent tickets.
  const tierLimit = getFirmOpenTicketLimit(firm.tier);
  const openRows = await db
    .select({ value: count() })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.firmId, firm.id),
        eq(schema.tickets.creatorType, 'firm_user'),
        inArray(schema.tickets.status, ['open', 'in_progress', 'waiting_customer']),
      ),
    );
  const openCount = openRows[0]?.value ?? 0;
  if (openCount >= tierLimit) {
    return ctx.errorJson(
      'rate_limit_exceeded',
      `Your ${firm.tier} plan allows at most ${String(
        tierLimit,
      )} open tickets at a time. Resolve or close an existing ticket to open a new one.`,
      429,
    );
  }

  const referenceNumber = await generateUniqueReference(db);
  if (referenceNumber === null) {
    return ctx.errorJson(
      'internal_error',
      'Failed to generate a unique ticket reference. Please try again.',
      500,
    );
  }

  const newTicketId = await db.transaction(async (tx) => {
    const ticketInserted = await tx
      .insert(schema.tickets)
      .values({
        referenceNumber,
        categoryId,
        creatorId: user.id,
        creatorType: 'firm_user',
        firmId: firm.id,
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
      senderId: user.id,
      senderType: 'firm_user',
      body: messageBody,
      isInternal: false,
      createdAt: now,
    });

    const actor = firmUserActorFromCtx(ctx);
    const auditContext = auditCtxFrom(ctx);
    const target = uuidTarget({ kind: 'ticket', id: ticket.id, ref: referenceNumber });

    await writeAudit(tx, {
      action: 'ticket.created',
      actor,
      target,
      context: auditContext,
      meta: {
        categoryId,
        categorySlug: category.slug,
        firmId: firm.id,
        subject,
      },
      ts: now,
    });

    return ticket.id;
  });

  // Fan out new-ticket notification to every active admin so the
  // assignment pool can pick it up. Mirrors the customer-create flow
  // (minus auto-assignment via `@support` chip — firm tickets go
  // straight to the pool; a future iteration can add the chip).
  const adminIds = await fetchActiveAdminIds(db);
  if (adminIds.length > 0) {
    await notifyAdminNewTicket(db, {
      adminUserIds: adminIds,
      ticket: {
        ticketId: newTicketId,
        referenceNumber,
        subject,
        ticketUrl: `${getAppUrl()}/admin/tickets/${newTicketId}`,
      },
      customerLabel: `${firm.displayName} (${user.email})`,
      priority: 'normal',
    });
  }

  return ctx.json(
    {
      id: newTicketId,
      referenceNumber,
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// Get ticket (team-scoped detail)
// ---------------------------------------------------------------------------

export async function handleGetFirmTicket(
  ctx: DashboardContext,
  ticketId: string,
): Promise<NextResponse> {
  const { firm, user, db } = ctx;

  if (!uuidSchema.safeParse(ticketId).success) {
    return ctx.errorJson('validation_error', 'Invalid ticket ID format.', 400);
  }

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
        eq(schema.tickets.firmId, firm.id),
        eq(schema.tickets.creatorType, 'firm_user'),
      ),
    )
    .limit(1);

  const row = ticketRows[0];
  if (row === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // Mark-as-seen: flip `seen_by_other = true` on messages this
  // firm-user viewer can lock — i.e. admin messages and teammates'
  // messages (anyone who is not this specific firm_user). Internal
  // notes are always excluded because they never render for the firm
  // side regardless.
  await db
    .update(schema.ticketMessages)
    .set({ seenByOther: true })
    .where(
      and(
        eq(schema.ticketMessages.ticketId, ticketId),
        eq(schema.ticketMessages.seenByOther, false),
        eq(schema.ticketMessages.isInternal, false),
        sql`(${schema.ticketMessages.senderType} != 'firm_user' OR ${schema.ticketMessages.senderId} != ${user.id})`,
      ),
    );

  // Fetch messages (exclude internal notes) with sender-name
  // enrichment. A single-query LEFT JOIN over admin_users +
  // firm_users resolves the display name for the author regardless
  // of which side posted — no n+1 lookups.
  const messageRows = await db
    .select({
      message: schema.ticketMessages,
      adminName: schema.adminUsers.displayName,
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
      schema.firmUsers,
      and(
        eq(schema.ticketMessages.senderType, 'firm_user'),
        eq(schema.ticketMessages.senderId, schema.firmUsers.id),
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
      mapMessageRow(r.message, r.adminName ?? r.firmUserEmail ?? null),
    ),
  });
}

// ---------------------------------------------------------------------------
// Add firm message
// ---------------------------------------------------------------------------

export async function handleAddFirmMessage(
  ctx: DashboardContext,
  ticketId: string,
): Promise<NextResponse> {
  const { firm, user, db, now } = ctx;

  if (!uuidSchema.safeParse(ticketId).success) {
    return ctx.errorJson('validation_error', 'Invalid ticket ID format.', 400);
  }

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

  // Team-visibility guard: ticket must belong to this firm and be a
  // firm_user ticket. Returning 404 (not 403) on other-firm access
  // avoids leaking ticket existence across tenants.
  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.id, ticketId),
        eq(schema.tickets.firmId, firm.id),
        eq(schema.tickets.creatorType, 'firm_user'),
      ),
    )
    .limit(1);
  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  if (ticket.status === 'closed' || ticket.status === 'resolved') {
    return ctx.errorJson(
      'ticket_closed',
      'This ticket has been resolved or closed. Open a new ticket if you need further help.',
      409,
    );
  }

  // Rate limit — same guards as the admin path (burst + duplicate +
  // reply-chain). We re-use the admin helper because the semantics
  // are identical for a non-superadmin replier on their side of the
  // conversation: "you can say N things before the other side
  // answers." `isSuperadmin` is hard-coded false here so the full
  // stack always applies.
  const rateCheck = await checkAdminMessageRate({
    db,
    ticketId,
    adminId: user.id,
    isSuperadmin: false,
    isInternal: false,
    body: messageBody,
    now,
    ticketCreatedAt: ticket.createdAt,
  });
  if (!rateCheck.ok) {
    return ctx.errorJson(rateCheck.code, rateCheck.message, 429);
  }

  const newMessageId = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.ticketMessages)
      .values({
        ticketId,
        senderId: user.id,
        senderType: 'firm_user',
        body: messageBody,
        isInternal: false,
        createdAt: now,
      })
      .returning({ id: schema.ticketMessages.id });

    const insertedId = inserted[0]?.id;
    if (insertedId === undefined) {
      throw new Error('Firm message insert returned no row');
    }

    // A firm reply on a waiting-customer ticket flips back to in
    // progress so the assignee knows the ball is back in their
    // court — same lifecycle logic as the customer path.
    const newStatus =
      ticket.status === 'waiting_customer' ? ('in_progress' as const) : ticket.status;
    await tx
      .update(schema.tickets)
      .set({ status: newStatus, updatedAt: now })
      .where(eq(schema.tickets.id, ticketId));

    const actor = firmUserActorFromCtx(ctx);
    const target = uuidTarget({
      kind: 'ticket',
      id: ticketId,
      ref: ticket.referenceNumber,
    });
    const auditContext = auditCtxFrom(ctx);
    await writeAudit(tx, {
      action: 'ticket.message_added',
      actor,
      target,
      context: auditContext,
      meta: {
        senderType: 'firm_user',
        statusBefore: ticket.status,
        statusAfter: newStatus,
      },
      ts: now,
    });

    return insertedId;
  });

  void newMessageId;

  // Notify admin team — assigned admin if present, otherwise the
  // active admin pool. Shared helper mirrors the customer-side
  // `notifyAdminTicketCustomerReply` call.
  const adminRecipients =
    ticket.assignedTo !== null ? [ticket.assignedTo] : await fetchActiveAdminIds(db);

  if (adminRecipients.length > 0) {
    await notifyAdminTicketCustomerReply(db, {
      adminUserIds: adminRecipients,
      ticket: {
        ticketId: ticket.id,
        referenceNumber: ticket.referenceNumber,
        subject: ticket.subject,
        ticketUrl: `${getAppUrl()}/admin/tickets/${ticket.id}`,
      },
      customerLabel: `${firm.displayName} (${user.email})`,
      replyPreview: truncateForEmail(messageBody),
      messageId: newMessageId,
    });
  }

  return ctx.json({ success: true });
}

// ---------------------------------------------------------------------------
// Edit firm message
// ---------------------------------------------------------------------------

/**
 * PATCH /api/internal/tickets/[id]/messages/[mid]
 *
 * Edit a firm-authored message while the seen-by-other flag is
 * still false. Mirrors the customer edit lock: the message becomes
 * immutable the moment anyone else (admin, teammate, customer) has
 * loaded the ticket. Only the author can edit; teammates cannot
 * edit each other's messages even while unseen.
 */
export async function handleEditFirmMessage(
  ctx: DashboardContext,
  ticketId: string,
  messageId: string,
): Promise<NextResponse> {
  const { firm, user, db, now } = ctx;

  if (!uuidSchema.safeParse(ticketId).success) {
    return ctx.errorJson('validation_error', 'Invalid ticket ID format.', 400);
  }
  if (!uuidSchema.safeParse(messageId).success) {
    return ctx.errorJson('validation_error', 'Invalid message ID format.', 400);
  }

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

  // Team-scoped ticket lookup — prevents cross-firm edits + 404
  // leakage across tenants.
  const ticketRows = await db
    .select()
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.id, ticketId),
        eq(schema.tickets.firmId, firm.id),
        eq(schema.tickets.creatorType, 'firm_user'),
      ),
    )
    .limit(1);
  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  const msgRows = await db
    .select()
    .from(schema.ticketMessages)
    .where(
      and(
        eq(schema.ticketMessages.id, messageId),
        eq(schema.ticketMessages.ticketId, ticketId),
      ),
    )
    .limit(1);
  const message = msgRows[0];
  if (message === undefined) {
    return ctx.errorJson('not_found', 'Message not found.', 404);
  }

  // Authorship: only the author can edit. Surface 404 instead of 403
  // to avoid telling teammates "hey this message exists, you just
  // can't touch it".
  if (message.senderType !== 'firm_user' || message.senderId !== user.id) {
    return ctx.errorJson('not_found', 'Message not found.', 404);
  }

  if (message.seenByOther) {
    return ctx.errorJson(
      'message_locked',
      'This message has already been seen and can no longer be edited.',
      409,
    );
  }

  // No-op fast path.
  if (message.body === newBody) {
    return ctx.json({ message: mapMessageRow(message, user.email) });
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.ticketMessages)
      .set({ body: newBody, editedAt: now })
      .where(eq(schema.ticketMessages.id, messageId))
      .returning();

    if (row === undefined) {
      throw new Error('Firm message edit returned no row');
    }

    const actor = firmUserActorFromCtx(ctx);
    const target = uuidTarget({
      kind: 'ticket',
      id: ticketId,
      ref: ticket.referenceNumber,
    });
    await writeAudit(tx, {
      action: 'ticket.message_edited',
      actor,
      target,
      context: auditCtxFrom(ctx),
      meta: {
        messageId,
        bodyBefore: message.body,
        bodyAfter: newBody,
      },
      ts: now,
    });

    return row;
  });

  return ctx.json({ message: mapMessageRow(updated, user.email) });
}
