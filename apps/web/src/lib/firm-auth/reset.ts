/**
 * Firm-user password reset — consume 6-digit code and set new password.
 *
 * Mirror of `lib/customer/reset.ts`. Side effects on success:
 *   - `firm_users.password_hash` is replaced with the new argon2id hash.
 *   - `failed_login_count`, `locked_at`, `locked_until` are cleared so
 *     a user who locked themselves out of the login form can recover
 *     through the reset flow.
 *   - `password_changed_at` is stamped.
 *   - Every `dashboard_sessions` row for the user is revoked to force
 *     a fresh login with the new credentials (cross-device logout on
 *     password change — standard pattern).
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { AuthConfig } from '@/lib/auth/config';
import { hashPassword } from '@/lib/auth/password';
import { assertPasswordNotPwned } from '@/lib/auth/pwned-passwords';
import { constantTimeHashEqual, hashSubmittedCode } from '@/lib/customer/verification-code';
import type { CrivacyDatabase } from '@/lib/db/client';
import { emitSecurityEvent } from '@/lib/security-events';
import type { AuditContextPayload } from '@/lib/security-events';

export type FirmUserResetPasswordResult =
  | { readonly status: 'reset'; readonly firmUserId: string }
  | { readonly status: 'expired' }
  | { readonly status: 'invalid' }
  | { readonly status: 'used' }
  | { readonly status: 'max_attempts' };

/**
 * The reduced-output peer of {@link resetFirmUserPassword}. Verifies
 * a reset code WITHOUT consuming it so the UI can confirm the code
 * up front and only show the "new password" step when the code is
 * actually valid. Writes to the DB on wrong codes (bumps `attempts`
 * and invalidates on the last try) so an attacker can't use the
 * verify endpoint as an oracle to brute-force without hitting the
 * per-code attempt cap.
 */
export type FirmUserVerifyResetCodeResult =
  | { readonly status: 'valid' }
  | { readonly status: 'expired' }
  | { readonly status: 'invalid' }
  | { readonly status: 'max_attempts' };

export async function resetFirmUserPassword(
  db: CrivacyDatabase,
  authConfig: Pick<
    AuthConfig,
    | 'passwordArgon2MemoryKib'
    | 'passwordArgon2Iterations'
    | 'passwordArgon2Parallelism'
    | 'passwordMinLength'
  >,
  email: string,
  rawCode: string,
  newPassword: string,
  auditContext: AuditContextPayload,
  displayName: string,
  maxAttempts: number,
  clock: () => Date = () => new Date(),
): Promise<FirmUserResetPasswordResult> {
  const now = clock();
  const emailLower = email.toLowerCase().trim();
  const codeHash = hashSubmittedCode(rawCode);

  const userResult = await db.execute<{ id: string }>(
    sql`SELECT fu.id
          FROM firm_users fu
          JOIN firms f ON f.id = fu.firm_id
         WHERE lower(fu.email) = ${emailLower}
           AND fu.accepted_at IS NOT NULL
           AND f.deleted_at IS NULL
         LIMIT 1`,
  );
  const user = userResult.rows[0] as { id: string } | undefined;
  if (!user) {
    // Anti-enumeration — tell the caller "invalid" so the response
    // shape matches the wrong-code-for-real-user case.
    return { status: 'invalid' };
  }

  const tokenResult = await db.execute<{
    id: string;
    token_hash: string;
    expires_at: string;
    attempts: number;
  }>(
    sql`SELECT id, token_hash, expires_at::text, attempts::int
          FROM firm_user_password_reset_tokens
         WHERE firm_user_id = ${user.id}
           AND used_at IS NULL
           AND invalidated_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
  );
  const tokenRow = tokenResult.rows[0] as
    | { id: string; token_hash: string; expires_at: string; attempts: number }
    | undefined;
  // Collapse "no pending token" into `invalid`. A distinct status
  // would let an attacker tell "email registered without an active
  // reset" apart from "email not registered" in one request — a
  // plain enumeration oracle.
  if (!tokenRow) {
    return { status: 'invalid' };
  }

  if (new Date(tokenRow.expires_at) < now) {
    return { status: 'expired' };
  }

  if (!constantTimeHashEqual(tokenRow.token_hash, codeHash)) {
    const newAttempts = tokenRow.attempts + 1;
    if (newAttempts >= maxAttempts) {
      await db.execute(
        sql`UPDATE firm_user_password_reset_tokens
              SET attempts = ${newAttempts}, invalidated_at = ${now.toISOString()}
            WHERE id = ${tokenRow.id}`,
      );
      return { status: 'max_attempts' };
    }
    await db.execute(
      sql`UPDATE firm_user_password_reset_tokens
            SET attempts = ${newAttempts}
          WHERE id = ${tokenRow.id}`,
    );
    return { status: 'invalid' };
  }

  // Code matches — reject the new password if it's in a breach
  // corpus before we overwrite the stored hash. Same HIBP check as
  // the customer reset flow.
  await assertPasswordNotPwned(newPassword);

  const passwordHash = await hashPassword(newPassword, authConfig);

  // Atomic state change + event emit — see customer reset helper for
  // the full rationale. Audit + password-changed notification email
  // are fanned out by the worker.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE firm_user_password_reset_tokens
            SET used_at = ${now.toISOString()}
          WHERE id = ${tokenRow.id}`,
    );
    await tx.execute(
      sql`UPDATE firm_users
            SET password_hash = ${passwordHash},
                failed_login_count = 0,
                locked_at = NULL,
                locked_until = NULL,
                password_changed_at = ${now.toISOString()},
                updated_at = ${now.toISOString()}
          WHERE id = ${user.id}`,
    );
    await tx.execute(
      sql`UPDATE sessions
            SET revoked_at = ${now.toISOString()},
                revoked_reason = 'password_reset'
          WHERE user_id = ${user.id}
            AND user_kind = 'firm'
            AND revoked_at IS NULL`,
    );
    await emitSecurityEvent({
      db: tx,
      eventType: 'firm_user.password_reset',
      subject: { kind: 'firm_user', id: user.id },
      payload: {
        auditContext,
        sessionId: null,
        email: emailLower,
        displayName,
        reason: 'reset',
        securityUrlPath: '/dashboard/settings/security',
      },
      now,
    });
  });

  return { status: 'reset', firmUserId: user.id };
}

