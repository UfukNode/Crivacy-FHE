/**
 * One-shot script to re-enqueue a credential-pipeline job for a
 * failed kyc_session. Used to recover from a `failed` pg-boss state
 * after a worker fix lands — the existing failed row's singleton_key
 * doesn't block a fresh enqueue (singleton dedup only applies to
 * `created`/`active`/`retry`).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/enqueue-credential-pipeline.ts \
 *     <kycSessionId> <customerId> <diditSessionId> <phase>
 */

import { createQueueClient } from '@/server/jobs/queue';
import { enqueueCredentialPipeline } from '@/server/jobs/credential-pipeline-worker';

async function main(): Promise<void> {
  const [, , kycSessionId, customerId, diditSessionId, phase] = process.argv;
  if (
    kycSessionId === undefined ||
    customerId === undefined ||
    diditSessionId === undefined ||
    (phase !== 'identity' && phase !== 'address')
  ) {
    console.error('Usage: tsx scripts/enqueue-credential-pipeline.ts <kycSessionId> <customerId> <diditSessionId> <identity|address>');
    process.exit(1);
  }

  const connectionString = process.env['DATABASE_URL_ADMIN'] ?? process.env['DATABASE_URL'];
  if (connectionString === undefined) {
    console.error('DATABASE_URL_ADMIN or DATABASE_URL must be set');
    process.exit(1);
  }

  const boss = await createQueueClient(connectionString);
  try {
    const jobId = await enqueueCredentialPipeline(boss, {
      flow: 'customer',
      kycSessionId,
      customerId,
      diditSessionId,
      phase: phase as 'identity' | 'address',
    });
    console.log(JSON.stringify({ ok: true, jobId, kycSessionId, phase }, null, 2));
  } finally {
    await boss.stop({ timeout: 5000 });
  }
}

void main().catch((err) => {
  console.error('enqueue failed:', err);
  process.exit(1);
});
