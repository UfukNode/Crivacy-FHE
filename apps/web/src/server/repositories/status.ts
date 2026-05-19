/**
 * Public status page repository — DB queries for /status and /api/v1/status.
 *
 * All functions take a `CrivacyDatabase` handle and return plain readonly
 * objects. No business logic — that lives in `@/lib/status/`.
 *
 * @module
 */

import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import {
  statusComponents,
  statusHistory,
  statusIncidents,
  statusSubscribers,
} from '@/lib/db/schema/status';

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export interface PublicComponentRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly groupName: string | null;
  readonly currentState: string;
  readonly updatedAt: Date;
}

/**
 * List all status components in display order (grouped by group_name, then position).
 */
export async function listPublicComponents(
  db: CrivacyDatabase,
): Promise<readonly PublicComponentRow[]> {
  return db
    .select({
      id: statusComponents.id,
      slug: statusComponents.slug,
      name: statusComponents.name,
      description: statusComponents.description,
      groupName: statusComponents.groupName,
      currentState: statusComponents.currentState,
      updatedAt: statusComponents.updatedAt,
    })
    .from(statusComponents)
    .orderBy(asc(statusComponents.groupName), asc(statusComponents.position));
}

// ---------------------------------------------------------------------------
// History (for 90-day uptime computation)
// ---------------------------------------------------------------------------

export interface HistoryRow {
  readonly componentId: string;
  readonly state: string;
  readonly ts: Date;
}

/**
 * Fetch status history entries for all components within the last `days` days.
 * Sorted ascending by ts for uptime computation.
 */
export async function listHistoryForUptime(
  db: CrivacyDatabase,
  days: number,
  now: Date,
): Promise<readonly HistoryRow[]> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  return db
    .select({
      componentId: statusHistory.componentId,
      state: statusHistory.state,
      ts: statusHistory.ts,
    })
    .from(statusHistory)
    .where(gte(statusHistory.ts, cutoff))
    .orderBy(asc(statusHistory.ts));
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export interface PublicIncidentRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly status: string;
  readonly componentIds: string[];
  readonly updatesTimeline: unknown;
  readonly startedAt: Date;
  readonly identifiedAt: Date | null;
  readonly monitoringAt: Date | null;
  readonly resolvedAt: Date | null;
}

/**
 * List published incidents from the last `days` days, newest first.
 */
export async function listPublicIncidents(
  db: CrivacyDatabase,
  days: number,
  now: Date,
): Promise<readonly PublicIncidentRow[]> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  return db
    .select({
      id: statusIncidents.id,
      title: statusIncidents.title,
      body: statusIncidents.body,
      severity: statusIncidents.severity,
      status: statusIncidents.status,
      componentIds: statusIncidents.componentIds,
      updatesTimeline: statusIncidents.updatesTimeline,
      startedAt: statusIncidents.startedAt,
      identifiedAt: statusIncidents.identifiedAt,
      monitoringAt: statusIncidents.monitoringAt,
      resolvedAt: statusIncidents.resolvedAt,
    })
    .from(statusIncidents)
    .where(and(eq(statusIncidents.published, true), gte(statusIncidents.startedAt, cutoff)))
    .orderBy(desc(statusIncidents.startedAt));
}

// ---------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------

export interface SubscribeResult {
  readonly id: string;
  readonly confirmToken: string;
  readonly isNew: boolean;
}

/**
 * Subscribe an email to status updates. If the email already exists,
 * return the existing row (idempotent).
 */
export async function subscribeEmail(
  db: CrivacyDatabase,
  email: string,
  componentIds: string[],
): Promise<SubscribeResult> {
  // Check existing first (case-insensitive)
  const existing = await db
    .select({
      id: statusSubscribers.id,
      confirmToken: statusSubscribers.confirmToken,
      unsubscribedAt: statusSubscribers.unsubscribedAt,
    })
    .from(statusSubscribers)
    .where(eq(sql`lower(${statusSubscribers.email})`, email.toLowerCase()))
    .limit(1);

  const row = existing[0];
  if (row !== undefined) {
    // If previously unsubscribed, re-enable
    if (row.unsubscribedAt !== null) {
      await db
        .update(statusSubscribers)
        .set({
          unsubscribedAt: null,
          componentIds,
        })
        .where(eq(statusSubscribers.id, row.id));
    }
    return { id: row.id, confirmToken: row.confirmToken, isNew: false };
  }

  // Create new subscriber
  const result = await db
    .insert(statusSubscribers)
    .values({
      email: email.toLowerCase(),
      componentIds,
    })
    .returning({
      id: statusSubscribers.id,
      confirmToken: statusSubscribers.confirmToken,
    });
  const inserted = result[0];
  if (inserted === undefined) throw new Error('Failed to insert subscriber');
  return { ...inserted, isNew: true };
}

/**
 * Confirm a subscription via the confirm token.
 */
export async function confirmSubscription(db: CrivacyDatabase, token: string): Promise<boolean> {
  const result = await db
    .update(statusSubscribers)
    .set({ confirmedAt: new Date() })
    .where(and(eq(statusSubscribers.confirmToken, token), isNull(statusSubscribers.confirmedAt)))
    .returning({ id: statusSubscribers.id });
  return result.length > 0;
}

/**
 * Unsubscribe via the unsubscribe token.
 */
export async function unsubscribeByToken(db: CrivacyDatabase, token: string): Promise<boolean> {
  const result = await db
    .update(statusSubscribers)
    .set({ unsubscribedAt: new Date() })
    .where(
      and(eq(statusSubscribers.unsubscribeToken, token), isNull(statusSubscribers.unsubscribedAt)),
    )
    .returning({ id: statusSubscribers.id });
  return result.length > 0;
}

/**
 * List confirmed, active subscribers (for email notification).
 */
export async function listActiveSubscribers(
  db: CrivacyDatabase,
): Promise<readonly { id: string; email: string; componentIds: string[] }[]> {
  return db
    .select({
      id: statusSubscribers.id,
      email: statusSubscribers.email,
      componentIds: statusSubscribers.componentIds,
    })
    .from(statusSubscribers)
    .where(and(isNotNull(statusSubscribers.confirmedAt), isNull(statusSubscribers.unsubscribedAt)));
}
