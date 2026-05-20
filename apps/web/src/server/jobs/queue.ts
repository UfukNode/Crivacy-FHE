/**
 * pg-boss queue client lifecycle.
 *
 * Provides a thin wrapper around pg-boss for starting, stopping, and
 * enqueuing webhook delivery jobs. The actual job handler lives in
 * `webhook-worker.ts`.
 *
 * @module
 */

import type PgBoss from 'pg-boss';

/* ---------- Constants ---------- */

/** Queue name for webhook delivery jobs. */
export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';

/**
 * Pure work queues that must exist before `boss.send()` or `boss.work()`.
 *
 * pg-boss v10 dropped auto-create-on-send/work. Cron-scheduled queues
 * (credential-pipeline, credential-expire-sweep, security-events-dispatch,
 * session-cleanup, idempotency-sweeper) get implicit `createQueue` via
 * `boss.schedule()`. Pure work queues (email-send, webhook-delivery) have
 * no schedule and must be created explicitly — otherwise `boss.send()`
 * returns null silently and routes that don't null-check the return value
 * silently lose every job.
 */
const PURE_WORK_QUEUES = ['email-send', WEBHOOK_DELIVERY_QUEUE] as const;

/* ---------- Types ---------- */

/** Shape of the job payload enqueued for each webhook delivery. */
export interface WebhookDeliveryJob {
  readonly deliveryId: string;
}

/* ---------- Queue operations ---------- */

/**
 * Create and start a pg-boss instance.
 *
 * The caller is responsible for calling `boss.stop()` on shutdown.
 *
 * @param connectionString - PostgreSQL connection string
 * @param schema - pg-boss schema name (default: 'pgboss')
 */
export async function createQueueClient(
  connectionString: string,
  schema = 'pgboss',
): Promise<PgBoss> {
  // Dynamic import so the module doesn't fail when pg-boss
  // is not installed (e.g. during type-checking only builds).
  const { default: PgBossConstructor } = await import('pg-boss');
  const boss = new PgBossConstructor({ connectionString, schema });
  await boss.start();
  for (const queue of PURE_WORK_QUEUES) {
    await boss.createQueue(queue);
  }
  return boss;
}

/**
 * Enqueue a webhook delivery job.
 *
 * @param boss - pg-boss instance
 * @param deliveryId - ID of the webhook_deliveries row
 * @param startAfter - When to start processing (for retries)
 * @returns pg-boss job ID (or null if deduplicated)
 */
export async function enqueueDelivery(
  boss: PgBoss,
  deliveryId: string,
  startAfter?: Date,
): Promise<string | null> {
  const options: PgBoss.SendOptions = {
    singletonKey: deliveryId, // deduplicate by delivery ID
  };
  if (startAfter !== undefined) {
    options.startAfter = startAfter;
  }

  return boss.send(WEBHOOK_DELIVERY_QUEUE, { deliveryId }, options);
}

/**
 * Enqueue multiple webhook delivery jobs.
 */
export async function enqueueDeliveries(
  boss: PgBoss,
  deliveries: readonly { deliveryId: string; startAfter?: Date }[],
): Promise<void> {
  for (const d of deliveries) {
    await enqueueDelivery(boss, d.deliveryId, d.startAfter);
  }
}
