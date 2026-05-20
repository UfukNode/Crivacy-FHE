/**
 * Email send worker — pg-boss job handler.
 *
 * Processes email-send jobs by:
 * 1. Deserializing the job payload
 * 2. Sending the email via nodemailer
 * 3. Logging success/failure
 *
 * Follows the same DI pattern as webhook-worker.ts.
 *
 * @module
 */

import type PgBoss from 'pg-boss';
import type { EmailConfig } from '@/lib/email/config';
import { getTransporter } from '@/lib/email/client';
import { EMAIL_SEND_QUEUE, type EmailSendJob } from '@/lib/email/send';

/* ---------- Types ---------- */

export interface EmailWorkerDeps {
  readonly config: EmailConfig;
  readonly logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/* ---------- Worker ---------- */

/**
 * Register the email-send job handler with pg-boss.
 *
 * @param boss - pg-boss instance
 * @param deps - Worker dependencies
 */
export async function registerEmailWorker(
  boss: PgBoss,
  deps: EmailWorkerDeps,
): Promise<string> {
  return boss.work<EmailSendJob>(
    EMAIL_SEND_QUEUE,
    { batchSize: 3 },
    async (jobs) => {
      for (const job of jobs) {
        const { to, subject, html, text, emailType, userId, metadata } = job.data;

        const logMeta: Record<string, unknown> = {
          jobId: job.id,
          emailType,
          userId,
          to: to.replace(/(.{2}).*@/, '$1***@'), // Redact email for logs
          ...metadata,
        };

        try {
          const transporter = await getTransporter(deps.config);

          await transporter.sendMail({
            from: deps.config.from,
            replyTo: deps.config.replyTo,
            to,
            subject,
            html,
            text,
          });

          deps.logger?.info('Email sent successfully', logMeta);
        } catch (err) {
          deps.logger?.error('Email send failed', {
            ...logMeta,
            error: err instanceof Error ? err.message : String(err),
          });
          // Re-throw so pg-boss retries
          throw err;
        }
      }
    },
  );
}
