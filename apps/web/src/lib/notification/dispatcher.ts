/**
 * Central notification dispatcher — in-app + email delivery in one call.
 *
 * This module replaces ad-hoc `createNotification` + `enqueueEmailFromRoute`
 * chains scattered across handlers. Every notification call-site should
 * funnel through `notify` (single recipient) or `notifyBulk` (fan-out).
 *
 * What the dispatcher guarantees:
 *
 *   1. `notification_preferences` honoured for BOTH channels —
 *      `channelInApp` is checked inside {@link createNotification}, and
 *      `channelEmail` is checked here before enqueueing any email. This
 *      closes the prior gap where user email preferences were ignored.
 *   2. Security events (see {@link SECURITY_EVENT_TYPES}) bypass preferences
 *      for both channels and are always delivered.
 *   3. Missing email address (wallet-only customers, firm/admin rows without
 *      a usable address) gracefully skips the email channel; in-app delivery
 *      is still attempted.
 *   4. Email rate limiting stays centralised in `enqueueEmailFromRoute`.
 *   5. The dispatcher is non-throwing: any failure is logged and returned as
 *      a boolean result so callers never have to wrap it in try/catch to
 *      protect the primary action (ticket reply, status change, etc.).
 *
 * The public API intentionally keeps the email channel provider-agnostic —
 * callers supply an `EmailContent` builder so the dispatcher never imports
 * individual templates. If the system later grows to SMS/push/webhook
 * channels, they can be added here without touching the callers.
 *
 * @module
 */

import { and, eq } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { getRootLogger } from '@/lib/observability/logger';
import type { EmailType } from '@/lib/email/rate-limit';
import type { EmailContent } from '@/lib/email/templates';
import { createNotification } from './create';
import { type NotificationType, isSecurityEvent } from './types';

/* ---------- Public types ---------- */

/**
 * Discriminated recipient reference. The dispatcher resolves the recipient's
 * contact information (email, display name) from the corresponding user
 * table so callers never have to pre-fetch or pass redundant data.
 */
export type RecipientRef =
  | { readonly type: 'customer'; readonly customerId: string }
  | { readonly type: 'firm_user'; readonly firmUserId: string }
  | { readonly type: 'admin_user'; readonly adminUserId: string };

/** Content used for the in-app (bell dropdown) notification. */
export interface InAppContent {
  readonly title: string;
  readonly body: string;
  readonly link?: string;
}

/** Resolved contact payload passed to the email builder. */
export interface ResolvedContact {
  readonly email: string;
  /** Falls back to the email local-part when no display name is stored. */
  readonly displayName: string;
}

/**
 * Email channel configuration. The builder receives the recipient's resolved
 * contact so the template can personalise greeting / subject without
 * forcing callers to fetch user rows themselves.
 */
export interface EmailChannel {
  readonly emailType: EmailType;
  readonly build: (contact: ResolvedContact) => EmailContent;
}

export interface NotifyInput {
  readonly eventType: NotificationType;
  readonly recipient: RecipientRef;
  readonly inApp: InAppContent;
  /** Omit to deliver in-app only. */
  readonly email?: EmailChannel;
}

export interface NotifyBulkInput {
  readonly eventType: NotificationType;
  readonly recipients: readonly RecipientRef[];
  readonly inApp: InAppContent;
  /** Omit to deliver in-app only. */
  readonly email?: EmailChannel;
}

export interface NotifyResult {
  readonly notificationCreated: boolean;
  readonly emailEnqueued: boolean;
}

/* ---------- Internal helpers ---------- */

type UserTypeKey = 'customer' | 'firm_user' | 'admin_user';

interface ResolvedRecipient {
  readonly userId: string;
  readonly userType: UserTypeKey;
  readonly email: string | null;
  readonly displayName: string | null;
}

/**
 * Fetches the recipient's email + display name in a single indexed PK lookup.
 * Returns `null` if the underlying row is missing (race with deletion).
 */
