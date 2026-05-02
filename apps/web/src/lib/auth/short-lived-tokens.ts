/**
 * Short-lived one-time-code issuance — the issue side of the primitive
 * that {@link verifyEmailCode} verifies.
 *
 * Every email-code flow in the app (customer registration verify,
 * resend-verification, email-change, customer forgot-password, firm
 * forgot-password) previously ran the same four-statement dance inline:
 *
 *   1. Invalidate pending tokens for this subject so a newly-requested
 *      code wins ties with whichever stale row the user never completed.
 *   2. Generate a cryptographically random 6-digit code.
 *   3. INSERT a new row with (subject_id, token_hash, expires_at,
 *      attempts = 0, ip_address?, created_at = now).
 *   4. Return the raw code so the caller can hand it to the email
 *      dispatcher (never persisted, never recoverable from the DB).
 *
 * The schema shape varies only in whether the table keeps an
 * `ip_address` column — {@link TokenTableConfig.supportsIpAddress}
 * decides whether the INSERT includes it. Every other column is
 * identical across the three tables.
 *
 * Race + replay posture:
 *   - Invalidation + INSERT run in a single transaction, so a concurrent
 *     caller cannot see "no pending rows, ready to issue" then race into
 *     two fresh rows (each thinking it was first).
 *   - A row's hash is the only retrievable artefact after the call
 *     returns; the raw code lives only in the transient return value.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { generateVerificationCode } from '@/lib/customer/verification-code';

import type { TokenTableConfig } from './verify-email-code';

/* -------------------------------------------------------------------------- */
/*  Input / output                                                             */
/* -------------------------------------------------------------------------- */

export interface IssueShortLivedTokenInput {
  readonly db: CrivacyDatabase;
  readonly table: TokenTableConfig;
  /** Owning customer / firm-user UUID. */
  readonly subjectId: string;
  /** TTL in seconds — expires_at is stamped at `now + ttlSeconds`. */
  readonly ttlSeconds: number;
  /**
   * When `true` (default), any previously-issued row for this subject
   * that is not already consumed or invalidated gets stamped
   * `invalidated_at = now` BEFORE the new row is inserted. Callers
   * that want to issue a parallel code (rare — should be a conscious
   * choice) pass `false`.
   */
  readonly invalidatePrevious?: boolean;
  /**
   * IP breadcrumb for audit triage. Only written when the configured
   * table supports it (`supportsIpAddress: true`); silently dropped
   * on email-verification tokens. A missing `ipAddress` on a support-
   * ing table writes `NULL`, preserving the existing column behaviour.
   */
  readonly ipAddress?: string;
  readonly now: Date;
}

export interface IssueShortLivedTokenResult {
  /** Raw 6-digit code — the caller MUST transmit it exactly once. */
  readonly rawCode: string;
  readonly expiresAt: Date;
}

/* -------------------------------------------------------------------------- */
/*  Issue                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mint a fresh one-time code for the given subject. See module header
 * for the race/replay contract.
 *
 * The function is atomic through a `db.transaction()` — rollback on
 * any failure leaves no partially-inserted row, so there is never a
 * window in which the old code was invalidated but the new code had
 * not been written yet.
 */
export async function issueShortLivedToken(
  input: IssueShortLivedTokenInput,
): Promise<IssueShortLivedTokenResult> {
  const {
    db,
    table,
    subjectId,
    ttlSeconds,
    invalidatePrevious = true,
    ipAddress,
    now,
  } = input;

  const { code, codeHash } = generateVerificationCode();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  // Dynamic identifiers come from the closed-union config — not
  // caller-controlled — so `sql.raw()` has no injection surface.
  const tableIdent = sql.raw(`"${table.tableName}"`);
  const subjectIdent = sql.raw(`"${table.subjectColumn}"`);

  await db.transaction(async (tx) => {
    if (invalidatePrevious) {
      await tx.execute(
        sql`UPDATE ${tableIdent}
              SET invalidated_at = ${now.toISOString()}
            WHERE ${subjectIdent} = ${subjectId}
              AND used_at IS NULL
              AND invalidated_at IS NULL`,
      );
    }

    if (table.supportsIpAddress) {
      await tx.execute(
        sql`INSERT INTO ${tableIdent}
              (${subjectIdent}, token_hash, expires_at, attempts, ip_address, created_at)
            VALUES
              (${subjectId}, ${codeHash}, ${expiresAt.toISOString()}, 0, ${ipAddress ?? null}, ${now.toISOString()})`,
      );
    } else {
      await tx.execute(
        sql`INSERT INTO ${tableIdent}
              (${subjectIdent}, token_hash, expires_at, attempts, created_at)
            VALUES
              (${subjectId}, ${codeHash}, ${expiresAt.toISOString()}, 0, ${now.toISOString()})`,
      );
    }
  });

  return { rawCode: code, expiresAt };
}
