/**
 * Notification creation — inserts a notification into the database after
 * checking user preferences. Security events always create a notification
 * regardless of preferences.
 *
 * @module
 */

import { and, eq } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import type { Notification } from '@/lib/db/schema';

import { isSecurityEvent } from './types';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateNotificationInput {
  /** Customer recipient (null if targeting firm_user or admin_user). */
  readonly customerId?: string | undefined;
  /** Firm user recipient (null if targeting customer or admin_user). */
  readonly firmUserId?: string | undefined;
  /** Admin user recipient (null if targeting customer or firm_user). */
  readonly adminUserId?: string | undefined;
  /** Notification type (e.g., 'credential.issued'). */
  readonly type: string;
  /** Short title shown in the bell dropdown. */
  readonly title: string;
  /** Longer body text with notification details. */
  readonly body: string;
  /** In-app navigation path (e.g., '/kyc' or '/tickets/CRV-00042'). */
  readonly link?: string | undefined;
}

// ---------------------------------------------------------------------------
// User type resolution
// ---------------------------------------------------------------------------

type UserTypeKey = 'customer' | 'firm_user' | 'admin_user';

function resolveRecipient(
  input: CreateNotificationInput,
): { userId: string; userType: UserTypeKey } | null {
  if (input.customerId !== undefined) {
    return { userId: input.customerId, userType: 'customer' };
  }
  if (input.firmUserId !== undefined) {
    return { userId: input.firmUserId, userType: 'firm_user' };
  }
  if (input.adminUserId !== undefined) {
    return { userId: input.adminUserId, userType: 'admin_user' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// createNotification
// ---------------------------------------------------------------------------

/**
 * Create an in-app notification for a user. Checks the
 * `notification_preferences` table before creating the notification — if the
 * user has disabled in-app notifications for this event type, the
 * notification is skipped (returns `null`).
 *
 * Security events (`session.new_device`, `password.changed`) always create a
 * notification regardless of user preferences.
 *
 * @returns The created notification row, or `null` if the notification was
 *          skipped due to user preferences.
 */
export async function createNotification(
  db: CrivacyDatabase,
  input: CreateNotificationInput,
): Promise<Notification | null> {
  const recipient = resolveRecipient(input);
  if (recipient === null) {
    throw new Error(
      'createNotification: exactly one of customerId, firmUserId, or adminUserId must be provided.',
    );
  }

  // Security events bypass preference checks
  if (!isSecurityEvent(input.type)) {
    // Check if the user has disabled in-app notifications for this event type
    const prefRows = await db
      .select({ channelInApp: schema.notificationPreferences.channelInApp })
      .from(schema.notificationPreferences)
      .where(
        and(
          eq(schema.notificationPreferences.userId, recipient.userId),
          eq(schema.notificationPreferences.userType, recipient.userType),
          eq(schema.notificationPreferences.eventType, input.type),
        ),
      )
      .limit(1);

    const pref = prefRows[0];
    // If a preference row exists and in_app is disabled, skip notification
    if (pref !== undefined && !pref.channelInApp) {
      return null;
    }
    // If no preference row exists, default is enabled (proceed)
  }

  // Insert the notification
  const insertedRows = await db
    .insert(schema.notifications)
    .values({
      customerId: input.customerId ?? null,
      firmUserId: input.firmUserId ?? null,
      adminUserId: input.adminUserId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
    })
    .returning();

  const inserted = insertedRows[0];
  if (inserted === undefined) {
    throw new Error('createNotification: insert returned no row.');
  }

  return inserted;
}
