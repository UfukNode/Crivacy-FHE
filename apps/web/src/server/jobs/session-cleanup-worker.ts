/**
 * Session cleanup worker — pg-boss scheduled job.
 *
 * Periodically deletes expired and revoked session rows from both
 * `sessions` (dashboard + admin) and `customer_sessions` tables.
 *
 * Rows are only deleted after a retention period (7 days past expiry)
 * to allow audit trail queries against recently-expired sessions.
 *
 * Schedule: every 6 hours via pg-boss cron.
 *
 * @module
 */

import type PgBoss from 'pg-boss';
import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';

/* ---------- Constants ---------- */

/** pg-boss queue name for session cleanup. */
export const SESSION_CLEANUP_QUEUE = 'session-cleanup';

/** Only delete sessions that expired more than 7 days ago. */
const RETENTION_DAYS = 7;

/* ---------- Types ---------- */

export interface SessionCleanupWorkerDeps {
  readonly db: CrivacyDatabase;
  readonly logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/* ---------- Worker ---------- */

/**
 * Register the session-cleanup job handler with pg-boss and schedule
 * it to run every 6 hours.
 */
export async function registerSessionCleanupWorker(
  boss: PgBoss,
  deps: SessionCleanupWorkerDeps,
): Promise<void> {
  // Ensure the queue exists (pg-boss v10 requires explicit creation
  // for queues that are only used with work() + schedule(), not send())
  await boss.createQueue(SESSION_CLEANUP_QUEUE);

  // Register the handler
  await boss.work(SESSION_CLEANUP_QUEUE, async () => {
    await cleanupExpiredSessions(deps);
  });

  // Schedule to run every 6 hours (pg-boss cron syntax)
  await boss.schedule(SESSION_CLEANUP_QUEUE, '0 */6 * * *', undefined, {
    tz: 'UTC',
  });

  deps.logger?.info('Session cleanup worker registered (every 6 hours)');
}

/**
 * Delete expired + revoked sessions older than the retention period.
 */
async function cleanupExpiredSessions(deps: SessionCleanupWorkerDeps): Promise<void> {
  const cutoff = sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`;

  // Delete from sessions (dashboard + admin)
  const dashboardResult = await deps.db.execute(
    sql`DELETE FROM sessions WHERE expires_at < ${cutoff}`,
  );

  // Delete from customer_sessions
  const customerResult = await deps.db.execute(
    sql`DELETE FROM customer_sessions WHERE expires_at < ${cutoff}`,
  );

  const dashboardDeleted = Number(dashboardResult.rowCount ?? 0);
  const customerDeleted = Number(customerResult.rowCount ?? 0);

  if (dashboardDeleted > 0 || customerDeleted > 0) {
    deps.logger?.info('Session cleanup completed', {
      dashboardDeleted,
      customerDeleted,
      retentionDays: RETENTION_DAYS,
    });
  }
}
