/**
 * One-off ops script: directly invoke the credential-pipeline handler
 * for a single customer KYC session, bypassing pg-boss queueing.
 *
 * Used when the dev environment doesn't run pg-boss workers
 * (instrumentation.ts skips workers in NODE_ENV !== 'production')
 * but we still need to mint a credential for a stuck customer.
 *
 * Usage:
 *   pnpm dlx dotenv-cli -e .env -- pnpm tsx scripts/process-pipeline-once.ts \
 *     <kycSessionId> <customerId> <diditSessionId> <phase>
 */

import { getDatabaseClient } from '@/lib/db/client';
import { processCredentialPipeline } from '@/server/jobs/credential-pipeline-worker';
import { getRootLogger } from '@/lib/observability/logger';

async function main(): Promise<void> {
  const [kycSessionId, customerId, diditSessionId, phaseRaw] = process.argv.slice(2);
  if (
    kycSessionId === undefined ||
    customerId === undefined ||
    diditSessionId === undefined ||
    phaseRaw === undefined
  ) {
    throw new Error(
      'Usage: tsx process-pipeline-once.ts <kycSessionId> <customerId> <diditSessionId> <phase>',
    );
  }
  const phase = phaseRaw as 'identity' | 'address';
  const { db } = getDatabaseClient();
  const logger = getRootLogger();

  console.log('[process-pipeline-once] starting', {
    kycSessionId,
    customerId,
    diditSessionId,
    phase,
  });

  await processCredentialPipeline(
    { db, logger: logger as never },
    {
      flow: 'customer',
      kycSessionId,
      customerId,
      diditSessionId,
      phase,
    },
  );

  console.log('[process-pipeline-once] DONE');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[process-pipeline-once] FAIL:', err);
  process.exit(1);
});
