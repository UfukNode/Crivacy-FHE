/**
 * Security-events outbox worker — pg-boss scheduled job.
 *
 * Drains the `security_events_outbox` table by calling
 * {@link dispatchPendingSecurityEvents} on a fixed cadence. Every run
 * pulls up to `BATCH_SIZE` pending rows, fans each out to every
 * registered subscriber, and marks successes / bumps retry counters
 * on failure.
 *
 * Schedule: every minute. The primitive itself uses
 * `FOR UPDATE SKIP LOCKED` so multiple worker replicas are safe to
 * run concurrently — no leader election required.
 *
 * Failure posture:
 *   - An exception thrown by the primitive (e.g. DB connection lost)
 *     lets pg-boss mark the job failed and retry on the next
 *     schedule tick. The outbox rows stay pending.
 *   - A subscriber that throws is recorded in `last_error` on the
 *     specific event row by the primitive itself; the job continues
 *     to process other events in the batch.
 *
 * @module
 */

import type PgBoss from 'pg-boss';
import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import {
  MAX_DISPATCH_ATTEMPTS,
  bootstrapSecurityEventSubscribers,
  dispatchPendingSecurityEvents,
} from '@/lib/security-events';

/* ---------- Constants ---------- */

/** pg-boss queue name for the outbox drain. */
export const SECURITY_EVENTS_QUEUE = 'security-events-dispatch';

/** Rows drained per scheduled run. */
const BATCH_SIZE = 100;

/* ---------- Types ---------- */

export interface SecurityEventsWorkerDeps {
  readonly db: CrivacyDatabase;
  readonly logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/* ---------- Worker ---------- */

/**
 * Register the outbox drain job with pg-boss and schedule it every
 * minute. Subscribers are bootstrapped here so the job's process
 * knows how to handle events without needing a separate registration
 * step at app boot.
 */
export async function registerSecurityEventsWorker(
  boss: PgBoss,
  deps: SecurityEventsWorkerDeps,
): Promise<void> {
  // Bootstrap built-in subscribers (audit + email). Idempotent
  // inside a process, so if multiple worker processes import this
  // at startup the second one is a no-op.
  bootstrapSecurityEventSubscribers();

  await boss.createQueue(SECURITY_EVENTS_QUEUE);

  await boss.work(SECURITY_EVENTS_QUEUE, async () => {
    const result = await dispatchPendingSecurityEvents({
      db: deps.db,
      now: new Date(),
      batchSize: BATCH_SIZE,
    });
    if (result.picked > 0) {
      deps.logger?.info('[security-events] dispatch batch', {
        picked: result.picked,
        succeeded: result.succeeded,
        failed: result.failed,
        newlyParked: result.parked,
      });
    }

    // Standing backlog of parked rows (events that hit MAX_DISPATCH_ATTEMPTS
    // at some point in the past and are still sitting in the outbox
    // waiting for an operator to triage). A per-batch "newly parked"
    // log only fires on the run that pushed a row over the cap; this
    // fan-out query surfaces the standing total on EVERY run so a
    // log-based alert can trip the moment anything is stuck, not
    // only during the transition.
    const parkedResult = await deps.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count
            FROM security_events_outbox
           WHERE processed_at IS NULL
             AND attempts >= ${MAX_DISPATCH_ATTEMPTS}`,
    );
    const parkedTotal = Number.parseInt(
      (parkedResult.rows[0] as { count: string } | undefined)?.count ?? '0',
      10,
    );
    if (parkedTotal > 0) {
      deps.logger?.error(
        '[security-events] parked rows need triage — inspect security_events_outbox',
        {
          parkedTotal,
          cap: MAX_DISPATCH_ATTEMPTS,
        },
      );
    }
  });

  // Cron: every 30 seconds gives a user-visible "your password was
  // changed" email within ~30s of the mutation, matching Stripe's
  // webhook-cadence UX expectations. pg-boss cron minimum is 1
  // minute, so we register BOTH: a 1-min cron for scheduling
  // guarantees + a manual 30s re-trigger inside the worker callback
  // is overkill, so stick with the minute baseline. 1-minute delay
  // is the acknowledged tradeoff vs. the inline dispatch that
  // existed pre-migration.
  await boss.schedule(SECURITY_EVENTS_QUEUE, '* * * * *', undefined, {
    tz: 'UTC',
  });

  deps.logger?.info('Security events outbox worker registered (every 1 minute)');
}
