/**
 * Firm access-grant worker — pg-boss scheduled sweep.
 *
 * Drains `firm_credential_grants` rows written by the OAuth consent handler
 * (status `pending`/`failed`) and calls the on-chain gatekeeper
 * `grantAccess(userAddress, firmAddress, minLevel)` on CrivacyKYC. That ~15s
 * tx is why this runs async off the consent request path: the user's redirect
 * never waits on chain, and a crash/restart just re-drains the durable rows.
 *
 * Distributed-safe: pg-boss owns the cron tick (one worker runs it per
 * cluster), and each row is marked `granted`/`failed` before the next sweep,
 * so no double-grant. The on-chain `grantAccess` overwrites `_grant[user][firm]`
 * anyway, so even a redundant call is harmless.
 *
 * Retry: a transient failure (RPC hiccup, credential not yet mined) bumps
 * `attempts` and parks the row `failed`; it is re-picked while
 * `attempts < MAX_ATTEMPTS`, then left for an operator. The firm-facing verify
 * path degrades gracefully in the meantime (plaintext lifecycle still reads;
 * only the encrypted-verdict decrypt waits for the grant to land).
 *
 * Worker pool: runs under the admin pool (BYPASSRLS) like every other pg-boss
 * worker — a cross-firm sweep without `app.firm_id` set would otherwise be
 * filtered to zero rows by RLS.
 *
 * @module
 */

import type PgBoss from 'pg-boss';

import { getFheClient, type CredentialLevel } from '@crivacy-fhe/credential';
import type { Address } from 'viem';

import type { CrivacyDatabase } from '@/lib/db/client';
import {
  claimGrantsToProcess,
  markGrantFailed,
  markGrantGranted,
} from '@/server/repositories/firm-grants';

/* ---------- Constants ---------- */

/** pg-boss queue name for the scheduled grant sweep. */
export const FIRM_GRANT_QUEUE = 'firm-grant-access-sweep';

/** Cron schedule — every minute. A consent-to-grant latency of up to ~1min
 *  + the ~15s tx is acceptable; the firm verify UI shows a pending state. */
export const FIRM_GRANT_CRON = '* * * * *';

/** Rows drained per tick. Each grant is a real on-chain tx, so keep the
 *  per-sweep wall time bounded to not starve other workers on the boss. */
export const FIRM_GRANT_BATCH_SIZE = 10;

/** Retry budget per grant before it is parked `failed` for an operator. */
export const FIRM_GRANT_MAX_ATTEMPTS = 8;

/* ---------- Types ---------- */

export interface FirmGrantWorkerDeps {
  readonly db: CrivacyDatabase;
  readonly logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Time source — injectable for testing. Defaults to wall clock. */
  readonly clock?: () => Date;
  /** Optional override of the batch cap (tests use a small value). */
  readonly batchSize?: number;
}

/* ---------- Sweep ---------- */

/**
 * Process one drain tick. Exported for direct testing; the pg-boss handler
 * wraps this. Returns a small summary for observability/tests.
 */
export async function processGrantSweep(
  deps: FirmGrantWorkerDeps,
): Promise<{ scanned: number; granted: number; failed: number }> {
  const now = deps.clock?.() ?? new Date();
  const batchSize = deps.batchSize ?? FIRM_GRANT_BATCH_SIZE;
  const pending = await claimGrantsToProcess(deps.db, FIRM_GRANT_MAX_ATTEMPTS, batchSize);

  if (pending.length === 0) {
    return { scanned: 0, granted: 0, failed: 0 };
  }

  const fhe = getFheClient();
  let granted = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const txHash = await fhe.grantAccess(
        row.userAddress as Address,
        row.firmAddress as Address,
        row.minLevel as CredentialLevel,
      );
      await markGrantGranted(deps.db, row.id, txHash, deps.clock?.() ?? new Date());
      granted += 1;
      deps.logger?.info?.('firm-grant: granted', {
        grantId: row.id,
        firmId: row.firmId,
        txHash,
      });
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await markGrantFailed(deps.db, row.id, message, deps.clock?.() ?? new Date());
      deps.logger?.error?.('firm-grant: grantAccess failed (will retry)', {
        grantId: row.id,
        firmId: row.firmId,
        attempts: row.attempts + 1,
        err: message,
      });
      // Continue with the remaining rows — one bad grant (e.g. a
      // not-yet-mined credential) must not block the others in the batch.
    }
  }

  deps.logger?.info?.('firm-grant: sweep complete', {
    scanned: pending.length,
    granted,
    failed,
  });

  return { scanned: pending.length, granted, failed };
}

/* ---------- Registration ---------- */

/**
 * Register the worker + cron against a pg-boss instance. Mirrors the
 * credential-expire-worker shape so `instrumentation.ts` wires it the same way.
 */
export async function registerFirmGrantWorker(
  boss: PgBoss,
  deps: FirmGrantWorkerDeps,
): Promise<void> {
  // pg-boss requires the queue to exist before schedule/work resolve.
  await boss.createQueue(FIRM_GRANT_QUEUE);
  await boss.schedule(FIRM_GRANT_QUEUE, FIRM_GRANT_CRON);
  // Single-concurrency consumer: grants are real txs, and the row status
  // flip already dedups, so one sequential drainer avoids double-spends.
  await boss.work(FIRM_GRANT_QUEUE, { batchSize: 1 }, async () => {
    await processGrantSweep(deps);
  });
}
