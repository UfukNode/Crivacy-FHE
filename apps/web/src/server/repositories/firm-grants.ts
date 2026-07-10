/**
 * Repository for `firm_credential_grants` — the per-(firm, user) FHE
 * access-grant handoff between the consent request path and the async
 * on-chain grant worker.
 *
 * @module
 */

import { and, asc, eq, lt, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import {
  firmCredentialGrants,
  type FirmCredentialGrant,
} from '@/lib/db/schema';

/**
 * Upsert a `pending` grant for (firm, customer). Called in the consent
 * request path AFTER commit. On re-consent the existing row is reset to
 * `pending` with the (possibly upgraded) `minLevel`, so a level bump
 * re-grants on chain. Never throws on the common path.
 */
export async function upsertPendingGrant(
  db: CrivacyDatabase,
  input: {
    readonly firmId: string;
    readonly customerId: string;
    readonly userAddress: string;
    readonly firmAddress: string;
    readonly minLevel: 'basic' | 'enhanced';
    readonly now: Date;
  },
): Promise<FirmCredentialGrant> {
  const rows = await db
    .insert(firmCredentialGrants)
    .values({
      firmId: input.firmId,
      customerId: input.customerId,
      userAddress: input.userAddress,
      firmAddress: input.firmAddress,
      minLevel: input.minLevel,
      status: 'pending',
      attempts: 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [firmCredentialGrants.firmId, firmCredentialGrants.customerId],
      set: {
        userAddress: input.userAddress,
        firmAddress: input.firmAddress,
        minLevel: input.minLevel,
        status: 'pending',
        attempts: 0,
        lastError: null,
        txHash: null,
        grantedAt: null,
        updatedAt: input.now,
      },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error('firm_credential_grants upsert returned no rows');
  }
  return row;
}

/**
 * Fetch the next batch of grants the worker should process: `pending` or
 * previously-`failed` rows that have not exhausted their retry budget,
 * oldest first. Concurrency is 1 (see the worker), so no row locking is
 * needed; the single consumer drains sequentially.
 */
export async function claimGrantsToProcess(
  db: CrivacyDatabase,
  maxAttempts: number,
  limit: number,
): Promise<readonly FirmCredentialGrant[]> {
  return db
    .select()
    .from(firmCredentialGrants)
    .where(
      and(
        sql`${firmCredentialGrants.status} IN ('pending', 'failed')`,
        lt(firmCredentialGrants.attempts, maxAttempts),
      ),
    )
    .orderBy(asc(firmCredentialGrants.createdAt))
    .limit(limit);
}

/** Mark a grant granted with its on-chain tx hash. */
export async function markGrantGranted(
  db: CrivacyDatabase,
  id: string,
  txHash: string,
  now: Date,
): Promise<void> {
  await db
    .update(firmCredentialGrants)
    .set({ status: 'granted', txHash, grantedAt: now, updatedAt: now, lastError: null })
    .where(eq(firmCredentialGrants.id, id));
}

/**
 * Mark a grant attempt failed: bump `attempts`, record the error, set
 * `status='failed'`. The claim query re-picks it next sweep while
 * `attempts < maxAttempts`, then leaves it parked for an operator.
 */
export async function markGrantFailed(
  db: CrivacyDatabase,
  id: string,
  error: string,
  now: Date,
): Promise<void> {
  await db
    .update(firmCredentialGrants)
    .set({
      status: 'failed',
      lastError: error.slice(0, 2000),
      attempts: sql`${firmCredentialGrants.attempts} + 1`,
      updatedAt: now,
    })
    .where(eq(firmCredentialGrants.id, id));
}
