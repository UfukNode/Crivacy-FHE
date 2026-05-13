/**
 * Ticket visibility helpers — DB queries for participant lookup and
 * list filtering. The permission matrix in `./permissions.ts` is pure;
 * this module bridges it to Drizzle.
 *
 * Two primary concerns:
 *
 *   1. {@link getParticipantRef} — fetch (or infer) the caller's
 *      relationship to a single ticket so handlers can authorize
 *      mutations. Returns `null` when the caller has no active row.
 *
 *   2. {@link buildTicketVisibilityCondition} — SQL predicate for the
 *      list endpoint that restricts rows to the caller's visible set.
 *      Superadmin bypasses the filter entirely (caller should skip
 *      applying the condition).
 *
 * Both helpers consult `ticket_participants` with `status IN
 * ('active', 'pending')` so an invited admin can discover the ticket
 * and decide on the invitation. `declined` / `removed` rows never
 * resurface stale access. Mutation authorization (reply, reassign,
 * etc.) lives in `permissions.ts` and still requires `active` status.
 *
 * @module
 */

import { and, eq, sql, type SQL } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

import type { ParticipantRef } from './permissions';

// ---------------------------------------------------------------------------
// Single-ticket participant lookup
// ---------------------------------------------------------------------------

/**
 * Resolve the caller's participant row for a specific ticket.
 *
 * Returns the row regardless of status so handlers can distinguish
 * between "never invited" (null), "invite pending", and "active" when
 * surfacing UI state. Most authorization decisions rely on
 * `status === 'active'` -- see {@link ParticipantRef} helpers.
 */
export async function getParticipantRef(
  db: CrivacyDatabase,
  ticketId: string,
  adminUserId: string,
): Promise<ParticipantRef | null> {
  const rows = await db
    .select({
      role: schema.ticketParticipants.role,
      status: schema.ticketParticipants.status,
    })
    .from(schema.ticketParticipants)
    .where(
      and(
        eq(schema.ticketParticipants.ticketId, ticketId),
        eq(schema.ticketParticipants.adminUserId, adminUserId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return { role: row.role, status: row.status };
}

// ---------------------------------------------------------------------------
// List-endpoint visibility predicate
// ---------------------------------------------------------------------------

/**
 * Build the SQL `WHERE` fragment that limits a ticket list to rows the
 * admin caller is allowed to see.
 *
 * Rules (in order, OR-combined):
 *
 *   1. Caller has an ACTIVE or PENDING participant row on the ticket.
 *      Pending invitees can discover the ticket so they have the
 *      context to accept or decline; mutation gating still requires
 *      `active` (enforced in `permissions.ts`).
 *   2. The ticket has no assignee (`tickets.assigned_to IS NULL`) --
 *      the pickup pool is discoverable to every admin so unassigned
 *      work is visible.
 *
 * The superadmin bypass lives in the calling handler: when
 * `user.role === 'superadmin'`, skip this predicate entirely so the
 * query returns the global ticket set.
 *
 * The `EXISTS` sub-query is cheap because
 * `ticket_participants_admin_status_idx` covers
 * `(admin_user_id, status)` -- the planner reduces the check to an
 * index-only scan per ticket.
 */
export function buildTicketVisibilityCondition(adminUserId: string): SQL {
  // NOTE: we hand-write the EXISTS so we can correlate the subquery's
  // `ticket_id` to the outer `tickets.id` without Drizzle forcing a
  // self-join. `sql.raw` is intentionally avoided -- all interpolated
  // values go through parameters to prevent SQL injection even though
  // the input is a UUID from a trusted session.
  return sql`(
    ${schema.tickets.assignedTo} IS NULL
    OR EXISTS (
      SELECT 1
      FROM ${schema.ticketParticipants} AS p
      WHERE p.ticket_id = ${schema.tickets.id}
        AND p.admin_user_id = ${adminUserId}
        AND p.status IN ('active', 'pending')
    )
  )`;
}

// ---------------------------------------------------------------------------
// Participant listing for ticket detail pages
// ---------------------------------------------------------------------------

/**
 * Shape returned to the admin ticket detail page. Keep this flat and
 * serialisable -- no Date objects, no nested schema rows.
 */
export interface TicketParticipantSummary {
  readonly adminUserId: string;
  readonly displayName: string;
  readonly email: string;
  readonly adminRole: 'superadmin' | 'admin' | 'support';
  readonly role: 'assignee' | 'collaborator';
  readonly status: 'pending' | 'active' | 'declined' | 'removed';
  readonly muted: boolean;
  readonly invitedAt: string;
  readonly respondedAt: string | null;
  readonly expiresAt: string | null;
}

/**
 * Fetch the full participant list for a ticket, joined with admin user
 * metadata. Ordered assignee-first then by invite time so the UI can
 * render a stable list without client-side sorting.
 *
 * Includes `declined` and `removed` rows for audit/history context.
 * The UI decides whether to show them (collapsed by default).
 */
export async function listTicketParticipants(
  db: CrivacyDatabase,
  ticketId: string,
): Promise<readonly TicketParticipantSummary[]> {
  const rows = await db
    .select({
      adminUserId: schema.ticketParticipants.adminUserId,
      role: schema.ticketParticipants.role,
      status: schema.ticketParticipants.status,
      muted: schema.ticketParticipants.muted,
      invitedAt: schema.ticketParticipants.invitedAt,
      respondedAt: schema.ticketParticipants.respondedAt,
      expiresAt: schema.ticketParticipants.expiresAt,
      displayName: schema.adminUsers.displayName,
      email: schema.adminUsers.email,
      adminRole: schema.adminUsers.role,
    })
    .from(schema.ticketParticipants)
    .innerJoin(
      schema.adminUsers,
      eq(schema.ticketParticipants.adminUserId, schema.adminUsers.id),
    )
    .where(eq(schema.ticketParticipants.ticketId, ticketId))
    .orderBy(
      // assignee before collaborator by ordering on role ASC --
      // 'assignee' sorts before 'collaborator' alphabetically.
      schema.ticketParticipants.role,
      schema.ticketParticipants.invitedAt,
    );

  return rows.map((row) => ({
    adminUserId: row.adminUserId,
    displayName: row.displayName,
    email: row.email,
    adminRole: row.adminRole,
    role: row.role,
    status: row.status,
    muted: row.muted,
    invitedAt: row.invitedAt.toISOString(),
    respondedAt: row.respondedAt !== null ? row.respondedAt.toISOString() : null,
    expiresAt: row.expiresAt !== null ? row.expiresAt.toISOString() : null,
  }));
}
