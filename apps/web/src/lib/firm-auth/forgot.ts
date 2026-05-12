/**
 * Firm-user forgot-password — mint a 6-digit reset code.
 *
 * Mirror of `lib/customer/forgot.ts`, isolated to the firm-user
 * audience. Returns `null` when the email doesn't resolve to a
 * loadable firm user so the caller can return the generic "if
 * this email is registered…" response without branching on
 * existence (anti-enumeration).
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { issueShortLivedToken } from '@/lib/auth/short-lived-tokens';
import { FIRM_PASSWORD_RESET_TABLE } from '@/lib/auth/verify-email-code';
import { hashSubmittedCode } from '@/lib/customer/verification-code';

export interface FirmUserForgotPasswordResult {
  /** Null when no active firm user matched the email. */
  readonly resetCode: string | null;
  readonly firmUserId: string | null;
  readonly codeHash: string | null;
}

/**
 * Generate a fresh password-reset code for the firm user with this
 * email. Any previously issued pending code for the user is
 * invalidated in the same transaction so only the latest code can
 * be redeemed — matches the customer flow's single-code invariant.
 *
 * Row-resolution policy MUST mirror `findUserByEmail` (login):
 *   - `accepted_at IS NOT NULL`  — invite flow completed.
 *   - `password_hash IS NOT NULL` — a password was actually set.
 *   - `locked_at IS NULL`        — row hasn't been offboarded.
 *   - `f.deleted_at IS NULL`     — firm itself is live.
 *   - `ORDER BY accepted_at DESC LIMIT 1` — most-recent membership.
 *
 * F-A7-MULTIFIRM-L4-001 (Page 7 closure): the previous query
 * resolved the OLDEST membership row (no ORDER BY, no password_hash
 * filter, no locked_at filter). When a multi-firm user logged in
 * with their most-recent firm credentials and then requested a
 * reset, the email keyed to a different (older) row — the user
 * could reset a password they never used and still couldn't sign
 * in. Login + reset MUST resolve the same row.
 */
export async function requestFirmUserPasswordReset(
  db: CrivacyDatabase,
  email: string,
  resetTtlSeconds: number,
  ip: string | null,
  clock: () => Date = () => new Date(),
): Promise<FirmUserForgotPasswordResult> {
  const now = clock();
  const emailLower = email.toLowerCase().trim();

  const userResult = await db.execute<{ id: string; firm_id: string }>(
    sql`SELECT fu.id, fu.firm_id
          FROM firm_users fu
          JOIN firms f ON f.id = fu.firm_id
         WHERE lower(fu.email) = ${emailLower}
           AND fu.accepted_at IS NOT NULL
           AND fu.password_hash IS NOT NULL
           AND fu.locked_at IS NULL
           AND f.deleted_at IS NULL
         ORDER BY fu.accepted_at DESC
         LIMIT 1`,
  );
  const user = userResult.rows[0] as { id: string; firm_id: string } | undefined;
  if (!user) {
    return { resetCode: null, firmUserId: null, codeHash: null };
  }

  const issued = await issueShortLivedToken({
    db,
    table: FIRM_PASSWORD_RESET_TABLE,
    subjectId: user.id,
    ttlSeconds: resetTtlSeconds,
    ...(ip !== null ? { ipAddress: ip } : {}),
    now,
  });

  return {
    resetCode: issued.rawCode,
    firmUserId: user.id,
    codeHash: hashSubmittedCode(issued.rawCode),
  };
}
