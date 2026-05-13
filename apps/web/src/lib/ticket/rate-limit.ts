/**
 * Ticket-message rate limiting.
 *
 * Three independent guards, layered so the most specific / least
 * intrusive one is surfaced first when multiple would fire:
 *
 *   1. `burst`    -- too many messages from the same sender on the
 *                    same ticket within a 60-second window.
 *   2. `duplicate`-- identical body posted by the same sender within
 *                    a 60-second window (copy-paste spam guard).
 *   3. `reply_chain` -- "conversation-based" limit: a sender cannot
 *                    exceed N messages since the OTHER side's last
 *                    message. For a customer, `N = 3` between admin
 *                    public replies. For a non-superadmin admin,
 *                    `N = 5` between customer replies (internal notes
 *                    are exempt -- they're admin-to-admin bookkeeping,
 *                    not "replying" to the customer).
 *
 * Superadmins are exempt from every guard -- the business requirement
 * is that they can always intervene. Customers are always subject.
 * Non-superadmin admins are subject on public replies only.
 *
 * The first-message (ticket creation) path lives in a different
 * handler (`handleCreateCustomerTicket`) and is NOT rate limited;
 * these helpers only protect the follow-up path. That avoids a
 * chicken-and-egg bug where a brand-new ticket would reject its own
 * creation message.
 *
 * @module
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max messages per sender per ticket within {@link BURST_WINDOW_MS}. */
export const BURST_LIMIT = 3;

/** Max customer messages since last admin public reply (or ticket creation). */
export const CUSTOMER_REPLY_CHAIN_LIMIT = 3;

/** Max non-superadmin admin public replies since last customer message. */
export const ADMIN_REPLY_CHAIN_LIMIT = 5;

/** Sliding window for the burst guard (60 seconds). */
export const BURST_WINDOW_MS = 60_000;

/** Sliding window for the duplicate-body guard (60 seconds). */
export const DUPLICATE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Error codes returned to the client on rate-limit rejection. */
export type RateLimitCode =
  | 'rate_limit_burst'
  | 'rate_limit_duplicate'
  | 'rate_limit_reply_chain';

export interface RateLimitFailure {
  readonly ok: false;
  readonly code: RateLimitCode;
  readonly message: string;
  /** Suggested wait-time in seconds, when the UI can render a countdown. */
  readonly retryAfter?: number;
}

export type RateLimitResult = { readonly ok: true } | RateLimitFailure;

// ---------------------------------------------------------------------------
// Generic guards
// ---------------------------------------------------------------------------

/**
 * Count rows authored by `(senderType, senderId)` on `ticketId` within
 * the burst window. Uses the covering index on
 * `ticket_messages(ticket_id, created_at)` so the scan stays cheap.
 */
async function countBurst(
  db: CrivacyDatabase,
  ticketId: string,
  senderType: string,
  senderId: string,
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - BURST_WINDOW_MS);
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(schema.ticketMessages)
    .where(
      and(
        eq(schema.ticketMessages.ticketId, ticketId),
        eq(schema.ticketMessages.senderType, senderType),
        eq(schema.ticketMessages.senderId, senderId),
        sql`${schema.ticketMessages.createdAt} > ${since}`,
      ),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Return the most recent message body from the same sender on the
 * same ticket within the duplicate window, or `null` if none.
 */
async function findRecentDuplicate(
  db: CrivacyDatabase,
  ticketId: string,
  senderType: string,
  senderId: string,
  body: string,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - DUPLICATE_WINDOW_MS);
  const rows = await db
    .select({ body: schema.ticketMessages.body })
    .from(schema.ticketMessages)
    .where(
      and(
        eq(schema.ticketMessages.ticketId, ticketId),
        eq(schema.ticketMessages.senderType, senderType),
        eq(schema.ticketMessages.senderId, senderId),
        sql`${schema.ticketMessages.createdAt} > ${since}`,
      ),
    )
    .orderBy(desc(schema.ticketMessages.createdAt))
    .limit(1);
  const last = rows[0];
  return last !== undefined && last.body === body;
}

// ---------------------------------------------------------------------------
// Customer rate check
// ---------------------------------------------------------------------------

/**
 * Evaluate all customer-facing rate limits for a follow-up message.
 *
 * Order of checks mirrors user priority: tell the client about the
 * most actionable problem first (burst / duplicate are immediate fix;
 * reply-chain is a conversation-level wait).
 */
