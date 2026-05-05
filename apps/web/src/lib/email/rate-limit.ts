/**
 * Email rate limiting — per-user, per-type, sliding window.
 *
 * Uses email_send_log table for tracking.
 * Two limits:
 * 1. Max N emails per user per hour (all types)
 * 2. Max M resends per type per 15 minutes (verification, reset)
 *
 * @module
 */

import { sql } from 'drizzle-orm';
import type { CrivacyDatabase } from '@/lib/db/client';
import type { EmailConfig } from './config';

/* ---------- Types ---------- */

export type EmailType = 'verification' | 'password_reset' | 'welcome' | 'ticket_update' | 'login_alert' | 'notification' | 'account_status';

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly retryAfterSeconds?: number;
}

/* ---------- Check ---------- */

/**
 * Check if sending an email to this user is allowed.
 *
 * @param db - Database instance
 * @param config - Email config with limits
 * @param userId - Customer or firm user ID
 * @param emailType - Type of email being sent
 * @param clock - Clock function for testing
 */
export async function checkEmailRateLimit(
  db: CrivacyDatabase,
  config: EmailConfig,
  userId: string,
  emailType: EmailType,
  clock: () => Date = () => new Date(),
): Promise<RateLimitResult> {
  const now = clock();

  // 1. Check per-user per-hour limit
  const oneHourAgo = new Date(now.getTime() - 3600000);
  const hourlyResult = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM email_send_log WHERE user_id = ${userId} AND created_at > ${oneHourAgo.toISOString()}`,
  );
  const hourlyRow = hourlyResult.rows[0] as { count: string } | undefined;
  const hourlyCount = parseInt(hourlyRow?.count ?? '0', 10);

  if (hourlyCount >= config.maxPerUserPerHour) {
    return {
      allowed: false,
      reason: 'Too many emails sent. Please try again later.',
      retryAfterSeconds: 3600,
    };
  }

  // 2. Check per-type per-window limit (15 min for verification/reset resends)
  if (emailType === 'verification' || emailType === 'password_reset') {
    const windowAgo = new Date(now.getTime() - 900000); // 15 minutes
    const windowResult = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM email_send_log WHERE user_id = ${userId} AND email_type = ${emailType} AND created_at > ${windowAgo.toISOString()}`,
    );
    const windowRow = windowResult.rows[0] as { count: string } | undefined;
    const windowCount = parseInt(windowRow?.count ?? '0', 10);

    if (windowCount >= config.maxResendsPerWindow) {
      return {
        allowed: false,
        reason: 'Please wait before requesting another email.',
        retryAfterSeconds: 900,
      };
    }
  }

  return { allowed: true };
}

/**
 * Record a sent email for rate limiting.
 */
export async function recordEmailSent(
  db: CrivacyDatabase,
  userId: string,
  emailType: EmailType,
  recipientEmail: string,
  clock: () => Date = () => new Date(),
): Promise<void> {
  const now = clock();
  await db.execute(
    sql`INSERT INTO email_send_log (id, user_id, email_type, recipient_email, created_at)
     VALUES (gen_random_uuid(), ${userId}, ${emailType}, ${recipientEmail}, ${now.toISOString()})`,
  );
}
