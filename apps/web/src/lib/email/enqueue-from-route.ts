/**
 * Convenience helper: send or enqueue an email from a Next.js route handler.
 *
 * **Production:** Enqueues a pg-boss job. The email worker processes
 * it asynchronously with automatic retries and exponential backoff.
 *
 * **Dev mode:** Sends the email directly via nodemailer. The pg-boss
 * email worker only runs in production (started in `instrumentation.ts`),
 * so dev mode bypasses the queue entirely. This ensures emails arrive
 * immediately during local testing without requiring a background worker.
 *
 * Both modes check rate limits before sending/enqueueing.
 *
 * For high-throughput paths (e.g. webhook batches) the caller should
 * manage the boss instance directly to avoid per-request overhead.
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';
import { getRootLogger } from '@/lib/observability/logger';
import type { EmailContent } from './templates';
import type { EmailType, RateLimitResult } from './rate-limit';
import { tryBuildEmailConfig } from './config';
import { checkEmailRateLimit, recordEmailSent } from './rate-limit';
import { enqueueEmail } from './send';
import { getTransporter } from './client';

/**
 * Send or enqueue an email from a route handler.
 *
 * - **Dev:** sends directly via nodemailer (synchronous, no worker needed)
 * - **Production:** enqueues via pg-boss (async, worker processes)
 *
 * Silently no-ops if SMTP is not configured or DATABASE_URL is missing.
 *
 * @returns RateLimitResult if sent/enqueued, null if email system is unavailable
 */
export async function enqueueEmailFromRoute(
  db: CrivacyDatabase,
  params: {
    to: string;
    content: EmailContent;
    emailType: EmailType;
    userId: string;
    metadata?: Record<string, string>;
  },
): Promise<RateLimitResult | null> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) return null;

  const config = tryBuildEmailConfig(process.env as Record<string, string | undefined>);
  if (!config) {
    getRootLogger().info(
      { event: 'email_smtp_not_configured' },
      'SMTP not configured, skipping email',
    );
    return null;
  }

  // --- Dev mode: direct send (no pg-boss worker in dev) ---
  if (process.env.NODE_ENV !== 'production') {
    const rateCheck = await checkEmailRateLimit(db, config, params.userId, params.emailType);
    if (!rateCheck.allowed) return rateCheck;

    try {
      const transporter = await getTransporter(config);
      await transporter.sendMail({
        from: config.from,
        replyTo: config.replyTo,
        to: params.to,
        subject: params.content.subject,
        html: params.content.html,
        text: params.content.text,
      });

      await recordEmailSent(db, params.userId, params.emailType, params.to);
      getRootLogger().info(
        {
          event: 'email_direct_send_success',
          emailType: params.emailType,
          toMasked: params.to.replace(/(.{2}).*@/, '$1***@'),
        },
        'Email sent directly (dev mode)',
      );
      return { allowed: true };
    } catch (err) {
      getRootLogger().error(
        {
          event: 'email_direct_send_failed',
          emailType: params.emailType,
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        },
        'Email direct send failed (dev mode)',
      );
      return null;
    }
  }

  // --- Production: enqueue via pg-boss ---
  const { createQueueClient } = await import('@/server/jobs/queue');
  const boss = await createQueueClient(connectionString);
  try {
    return await enqueueEmail(boss, db, config, params);
  } finally {
    await boss.stop();
  }
}