export async function checkCustomerMessageRate(params: {
  readonly db: CrivacyDatabase;
  readonly ticketId: string;
  readonly customerId: string;
  readonly body: string;
  readonly now: Date;
  readonly ticketCreatedAt: Date;
}): Promise<RateLimitResult> {
  const { db, ticketId, customerId, body, now, ticketCreatedAt } = params;

  // --- Burst guard ---
  const burstCount = await countBurst(db, ticketId, 'customer', customerId, now);
  if (burstCount >= BURST_LIMIT) {
    return {
      ok: false,
      code: 'rate_limit_burst',
      message: `You are sending messages too quickly. Please wait up to ${String(
        BURST_WINDOW_MS / 1000,
      )} seconds before trying again.`,
      retryAfter: BURST_WINDOW_MS / 1000,
    };
  }

  // --- Duplicate guard ---
  const isDuplicate = await findRecentDuplicate(
    db,
    ticketId,
    'customer',
    customerId,
    body,
    now,
  );
  if (isDuplicate) {
    return {
      ok: false,
      code: 'rate_limit_duplicate',
      message: 'You already sent this exact message a moment ago.',
    };
  }

  // --- Reply-chain guard: count customer messages after the last
  // admin public message (or ticket creation if no reply yet). ---
  const lastAdminPublicRows = await db
    .select({ createdAt: schema.ticketMessages.createdAt })
    .from(schema.ticketMessages)
    .where(
      and(
        eq(schema.ticketMessages.ticketId, ticketId),
        eq(schema.ticketMessages.senderType, 'admin_user'),
        eq(schema.ticketMessages.isInternal, false),
      ),
    )
    .orderBy(desc(schema.ticketMessages.createdAt))
    .limit(1);

  const anchor: Date = lastAdminPublicRows[0]?.createdAt ?? ticketCreatedAt;
  const sinceAnchorRows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(schema.ticketMessages)
    .where(
      and(
        eq(schema.ticketMessages.ticketId, ticketId),
        eq(schema.ticketMessages.senderType, 'customer'),
        eq(schema.ticketMessages.senderId, customerId),
        sql`${schema.ticketMessages.createdAt} > ${anchor}`,
      ),
    );
  const customerSinceAnchor = sinceAnchorRows[0]?.value ?? 0;
  if (customerSinceAnchor >= CUSTOMER_REPLY_CHAIN_LIMIT) {
    return {
      ok: false,
      code: 'rate_limit_reply_chain',
      message: `You have sent ${String(
        CUSTOMER_REPLY_CHAIN_LIMIT,
      )} messages since the last support reply. Please wait for a response before sending more.`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin rate check
// ---------------------------------------------------------------------------

/**
 * Evaluate rate limits for an admin reply.
 *
 * Rules:
 *   - Superadmin is exempt from every guard.
 *   - Internal notes bypass the reply-chain guard (admin-to-admin,
 *     not a customer-facing reply) but still trip burst + duplicate
 *     so a runaway client can't flood internal notes either.
 *   - Public replies from non-superadmins trigger the full stack.
 */
export async function checkAdminMessageRate(params: {
  readonly db: CrivacyDatabase;
  readonly ticketId: string;
  readonly adminId: string;
  readonly isSuperadmin: boolean;
  readonly isInternal: boolean;
  readonly body: string;
  readonly now: Date;
  readonly ticketCreatedAt: Date;
}): Promise<RateLimitResult> {
  const { db, ticketId, adminId, isSuperadmin, isInternal, body, now, ticketCreatedAt } =
    params;

  // Superadmin bypass — business requirement.
  if (isSuperadmin) {
    return { ok: true };
  }

  // --- Burst guard (applies to both public replies and internal notes) ---
  const burstCount = await countBurst(db, ticketId, 'admin_user', adminId, now);
  if (burstCount >= BURST_LIMIT) {
    return {
      ok: false,
      code: 'rate_limit_burst',
      message: `Slow down — you can post at most ${String(
        BURST_LIMIT,
      )} messages per ${String(BURST_WINDOW_MS / 1000)} seconds on a ticket.`,
      retryAfter: BURST_WINDOW_MS / 1000,
    };
  }

  // --- Duplicate guard ---
  const isDuplicate = await findRecentDuplicate(
    db,
    ticketId,
    'admin_user',
    adminId,
    body,
    now,
  );
  if (isDuplicate) {
    return {
      ok: false,
      code: 'rate_limit_duplicate',
      message: 'You already posted this exact content a moment ago.',
    };
  }

  // Internal notes skip the conversation guard. They're coordination,
  // not replies to the customer.
  if (isInternal) {
    return { ok: true };
  }

  // --- Reply-chain guard: count THIS admin's public replies since
  // the last customer message (or ticket creation if the customer
  // hasn't sent anything since the admin joined -- unusual but
  // possible on a reopened ticket). ---
  const lastCustomerRows = await db
    .select({ createdAt: schema.ticketMessages.createdAt })
    .from(schema.ticketMessages)
    .where(
      and(
        eq(schema.ticketMessages.ticketId, ticketId),
        eq(schema.ticketMessages.senderType, 'customer'),
      ),
    )
    .orderBy(desc(schema.ticketMessages.createdAt))
    .limit(1);

  const anchor: Date = lastCustomerRows[0]?.createdAt ?? ticketCreatedAt;
  const sinceAnchorRows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(schema.ticketMessages)
    .where(
      and(
        eq(schema.ticketMessages.ticketId, ticketId),
        eq(schema.ticketMessages.senderType, 'admin_user'),
        eq(schema.ticketMessages.senderId, adminId),
        eq(schema.ticketMessages.isInternal, false),
        sql`${schema.ticketMessages.createdAt} > ${anchor}`,
      ),
    );
  const publicSinceAnchor = sinceAnchorRows[0]?.value ?? 0;
  if (publicSinceAnchor >= ADMIN_REPLY_CHAIN_LIMIT) {
    return {
      ok: false,
      code: 'rate_limit_reply_chain',
      message: `You have sent ${String(
        ADMIN_REPLY_CHAIN_LIMIT,
      )} public replies since the customer last wrote. Wait for a response, or post an internal note instead.`,
    };
  }

  return { ok: true };
}
