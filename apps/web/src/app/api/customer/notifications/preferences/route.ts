/**
 * GET  /api/customer/notifications/preferences, list notification preferences
 * PATCH /api/customer/notifications/preferences, update notification preferences
 *
 * Returns/updates per-event-type notification channel toggles for the current
 * customer. Security events cannot be disabled (returns 400 if attempted).
 *
 * Requires a valid customer session.
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import {
  NOTIFICATION_TYPES,
  isSecurityEvent,
} from '@/lib/notification';
import type { NotificationPreferenceItem, NotificationType } from '@/lib/notification';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseBody } from '@/server/middleware/parse';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export const GET = customerRoute({
  handler: async (ctx) => {
    const customerId = ctx.customer.id;

    // Fetch existing preferences for this customer
    const existingPrefs = await ctx.db
      .select({
        eventType: schema.notificationPreferences.eventType,
        channelInApp: schema.notificationPreferences.channelInApp,
        channelEmail: schema.notificationPreferences.channelEmail,
      })
      .from(schema.notificationPreferences)
      .where(
        and(
          eq(schema.notificationPreferences.userId, customerId),
          eq(schema.notificationPreferences.userType, 'customer'),
        ),
      );

    // Build a map of stored preferences
    const storedMap = new Map<string, { channelInApp: boolean; channelEmail: boolean }>();
    for (const pref of existingPrefs) {
      storedMap.set(pref.eventType, {
        channelInApp: pref.channelInApp,
        channelEmail: pref.channelEmail,
      });
    }

    // Build full preference list: default to true for types without a stored row
    const preferences: NotificationPreferenceItem[] = NOTIFICATION_TYPES.map((eventType) => {
      const stored = storedMap.get(eventType);
      if (stored !== undefined) {
        return {
          eventType,
          channelInApp: stored.channelInApp,
          channelEmail: stored.channelEmail,
        };
      }
      // Default: both channels enabled
      return {
        eventType,
        channelInApp: true,
        channelEmail: true,
      };
    });

    return ctx.json({ preferences });
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});

/**
 * PATCH body schema. The outer `preferences` array is capped at the
 * total number of notification types, sending more entries than the
 * catalogue contains is either a duplicate (which would just clobber
 * earlier writes) or a type that doesn't exist (caught by the enum).
 * The cap prevents a stolen-session attacker from submitting a
 * megabyte-sized preferences array to thrash the upsert loop.
 */
const NOTIFICATION_TYPE_ENUM = z.enum(NOTIFICATION_TYPES as readonly [NotificationType, ...NotificationType[]]);

const PreferencesBody = z.object({
  preferences: z
    .array(
      z
        .object({
          eventType: NOTIFICATION_TYPE_ENUM,
          channelInApp: z.boolean(),
          channelEmail: z.boolean(),
        })
        .strict(),
    )
    .max(NOTIFICATION_TYPES.length, 'Too many preferences submitted.'),
});

export const PATCH = customerRoute({
  handler: async (ctx) => {
    // --- 0. Per-IP rate limit. Legitimate users flip toggles a few
    //        times per session; 30/15min is generous headroom while
    //        still capping stolen-session write-amplification.
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'customer_notifications_preferences',
      ctx.ip,
      ctx.now,
    );
    if (limited) return limited;

    // --- 1. Parse body through the shared Zod pipeline. Replaces the
    //        old hand-rolled `typeof` validation for consistency with
    //        the rest of the settings endpoints.
    const body = await parseBody(ctx.request, PreferencesBody);
    const customerId = ctx.customer.id;

    // --- 2. Security-event guard. Certain event types represent
    //        account-integrity notifications the user is not allowed
    //        to silence (password change alerts etc.), reject if the
    //        submission tries to disable any channel on them.
    for (const pref of body.preferences) {
      if (isSecurityEvent(pref.eventType) && (!pref.channelInApp || !pref.channelEmail)) {
        return ctx.errorJson(
          'security_event_required',
          `Security event "${pref.eventType}" cannot be disabled.`,
          400,
        );
      }
    }

    // --- 3. Upsert each preference. The composite unique index on
    //        (user_id, user_type, event_type) means each row is
    //        either inserted or atomically updated in-place, two
    //        concurrent PATCH requests cannot produce duplicate rows.
    const now = ctx.now;
    for (const pref of body.preferences) {
      await ctx.db
        .insert(schema.notificationPreferences)
        .values({
          userId: customerId,
          userType: 'customer',
          eventType: pref.eventType,
          channelInApp: pref.channelInApp,
          channelEmail: pref.channelEmail,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.notificationPreferences.userId,
            schema.notificationPreferences.userType,
            schema.notificationPreferences.eventType,
          ],
          set: {
            channelInApp: pref.channelInApp,
            channelEmail: pref.channelEmail,
            updatedAt: now,
          },
        });
    }

    return ctx.json({ success: true });
  },
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
