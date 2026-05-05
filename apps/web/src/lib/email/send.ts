/**
 * Email send — enqueue via pg-boss.
 *
 * Does NOT send emails directly. Enqueues a pg-boss job that the
 * email worker processes. This ensures:
 * - Fire-and-forget from route handlers (no SMTP latency in request)
 * - Automatic retries with exponential backoff
 * - Rate limiting checked before enqueue
 *
 * @module
 */

import type PgBoss from 'pg-boss';
import type { CrivacyDatabase } from '@/lib/db/client';
import type { EmailConfig } from './config';
import type { EmailContent } from './templates';
import type { EmailType, RateLimitResult } from './rate-limit';
import { checkEmailRateLimit, recordEmailSent } from './rate-limit';

/* ---------- Constants ---------- */

/** pg-boss queue name for email jobs */
export const EMAIL_SEND_QUEUE = 'email-send';

/* ---------- Types ---------- */

/** Shape of the job payload for email-send queue */
export interface EmailSendJob {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly emailType: EmailType;
  readonly userId: string;
  readonly metadata?: Record<string, string> | undefined;
}

/* ---------- Enqueue ---------- */

/**
 * Enqueue an email for sending via pg-boss.
 *
 * Checks rate limits before enqueue. Returns rate limit result.
 * On success, records the email for future rate limit checks.
 *
 * @param boss - pg-boss instance
 * @param db - Database instance
 * @param config - Email config
 * @param params - Email parameters
 * @returns Rate limit result (allowed: true if enqueued)
 */
export async function enqueueEmail(
  boss: PgBoss,
  db: CrivacyDatabase,
  config: EmailConfig,
  params: {
    to: string;
    content: EmailContent;
    emailType: EmailType;
    userId: string;
    metadata?: Record<string, string>;
  },
  clock: () => Date = () => new Date(),
): Promise<RateLimitResult> {
  // Check rate limits first
  const rateCheck = await checkEmailRateLimit(db, config, params.userId, params.emailType, clock);
  if (!rateCheck.allowed) return rateCheck;

  // Enqueue the job
  const job: EmailSendJob = {
    to: params.to,
    subject: params.content.subject,
    html: params.content.html,
    text: params.content.text,
    emailType: params.emailType,
    userId: params.userId,
    metadata: params.metadata,
  };

  await boss.send(EMAIL_SEND_QUEUE, job, {
    retryLimit: 3,
    retryBackoff: true,
    retryDelay: 30, // seconds between retries
    expireInSeconds: 3600, // expire after 1 hour if not processed
  });

  // Record for rate limiting
  await recordEmailSent(db, params.userId, params.emailType, params.to, clock);

  return { allowed: true };
}
