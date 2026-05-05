/**
 * Notification query functions — list, count unread, mark read.
 *
 * All queries are scoped by user ID + user type. Cursor-based pagination
 * uses the `created_at` timestamp of the last item as the cursor.
 *
 * @module
 */

import { and, count, desc, eq, isNull, lt, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

import type { NotificationItem } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UserType = 'customer' | 'firm_user' | 'admin_user';

export interface ListNotificationsOptions {
  /** ISO 8601 timestamp cursor — fetch notifications created before this. */
  readonly cursor?: string | undefined;
  /** Page size. Defaults to 20, max 50. */
  readonly limit?: number | undefined;
}

export interface ListNotificationsResult {
  readonly notifications: readonly NotificationItem[];
  readonly nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the user-id column filter based on user type. */
function userColumn(userType: UserType) {
  switch (userType) {
    case 'customer':
      return schema.notifications.customerId;
    case 'firm_user':
      return schema.notifications.firmUserId;
    case 'admin_user':
      return schema.notifications.adminUserId;
  }
}

function mapRow(row: typeof schema.notifications.$inferSelect): NotificationItem {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    readAt: row.readAt !== null ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit < 1) return 20;
  return Math.min(limit, 50);
}

// ---------------------------------------------------------------------------
// listNotifications
// ---------------------------------------------------------------------------

/**
 * List notifications for a user with cursor-based pagination.
 * Returns up to `limit` notifications ordered by `created_at DESC`.
 */
export async function listNotifications(
  db: CrivacyDatabase,
  userId: string,
  userType: UserType,
  opts?: ListNotificationsOptions,
): Promise<ListNotificationsResult> {
  const limit = clampLimit(opts?.limit);
  const col = userColumn(userType);

  const conditions = [eq(col, userId)];

  // Cursor: fetch notifications created strictly before the cursor timestamp
  if (opts?.cursor !== undefined && opts.cursor.length > 0) {
    const cursorDate = new Date(opts.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conditions.push(lt(schema.notifications.createdAt, cursorDate));
    }
  }

  const rows = await db
    .select()
    .from(schema.notifications)
    .where(and(...conditions))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow !== undefined
    ? lastRow.createdAt.toISOString()
    : null;

  return {
    notifications: pageRows.map(mapRow),
    nextCursor,
  };
}

// ---------------------------------------------------------------------------
// unreadCount
// ---------------------------------------------------------------------------

/**
 * Count unread notifications for a user (where `read_at IS NULL`).
 */
export async function unreadCount(
  db: CrivacyDatabase,
  userId: string,
  userType: UserType,
): Promise<number> {
  const col = userColumn(userType);

  const result = await db
    .select({ value: count() })
    .from(schema.notifications)
    .where(and(eq(col, userId), isNull(schema.notifications.readAt)));

  return result[0]?.value ?? 0;
}

// ---------------------------------------------------------------------------
// markRead
// ---------------------------------------------------------------------------

/**
 * Mark a single notification as read. Verifies ownership before updating.
 * Silently succeeds if the notification is already read or does not exist
 * (ownership mismatch).
 */
export async function markRead(
  db: CrivacyDatabase,
  notificationId: string,
  userId: string,
  userType: UserType,
): Promise<void> {
  const col = userColumn(userType);

  await db
    .update(schema.notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(schema.notifications.id, notificationId),
        eq(col, userId),
        isNull(schema.notifications.readAt),
      ),
    );
}

// ---------------------------------------------------------------------------
// markAllRead
// ---------------------------------------------------------------------------

/**
 * Mark all unread notifications as read for a user.
 */
export async function markAllRead(
  db: CrivacyDatabase,
  userId: string,
  userType: UserType,
): Promise<void> {
  const col = userColumn(userType);

  await db
    .update(schema.notifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(col, userId), isNull(schema.notifications.readAt)));
}
