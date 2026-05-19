/**
 * Shared helpers used by every ticket handler surface — customer,
 * admin, and firm. Each handler file used to carry its own copy of
 * these utilities; the drift risk (row-shape changes on one side but
 * not the other) is why they live in one place now.
 *
 * Pure mapping functions + stateless DB utilities. No middleware,
 * no context-specific logic — that stays in the individual handler
 * files.
 *
 * @module
 */

import { eq, isNull } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import { generateReferenceNumber } from '@/lib/ticket/reference';

const MAX_REFERENCE_RETRIES = 10;

/**
 * Project a raw `tickets` row to the JSON shape every ticket
 * endpoint returns. Timestamps are ISO-serialised so the API is
 * consistent regardless of which side called — customer / admin /
 * firm tickets share the same wire format.
 */
export function mapTicketRowShared(row: typeof schema.tickets.$inferSelect) {
  return {
    id: row.id,
    referenceNumber: row.referenceNumber,
    categoryId: row.categoryId,
    creatorId: row.creatorId,
    creatorType: row.creatorType,
    firmId: row.firmId,
    assignedTo: row.assignedTo,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    resolvedAt: row.resolvedAt !== null ? row.resolvedAt.toISOString() : null,
    closedAt: row.closedAt !== null ? row.closedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as const;
}

/**
 * Project a raw `ticket_messages` row to the JSON response shape.
 * `senderName` is resolved by the caller (they own the JOIN) and
 * passed in — this mapper stays stateless.
 */
export function mapMessageRowShared(
  row: typeof schema.ticketMessages.$inferSelect,
  senderName: string | null = null,
) {
  return {
    id: row.id,
    ticketId: row.ticketId,
    senderId: row.senderId,
    senderType: row.senderType,
    senderName,
    body: row.body,
    isInternal: row.isInternal,
    seenByOther: row.seenByOther,
    editedAt: row.editedAt !== null ? row.editedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  } as const;
}

/**
 * Generate a unique reference number (`CRV-XXXXX`). Retries up to
 * {@link MAX_REFERENCE_RETRIES} times to dodge collisions; returns
 * `null` if every attempt lost the race — callers surface that as a
 * 500 so the customer / firm user sees a clean error rather than a
 * silent retry storm.
 */
export async function generateUniqueReferenceShared(
  db: CrivacyDatabase,
): Promise<string | null> {
  for (let i = 0; i < MAX_REFERENCE_RETRIES; i += 1) {
    const ref = generateReferenceNumber();
    const hit = await db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(eq(schema.tickets.referenceNumber, ref))
      .limit(1);
    if (hit.length === 0) return ref;
  }
  return null;
}

/**
 * All active (non-locked) admin user IDs. Used by any ticket flow
 * that needs to fan a notification out to the entire admin team
 * (new ticket, unassigned customer reply).
 */
export async function fetchActiveAdminIdsShared(
  db: CrivacyDatabase,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: schema.adminUsers.id })
    .from(schema.adminUsers)
    .where(isNull(schema.adminUsers.lockedAt));
  return rows.map((r) => r.id);
}

/**
 * Trim a message body down to an email-safe preview. Used in every
 * `ticket_update`-category email template.
 */
export function truncateForEmailShared(body: string, max = 280): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max - 1)}…`;
}
