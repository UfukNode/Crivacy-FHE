/**
 * One-off ops script: reconcile a single customer's KYC drift right
 * now, bypassing the cron + lookback window.
 *
 * Usage:
 *   pnpm dlx dotenv-cli -e .env -- pnpm tsx scripts/kyc-reconcile-once.ts <customer-uuid>
 *
 * Use cases:
 *   1. Customer in drift outside the default 7-day lookback (older
 *      `customer.kyc_started` audit) — the cron worker would skip
 *      them, this script runs the reconcileCustomer logic directly.
 *   2. Faster turnaround on a freshly-detected drift than waiting for
 *      the next cron tick.
 *   3. Manual smoke test of the reconciler logic against a known
 *      customer in dev / staging.
 *
 * The script enforces the SAME guards as the cron path: throttle
 * (1 outbound Didit GET per 500ms by default), Phase 2 prerequisite
 * check, admin-override skip via `customers.revoked_at`, audit-log
 * writes for every branch.
 *
 * Idempotent — re-running against a customer who is already in sync
 * goes through the no_session_found / session_already_terminal /
 * didit_pending_decision branches without enqueuing a new pipeline
 * job and without touching the DB. Safe to invoke any number of
 * times; the pipeline's existing dedupe layers absorb concurrent
 * webhook + reconciler enqueue.
 */

import { eq } from 'drizzle-orm';

import { getDatabaseClient } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import { createQueueClient } from '@/server/jobs/queue';
import {
  buildThrottle,
  createNoopFailureStreakCounter,
  loadKycReconcilerConfig,
  reconcileCustomer,
} from '@/server/jobs/kyc-reconciler-worker';

async function main(): Promise<void> {
  const customerId = process.argv[2];
  if (customerId === undefined || customerId.length === 0) {
    throw new Error('Usage: tsx scripts/kyc-reconcile-once.ts <customer-uuid>');
  }
  console.log('[kyc-reconcile-once] customerId =', customerId);

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL not set');
  }

  const { db } = getDatabaseClient();
  const config = loadKycReconcilerConfig();
  console.log('[kyc-reconcile-once] config =', config);

  // Pre-check matching the cron path — soft-deleted or admin-revoked
  // customers are NEVER reconciled even from the manual entry point.
  const rows = await db
    .select({
      id: schema.customers.id,
      revokedAt: schema.customers.revokedAt,
      deletedAt: schema.customers.deletedAt,
    })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    console.error('[kyc-reconcile-once] customer not found, aborting');
    process.exit(1);
  }
  if (row.deletedAt !== null) {
    console.error('[kyc-reconcile-once] customer is soft-deleted, aborting');
    process.exit(1);
  }
  if (row.revokedAt !== null) {
    console.error(
      '[kyc-reconcile-once] customer is admin-revoked, aborting (revoked_at =',
      row.revokedAt,
      ')',
    );
    process.exit(1);
  }

  const boss = await createQueueClient(connectionString);

  // Same throttle the cron worker uses, but we only call it once per
  // run so the interval is essentially a noop here. Including it
  // keeps the call site identical to the cron path.
  const throttle = buildThrottle(config.throttleMs);

  // The 401-streak counter is single-shot here (one customer, no
  // streak possible). Use the canonical no-op factory so we don't
  // hand-roll an inline cast.
  const apiKeyFailureStreak = createNoopFailureStreakCounter();

  const logger = {
    info: (msg: string, meta?: Record<string, unknown>): void => {
      console.log(`[kyc-reconcile-once] ${msg}`, meta ?? '');
    },
    error: (msg: string, meta?: Record<string, unknown>): void => {
      console.error(`[kyc-reconcile-once] ${msg}`, meta ?? '');
    },
  };

  try {
    const outcome = await reconcileCustomer(
      {
        db,
        boss,
        logger,
        throttle,
        apiKeyFailureStreak,
        now: new Date(),
      },
      customerId,
    );
    console.log('[kyc-reconcile-once] outcome =', outcome);
  } finally {
    await boss.stop();
  }
}

main().catch((err) => {
  console.error('[kyc-reconcile-once] FAIL:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
