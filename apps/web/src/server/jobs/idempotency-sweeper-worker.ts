/**
 * Idempotency-keys sweeper — pg-boss scheduled job.
 *
 * The `idempotency_keys` table grows forever otherwise: every
 * successful state-changing request caches a row with a 24h TTL, but
 * the TTL check is only consulted by readers (who skip expired rows).
 * Nothing DELETEs them.
 *
 * This worker runs every 6 hours and drops rows past their
 * `expires_at` window. Identical structure to the session-cleanup
 * worker — same retention posture, same failure handling.
 *
 * @module
 */

import type PgBoss from 'pg-boss';
import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';

/** pg-boss queue name for the idempotency sweeper. */
export const IDEMPOTENCY_SWEEPER_QUEUE = 'idempotency-sweeper';

export interface IdempotencySweeperDeps {
  readonly db: CrivacyDatabase;
  readonly logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export async function registerIdempotencySweeperWorker(
  boss: PgBoss,
  deps: IdempotencySweeperDeps,
): Promise<void> {
  await boss.createQueue(IDEMPOTENCY_SWEEPER_QUEUE);

  await boss.work(IDEMPOTENCY_SWEEPER_QUEUE, async () => {
    await sweepExpiredIdempotencyKeys(deps);
  });

  // Every 6 hours, same cadence as session-cleanup. Higher than
  // necessary for table-size but the operation is cheap and the
  // workload is off-peak.
  await boss.schedule(IDEMPOTENCY_SWEEPER_QUEUE, '0 */6 * * *', undefined, {
    tz: 'UTC',
  });

  deps.logger?.info('Idempotency sweeper registered (every 6 hours)');
}

async function sweepExpiredIdempotencyKeys(deps: IdempotencySweeperDeps): Promise<void> {
  try {
    const result = await deps.db.execute<{ deleted: string }>(
      sql`WITH deleted AS (
            DELETE FROM idempotency_keys
             WHERE expires_at < now()
             RETURNING 1
          )
          SELECT COUNT(*)::text AS deleted FROM deleted`,
    );
    const count = Number.parseInt(
      (result.rows[0] as { deleted: string } | undefined)?.deleted ?? '0',
      10,
    );
    if (count > 0) {
      deps.logger?.info('Idempotency sweeper deleted expired rows', { count });
    }
  } catch (err) {
    deps.logger?.error('Idempotency sweeper failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
