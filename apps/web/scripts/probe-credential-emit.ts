/**
 * One-off probe: replay `emitUserEvent('credential.created')` for a
 * given customer + credential pair so the underlying error surfaces
 * cleanly. The pipeline-once logger swallowed the `error` field; this
 * script prints it verbatim.
 */

import { getDatabaseClient } from '@/lib/db/client';
import { fromKycCredentialMetaRow, toWebhookPayload } from '@/lib/credentials/view';
import { emitUserEvent } from '@/lib/webhook/emit';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';

async function main(): Promise<void> {
  const customerId = process.argv[2];
  const credentialId = process.argv[3];
  if (customerId === undefined || credentialId === undefined) {
    throw new Error('Usage: probe-credential-emit.ts <customerId> <credentialId>');
  }

  const { db } = getDatabaseClient();
  const rows = await db
    .select()
    .from(schema.kycCredentialsMeta)
    .where(eq(schema.kycCredentialsMeta.id, credentialId))
    .limit(1);
  const credentialMeta = rows[0];
  if (credentialMeta === undefined) {
    throw new Error(`credential ${credentialId} not found`);
  }

  const payload = toWebhookPayload(fromKycCredentialMetaRow(credentialMeta));

  const selfServiceFirmId = process.env['CRIVACY_SELF_SERVICE_FIRM_ID'];
  if (selfServiceFirmId === undefined) {
    throw new Error('CRIVACY_SELF_SERVICE_FIRM_ID not set');
  }

  const now = new Date();
  console.log('[probe] dispatching credential.created…', { customerId, credentialId });
  try {
    const res = await emitUserEvent(db, {
      customerId,
      ownerFirmId: selfServiceFirmId,
      type: 'credential.created',
      payload: { ...payload, createdAt: now.toISOString() },
      sourceCredentialId: credentialMeta.id,
      idempotencyKey: `probe-created:${credentialMeta.id}:${now.getTime()}`,
      now,
    });
    console.log('[probe] OK', res);
  } catch (err) {
    console.error('[probe] DISPATCH FAILED');
    console.error(err);
    if (err instanceof Error && err.stack !== undefined) {
      console.error(err.stack);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[probe] fatal');
  console.error(err);
  process.exit(2);
});