async function resolveRecipient(
  db: CrivacyDatabase,
  recipient: RecipientRef,
): Promise<ResolvedRecipient | null> {
  if (recipient.type === 'customer') {
    const rows = await db
      .select({
        email: schema.customers.email,
        displayName: schema.customers.displayName,
      })
      .from(schema.customers)
      .where(eq(schema.customers.id, recipient.customerId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      userId: recipient.customerId,
      userType: 'customer',
      email: row.email,
      displayName: row.displayName,
    };
  }

  if (recipient.type === 'firm_user') {
    // firm_users has no display_name column — we fall back to email local-part
    const rows = await db
      .select({ email: schema.firmUsers.email })
      .from(schema.firmUsers)
      .where(eq(schema.firmUsers.id, recipient.firmUserId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      userId: recipient.firmUserId,
      userType: 'firm_user',
      email: row.email,
      displayName: null,
    };
  }

  // admin_user
  const rows = await db
    .select({
      email: schema.adminUsers.email,
      displayName: schema.adminUsers.displayName,
    })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, recipient.adminUserId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    userId: recipient.adminUserId,
    userType: 'admin_user',
    email: row.email,
    displayName: row.displayName,
  };
}

/**
 * Checks `notification_preferences.channelEmail` for the given recipient +
 * event type. Security events bypass the preference and always return `true`
 * so critical alerts (new device, password changed, account status change)
 * cannot be silently suppressed by a misconfigured preference row.
 *
 * Default when no preference row exists: `true` (enabled) — mirrors the DB
 * column default.
 */
async function isEmailAllowed(
  db: CrivacyDatabase,
  userId: string,
  userType: UserTypeKey,
  eventType: string,
): Promise<boolean> {
  if (isSecurityEvent(eventType)) return true;

  const rows = await db
    .select({ channelEmail: schema.notificationPreferences.channelEmail })
    .from(schema.notificationPreferences)
    .where(
      and(
        eq(schema.notificationPreferences.userId, userId),
        eq(schema.notificationPreferences.userType, userType),
        eq(schema.notificationPreferences.eventType, eventType),
      ),
    )
    .limit(1);

  const pref = rows[0];
  return pref === undefined || pref.channelEmail;
}

/**
 * Translates a {@link RecipientRef} into the recipient-discriminant fields
 * expected by {@link createNotification}.
 */
function recipientToCreateArgs(
  recipient: RecipientRef,
): { customerId?: string; firmUserId?: string; adminUserId?: string } {
  switch (recipient.type) {
    case 'customer':
      return { customerId: recipient.customerId };
    case 'firm_user':
      return { firmUserId: recipient.firmUserId };
    case 'admin_user':
      return { adminUserId: recipient.adminUserId };
  }
}

/* ---------- Public API ---------- */

/**
 * Dispatch an in-app notification (and optional email) to a single recipient.
 *
 * The call is non-throwing. Preference checks, rate limits, and missing
 * contact details cause individual channels to be skipped — the returned
 * {@link NotifyResult} reports exactly what was delivered.
 */
export async function notify(
  db: CrivacyDatabase,
  input: NotifyInput,
): Promise<NotifyResult> {
  let notificationCreated = false;
  let emailEnqueued = false;

  try {
    const resolved = await resolveRecipient(db, input.recipient);
    if (resolved === null) {
      // Row missing (deleted between action and dispatch) — skip silently.
      return { notificationCreated: false, emailEnqueued: false };
    }

    // 1. In-app channel — createNotification enforces channelInApp + security bypass.
    const notification = await createNotification(db, {
      ...recipientToCreateArgs(input.recipient),
      type: input.eventType,
      title: input.inApp.title,
      body: input.inApp.body,
      ...(input.inApp.link !== undefined && { link: input.inApp.link }),
    });
    notificationCreated = notification !== null;

    // 2. Email channel — only if requested, allowed, and recipient is reachable.
    if (input.email !== undefined && resolved.email !== null) {
      const allowed = await isEmailAllowed(
        db,
        resolved.userId,
        resolved.userType,
        input.eventType,
      );
      if (allowed) {
        const localPart = resolved.email.split('@')[0] ?? 'there';
        const displayName = resolved.displayName ?? localPart;
        const content = input.email.build({ email: resolved.email, displayName });

        const result = await enqueueEmailFromRoute(db, {
          to: resolved.email,
          content,
          emailType: input.email.emailType,
          userId: resolved.userId,
        });
        emailEnqueued = result !== null && result.allowed;
      }
    }
  } catch (err) {
    // Non-throwing: log and keep going. Notifications must never block the
    // primary action that triggered them.
    getRootLogger().error(
      {
        event: 'notify_failed',
        eventType: input.eventType,
        recipientType: input.recipient.type,
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'notification dispatch failed',
    );
  }

  return { notificationCreated, emailEnqueued };
}

/**
 * Fan-out variant of {@link notify}. Runs recipients sequentially so that the
 * per-user email rate limiter sees one request at a time and each recipient
 * is independently governed by its own preferences.
 *
 * Typical N for this helper is small (a handful of admins or firm members);
 * if a large fan-out is ever needed it should go through a queued worker,
 * not this synchronous path.
 */
export async function notifyBulk(
  db: CrivacyDatabase,
  input: NotifyBulkInput,
): Promise<NotifyResult[]> {
  const results: NotifyResult[] = [];
  for (const recipient of input.recipients) {
    const result = await notify(db, {
      eventType: input.eventType,
      recipient,
      inApp: input.inApp,
      ...(input.email !== undefined && { email: input.email }),
    });
    results.push(result);
  }
  return results;
}
