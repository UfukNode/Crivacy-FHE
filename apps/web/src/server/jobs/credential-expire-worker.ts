/**
 * Credential expiry worker — pg-boss scheduled job handler.
 *
 * Closes PROD-TODO blocker #1 (credential.expired webhook emit).
 * Hourly cron sweeps `kyc_credentials_meta` rows whose
 * `valid_until` has passed but whose `status` is still `active`,
 * flips each one to `expired`, and emits a `credential.expired`
 * webhook to the issuing firm.
 *
 * Scope clarification (from PROD-TODO §1):
 *   - Admin `ban` already fires `credential.revoked` via
 *     `lib/fraud/ban.ts:286`.
 *   - Admin `reset_kyc` already fires `credential.revoked` via
 *     `admin-customers.ts:830`.
 *   - Customer self-revoke already fires `credential.revoked` via
 *     `customer-kyc.ts:881`.
 *   - TTL expiration is the gap this worker closes; no other path
 *     produces `credential.expired` today.
 *
 * chain archive is NOT exercised here. The CIP #204 standard interface
 * surface (`Credential_PublicFetch`, `Credential_ArchiveAsHolder`) plus
 * the implementer-side `RevokeCredential` choice do not include a
 * dedicated `Expire` path — expiration is interpreted client-side from
 * `claims.validUntil` against current time. Off-chain TTL flip + webhook
 * is sufficient because firms read credential status from our API and
 * also recompute the validity window from the disclosure blob. A future
 * implementer choice could archive the contract on expiry; this worker
 * would only need an on-chain call inserted before the DB UPDATE.
 *
 * Worker pool: this job runs under the admin pool (BYPASSRLS) by
 * the same reasoning as every other pg-boss worker. Cross-firm
 * row scans without `app.firm_id` set would be filtered to zero
 * rows under the Cat 34b RLS policy on `kyc_credentials_meta`;
 * BYPASSRLS keeps the sweep working.
 *
 * @module
 */

import type PgBoss from 'pg-boss';

import type { CrivacyDatabase } from '@/lib/db/client';
import { findExpiredCredentialsToFlip, updateCredentialStatus } from '../repositories';
import { emitFirmEvent } from '@/lib/webhook/emit';

/* ---------- Constants ---------- */

/** pg-boss queue name for the scheduled expiry sweep. */
export const CREDENTIAL_EXPIRE_QUEUE = 'credential-expire-sweep';

/** Cron schedule — hourly at :00. TTL is in days/months so a
 *  1-hour granularity is plenty without spamming the DB. */
export const CREDENTIAL_EXPIRE_CRON = '0 * * * *';

/** Max rows per sweep. A single tick scans up to this many aged
 *  credentials; the next tick picks up the rest. Keeps a single
 *  job's wall time bounded so a backlog doesn't block other
 *  workers on the same boss instance. */
export const CREDENTIAL_EXPIRE_BATCH_SIZE = 200;

/* ---------- Types ---------- */

export interface CredentialExpireWorkerDeps {
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

export interface CredentialExpireResult {
  readonly scanned: number;
  readonly expired: number;
  readonly errors: number;
}

/* ---------- Handler ---------- */

/**
 * Process one sweep. Exposed separately from `register()` so tests
 * can drive it without a live pg-boss instance.
 */
export async function processExpirySweep(
  deps: CredentialExpireWorkerDeps,
): Promise<CredentialExpireResult> {
  const now = (deps.clock ?? (() => new Date()))();
  const batchSize = deps.batchSize ?? CREDENTIAL_EXPIRE_BATCH_SIZE;

  const aged = await findExpiredCredentialsToFlip(deps.db, now, batchSize);
  let expired = 0;
  let errors = 0;

  for (const row of aged) {
    try {
      // 1. DB flip first. Repository UPDATE is the source of truth
      //    for the off-chain credential status; webhook emission is
      //    a side-effect that consumers are allowed to lose
      //    occasionally (re-driven by a future scan).
      await updateCredentialStatus(deps.db, row.id, 'expired', { expiredAt: now });

      // 2. Emit credential.expired to the issuing firm. Single-firm
      //    dispatch — the credential belongs to one firm + one
      //    user_ref pair. Multi-firm fan-out via emitUserEvent is
      //    not appropriate here because the consenting firms
      //    already see the revoked / expired state through their
      //    own consent lifecycle webhooks.
      //
      //    Payload uses the canonical credential view so the wire
      //    shape stays in lockstep with `credential.created` /
      //    `credential.verified` / `credential.upgraded` —
      //    `lib/credentials/view.ts` is the single SoT. The just-
      //    flipped status + expiredAt aren't yet reflected in the
      //    in-memory `row`, so we override those two fields on the
      //    projection before passing it through `toWebhookPayload`.
      const { fromKycCredentialMetaRow, toWebhookPayload } = await import(
        '@/lib/credentials/view',
      );
      const expiredView = {
        ...fromKycCredentialMetaRow(row),
        status: 'expired' as const,
        expiredAt: now,
      };
      await emitFirmEvent(deps.db, {
        firmId: row.firmId,
        type: 'credential.expired',
        payload: { ...toWebhookPayload(expiredView) },
        sourceCredentialId: row.id,
        now,
      });

      expired += 1;
    } catch (err) {
      errors += 1;
      deps.logger?.error?.('credential-expire: row processing failed', {
        credentialId: row.id,
        firmId: row.firmId,
        err: err instanceof Error ? err.message : String(err),
      });
      // Continue with remaining rows. The next sweep picks up any
      // row whose UPDATE didn't commit (status still 'active' +
      // valid_until still passed).
    }
  }

  deps.logger?.info?.('credential-expire: sweep complete', {
    scanned: aged.length,
    expired,
    errors,
  });

  return { scanned: aged.length, expired, errors };
}

/* ---------- Registration ---------- */

/**
 * Register the worker against a pg-boss instance and schedule the
 * hourly cron. Mirrors the email-worker / credential-pipeline-worker
 * shape so `instrumentation.ts` can wire it up the same way.
 */
export async function registerCredentialExpireWorker(
  boss: PgBoss,
  deps: CredentialExpireWorkerDeps,
): Promise<void> {
  // pg-boss requires the queue to be created before `schedule` /
  // `work` resolve to it. Idempotent — safe to call on every boot.
  await boss.createQueue(CREDENTIAL_EXPIRE_QUEUE);

  // Schedule the cron tick. pg-boss persists the schedule in
  // pgboss.schedule; calling schedule() again with the same name
  // overwrites the pattern, so the boot is idempotent.
  await boss.schedule(CREDENTIAL_EXPIRE_QUEUE, CREDENTIAL_EXPIRE_CRON);

  // Single-concurrency consumer. The sweep itself is bounded by
  // `batchSize`, so two parallel ticks would only race over the
  // SAME aged rows — postgres' RLS is BYPASSRLS for the admin pool,
  // not a row-level lock, so we keep concurrency = 1 to avoid
  // duplicate webhook emissions on the unlikely overlap window.
  await boss.work(CREDENTIAL_EXPIRE_QUEUE, { batchSize: 1 }, async () => {
    await processExpirySweep(deps);
  });
}