/**
 * Pre-verify a reset code before showing the new-password form.
 * Same guards as {@link resetFirmUserPassword} up to (but not
 * including) the hash/update pair — `used_at` stays null, the code
 * remains redeemable. Wrong submits still count: `attempts` is
 * incremented and `invalidated_at` stamped on the 5th miss so the
 * verify surface can't become a free brute-force oracle.
 */
export async function verifyFirmUserResetCode(
  db: CrivacyDatabase,
  email: string,
  rawCode: string,
  maxAttempts: number,
  clock: () => Date = () => new Date(),
): Promise<FirmUserVerifyResetCodeResult> {
  const now = clock();
  const emailLower = email.toLowerCase().trim();
  const codeHash = hashSubmittedCode(rawCode);

  const userResult = await db.execute<{ id: string }>(
    sql`SELECT fu.id
          FROM firm_users fu
          JOIN firms f ON f.id = fu.firm_id
         WHERE lower(fu.email) = ${emailLower}
           AND fu.accepted_at IS NOT NULL
           AND f.deleted_at IS NULL
         LIMIT 1`,
  );
  const user = userResult.rows[0] as { id: string } | undefined;
  if (!user) {
    return { status: 'invalid' };
  }

  const tokenResult = await db.execute<{
    id: string;
    token_hash: string;
    expires_at: string;
    attempts: number;
  }>(
    sql`SELECT id, token_hash, expires_at::text, attempts::int
          FROM firm_user_password_reset_tokens
         WHERE firm_user_id = ${user.id}
           AND used_at IS NULL
           AND invalidated_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
  );
  const tokenRow = tokenResult.rows[0] as
    | { id: string; token_hash: string; expires_at: string; attempts: number }
    | undefined;
  // Same collapse as the reset path: surfacing a distinct status for
  // "no pending token" would enumerate registered firm users from
  // unregistered addresses.
  if (!tokenRow) {
    return { status: 'invalid' };
  }

  if (new Date(tokenRow.expires_at) < now) {
    return { status: 'expired' };
  }

  if (!constantTimeHashEqual(tokenRow.token_hash, codeHash)) {
    const newAttempts = tokenRow.attempts + 1;
    if (newAttempts >= maxAttempts) {
      await db.execute(
        sql`UPDATE firm_user_password_reset_tokens
              SET attempts = ${newAttempts}, invalidated_at = ${now.toISOString()}
            WHERE id = ${tokenRow.id}`,
      );
      return { status: 'max_attempts' };
    }
    await db.execute(
      sql`UPDATE firm_user_password_reset_tokens
            SET attempts = ${newAttempts}
          WHERE id = ${tokenRow.id}`,
    );
    return { status: 'invalid' };
  }

  return { status: 'valid' };
}
