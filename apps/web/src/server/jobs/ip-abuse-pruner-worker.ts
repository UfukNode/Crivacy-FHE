/**
 * IP-abuse-signals pruner — pg-boss scheduled job (Sprint 6).
 *
 * `ip_abuse_signals` rows have a 7-day TTL by design (see
 * `lib/fraud/ip-abuse.ts`). The TTL is checked by readers
 * (`getCount` filters `last_seen >= now - ttlDays`), so stale rows
 * just leak storage; they don't cause false positives. This worker
 * keeps the table bounded by DELETEing past-window rows nightly.
 *
 * Runs every 24h at 03:00 UTC — off-peak across all our supported
 * regions, and matches the session-cleanup cadence so the storage
 * envelope stays predictable.
 *
 * @module
 */

import type PgBoss from 'pg-boss';

import type { CrivacyDatabase } from '@/lib/db/client';
import { pruneExpired } from '@/lib/fraud/ip-abuse';

/** pg-boss queue name. */
export const IP_ABUSE_PRUNER_QUEUE = 'ip-abuse-pruner';

export interface IpAbusePrunerDeps {
  readonly db: CrivacyDatabase;
  readonly logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export async function registerIpAbusePrunerWorker(
  boss: PgBoss,
  deps: IpAbusePrunerDeps,
): Promise<void> {
  await boss.createQueue(IP_ABUSE_PRUNER_QUEUE);

  await boss.work(IP_ABUSE_PRUNER_QUEUE, async () => {
    try {
      const deleted = await pruneExpired(deps.db);
      if (deleted > 0) {
        deps.logger?.info('IP abuse pruner deleted expired rows', { deleted });
      }
    } catch (err) {
      deps.logger?.error('IP abuse pruner failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  // Daily at 03:00 UTC — same cadence as the session-cleanup family,
  // off-peak. Idempotent: re-running mid-window is a no-op (every
  // surviving row has a `last_seen` within the active window).
  await boss.schedule(IP_ABUSE_PRUNER_QUEUE, '0 3 * * *', undefined, {
    tz: 'UTC',
  });

  deps.logger?.info('IP-abuse pruner registered (daily 03:00 UTC)');
}
